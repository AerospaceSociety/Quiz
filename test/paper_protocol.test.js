import assert from 'node:assert/strict';
import { S } from '../scripts/session.js';
import { installPaper, responseItems } from '../scripts/engine.js';

const paper = [{
  id: 'Q1',
  n: 1,
  catId: 0,
  scheme: 'standard',
  question: 'Pick one',
  options: ['Second original option', 'First original option']
}];

installPaper(paper);
assert.equal(Object.hasOwn(S.paper[0], 'order'), false);
S.answers[0].sel = [1];
assert.deepEqual(responseItems()[0], {
  n: 1,
  id: 'Q1',
  catId: 0,
  scheme: 'standard',
  displayed: ['B'],
  selected: [1],
  text: ['First original option'],
  marked: false,
  visits: 0,
  seconds: 0
});

console.log('Order-free paper client protocol checks passed.');
