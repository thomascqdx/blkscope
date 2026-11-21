/* BLK.model dstate/quality: JS port of build_dstate + build_quality
 * from src/blkscope/model.py (P4b).
 *
 * Depends on BLK.frame and BLK.model basics (req.js). Classic script.
 */
(function () {
  'use strict';
  const BLK = (globalThis.BLK = globalThis.BLK || {});
  const frame = BLK.frame;
  const model = (BLK.model = BLK.model || {});
  const isNull = frame.isNull;
  const nrows = model._nrows;

  const D_BLK_SLACK_NS = 1000000;    // blocked event within [D.ts, D.end+1ms]
  const D_END_SLACK_NS = 50000;      // 50 us after D end for own-request wait
  const D_END_BACK_NS = 100000;      // 100 us before D end for io_wait guess

  const DCOLS = ['utid', 'ts', 'dur', 'fn', 'fn_ok', 'iow'];

  function emptyDst() {
    return { dst: { columns: DCOLS.slice(), data: {
        utid: [], ts: [], dur: [], fn: [], fn_ok: [], iow: [] } },
      waitOff: [0], waitReq: [], waitSrc: [] };
  }

  /* build_dstate: D-state segments of IO threads + block function +
   * wait CSR (design 3.6). ioUtids = Set of request/batch utids.
   * Returns {dst, waitOff, waitReq, waitSrc}. */
  model.buildDstate = function (dstate, blocked, req, ioUtids, threads) {
    if (!nrows(dstate) || !ioUtids || !ioUtids.size) return emptyDst();

    // d = dstate rows on io threads, sorted by (utid, ts)
    const ds = dstate.data;
    const keep = [];
    for (let i = 0; i < nrows(dstate); i++) {
      if (ioUtids.has(ds.utid[i])) keep.push(i);
    }
    if (!keep.length) return emptyDst();
    const order = frame.argsort(
      [keep.map(function (i) { return ds.utid[i]; }),
       keep.map(function (i) { return ds.ts[i]; })], keep.length);
    const nd = order.length;
    const d = { utid: new Array(nd), ts: new Array(nd),
      dur: new Array(nd), end: new Array(nd), fn: new Array(nd),
      fn_ok: new Array(nd), iow: new Array(nd).fill(-1) };
    const noBf = [];      // d-positions with no blocked_function
    for (let k = 0; k < nd; k++) {
      const i = keep[order[k]];
      d.utid[k] = ds.utid[i];
      d.ts[k] = ds.ts[i];
      d.dur[k] = ds.dur[i];
      d.end[k] = ds.ts[i] + ds.dur[i];
      const bf = isNull(ds.blocked_function[i]) ? ''
        : String(ds.blocked_function[i]);
      const has = bf.length > 0;
      d.fn[k] = has ? bf : '';
      d.fn_ok[k] = has ? 1 : 0;
      if (!has) noBf.push(k);
    }

    // block function: sched_blocked_reason caller lookup
    if (noBf.length && nrows(blocked) && nrows(threads)) {
      // tid_of: utid -> tid (first row per utid)
      const tidOf = new Map();
      const t = threads.data;
      const seen = new Set();
      for (let i = 0; i < nrows(threads); i++) {
        const u = t.utid[i];
        if (isNull(t.tid[i]) || seen.has(u)) continue;
        seen.add(u);
        tidOf.set(u, t.tid[i]);
      }
      // blk = blocked rows with ts/pid, sorted by ts (bts, tid, caller,
      // io_wait); dd = no-bf segs with a resolved tid, sorted by q
      const blk = blocked.data;
      const nb = nrows(blocked);
      const bidx = [];
      for (let i = 0; i < nb; i++) {
        if (!isNull(blk.ts[i]) && !isNull(blk.pid[i])) bidx.push(i);
      }
      const bOrder = frame.argsort(
        [bidx.map(function (i) { return blk.ts[i]; })], bidx.length);
      const bts = new Array(bidx.length), bTid = new Array(bidx.length);
      for (let k = 0; k < bOrder.length; k++) {
        const i = bidx[bOrder[k]];
        bts[k] = blk.ts[i];
        bTid[k] = blk.pid[i];
      }
      // dd with tid
      const dd = [];      // {di, tid, q, ts}
      for (const k of noBf) {
        const tid = tidOf.get(d.utid[k]);
        if (tid === undefined || isNull(tid)) continue;
        dd.push({ di: k, tid: tid, q: d.end[k] + D_BLK_SLACK_NS,
          ts: d.ts[k] });
      }
      if (dd.length && bidx.length) {
        const lOrder = frame.argsort(
          [dd.map(function (e) { return e.q; })], dd.length);
        const lOn = new Array(dd.length), lBy = new Array(dd.length);
        for (let k = 0; k < lOrder.length; k++) {
          lOn[k] = dd[lOrder[k]].q;
          lBy[k] = frame.encodeKeyVal(dd[lOrder[k]].tid);
        }
        const rBy = new Array(bidx.length);
        for (let k = 0; k < bidx.length; k++) {
          rBy[k] = frame.encodeKeyVal(bTid[k]);
        }
        const hit = frame.mergeAsof({
          leftOn: lOn, rightOn: bts, leftBy: lBy, rightBy: rBy,
          direction: 'backward' });
        /* pandas dtype of m["caller"]: blk.caller is object when it
         * holds any string, else float64 when it holds NaN/non-integral
         * numbers OR when merge_asof leaves unmatched left rows (NaN
         * fills the column). "caller#" + caller.astype(str) therefore
         * yields "13" for int64/object but "13.0" for float64 — and
         * "nan" / "None" for missing callers. Mirror that exactly. */
        let hasStr = false, floatCol = false;
        for (const i of bidx) {
          const c = blk.caller[i];
          if (typeof c === 'string') hasStr = true;
          else if (isNull(c) || !Number.isInteger(c)) floatCol = true;
        }
        if (!hasStr) {
          for (let k = 0; k < hit.length; k++) {
            if (hit[k] < 0) { floatCol = true; break; }
          }
        }
        const fmtCaller = function (c) {
          if (isNull(c)) return floatCol ? 'nan' : 'None';
          if (typeof c === 'string') return c;
          if (floatCol && Number.isInteger(c)) return c + '.0';
          return String(c);
        };
        for (let k = 0; k < hit.length; k++) {
          const j = hit[k];
          if (j < 0) continue;
          const e = dd[lOrder[k]];
          const bi = bidx[bOrder[j]];
          if (!(bts[j] >= e.ts)) continue;   // bts in [D.ts, D.end+1ms]
          const caller = blk.caller[bi];
          const num = !Number.isNaN(frame.pyToNumber(caller));
          d.fn[e.di] = num ? 'caller#' + fmtCaller(caller)
            : fmtCaller(caller);
          d.fn_ok[e.di] = num ? 0 : 1;
          d.iow[e.di] = isNull(blk.io_wait[bi]) ? -1
            : Math.trunc(blk.io_wait[bi]);
        }
      }
    }

    // wait CSR: src1 = own-thread requests completing in
    // [D.ts, D.end + 50us]
    const pairs = new Map();   // d_idx -> [[req_id, src], ...]
    const rd = req.data;
    const nr = frame.nrows(req);
    const rqIdx = [];
    for (let i = 0; i < nr; i++) {
      if (!isNull(rd.t_cmp[i]) && !isNull(rd.utid[i])) rqIdx.push(i);
    }
    if (rqIdx.length) {
      // dr = right: d sorted by ts
      const drOrder = frame.argsort([d.ts], nd);
      const drTs = new Array(nd), drBy = new Array(nd);
      for (let k = 0; k < nd; k++) {
        drTs[k] = d.ts[drOrder[k]];
        drBy[k] = frame.encodeKeyVal(d.utid[drOrder[k]]);
      }
      const lOrder = frame.argsort(
        [rqIdx.map(function (i) { return rd.t_cmp[i]; })], rqIdx.length);
      const lOn = new Array(rqIdx.length), lBy = new Array(rqIdx.length);
      for (let k = 0; k < lOrder.length; k++) {
        const i = rqIdx[lOrder[k]];
        lOn[k] = rd.t_cmp[i];
        lBy[k] = frame.encodeKeyVal(rd.utid[i]);
      }
      const hit = frame.mergeAsof({
        leftOn: lOn, rightOn: drTs, leftBy: lBy, rightBy: drBy,
        direction: 'backward' });
      for (let k = 0; k < hit.length; k++) {
        const j = hit[k];
        if (j < 0) continue;
        const di = drOrder[j];
        const ri = rqIdx[lOrder[k]];
        if (!(rd.t_cmp[ri] <= d.end[di] + D_END_SLACK_NS)) continue;
        let a = pairs.get(di);
        if (!a) { a = []; pairs.set(di, a); }
        a.push([rd.req_id[ri], 1]);
      }
    }
    // src2 = io_wait==1 segs w/o src1: nearest request completing
    // <= D.end within 100us (any thread)
    const d2 = [];
    for (let k = 0; k < nd; k++) {
      if (d.iow[k] === 1 && !pairs.has(k)) d2.push(k);
    }
    const rqAny = [];
    for (let i = 0; i < nr; i++) {
      if (!isNull(rd.t_cmp[i])) rqAny.push(i);
    }
    if (d2.length && rqAny.length) {
      const lOrder = frame.argsort(
        [d2.map(function (k) { return d.end[k]; })], d2.length);
      const lOn = new Array(d2.length);
      for (let k = 0; k < lOrder.length; k++) {
        lOn[k] = d.end[d2[lOrder[k]]];
      }
      const rOrder = frame.argsort(
        [rqAny.map(function (i) { return rd.t_cmp[i]; })], rqAny.length);
      const rOn = new Array(rqAny.length);
      for (let k = 0; k < rOrder.length; k++) {
        rOn[k] = rd.t_cmp[rqAny[rOrder[k]]];
      }
      const hit = frame.mergeAsof({
        leftOn: lOn, rightOn: rOn, direction: 'backward',
        tolerance: D_END_BACK_NS });
      for (let k = 0; k < hit.length; k++) {
        const j = hit[k];
        if (j < 0) continue;
        const di = d2[lOrder[k]];
        const ri = rqAny[rOrder[j]];
        let a = pairs.get(di);
        if (!a) { a = []; pairs.set(di, a); }
        a.push([rd.req_id[ri], 2]);
      }
    }

    const waitReq = [], waitSrc = [], waitOff = [0];
    for (let di = 0; di < nd; di++) {
      const a = pairs.get(di);
      if (a) {
        a.sort(function (x, y) { return (x[0] - y[0]) || (x[1] - y[1]); });
        for (const p of a) { waitReq.push(p[0]); waitSrc.push(p[1]); }
      }
      waitOff.push(waitReq.length);
    }
    return { dst: { columns: DCOLS.slice(), data: {
        utid: d.utid, ts: d.ts, dur: d.dur, fn: d.fn, fn_ok: d.fn_ok,
        iow: d.iow } },
      waitOff: waitOff, waitReq: waitReq, waitSrc: waitSrc };
  };

  // --------------------------------------------------------- quality

  /* build_quality (design 3.7): same messages as Python, pyFixed for
   * the %.2f/%.1f interpolation. ex = extracted JSON. */
  model.buildQuality = function (ex, counters, tMin, tMax) {
    const q = [];
    const warn = function (code, msg) {
      q.push({ level: 'warn', code: code, msg: msg });
    };
    const info = function (code, msg) {
      q.push({ level: 'info', code: code, msg: msg });
    };
    const T = ex.tables || {};
    const stats = ex.stats || {};

    if ((stats.traced_buf_write_wrap_count || 0) > 0) {
      warn('ring_wrap',
        'RING_BUFFER 已回绕，早期数据被覆盖；有效时间窗约 ' +
        frame.pyFixed(tMin / 1e9, 2) + 's ~ ' +
        frame.pyFixed(tMax / 1e9, 2) + 's（' +
        frame.pyFixed((tMax - tMin) / 1e9, 1) + 's）');
    }
    if (!(nrows(T.rq_insert) || nrows(T.rq_issue) ||
          nrows(T.rq_complete))) {
      warn('no_block_events',
        '未解析到块设备 IO 事件（block_rq_*），请确认抓取配置包含 ' +
        'block ftrace 事件');
    }
    if (!nrows(T.bio_make)) {
      warn('no_make_request',
        '缺少传音定制事件 block_rq_mq_make_request：IO 优先级与提交者' +
        '信息不可用（已按 insert 线程降级归属）');
    }
    if (!nrows(T.pc_start) || !nrows(T.fm_add)) {
      warn('no_pagecache',
        '缺少传音定制事件 tran_fs_pagecache_start / ' +
        'mm_filemap_add_to_page_cache：文件关联不可用');
    }
    let bfOk = false;
    if (nrows(T.dstate)) {
      const bf = T.dstate.data.blocked_function;
      if (bf) {
        for (const v of bf) {
          if (!isNull(v) && String(v).length > 0) { bfOk = true; break; }
        }
      }
    }
    let callerNum = false;
    if (nrows(T.blocked)) {
      callerNum = true;
      for (const v of (T.blocked.data.caller || [])) {
        if (Number.isNaN(frame.pyToNumber(v))) { callerNum = false; break; }
      }
    }
    if (nrows(T.dstate) && !bfOk && callerNum) {
      warn('block_fn_unresolved',
        'block function 未能符号化（sched_blocked_reason.caller 为内部 ' +
        'id，显示为 caller#<id>）：可能是环形缓冲回绕导致内核符号表' +
        '丢失；建议增大 buffer 或使用 DISCARD 模式重抓，并确保保留 ' +
        'kernel symbols');
    }
    if (counters.orphan_complete) {
      info('orphan_complete',
        counters.orphan_complete + ' 个 complete 事件找不到配对的 ' +
        'issue/insert（请求在有效窗口外开始或事件丢失）');
    }
    if (counters.incomplete) {
      info('incomplete',
        counters.incomplete + ' 个请求到 trace 结束未完成，' +
        '将绘制到窗口末尾');
    }
    if (counters.cmp_lost) {
      info('cmp_lost',
        counters.cmp_lost + ' 个请求没有 complete 事件' +
        '（多为 flush，内核未上报 block_rq_complete），' +
        '仅标注下发时刻');
    }
    if (counters.dropped_insert) {
      info('dropped_insert',
        counters.dropped_insert + ' 个 insert 请求在下发前' +
        '被合并或丢失');
    }
    const ov = (stats.ftrace_cpu_overrun_end || 0) -
      (stats.ftrace_cpu_overrun_begin || 0);
    if (ov > 0) {
      warn('ftrace_overrun',
        '录制期间丢失 ' + ov + ' 个 ftrace 事件（CPU overrun），' +
        '部分 IO 事件可能缺失');
    }
    for (const note of (ex.notes || [])) {
      (note[0] === 'warn' ? warn : info)(note[1], note[2]);
    }
    return q;
  };
})();
