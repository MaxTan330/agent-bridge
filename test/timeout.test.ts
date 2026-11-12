import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bounded } from '../src/timeout.ts';
test('unresponsive transport is bounded', async () => {
  await assert.rejects(bounded(new Promise(() => {}), 10), /timed out/);
  assert.equal(await bounded(Promise.resolve('ok'), 1000), 'ok');
});
