// Node unit tests for web/model/frame.js. The merge_asof expectations
// were derived by running the same inputs through pandas 3.0.6
// pd.merge_asof (see test comments).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadWeb } = require('./_load.js');

const BLK = loadWeb(['web/model/frame.js']);
const frame = BLK.frame;

test('argsort: stable, ascending, nulls last', () => {
  // [30, 10, 10, null, 20] -> indices 1,2 (10 keeps index order), 4, 0, 3
  const idx = frame.argsort([[30, 10, 10, null, 20]], 5);
  assert.deepStrictEqual(Array.from(idx), [1, 2, 4, 0, 3]);
  // multi-key
  const idx2 = frame.argsort([
    [2, 1, 2, 1],
    [9, 9, 8, 7],
  ], 4);
  assert.deepStrictEqual(Array.from(idx2), [3, 1, 2, 0]);
  // NaN treated like null (last)
  const idx3 = frame.argsort([[NaN, 5, 1]], 3);
  assert.deepStrictEqual(Array.from(idx3), [2, 1, 0]);
});

test('groupBy: sorted keys, null keys dropped', () => {
  const groups = frame.groupBy([[2, 1, null, 2, 1, NaN]], 6);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].key, 1);
  assert.strictEqual(groups[0].idxs.join(), '1,4');
  assert.strictEqual(groups[1].key, 2);
  assert.strictEqual(groups[1].idxs.join(), '0,3');
});

// pandas verified (pandas 3.0.6):
//   merge_asof(left on=[10], right on=[5,5], backward) -> LAST dup (v='b')
//   merge_asof(left on=[10], right on=[12,12,20], forward) -> FIRST ('a')
//   merge_asof nearest on equal distance picks the BELOW side
//   merge_asof nearest within equal on-values: below -> last, above->first
test('mergeAsof backward: latest <=, last of equal block', () => {
  const out = frame.mergeAsof({
    leftOn: [10], rightOn: [5, 5, 8], direction: 'backward' });
  assert.strictEqual(out[0], 2);           // 8 is the max <= 10
  const out2 = frame.mergeAsof({
    leftOn: [10], rightOn: [5, 5], direction: 'backward' });
  assert.strictEqual(out2[0], 1);          // last of equal keys
  const out3 = frame.mergeAsof({
    leftOn: [4], rightOn: [5, 5], direction: 'backward' });
  assert.strictEqual(out3[0], -1);         // none <= 4
});

test('mergeAsof forward: earliest >=, first of equal block', () => {
  const out = frame.mergeAsof({
    leftOn: [10], rightOn: [12, 12, 20], direction: 'forward' });
  assert.strictEqual(out[0], 0);           // pandas: first of the 12s
  const out2 = frame.mergeAsof({
    leftOn: [25], rightOn: [12, 20], direction: 'forward' });
  assert.strictEqual(out2[0], -1);
});

test('mergeAsof nearest: smaller diff, tie -> backward', () => {
  // equal distance: below wins (pandas 3.0.6 observed)
  let out = frame.mergeAsof({
    leftOn: [10], rightOn: [8, 12], direction: 'nearest' });
  assert.strictEqual(out[0], 0);
  // strictly nearer above
  out = frame.mergeAsof({
    leftOn: [10], rightOn: [3, 11], direction: 'nearest' });
  assert.strictEqual(out[0], 1);
  // equal on-values below: last index wins (backward side)
  out = frame.mergeAsof({
    leftOn: [10], rightOn: [3, 8, 8], direction: 'nearest' });
  assert.strictEqual(out[0], 2);
  // equal on-values above: first index wins (forward side)
  out = frame.mergeAsof({
    leftOn: [10], rightOn: [12, 12, 20], direction: 'nearest' });
  assert.strictEqual(out[0], 0);
  // exact match
  out = frame.mergeAsof({
    leftOn: [10], rightOn: [5, 10, 15], direction: 'nearest' });
  assert.strictEqual(out[0], 1);
});

test('mergeAsof tolerance inclusive, allowExactMatches', () => {
  // |10-8| = 2 <= tol 2: match
  let out = frame.mergeAsof({
    leftOn: [10], rightOn: [8, 14], direction: 'backward',
    tolerance: 2 });
  assert.strictEqual(out[0], 0);
  out = frame.mergeAsof({
    leftOn: [10], rightOn: [7], direction: 'backward', tolerance: 2 });
  assert.strictEqual(out[0], -1);          // diff 3 > tol
  out = frame.mergeAsof({
    leftOn: [10], rightOn: [12], direction: 'forward', tolerance: 2 });
  assert.strictEqual(out[0], 0);
  out = frame.mergeAsof({
    leftOn: [10], rightOn: [8, 10], direction: 'backward',
    allowExactMatches: false });
  assert.strictEqual(out[0], 0);           // skips exact 10 -> 8
  out = frame.mergeAsof({
    leftOn: [10], rightOn: [10, 12], direction: 'forward',
    allowExactMatches: false });
  assert.strictEqual(out[0], 1);           // skips exact 10 -> 12
});

test('mergeAsof null on never matches; NaN by-key matches NaN', () => {
  const out = frame.mergeAsof({
    leftOn: [null, 10], rightOn: [5], direction: 'backward' });
  assert.strictEqual(out[0], -1);
  assert.strictEqual(out[1], 0);
  // pandas 3.x: NaN by-keys merge with each other
  const nullKey = frame.byKey([null]);
  const out2 = frame.mergeAsof({
    leftOn: [10], rightOn: [5], leftBy: [nullKey], rightBy: [nullKey],
    direction: 'backward' });
  assert.strictEqual(out2[0], 0);
  // different by keys don't match
  const out3 = frame.mergeAsof({
    leftOn: [10], rightOn: [5], leftBy: ['#1'], rightBy: ['#2'],
    direction: 'backward' });
  assert.strictEqual(out3[0], -1);
});

test('Heap: min-heap with tuple comparator', () => {
  const h = new frame.Heap((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  h.push([5, 2]); h.push([5, 1]); h.push([3, 9]); h.push([7, 0]);
  const popped = [h.pop(), h.pop(), h.pop(), h.pop()];
  assert.deepStrictEqual(popped, [[3, 9], [5, 1], [5, 2], [7, 0]]);
});
