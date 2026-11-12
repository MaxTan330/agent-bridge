import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { workspacePath } from '../src/workspace.ts';

test('message claims are durable and recovery interrupts work', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'test.db');
  let db = new Store(path);
  assert.equal(db.claim('a'), true);
  assert.equal(db.claim('a'), false);
  db.task('t', 's', 'a');
  db.close();
  db = new Store(path);
  assert.equal(db.claim('a'), false);
  assert.equal(db.taskStatus('t'), 'interrupted');
  db.close();
});

test('workspace is an existing directory inside registered root', () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-'));
  mkdirSync(join(root, 'project'));
  assert.equal(workspacePath(root, 'project'), join(root, 'project'));
  assert.throws(() => workspacePath(root, '..'), /outside/);
});

test('final results survive restart and are isolated by session key', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'bridge-results-')), 'test.db');
  let db = new Store(file);
  assert.equal(db.accept('t', 'owner-session', 'message'), true);
  db.complete('t', 'completed', 'final answer'); db.delivered('t', false); db.close();
  db = new Store(file);
  assert.deepEqual({ ...db.latestResult('owner-session') }, { task: 't', text: 'final answer', delivery: 'failed' });
  assert.equal(db.latestResult('other-session'), undefined); db.close();
});
