import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitWaitMs, isRateLimitError, Throttle } from '../dist/index.js';

test('Throttle.onRateLimit slows the pace and caps at 120s', () => {
  const t = new Throttle(1200);
  assert.equal(t.intervalMs, 1200);
  t.onRateLimit();
  assert.equal(t.intervalMs, 3200);
  t.onRateLimit();
  assert.equal(t.intervalMs, 5200);
  for (let i = 0; i < 200; i++) t.onRateLimit();
  assert.equal(t.intervalMs, 120_000);
});

test('rateLimitWaitMs honors a positive Retry-After header', () => {
  assert.equal(rateLimitWaitMs('60', 1), 60_000);
  assert.equal(rateLimitWaitMs('5', 3), 5_000);
});

test('rateLimitWaitMs backs off when Retry-After is missing or invalid', () => {
  assert.equal(rateLimitWaitMs(null, 1), (30 + 15) * 1000);
  assert.equal(rateLimitWaitMs('', 2), (30 + 30) * 1000);
  assert.equal(rateLimitWaitMs('nope', 3), (30 + 45) * 1000);
  assert.equal(rateLimitWaitMs('0', 1), (30 + 15) * 1000);
});

test('isRateLimitError only matches tagged 429 errors', () => {
  const tagged = Object.assign(new Error('429'), { rateLimited: true });
  assert.equal(isRateLimitError(tagged), true);
  assert.equal(isRateLimitError(new Error('other')), false);
  assert.equal(isRateLimitError(null), false);
  assert.equal(isRateLimitError(undefined), false);
});
