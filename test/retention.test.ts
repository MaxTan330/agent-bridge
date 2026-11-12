import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { TaskState } from '../src/task.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const day = 24 * 60 * 60 * 1000;

test('startup retention removes expired dedup, task, result and history rows and keeps recent ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-retention-'));
  const path = join(dir, 'bridge.db');
  try {
    let db = new Store(path);
    const expired = Date.now() - 31 * day;
    db.accept('recent-task', 'session', 'recent-message');
    db.complete('recent-task', TaskState.Completed, 'recent result');
    db.saveSession('session', 'acp-recent');
    db.db.prepare('INSERT INTO messages VALUES (?,?)').run('old-message', expired);
    db.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?)').run('old-task', 'old-session', 'old-message', TaskState.Completed, expired);
    db.db.prepare('INSERT INTO results(task,text,delivery) VALUES (?,?,?)').run('old-task', 'old result', 'pending');
    db.db.prepare('INSERT INTO session_history(owner,acp,at) VALUES (?,?,?)').run('old-session', 'acp-old', expired);
    db.close();

    db = new Store(path, 30 * day);
    try {
      assert.equal(db.claim('old-message'), true, 'expired dedup row should be claimable again');
      assert.equal(db.claim('recent-message'), false, 'recent dedup row should remain');
      assert.equal(db.taskStatus('old-task'), undefined);
      assert.equal(db.taskStatus('recent-task'), TaskState.Completed);
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task=?').get('old-task')!.n, 0);
      assert.equal(db.latestResult('session')?.text, 'recent result');
      assert.equal(db.latestResult('old-session'), undefined);
      assert.deepEqual(db.sessionHistory('old-session'), []);
      assert.ok(db.sessionHistory('session').some(entry => entry.acp === 'acp-recent'));
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restart interrupt marking happens before retention so old waiting work stays retrievable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-retention-'));
  const path = join(dir, 'bridge.db');
  try {
    let db = new Store(path);
    db.accept('queued', 'session', 'message', TaskState.Queued);
    const expired = Date.now() - 40 * day;
    db.db.prepare('UPDATE tasks SET at=? WHERE id=?').run(expired, 'queued');
    db.db.prepare('UPDATE messages SET at=? WHERE id=?').run(expired, 'message');
    db.close();

    db = new Store(path, 30 * day);
    try {
      assert.equal(db.taskStatus('queued'), TaskState.Interrupted);
      assert.match(db.latestResult('session')!.text, /中断/);
      assert.equal(db.accept('replay', 'session', 'message'), false);
      assert.equal(db.taskStatus('replay'), undefined);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retention also removes result rows whose task row is already gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-retention-'));
  const path = join(dir, 'bridge.db');
  try {
    let db = new Store(path);
    db.db.prepare('INSERT INTO results(task,text,delivery) VALUES (?,?,?)').run('orphan', 'orphan result', 'pending');
    db.close();

    db = new Store(path, 30 * day);
    try {
      assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM results WHERE task=?').get('orphan')!.n, 0);
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
