// P4b/P4c unit tests: device encode/decode beyond 2^31, exact
// (s_dev, ino) file keys, pyFixed round-half-even, code-point string
// ordering, dstate caller formatting (integer rendering), buildQuality
// message bytes. Expected values verified against model.py in .venv.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadWeb } = require('./_load.js');

const BLK = loadWeb([
  'web/model/frame.js',
  'web/model/req.js',
  'web/model/files.js',
  'web/model/dstate.js',
  'web/model/model.js',
  'web/model/payload.js',
]);
const frame = BLK.frame;
const model = BLK.model;

function table(cols, rows) {
  const data = {};
  cols.forEach((c, i) => { data[c] = rows.map(r => r[i]); });
  return { columns: cols.slice(), data: data };
}

// ------------------------------------------------------- dev encode

test('newEncodeDev/newDecodeDev beyond 2^31 (Python-verified)', () => {
  // expected from blkscope.model.new_encode_dev / new_decode_dev
  const enc = [
    [259, 0, 66304], [8, 32, 2080], [16777216, 5, 4294967301],
    [16777216, 0, 4294967296], [4095, 524287, 2147483647],
    [1, 300, 1048876],
  ];
  for (const [mj, mi, e] of enc) {
    assert.strictEqual(model.newEncodeDev(mj, mi), e,
      `encode(${mj},${mi})`);
  }
  // minor 524288 -> the <<12 term alone exceeds 2^31 (JS '<<' breaks)
  assert.strictEqual(model.newEncodeDev(0, 524288), 2147483648);
  const dec = [
    [2080, '8:32'], [4294967296, '0:1048576'],
    [4294967301, '0:1048581'], [64424509440, '0:15728640'],
    [66304, '259:0'], [1048876, '1:300'],
  ];
  for (const [d, s] of dec) {
    assert.strictEqual(model.newDecodeDev(d), s, `decode(${d})`);
  }
  assert.strictEqual(model.devMajor(2080), 8);
  assert.strictEqual(model.devMajor(4294967296), 0);
  assert.strictEqual(model.devKind(1792), 'loop');   // major 7
  assert.strictEqual(model.devKind(2080), 'disk');
  assert.strictEqual(model.devKind(4294967296), 'other');
});

// ------------------------------------------------------ pyFixed

test('pyFixed: Python round-half-even', () => {
  const f = frame.pyFixed;
  assert.strictEqual(f(0.125, 2), '0.12');
  assert.strictEqual(f(0.375, 2), '0.38');
  assert.strictEqual(f(2.5, 0), '2');
  assert.strictEqual(f(3.5, 0), '4');
  assert.strictEqual(f(1.005, 2), '1.00');   // 1.005 is 1.00499... bin
  assert.strictEqual(f(0.045, 1), '0.0');
  assert.strictEqual(f(-0.125, 2), '-0.12');
  assert.strictEqual(f(0, 2), '0.00');
  assert.strictEqual(f(1.5e-7, 4), '0.0000');
  // doubles just above/below the decimal tie round normally
  assert.strictEqual(f(123456.785, 2), '123456.79');
  assert.strictEqual(f(2.675, 2), '2.67');
});

// --------------------------------------------------- cmpStr (code point)

test('cmpStr orders by code point, not UTF-16 unit', () => {
  // U+1F600 (😀) > U+FFFF — JS '<' gets this wrong (surrogates)
  assert.ok(frame.cmpStr('😀', '￿') > 0);
  assert.strictEqual(frame.cmpStr('aa.so', 'bb.so') < 0, true);
  assert.strictEqual(frame.cmpStr('x', 'x'), 0);
  assert.ok(frame.cmpStr('ab', 'abc') < 0);
});

// ------------------------------------------------ composite file keys

test('buildFiles uses composite keys beyond 2^53 fkey space', () => {
  const sdev = 4294967301;             // 2**32 + 5
  const { files, key2id } = model.buildFiles(
    table(['ts', 'utid', 'major_dev', 'minor_dev', 'ino', 'offset',
      'bytes', 'filebuf'],
      [[400, 5, 16777216, 5, 99, 0, 4096, 'big.so']]),
    table(['ts', 'utid', 's_dev', 'i_ino', 'index'],
      [[600, 5, sdev, 1099511627776 + 7, 0]]));   // ino > 2**40
  assert.strictEqual(files.data.s_dev.length, 2);
  // Python fkey = s_dev*2^40 + ino would be ~4.7e21 — composite keys
  // keep both entries distinct
  const id99 = key2id.get(sdev + '' + 99);
  const idBig = key2id.get(sdev + '' + (1099511627776 + 7));
  assert.notStrictEqual(id99, idBig);
  assert.strictEqual(files.data.name[id99], 'big.so');
});

test('buildFiles: FS元数据 naming + filebuf mode code-point tie', () => {
  const { files } = model.buildFiles(
    table(['ts', 'utid', 'major_dev', 'minor_dev', 'ino', 'offset',
      'bytes', 'filebuf'],
      [[1, 5, 8, 32, 150, 0, 4096, 'bb.so'],
       [2, 5, 8, 32, 150, 0, 4096, 'aa.so'],   // tie -> aa.so
       [3, 5, 8, 32, 150, 0, 4096, null]]),
    table(['ts', 'utid', 's_dev', 'i_ino', 'index'],
      [[10, 5, 2080, 1, 0], [11, 5, 2080, 2, 0],
       [12, 5, 2080, 77, 0]]));
  const n = files.data.name;
  const i = files.data.ino;
  const m = files.data.is_meta;
  const idxOf = ino => i.indexOf(ino);
  assert.strictEqual(n[idxOf(150)], 'aa.so');
  assert.strictEqual(n[idxOf(1)], 'FS元数据');
  assert.strictEqual(m[idxOf(1)], 1);
  assert.strictEqual(m[idxOf(2)], 1);
  assert.strictEqual(n[idxOf(77)], 'ino:77');
  assert.strictEqual(m[idxOf(77)], 0);
});

test('buildBatches splits adjacent inos (P4c exact pair compare)',
  () => {
    // Same utid, same s_dev, consecutive adds ino 1 then 2 within the
    // 5 ms gap: the old combined-key float compare merged them; exact
    // (s_dev, i_ino) comparison must produce two batches.
    const pcEmpty = table(['ts', 'utid', 'major_dev', 'minor_dev', 'ino',
      'offset', 'bytes', 'filebuf'], []);
    const fa = table(['ts', 'utid', 's_dev', 'i_ino', 'index'],
      [[100, 5, 65155, 1, 0], [101, 5, 65155, 2, 1]]);
    const { key2id } = model.buildFiles(pcEmpty, fa);
    const { batches } = model.buildBatches(pcEmpty, fa, key2id);
    assert.strictEqual(batches.data.batch_id.length, 2);
    eq(batches.data.file_id,
      [key2id.get(65155 + '\x01' + 1), key2id.get(65155 + '\x01' + 2)]);
  });

// ---------------------------------------------------- caller format

function mkDstateInputs(callerRows, threadsRows, dstateRows, reqRows) {
  const threads = table(
    ['utid', 'tid', 'thread_name', 'upid', 'pid', 'process_name',
      'parent_pid'], threadsRows);
  const dst = table(['ts', 'utid', 'dur', 'blocked_function'],
    dstateRows);
  const blk = table(['ts', 'pid', 'caller', 'io_wait'], callerRows);
  const req = table(
    ['utid', 't_cmp', 'req_id'], reqRows);
  return { dst, blk, req, threads };
}

/* vm-realm arrays fail deepStrictEqual — compare serialized. */
function eq(actual, expected) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

test('buildDstate caller: all matched int64 -> caller#N', () => {
  const { dst, blk, req, threads } = mkDstateInputs(
    [[1050, 55, 7, 1]],
    [[5, 55, 't', 1, 55, 'p', 0]],
    [[1000, 5, 1000, '']],
    [[5, 1500, 0]]);
  const io = new Set([5]);
  const r = model.buildDstate(dst, blk, req, io, threads);
  eq(r.dst.data.fn, ['caller#7']);
  eq(r.dst.data.fn_ok, [0]);
  eq(r.dst.data.iow, [1]);
  // src1: req completing 1500 in [1000, 2000+50us]
  eq(r.waitReq, [0]);
  eq(r.waitSrc, [1]);
});

test('buildDstate caller: unmatched merge row -> caller#N (P4c)',
  () => {
    const { dst, blk, req, threads } = mkDstateInputs(
      [[1050, 55, 7, 1]],
      [[5, 55, 't', 1, 55, 'p', 0], [7, 77, 't2', 2, 77, 'q', 0]],
      [[1000, 5, 1000, ''], [3000, 7, 500, '']],
      [[5, 1500, 0]]);
    const io = new Set([5, 7]);
    const r = model.buildDstate(dst, blk, req, io, threads);
    // P4c: integral numeric callers render caller#<int> regardless of
    // the pandas dtype the merged caller column would have had
    eq(r.dst.data.fn, ['caller#7', '']);
    eq(r.dst.data.fn_ok, [0, 0]);
    eq(r.dst.data.iow, [1, -1]);
  });

test('buildDstate caller: symbolic + numeric + wait src1/src2', () => {
  // Three segs over two tids. Caller window is [ts, end+1ms]; src2
  // window is [end-100us, end] — toy timestamps must respect real ns
  // tolerances:
  //  seg0 utid5 [1000,1100]: bio_schedule 1050 -> fn as-is, iow 1,
  //      utid5 req cmp 1149 in window -> wait src1
  //  seg1 utid7 [100650,101150]: numeric caller 7 at 100700 (object
  //      col) -> caller#7, iow 1, no wait (req0 is >100us before end)
  //  seg2 utid5 [1e6,1000500]: wakeup 1002000 -> iow 1, no own
  //      completion -> src2: nearest req <= end within 100us -> req 1
  const { dst, blk, req, threads } = mkDstateInputs(
    [[1050, 55, 'bio_schedule', 1], [100700, 77, 7, 1],
     [1002000, 55, 'wakeup', 1]],
    [[5, 55, 't', 1, 55, 'p', 0], [7, 77, 't2', 2, 77, 'q', 0]],
    [[1000, 5, 100, ''], [100650, 7, 500, ''], [1000000, 5, 500, '']],
    [[5, 1149, 0], [7, 1000450, 1]]);
  const io = new Set([5, 7]);
  const r = model.buildDstate(dst, blk, req, io, threads);
  // dst rows are (utid,ts)-sorted: seg0, seg2 (utid5) then seg1 (utid7)
  eq(r.dst.data.fn, ['bio_schedule', 'wakeup', 'caller#7']);
  eq(r.dst.data.fn_ok, [1, 1, 0]);
  eq(r.dst.data.iow, [1, 1, 1]);
  eq(r.waitOff, [0, 1, 2, 2]);
  eq(r.waitReq, [0, 1]);
  eq(r.waitSrc, [1, 2]);
});

// ------------------------------------------------------ buildQuality

test('buildQuality messages byte-exact (ring wrap + overrun)', () => {
  const ex = {
    tables: {
      rq_insert: table(['ts'], [[1]]),
      rq_issue: table(['ts'], [[2]]),
      rq_complete: table(['ts'], [[3]]),
      bio_make: table(['ts'], [[0]]),
      pc_start: table(['ts'], [[0]]),
      fm_add: table(['ts'], [[0]]),
      dstate: table(['ts', 'utid', 'dur', 'blocked_function'],
        [[0, 1, 1, 'io_schedule']]),
      blocked: table(['ts', 'pid', 'caller', 'io_wait'],
        [[0, 1, 'x', 0]]),
    },
    stats: { traced_buf_write_wrap_count: 1,
      ftrace_cpu_overrun_begin: 2, ftrace_cpu_overrun_end: 5 },
    notes: [],
  };
  const q = model.buildQuality(ex, {}, 500000000, 2600000000);
  assert.strictEqual(q[0].msg,
    'RING_BUFFER 已回绕，早期数据被覆盖；有效时间窗约 0.50s ~ ' +
    '2.60s（2.1s）');
  const ov = q.find(e => e.code === 'ftrace_overrun');
  assert.strictEqual(ov.msg,
    '录制期间丢失 3 个 ftrace 事件（CPU overrun），部分 IO 事件可能缺失');
});

test('associateFiles pc fallback uses exact (s_dev, ino) keys (P4c)',
  () => {
    const mkReq = () => table(['op', 'utid', 't_make', 't_ins', 't_iss0'],
      [['R', 5, 1000, null, null]]);
    const faEmpty = table(['ts', 'utid', 's_dev', 'i_ino', 'index'], []);
    // s_dev beyond the old int64 fkey range: association now works
    const pcBig = table(['ts', 'utid', 'major_dev', 'minor_dev', 'ino',
        'offset', 'bytes', 'filebuf'],
      [[400, 5, 16777216, 5, 99, 0, 4096, 'big.so']]);
    const { key2id: k2, files: f2 } = model.buildFiles(pcBig, faEmpty);
    const req = mkReq();
    model.associateFiles(req, faEmpty, pcBig, k2);
    assert.strictEqual(req.data.file[0], f2.data.ino.indexOf(99));
    assert.strictEqual(req.data.fsrc[0], 2);
    // Nearby large inos that collided in float64: the request gets the
    // file of the pc row it actually matched (backward -> ts 500 row).
    const pcSmall = table(['ts', 'utid', 'major_dev', 'minor_dev', 'ino',
        'offset', 'bytes', 'filebuf'], [
      [500, 5, 254, 27, 12624502, 0, 4096, 'a'],
      [400, 5, 254, 27, 12624505, 0, 4096, 'b']]);
    const { key2id: k3, files: f3 } = model.buildFiles(pcSmall, faEmpty);
    const req2 = mkReq();
    model.associateFiles(req2, faEmpty, pcSmall, k3);
    const fid502 = f3.data.ino.indexOf(12624502);
    assert.notStrictEqual(fid502, -1);
    assert.strictEqual(req2.data.file[0], fid502);
    assert.strictEqual(req2.data.fsrc[0], 2);
  });
