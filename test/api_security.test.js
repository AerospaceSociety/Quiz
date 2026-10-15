import assert from 'node:assert/strict';
import { allowedOrigin, HttpError, jsonDepthWithin, readLimitedBody } from '../functions/_lib/firebase-admin.js';

const origin = 'https://quiz.pages.dev';
assert.equal(allowedOrigin(new Request('https://quiz.pages.dev/api/candidate', { headers: { Origin: origin } }), { ALLOWED_ORIGINS: origin }), origin);
assert.equal(allowedOrigin(new Request('https://quiz-ewy.pages.dev/api/candidate', { headers: { Origin: 'https://quiz-ewy.pages.dev' } }), { ALLOWED_ORIGINS: origin }), 'https://quiz-ewy.pages.dev');
assert.equal(allowedOrigin(new Request('https://quiz-ewy.pages.dev/api/candidate', { headers: { Origin: 'https://evil.example' } }), { ALLOWED_ORIGINS: origin }), false);

const request = new Request('https://quiz.pages.dev/api/candidate', { method: 'POST', body: '{"action":"time"}' });
assert.equal(await readLimitedBody(request, 100), '{"action":"time"}');
assert.equal(jsonDepthWithin('{"x":"[[[not nesting]]]","a":[1,{"b":2}]}'), true);
assert.equal(jsonDepthWithin('['.repeat(65) + '0' + ']'.repeat(65)), false);

const oversized = new Request('https://quiz.pages.dev/api/candidate', { method: 'POST', body: 'x'.repeat(20) });
await assert.rejects(readLimitedBody(oversized, 10), (error) => error instanceof HttpError && error.status === 413);

console.log('API origin allowlist and streaming body limit checks passed.');
