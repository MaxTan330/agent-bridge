import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interactions } from '../src/interactions.ts';

const question = { sessionId: 's', message: 'Choose', requestedSchema: { type: 'object' as const,
  properties: { choice: { type: 'string', oneOf: [{ const: 'A', title: 'A' }, { const: 'B', title: 'B' }] } }, required: ['choice'] } };

test('question answers bypass work scheduling, are owner-scoped and consumed once', async () => {
  const pending = new Interactions(); let text = '';
  const answer = pending.ask('owner', question, undefined, async t => { text = t; return true; });
  const id = /\/answer ([\w-]+)/.exec(text)![1];
  assert.match(pending.answer('other', id, 'A'), /不存在|无权/);
  assert.match(pending.answer('owner', id, 'wrong'), /无效/);
  assert.match(pending.answer('owner', id, 'A'), /已提交/);
  assert.deepEqual(await answer, { action: 'accept', content: { choice: 'A' } });
  assert.match(pending.answer('owner', id, 'B'), /不存在|过期/);
});

test('question cancellation and failed delivery release waiting runtime', async () => {
  const pending = new Interactions(); const controller = new AbortController();
  const answer = pending.ask('owner', question, controller.signal, async () => true);
  controller.abort(); assert.deepEqual(await answer, { action: 'cancel' });
  assert.deepEqual(await pending.ask('owner', question, undefined, async () => false), { action: 'cancel' });
  assert.equal(pending.count('owner'), 0);
});

test('JSON answers enforce required fields, types and enum values without consuming invalid answers', async () => {
  const pending = new Interactions(); let id = '';
  const answer = pending.ask('owner', { ...question, requestedSchema: { type: 'object', properties: {
    count: { type: 'integer', minimum: 1 }, selected: { type: 'array', items: { enum: ['a', 'b'] }, minItems: 1 },
  }, required: ['count', 'selected'] } }, undefined, async text => { id = /\/answer ([\w-]+)/.exec(text)![1]; return true; });
  for (const value of ['{}', '{"count":0,"selected":["a"]}', '{"count":1,"selected":["x"]}', '{"count":1,"selected":["a"],"extra":true}']) {
    assert.match(pending.answer('owner', id, value), /无效/);
  }
  assert.match(pending.answer('owner', id, '{"count":2,"selected":["a"]}'), /已提交/);
  assert.deepEqual(await answer, { action: 'accept', content: { count: 2, selected: ['a'] } });
});

test('multi-question forms show full questions and option descriptions, not only short headers', async () => {
  const pending = new Interactions(); let rendered = '';
  const answer = pending.ask('owner', { ...question, message: 'Please answer the following questions.', requestedSchema: { type: 'object', properties: {
    question_0: { type: 'string', title: '数据库', description: '生产环境应该使用哪种数据库？', oneOf: [{ const: 'SQLite', title: 'SQLite', description: '单实例本地存储' }] },
    question_1: { type: 'string', title: '环境', description: '先部署到测试环境还是生产环境？' },
  } } }, undefined, async text => { rendered = text; return true; });
  assert.match(rendered, /生产环境应该使用哪种数据库/); assert.match(rendered, /单实例本地存储/);
  assert.match(rendered, /先部署到测试环境还是生产环境/);
  pending.cancel('owner'); await answer;
});

test('expired questions release callbacks and late replies are rejected', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = new Interactions(); let id = '';
  const answer = pending.ask('owner', question, undefined, async text => { id = /\/answer ([\w-]+)/.exec(text)![1]; return true; });
  t.mock.timers.tick(600000);
  assert.deepEqual(await answer, { action: 'cancel' });
  assert.match(pending.answer('owner', id, 'A'), /过期/);
});
