// Node sanity tests for web/model/extract.js against a fake TpClient.
// Run: node --test tests/js/*.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadWeb } = require('./_load.js');

const BLK = loadWeb([
  'web/engine/proto.js',
  'web/engine/tp_client.js',
  'web/model/extract.js',
]);

// Objects created inside the vm context fail deepStrictEqual cross-realm;
// compare through JSON instead.
const eqj = (a, b) => assert.strictEqual(
  JSON.stringify(a), JSON.stringify(b));

function fakeClient(routes, sqlLog) {
  return {
    query(sql) {
      if (sqlLog) sqlLog.push(sql);
      for (const [match, res] of routes) {
        if (sql.includes(match)) return Promise.resolve(res);
      }
      return Promise.resolve({ columns: [], rows: 0, data: {} });
    },
  };
}

test('extractAll: empty trace -> empty tables with fixed schemas', async () => {
  const client = fakeClient([]);
  const ex = await BLK.extract.extractAll(client);
  const T = ex.tables;
  eqj(T.bio_make.columns,
    ['ts', 'utid', 'pid', 'sector', 'rwbs', 'class', 'priority',
      'is_ux_task', 'is_ux_loop', 'FG_META', 'bi_ioprio']);
  eqj(T.dstate.columns,
    ['utid', 'ts', 'dur', 'blocked_function']);
  eqj(T.threads.columns,
    ['utid', 'tid', 'thread_name', 'upid', 'pid', 'process_name',
      'parent_pid']);
  eqj(T.thread_ranges.columns,
    ['utid', 'ts_min', 'ts_max']);
  for (const a of Object.keys(T)) {
    for (const c of T[a].columns) eqj(T[a].data[c], []);
  }
  eqj(ex.device, {});
  eqj(ex.stats, {});
  assert.strictEqual(ex.t_min, 0);
  assert.strictEqual(ex.t_max, 0);
  assert.strictEqual(ex.trace_start, 0);
});

test('extractAll: event SQL mirrors extract.py exactly', async () => {
  const log = [];
  const client = fakeClient([], log);
  await BLK.extract.extractAll(client);
  const ev = log.find((s) => s.includes('block_rq_insert'));
  assert.strictEqual(ev,
    'select ts, utid, extract_arg(arg_set_id,\'dev\') as "dev", ' +
    'extract_arg(arg_set_id,\'sector\') as "sector", ' +
    'extract_arg(arg_set_id,\'nr_sector\') as "nr_sector", ' +
    'extract_arg(arg_set_id,\'bytes\') as "bytes", ' +
    'extract_arg(arg_set_id,\'rwbs\') as "rwbs" ' +
    'from ftrace_event where name=\'block_rq_insert\' order by ts');
});

// Same frame asserted literally in tests/test_model_parity.py against the
// real pandas _fill_process_names; keep the two frames in sync.
test('_fillProcessNames: main wins, first named, null upid / "" edge cases',
  () => {
    const t = {
      columns: ['utid', 'tid', 'thread_name', 'upid', 'pid',
        'process_name', 'parent_pid'],
      data: {
        // upid 10 (rows 0-2): main = row0 (tid==pid, named) -> 'main-t'
        // upid 20 (row 3): no named thread -> stays null
        // upid 30 (rows 4,5): main unnamed, row5 named -> 'named-x'
        // row 6: null upid -> pandas groupby drops the key, never filled
        // row 7: upid 40, process_name '' -> unmapped -> null (not '')
        utid: [1, 2, 3, 4, 5, 6, 7, 8],
        tid: [100, 101, 102, 200, 300, 301, 400, 401],
        thread_name: ['main-t', 'worker', null, null, null, 'named-x',
          't-x', null],
        upid: [10, 10, 10, 20, 30, 30, null, 40],
        pid: [100, 100, 100, 200, 300, 300, 400, 999],
        process_name: [null, 'keepme', null, null, null, null, '', ''],
        parent_pid: [0, 0, 0, 0, 0, 0, 0, 0],
      },
    };
    const out = BLK.extract._fillProcessNames(t);
    assert.strictEqual(out.data.process_name[0], 'main-t');   // filled: main
    assert.strictEqual(out.data.process_name[1], 'keepme');   // not missing
    assert.strictEqual(out.data.process_name[2], 'main-t');   // filled: main
    assert.strictEqual(out.data.process_name[3], null);       // no name in upid
    assert.strictEqual(out.data.process_name[4], 'named-x');  // first named
    assert.strictEqual(out.data.process_name[5], 'named-x');
    assert.strictEqual(out.data.process_name[6], null);       // null upid
    assert.strictEqual(out.data.process_name[7], null);       // '' -> NaN
  });

test('extractAll: device/stats/bounds from canned results', async () => {
  const client = fakeClient([
    ['from metadata', {
      columns: ['name', 'str_value', 'int_value'],
      rows: 2,
      data: {
        name: ['android_sdk_version', 'android_soc_model'],
        str_value: [null, 'MT6878'],
        int_value: [37, null],
      },
    }],
    ['from stats', {
      columns: ['name', 'value'], rows: 1,
      data: { name: ['ftrace_cpu_overrun_begin'], value: [3] },
    }],
    ['min(ts) as mn', {
      columns: ['mn', 'mx'], rows: 1, data: { mn: [100], mx: [200] },
    }],
    ['from trace_bounds', {
      columns: ['start_ts'], rows: 1, data: { start_ts: [50] },
    }],
  ]);
  const ex = await BLK.extract.extractAll(client);
  eqj(ex.device, { android_sdk_version: 37, android_soc_model: 'MT6878' });
  eqj(ex.stats, { ftrace_cpu_overrun_begin: 3 });
  assert.strictEqual(ex.t_min, 100);
  assert.strictEqual(ex.t_max, 200);
  assert.strictEqual(ex.trace_start, 50);
});
