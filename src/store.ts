/** SQLite 持久化：消息去重、任务/结果事务、会话映射与重启恢复。
 *  node:sqlite 是同步 API——Bridge 从鉴权到设置 active 之间无 await，
 *  单任务互斥正是建立在这个前提上，改成异步驱动库前必须重新设计加锁。 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DeliveryState, TaskLimits, TaskState, type TaskTerminalState } from './task.ts';
import type { RuntimeHooks } from './types.ts';
type Preferences = Pick<RuntimeHooks, 'mode' | 'model' | 'effort'>;

/** 启动时清理更早行的默认保留期（30 天）。 */
export const DefaultDataRetentionMs = 30 * 24 * 60 * 60 * 1000;

/** /result 取回的结果行。 */
type ResultRow = { task: string; text: string; delivery: DeliveryState };

export class Store {
  db: DatabaseSync;
  constructor(path: string, retentionMs: number = DefaultDataRetentionMs) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, acp TEXT NOT NULL, last_used_at INTEGER);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session TEXT, message TEXT, status TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS results (task TEXT PRIMARY KEY, text TEXT NOT NULL, delivery TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);`);
    // 旧映射没有活动时间，保持 NULL：下次读取时换新会话，不假定其仍然新鲜。
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all();
    if (!columns.some(column => column.name === 'last_used_at')) this.db.exec('ALTER TABLE sessions ADD COLUMN last_used_at INTEGER');
    this.db.exec(`CREATE TABLE IF NOT EXISTS session_history (owner TEXT NOT NULL, acp TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(owner,acp));
      CREATE TABLE IF NOT EXISTS session_preferences (owner TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO session_history SELECT id,acp,COALESCE(last_used_at,0) FROM sessions;`);
    // 进程已丢失，历史会话无法证明工具执行到哪一步；重启只标记中断，不重放任务。
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO results(task,text,delivery) SELECT id,?,? FROM tasks WHERE status=?')
        .run('服务重启，排队任务已中断且未执行，请重新发送。', DeliveryState.Pending, TaskState.Queued);
      this.db.prepare('UPDATE tasks SET status=?,at=? WHERE status IN (?,?)')
        .run(TaskState.Interrupted, Date.now(), TaskState.Running, TaskState.Queued);
      // 重启后已无在途投递，待发送结果可通过 /result failed 找回。
      this.db.prepare('UPDATE results SET delivery=? WHERE delivery=?').run(DeliveryState.Failed, DeliveryState.Pending);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    // 中断标记先刷新 at，随后的按期清理不会删除刚被标记的等待项。
    // tasks/results 以最后一次状态变更时间为准；results 不含时间列，随任务行或孤儿清理。
    const expired = Date.now() - retentionMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM results WHERE task NOT IN (SELECT id FROM tasks) OR task IN (SELECT id FROM tasks WHERE at<=?)').run(expired);
      this.db.prepare('DELETE FROM tasks WHERE at<=?').run(expired);
      // 任务按最后状态变更计时，保留的任务仍需要它的去重键。
      this.db.prepare('DELETE FROM messages WHERE at<=? AND id NOT IN (SELECT message FROM tasks WHERE message IS NOT NULL)').run(expired);
      this.db.prepare('DELETE FROM session_history WHERE at<=?').run(expired);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** 消息去重；首次见到该消息 id 返回 true，重复事件返回 false。 */
  claim(id: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?)').run(id, Date.now()).changes === 1;
  }
  /** 插入 running 或 queued 任务行；运行入口经 accept 的事务调用。 */
  task(id: string, session: string, message: string, status: typeof TaskState.Running | typeof TaskState.Queued = TaskState.Running) {
    this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?)').run(id, session, message, status, Date.now());
  }
  /** 去重与任务创建同事务；失败整体回滚，允许同一消息稍后重试。 */
  accept(id: string, session: string, message: string, status: typeof TaskState.Running | typeof TaskState.Queued = TaskState.Running): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed = this.claim(message);
      if (claimed) this.task(id, session, message, status);
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** 队列启动不重新 claim 消息；只允许 queued → running。 */
  startQueued(id: string) {
    if (this.db.prepare('UPDATE tasks SET status=?,at=? WHERE id=? AND status=?')
      .run(TaskState.Running, Date.now(), id, TaskState.Queued).changes !== 1) throw new Error('Queued task is unavailable');
  }
  /** 终态与最终文本同事务落盘：先持久化再投递，网络失败后 /result 可取回，不重复运行 Claude。 */
  complete(id: string, status: TaskTerminalState, text: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.finish(id, status);
      this.db.prepare('INSERT OR REPLACE INTO results(task,text,delivery,attempts) VALUES (?,?,?,0)').run(id, text, DeliveryState.Pending);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** 记录投递结果并累加 attempts（含 /result 重取，不是内部 HTTP 重试次数）。 */
  delivered(id: string, success: boolean) {
    this.db.prepare('UPDATE results SET delivery=CASE WHEN delivery=? THEN delivery ELSE ? END, attempts=attempts+1 WHERE task=?')
      .run(DeliveryState.Sent, success ? DeliveryState.Sent : DeliveryState.Failed, id);
  }
  /** 按结果写入顺序取最近结果；排队任务可能先取消，不能按任务接纳顺序排序。 */
  latestResult(session: string, delivery?: DeliveryState): ResultRow | undefined {
    return this.db.prepare(`SELECT r.task,r.text,r.delivery FROM results r JOIN tasks t ON t.id=r.task
      WHERE t.session=? AND (? IS NULL OR r.delivery=?) ORDER BY r.rowid DESC LIMIT 1`)
      .get(session, delivery ?? null, delivery ?? null) as ResultRow | undefined;
  }
  resultForTask(session: string, id: string): ResultRow | undefined {
    return this.db.prepare(`SELECT r.task,r.text,r.delivery FROM results r JOIN tasks t ON t.id=r.task
      WHERE t.session=? AND r.task=?`).get(session, id) as ResultRow | undefined;
  }
  finish(id: string, status: TaskTerminalState) {
    this.db.prepare('UPDATE tasks SET status=?,at=? WHERE id=?').run(status, Date.now(), id);
  }
  taskStatus(id: string): TaskState | undefined {
    return (this.db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as { status: TaskState } | undefined)?.status;
  }
  /** 仅恢复未过闲置期的会话；读取本身不延长有效期。 */
  session(id: string, idleMs: number = TaskLimits.SessionIdleTimeoutMs): string | undefined {
    const row = this.db.prepare('SELECT acp,last_used_at FROM sessions WHERE id=?').get(id) as { acp: string; last_used_at: number | null } | undefined;
    if (!row) return;
    if (row.last_used_at === null || Date.now() - row.last_used_at >= idleMs) { this.forget(id); return; }
    return row.acp;
  }
  /** 保存或更新会话映射。 */
  saveSession(id: string, acp: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      this.db.prepare('INSERT OR REPLACE INTO sessions(id,acp,last_used_at) VALUES (?,?,?)').run(id, acp, now);
      this.db.prepare('INSERT OR REPLACE INTO session_history(owner,acp,at) VALUES (?,?,?)').run(id, acp, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** 运行时收尾后开始计算闲置期；状态查询/回执不刷新。 */
  touchSession(id: string, acp: string) {
    this.db.prepare('UPDATE sessions SET last_used_at=? WHERE id=? AND acp=?').run(Date.now(), id, acp);
    this.db.prepare('UPDATE session_history SET at=? WHERE owner=? AND acp=?').run(Date.now(), id, acp);
  }
  /** 只列出 Bridge 能证明归属的历史，不能直接列共享 Claude 目录。 */
  sessionHistory(owner: string): { acp: string; at: number }[] {
    return this.db.prepare('SELECT acp,at FROM session_history WHERE owner=? ORDER BY at DESC,rowid DESC LIMIT 20').all(owner) as { acp: string; at: number }[];
  }
  resumeSession(owner: string, acp: string): boolean {
    if (!this.db.prepare('SELECT 1 FROM session_history WHERE owner=? AND acp=?').get(owner, acp)) return false;
    this.saveSession(owner, acp); return true;
  }
  preferences(owner: string): Preferences {
    const row = this.db.prepare('SELECT value FROM session_preferences WHERE owner=?').get(owner);
    return row ? JSON.parse(row.value as string) as Preferences : {};
  }
  setPreference(owner: string, name: keyof Preferences, value: string | undefined) {
    if (!['model', 'effort', 'mode'].includes(name) || (value !== undefined && (value.length > 160 || !value.length))
      || (name === 'mode' && value !== undefined && !['plan', 'bypassPermissions'].includes(value))) throw new Error('Invalid preference');
    const preferences = this.preferences(owner);
    if (value === undefined) delete preferences[name];
    else Object.assign(preferences, { [name]: value });
    this.db.prepare('INSERT OR REPLACE INTO session_preferences VALUES (?,?)').run(owner, JSON.stringify(preferences));
  }
  expireSessions(idleMs: number) {
    this.db.prepare('DELETE FROM sessions WHERE last_used_at IS NULL OR last_used_at<=?').run(Date.now() - idleMs);
  }
  /** 删除会话映射（/new）；不删除任务结果与 Adapter 侧历史。 */
  forget(id: string) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); }
  close() { this.db.close(); }
}
