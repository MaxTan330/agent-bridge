/** SQLite 持久化：消息去重、任务/结果事务、会话映射与重启恢复。
 *  node:sqlite 是同步 API——Bridge 从鉴权到设置 active 之间无 await，
 *  单任务互斥正是建立在这个前提上，改成异步驱动库前必须重新设计加锁。 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DeliveryState, TaskState, type TaskTerminalState } from './task.ts';

/** /result 取回的结果行。 */
type ResultRow = { task: string; text: string; delivery: DeliveryState };

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, acp TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session TEXT, message TEXT, status TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS results (task TEXT PRIMARY KEY, text TEXT NOT NULL, delivery TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);`);
    // 进程已丢失，历史会话无法证明工具执行到哪一步；重启只标记中断，不重放任务。
    this.db.prepare('UPDATE tasks SET status=? WHERE status=?').run(TaskState.Interrupted, TaskState.Running);
  }
  /** 消息去重；首次见到该消息 id 返回 true，重复事件返回 false。 */
  claim(id: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?)').run(id, Date.now()).changes === 1;
  }
  /** 插入 running 任务行；仅经 accept 的事务调用。 */
  task(id: string, session: string, message: string) {
    this.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?)').run(id, session, message, TaskState.Running, Date.now());
  }
  /** 去重与任务创建同事务；失败整体回滚，允许同一消息稍后重试。 */
  accept(id: string, session: string, message: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed = this.claim(message);
      if (claimed) this.task(id, session, message);
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
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
    this.db.prepare('UPDATE results SET delivery=?,attempts=attempts+1 WHERE task=?').run(success ? DeliveryState.Sent : DeliveryState.Failed, id);
  }
  /** 按会话键取最近一次已保存结果；任务运行中取到的是上一轮的结果。 */
  latestResult(session: string): ResultRow | undefined {
    return this.db.prepare('SELECT r.task,r.text,r.delivery FROM results r JOIN tasks t ON t.id=r.task WHERE t.session=? ORDER BY t.rowid DESC LIMIT 1').get(session) as ResultRow | undefined;
  }
  finish(id: string, status: TaskTerminalState) {
    this.db.prepare('UPDATE tasks SET status=?,at=? WHERE id=?').run(status, Date.now(), id);
  }
  taskStatus(id: string): TaskState | undefined {
    return (this.db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as { status: TaskState } | undefined)?.status;
  }
  /** 读取会话键对应的 ACP 会话 ID。 */
  session(id: string): string | undefined {
    return this.db.prepare('SELECT acp FROM sessions WHERE id=?').get(id)?.acp as string | undefined;
  }
  /** 保存或更新会话映射。 */
  saveSession(id: string, acp: string) {
    this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?)').run(id, acp);
  }
  /** 删除会话映射（/new）；不删除任务结果与 Adapter 侧历史。 */
  forget(id: string) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(id); }
  close() { this.db.close(); }
}
