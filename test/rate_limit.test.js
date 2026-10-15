import assert from 'node:assert/strict';
import { enforceActionRateLimit, enforceIpRateLimit, enforceUserRateLimit } from '../functions/_lib/rate-limit.js';
import { HttpError } from '../functions/_lib/firebase-admin.js';

for (let request = 0; request < 12; request++) enforceUserRateLimit('uid-minute-limit-test');
assert.throws(() => enforceUserRateLimit('uid-minute-limit-test'), (error) => error instanceof HttpError && error.status === 429);

for (let request = 0; request < 5; request++) {
  enforceUserRateLimit('uid-action-limit-test');
  enforceActionRateLimit('uid-action-limit-test', 'claim');
}
enforceUserRateLimit('uid-action-limit-test');
assert.throws(() => enforceActionRateLimit('uid-action-limit-test', 'claim'), (error) => error instanceof HttpError && error.status === 429);

for (let request = 0; request < 300; request++) enforceIpRateLimit('203.0.113.10');
assert.throws(() => enforceIpRateLimit('203.0.113.10'), (error) => error instanceof HttpError && error.status === 429);

console.log('User, action, and Cloudflare client-IP rate limits passed.');
