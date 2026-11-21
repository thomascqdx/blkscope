/* BLK.extract: SQL extraction layer — JS port of src/blkscope/extract.py.
 *
 * Runs the same queries as extract_all() against a BLK.TpClient with a
 * loaded trace and returns the same shape as scripts/dump_extracted.py's
 * dump(): {tables: {attr: {columns, data:{col:[..]}}}, device, stats,
 * t_min, t_max, trace_start, notes}.
 *
 * Deliberate difference vs extract.py: the text-systrace fallback
 * (Extracted.script / rq_* backfill from the text log) is not ported —
 * requirements.md §8 says v1 shows a "use the CLI" hint instead. Everything
 * else mirrors the Python, including column order and empty-table schemas.
 *
 * About _query()'s pd.to_numeric coercion: in Python it exists only because
 * pandas object columns may hold numeric-looking strings; the TP wire
 * protocol already returns typed cells (varint / float64 / string / null),
 * so there is nothing to coerce here — values are used as returned.
 *
 * Classic script, no modules. Exposes globalThis.BLK.extract.
 */
(function () {
  'use strict';
  const BLK = (globalThis.BLK = globalThis.BLK || {});

  // Columns pandas treats as strings in extract.py (_STR_COLS). Kept for
  // parity/doc; JS needs no coercion (see header comment).
  const STR_COLS = new Set([
    'rwbs', 'comm', 'filebuf', 'rq_log', 'caller', 'blocked_function',
    'error', 'type', 'name',
  ]);

  // Fixed output schema per event table — same key order as
  // extract._EVENT_QUERIES: [event name, arg keys, base cols].
  const EVENT_QUERIES = {
    bio_make: ['block_rq_mq_make_request',
      ['pid', 'sector', 'rwbs', 'class', 'priority', 'is_ux_task',
        'is_ux_loop', 'FG_META', 'bi_ioprio'],
      ['ts', 'utid']],
    rq_insert: ['block_rq_insert',
      ['dev', 'sector', 'nr_sector', 'bytes', 'rwbs'],
      ['ts', 'utid']],
    rq_issue: ['block_rq_issue',
      ['dev', 'sector', 'nr_sector', 'bytes', 'rwbs'],
      ['ts', 'utid']],
    rq_complete: ['block_rq_complete',
      ['dev', 'sector', 'nr_sector', 'rwbs', 'error'],
      ['ts']],
    mq_complete: ['block_rq_mq_complete_request',
      ['dev', 'sector', 'req_tag', 'rq_log'],
      ['ts']],
    mq_requeue: ['block_rq_mq_requeue_request',
      ['dev', 'sector', 'req_tag', 'rq_log'],
      ['ts']],
    pc_start: ['tran_fs_pagecache_start',
      ['major_dev', 'minor_dev', 'ino', 'offset', 'bytes', 'filebuf'],
      ['ts', 'utid']],
    fm_add: ['mm_filemap_add_to_page_cache',
      ['s_dev', 'i_ino', 'index'],
      ['ts', 'utid']],
    blocked: ['sched_blocked_reason',
      ['pid', 'caller', 'io_wait'],
      ['ts']],
  };

  const META_KEYS = [
    'android_build_fingerprint', 'android_device_manufacturer',
    'android_soc_model', 'system_release', 'android_sdk_version',
    'system_ram_gb',
  ];

  const STATS_KEYS = [
    'traced_buf_write_wrap_count', 'interned_data_tokenizer_errors',
    'ftrace_cpu_overrun_begin', 'ftrace_cpu_overrun_end',
  ];

  function empty(cols) {
    const data = {};
    for (const c of cols) data[c] = [];
    return { columns: cols.slice(), data: data };
  }

  function pick(res, cols) {
    const data = {};
    for (const c of cols) data[c] = res.data[c] || [];
    return { columns: cols.slice(), data: data };
  }

  async function events(client, name, argKeys, baseCols) {
    const cols = baseCols.concat(argKeys);
    const select = argKeys
      .map(function (k) {
        return "extract_arg(arg_set_id,'" + k + "') as \"" + k + "\"";
      })
      .join(', ');
    const res = await client.query(
      'select ' + baseCols.join(', ') + ', ' + select +
      " from ftrace_event where name='" + name + "' order by ts");
    if (!res.rows) return empty(cols);
    return pick(res, cols);
  }

  /* Port of extract._fill_process_names: missing/empty process_name gets
   * the main thread's name (tid==pid, named), else the first named thread
   * of the same upid (in original row order per pandas groupby). */
  function fillProcessNames(t) {
    const n = t.data.utid.length;
    const need = t.data.process_name.map(function (v) {
      return v === null || v === undefined || String(v).length === 0;
    });
    if (!need.some(Boolean)) return t;
    // group row indices by upid, preserving original order (pandas groupby)
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const k = t.data.upid[i];
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    }
    const names = {};
    for (const [upid, idxs] of groups) {
      let pick = -1;
      // main thread: tid == pid (both non-null) and has a name
      for (const i of idxs) {
        if (t.data.tid[i] !== null && t.data.tid[i] !== undefined &&
            t.data.pid[i] !== null && t.data.pid[i] !== undefined &&
            t.data.tid[i] === t.data.pid[i] &&
            t.data.thread_name[i] !== null &&
            t.data.thread_name[i] !== undefined) {
          pick = i;
          break;
        }
      }
      if (pick < 0) {
        for (const i of idxs) {
          if (t.data.thread_name[i] !== null &&
              t.data.thread_name[i] !== undefined) {
            pick = i;
            break;
          }
        }
      }
      if (pick >= 0) names[upid] = t.data.thread_name[pick];
    }
    for (let i = 0; i < n; i++) {
      if (need[i]) {
        const v = names[t.data.upid[i]];
        if (v !== undefined) t.data.process_name[i] = v;
      }
    }
    return t;
  }

  function sqlInList(keys) {
    return keys.map(function (k) { return "'" + k + "'"; }).join(', ');
  }

  async function extractAll(client, opts) {
    const out = { tables: {}, device: {}, stats: {},
      t_min: 0, t_max: 0, trace_start: 0, notes: [] };
    const T = out.tables;

    for (const attr of Object.keys(EVENT_QUERIES)) {
      const [name, argKeys, baseCols] = EVENT_QUERIES[attr];
      T[attr] = await events(client, name, argKeys, baseCols);
    }

    const DCOLS = ['utid', 'ts', 'dur', 'blocked_function'];
    let res = await client.query(
      'select utid, ts, dur, blocked_function from thread_state ' +
      "where state in ('D','DK') order by ts");
    T.dstate = res.rows ? pick(res, DCOLS) : empty(DCOLS);

    const TCOLS = ['utid', 'tid', 'thread_name', 'upid', 'pid',
      'process_name', 'parent_pid'];
    res = await client.query(
      'select t.utid, t.tid, t.name as thread_name, t.upid, ' +
      'p.pid, p.name as process_name, pp.pid as parent_pid ' +
      'from thread t left join process p using(upid) ' +
      'left join process pp on pp.upid = p.parent_upid');
    T.threads = res.rows
      ? fillProcessNames(pick(res, TCOLS))
      : empty(TCOLS);

    const RCOLS = ['utid', 'ts_min', 'ts_max'];
    res = await client.query(
      'select utid, min(ts) as ts_min, max(ts + dur) as ts_max ' +
      'from thread_state group by utid');
    T.thread_ranges = res.rows ? pick(res, RCOLS) : empty(RCOLS);

    res = await client.query(
      'select name, str_value, int_value from metadata ' +
      'where name in (' + sqlInList(META_KEYS) + ')');
    for (let i = 0; i < res.rows; i++) {
      let val = res.data.str_value[i];
      if (val === null || val === undefined) val = res.data.int_value[i];
      if (val !== null && val !== undefined) {
        out.device[res.data.name[i]] = val;
      }
    }

    res = await client.query(
      'select name, sum(value) as value from stats ' +
      'where name in (' + sqlInList(STATS_KEYS) + ') group by name');
    for (let i = 0; i < res.rows; i++) {
      const v = res.data.value[i];
      if (v !== null && v !== undefined) {
        out.stats[res.data.name[i]] = v;
      }
    }

    res = await client.query(
      'select min(ts) as mn, max(ts) as mx from ftrace_event');
    if (res.rows && res.data.mn[0] !== null && res.data.mn[0] !== undefined) {
      out.t_min = res.data.mn[0];
      out.t_max = res.data.mx[0];
    }

    res = await client.query('select start_ts from trace_bounds');
    if (res.rows && res.data.start_ts[0] !== null &&
        res.data.start_ts[0] !== undefined) {
      out.trace_start = res.data.start_ts[0];
    }

    return out;
  }

  BLK.extract = {
    EVENT_QUERIES: EVENT_QUERIES,
    META_KEYS: META_KEYS,
    STATS_KEYS: STATS_KEYS,
    STR_COLS: STR_COLS,
    extractAll: extractAll,
    _fillProcessNames: fillProcessNames,
  };
})();
