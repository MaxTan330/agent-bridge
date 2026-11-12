import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorFacts } from '../src/diagnostics.ts';
import { DeliveryError } from '../src/delivery-error.ts';
test('diagnostics preserve safe classification without message or credentials', () => {
  const e = Object.assign(new Error('secret prompt'), { code: 'ECONNRESET', config: { headers: { Authorization: 'secret' } } });
  assert.equal(errorFacts(e).errorCode, 'ECONNRESET');
  assert.doesNotMatch(JSON.stringify(errorFacts(e)), /secret|prompt|headers|Authorization/);
});
test('diagnostics retain sanitized delivery category and numeric API code', () => {
  const facts = errorFacts(new DeliveryError('api', true, 230020));
  assert.equal(facts.deliveryCategory, 'api');
  assert.equal(facts.apiCode, 230020);
  assert.equal(facts.retryable, true);
  assert.doesNotMatch(JSON.stringify(errorFacts(new DeliveryError('secret prompt', false))), /secret|prompt/);
});
