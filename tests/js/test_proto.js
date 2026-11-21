// Round-trip tests for web/engine/proto.js. Run: node --test tests/js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadWeb } = require('./_load.js');

const BLK = loadWeb(['web/engine/proto.js']);
const { Writer, Reader, encodeString, decodeString } = BLK.proto;

test('varint round-trip incl. >2^32 and 64-bit extremes', () => {
  const cases = [
    0, 1, 127, 128, 300, 0xffff, 2 ** 32, 2 ** 40, 2 ** 49 - 1, 2 ** 49,
    2 ** 53 - 1, 2n ** 53n, 2n ** 60n, 2n ** 63n - 1n, 2n ** 64n - 1n,
  ];
  for (const v of cases) {
    const w = new Writer();
    w.varintField(1, v);
    const r = new Reader(w.finish());
    assert.strictEqual(r.tag().join(","), "1,0");
    assert.strictEqual(BigInt(r.varint()), BigInt(v));
    assert.ok(r.eof());
  }
});

test('negative int64 round-trip via varintField/int64', () => {
  for (const v of [-1, -5, -300, -(2 ** 32), -(2 ** 53), -(2n ** 63n)]) {
    const w = new Writer();
    w.varintField(2, BigInt(v));
    const r = new Reader(w.finish());
    assert.strictEqual(r.tag().join(","), "2,0");
    assert.strictEqual(BigInt(r.int64()), BigInt(v));
  }
});

test('int64 stays signed for small positives', () => {
  const w = new Writer();
  w.varintField(1, 42);
  const r = new Reader(w.finish());
  r.tag();
  assert.strictEqual(r.int64(), 42);
});

test('string and bytes fields round-trip (incl. non-ascii)', () => {
  const w = new Writer();
  w.stringField(3, 'block_rq_鎻掑叆 h茅llo');
  w.bytesField(4, Uint8Array.from([0, 1, 2, 255, 0, 7]));
  const r = new Reader(w.finish());
  assert.strictEqual(r.tag().join(","), "3,2");
  const sb = r.bytes();
  assert.strictEqual(decodeString(sb, 0, sb.length), 'block_rq_鎻掑叆 h茅llo');
  assert.strictEqual(r.tag().join(","), "4,2");
  assert.deepStrictEqual(Array.from(r.bytes()), [0, 1, 2, 255, 0, 7]);
  assert.ok(r.eof());
});

test('nested message field', () => {
  const inner = new Writer();
  inner.varintField(2, 1); // like ingest_ftrace_in_raw_table
  inner.stringField(9, 'x');
  const outer = new Writer();
  outer.varintField(1, 7); // seq
  outer.varintField(2, 11); // method
  outer.messageField(107, inner);
  const r = new Reader(outer.finish());
  assert.strictEqual(r.tag().join(","), "1,0");
  assert.strictEqual(r.varint(), 7);
  assert.strictEqual(r.tag().join(","), "2,0");
  assert.strictEqual(r.varint(), 11);
  assert.strictEqual(r.tag().join(","), "107,2");
  const body = r.bytes();
  const ir = new Reader(body);
  assert.strictEqual(ir.tag().join(","), "2,0");
  assert.strictEqual(ir.varint(), 1);
  assert.strictEqual(ir.tag().join(","), "9,2");
  const xb = ir.bytes();
  assert.strictEqual(decodeString(xb, 0, xb.length), 'x');
});

test('double read/write little-endian', () => {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, 53200431234567.5, true);
  const r = new Reader(buf);
  assert.strictEqual(r.double(), 53200431234567.5);
});

test('skip works for all wire types', () => {
  const w = new Writer();
  w.varintField(1, 9); // wire 0
  const f64 = new Writer();
  f64.tag(2, 1);
  const d = new Uint8Array(8);
  new DataView(d.buffer).setFloat64(0, 1.5, true);
  f64._push(d);
  w._push(f64.finish());
  w.bytesField(3, Uint8Array.from([1, 2, 3])); // wire 2
  w.tag(4, 5);
  w._push(Uint8Array.from([9, 9, 9, 9])); // wire 5
  w.varintField(5, 77); // trailing field we actually read
  const r = new Reader(w.finish());
  for (let k = 0; k < 4; k++) {
    const [, wire] = r.tag();
    r.skip(wire);
  }
  assert.strictEqual(r.tag().join(","), "5,0");
  assert.strictEqual(r.varint(), 77);
  assert.ok(r.eof());
});

test('decodeString tolerates invalid utf-8', () => {
  const s = decodeString(Uint8Array.from([0xff, 0xfe, 0x61]), 0, 3);
  assert.strictEqual(typeof s, 'string');
  assert.ok(s.endsWith('a'));
});


