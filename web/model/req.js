/* BLK.model: JS port of the request-side half of src/blkscope/model.py
 * (P4a). Covers: parse_rwbs, categorize, prio_flags, pair_requests,
 * match_make_requests, enrich_requests, assign_slots and the build_model
 * orchestration up to and including slot/lanes + q/svc/total_ns.
 *
 * Input/output are columnar tables {columns, data:{col:[..]}} with null =
 * missing (same shape as BLK.extract output and dump_extracted.py).
 * Not yet ported (P4b): build_files/build_batches/associate_files/
 * build_file_hints/build_dstate/build_quality/slot_limits/devs/payload.
 *
 * Depends on BLK.frame (web/model/frame.js) — load it first.
 * Classic script, no modules. Exposes globalThis.BLK.model.
 */
(function () {
  'use strict';
  const BLK = (globalThis.BLK = globalThis.BLK || {});
  const frame = BLK.frame;
  const model = (BLK.model = BLK.model || {});

  const MAKE_MATCH_TOL_NS = 50000000;   // 50 ms: bio_make -> request
  const TAG_MATCH_TOL_NS = 1000000;     // 1 ms: mq_complete -> t_complete
  const SLOT_INCOMPLETE_NS = 200000000; // incomplete slot end: t_iss + 200ms

  const CAT_SYNC_READ = 0, CAT_READAHEAD = 1, CAT_META = 2, CAT_WRITE = 3;
  const CAT_FLUSH = 4, CAT_DISCARD = 5, CAT_OTHER = 6;

  const PRIO_RT = 1, PRIO_IDLE = 2, PRIO_UX = 4, PRIO_FG_META = 8;
  const PRIO_SYNC = 16, PRIO_META = 32, PRIO_FUA = 64;

  const REQUEUE_RE = /requeue_reason:\s*(\d+)/;

  const isNull = frame.isNull;

  function col(t, name) {
    return t && t.data && t.data[name] ? t.data[name] : [];
  }
  function nrows(t) {
    if (!t || !t.columns || !t.columns.length) return 0;
    const c = t.data[t.columns[0]];
    return c ? c.length : 0;
  }
  model._col = col;
  model._nrows = nrows;

  // ---------------------------------------------------------------- rwbs

  /* parse_rwbs: split rwbs into op letter + flags. Leading 'F' = preflush;
   * a bare 'F' (dataless flush) -> op 'F'. */
  function parseRwbs(rwbs) {
    const n = rwbs.length;
    const op = new Array(n), preflush = new Array(n), fua = new Array(n),
      rahead = new Array(n), sync = new Array(n), meta = new Array(n),
      secure = new Array(n);
    for (let i = 0; i < n; i++) {
      const raw = rwbs[i];
      const s = isNull(raw) ? '' : String(raw).toUpperCase();
      const pf = s.length > 0 && s.charCodeAt(0) === 70; // 'F'
      const rest = pf ? s.slice(1) : s;
      op[i] = rest.length > 0 ? rest.charAt(0) : 'F';
      const fl = rest.slice(1);
      preflush[i] = pf;
      fua[i] = fl.indexOf('F') >= 0;
      rahead[i] = fl.indexOf('A') >= 0;
      sync[i] = fl.indexOf('S') >= 0;
      meta[i] = fl.indexOf('M') >= 0;
      secure[i] = fl.indexOf('E') >= 0;
    }
    return { op: op, preflush: preflush, fua: fua, rahead: rahead,
      sync: sync, meta: meta, secure: secure };
  }
  model.parseRwbs = parseRwbs;

  /* categorize: discard > flush > meta > readahead > sync_read > write >
   * other (design 3.3). */
  function categorize(p) {
    const n = p.op.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const op = p.op[i];
      if (op === 'D') out[i] = CAT_DISCARD;
      else if (p.preflush[i] || op === 'N' || op === 'F') out[i] = CAT_FLUSH;
      else if (p.meta[i]) out[i] = CAT_META;
      else if (op === 'R' && p.rahead[i]) out[i] = CAT_READAHEAD;
      else if (op === 'R') out[i] = CAT_SYNC_READ;
      else if (op === 'W') out[i] = CAT_WRITE;
      else out[i] = CAT_OTHER;
    }
    return out;
  }
  model.categorize = categorize;

  /* prio_flags bitmask (design 3.3). cls/ux/fg_meta null -> no flag. */
  function prioFlags(p, cls, ux, fgMeta) {
    const n = p.op.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let f = 0;
      const c = cls[i];
      if (!isNull(c)) {
        if (c === 1) f += PRIO_RT;
        if (c === 3) f += PRIO_IDLE;
      }
      if (!isNull(ux[i]) && ux[i] !== 0) f += PRIO_UX;
      if (!isNull(fgMeta[i]) && fgMeta[i] !== 0) f += PRIO_FG_META;
      if (p.sync[i]) f += PRIO_SYNC;
      if (p.meta[i]) f += PRIO_META;
      if (p.fua[i]) f += PRIO_FUA;
      out[i] = f;
    }
    return out;
  }
  model.prioFlags = prioFlags;

  // ------------------------------------------------------------- pairing

  const PAIR_COLS = ['dev', 'sector', 't_ins', 'ins_utid', 't_iss0',
    't_iss', 'iss_utid', 't_cmp', 'err', 'bytes', 'nr_sector', 'rwbs',
    'issue_count', 'cmp_lost', 'incomplete'];

  const _R_DEV = 0, _R_SEC = 1, _R_TINS = 2, _R_INSU = 3, _R_TISS0 = 4,
    _R_TISS = 5, _R_ISSU = 6, _R_TCMP = 7, _R_ERR = 8, _R_BYTES = 9,
    _R_NR = 10, _R_RWBS = 11, _R_ICNT = 12, _R_LOST = 13;

  /* pair_requests: (dev, sector) keyed insert/issue/complete state
   * machine (design 3.1). Returns {req, counters}. */
  function pairRequests(rqInsert, rqIssue, rqComplete) {
    const counters = { orphan_complete: 0, dropped_insert: 0,
      incomplete: 0, cmp_lost: 0 };

    // concat order: inserts, issues, completes (stable within equal keys)
    const evs = [];
    const ni = nrows(rqInsert), ns = nrows(rqIssue), nc = nrows(rqComplete);
    if (ni + ns + nc === 0) {
      const data = {};
      for (const c of PAIR_COLS) data[c] = [];
      return { req: { columns: PAIR_COLS.slice(), data: data },
        counters: counters };
    }
    for (let i = 0; i < ni; i++) {
      evs.push({ dev: col(rqInsert, 'dev')[i],
        sector: col(rqInsert, 'sector')[i],
        ts: col(rqInsert, 'ts')[i], kind: 0,
        utid: col(rqInsert, 'utid')[i], error: null,
        bytes: col(rqInsert, 'bytes')[i],
        nr: col(rqInsert, 'nr_sector')[i],
        rwbs: col(rqInsert, 'rwbs')[i] });
    }
    for (let i = 0; i < ns; i++) {
      evs.push({ dev: col(rqIssue, 'dev')[i],
        sector: col(rqIssue, 'sector')[i],
        ts: col(rqIssue, 'ts')[i], kind: 1,
        utid: col(rqIssue, 'utid')[i], error: null,
        bytes: col(rqIssue, 'bytes')[i],
        nr: col(rqIssue, 'nr_sector')[i],
        rwbs: col(rqIssue, 'rwbs')[i] });
    }
    for (let i = 0; i < nc; i++) {
      evs.push({ dev: col(rqComplete, 'dev')[i],
        sector: col(rqComplete, 'sector')[i],
        ts: col(rqComplete, 'ts')[i], kind: 2,
        utid: null, error: col(rqComplete, 'error')[i],
        bytes: null, nr: col(rqComplete, 'nr_sector')[i],
        rwbs: col(rqComplete, 'rwbs')[i] });
    }
    // evs.sort_values(["dev","sector","ts","kind"], kind="mergesort")
    const devA = evs.map(function (e) { return e.dev; });
    const secA = evs.map(function (e) { return e.sector; });
    const tsA = evs.map(function (e) { return e.ts; });
    const kindA = evs.map(function (e) { return e.kind; });
    const order = frame.argsort([devA, secA, tsA, kindA], evs.length);

    const reqs = [];
    let cur = null, curSet = false;
    let pend = null;       // inserted, not yet issued
    let infl = [];         // issued, not yet completed

    function finKey() {
      // cmp_lost if any LATER event exists on the key (a following
      // in-flight request or a pending insert); the very last open
      // request is genuinely incomplete.
      if (pend !== null) {
        for (const r of infl) r[_R_LOST] = 1;
        reqs.push(pend);
      } else {
        for (let k = 0; k < infl.length - 1; k++) infl[k][_R_LOST] = 1;
      }
      for (const r of infl) reqs.push(r);
      pend = null;
      infl = [];
    }

    for (const ei of order) {
      const e = evs[ei];
      if (!curSet || e.dev !== cur.dev || e.sector !== cur.sec) {
        finKey();
        cur = { dev: e.dev, sec: e.sector };
        curSet = true;
      }
      if (e.kind === 0) {
        if (pend !== null) counters.dropped_insert += 1;
        pend = [e.dev, e.sector, e.ts, e.utid, null, null, null, null,
          null, e.bytes, e.nr, e.rwbs, 0, 0];
      } else if (e.kind === 1) {
        if (e.nr === 0) {
          // dataless issue (FFS flush): never a requeue; opens a new
          // request and supersedes open dataless requests on the key
          for (const r of infl) {
            if (r[_R_NR] === 0) r[_R_LOST] = 1;
          }
          let r;
          if (pend !== null) {
            r = pend;
            pend = null;
            r[_R_TISS0] = e.ts;
            r[_R_TISS] = e.ts;
            r[_R_ISSU] = e.utid;
            r[_R_BYTES] = e.bytes; r[_R_NR] = e.nr; r[_R_RWBS] = e.rwbs;
            r[_R_ICNT] = 1;
          } else {
            r = [e.dev, e.sector, null, null, e.ts, e.ts, e.utid, null,
              null, e.bytes, e.nr, e.rwbs, 1, 0];
          }
          infl.push(r);
        } else if (pend !== null) {
          const r = pend;
          pend = null;
          r[_R_TISS0] = e.ts;
          r[_R_TISS] = e.ts;
          r[_R_ISSU] = e.utid;
          r[_R_BYTES] = e.bytes; r[_R_NR] = e.nr; r[_R_RWBS] = e.rwbs;
          r[_R_ICNT] = 1;
          infl.push(r);
        } else if (infl.length && infl[infl.length - 1][_R_NR] > 0) {
          const r = infl[infl.length - 1];   // re-issue after requeue
          r[_R_TISS] = e.ts;
          r[_R_ICNT] += 1;
          r[_R_BYTES] = e.bytes; r[_R_NR] = e.nr; r[_R_RWBS] = e.rwbs;
        } else {                              // direct issue, no insert
          infl.push([e.dev, e.sector, null, null, e.ts, e.ts, e.utid,
            null, null, e.bytes, e.nr, e.rwbs, 1, 0]);
        }
      } else {
        if (infl.length) {
          const r = infl.shift();
          r[_R_TCMP] = e.ts;
          r[_R_ERR] = e.error;
          r[_R_LOST] = 0;
          reqs.push(r);
        } else {
          counters.orphan_complete += 1;
        }
      }
    }
    finKey();

    const n = reqs.length;
    const data = {};
    for (const c of PAIR_COLS) data[c] = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = reqs[i];
      data.dev[i] = r[_R_DEV];
      data.sector[i] = r[_R_SEC];
      data.t_ins[i] = r[_R_TINS];
      data.ins_utid[i] = r[_R_INSU];
      data.t_iss0[i] = r[_R_TISS0];
      data.t_iss[i] = r[_R_TISS];
      data.iss_utid[i] = r[_R_ISSU];
      data.t_cmp[i] = r[_R_TCMP];
      data.err[i] = r[_R_ERR];
      data.bytes[i] = r[_R_BYTES];
      data.nr_sector[i] = r[_R_NR];
      data.rwbs[i] = r[_R_RWBS];
      data.issue_count[i] = r[_R_ICNT];
      data.cmp_lost[i] = r[_R_LOST];
      const inc = r[_R_TCMP] === null && r[_R_LOST] === 0;
      data.incomplete[i] = inc;
      if (inc) counters.incomplete += 1;
      if (r[_R_LOST] > 0) counters.cmp_lost += 1;
    }
    return { req: { columns: PAIR_COLS.slice(), data: data },
      counters: counters };
  }
  model.pairRequests = pairRequests;

  // ------------------------------------------------- submitter/priority

  /* match_make_requests: attach t_make + submitter + priority fields
   * from bio_make (design 3.2). Match on (iutid, sector) + op within
   * 50 ms before t_ins (or t_iss0). Mutates req table (adds columns). */
  function matchMakeRequests(req, bioMake, threads, threadRanges) {
    const d = req.data, n = frame.nrows(req);
    for (const c of ['t_make', 'mk_pid', 'mk_utid', 'cls', 'lvl', 'ux',
      'fg_meta']) {
      d[c] = new Array(n).fill(null);
      req.columns.push(c);
    }

    if (n && nrows(bioMake)) {
      // t_key = t_ins.fillna(t_iss0); iutid = ins_utid.fillna(iss_utid)
      const tKey = new Array(n), iutid = new Array(n);
      for (let i = 0; i < n; i++) {
        tKey[i] = isNull(d.t_ins[i]) ? d.t_iss0[i] : d.t_ins[i];
        iutid[i] = isNull(d.ins_utid[i]) ? d.iss_utid[i] : d.ins_utid[i];
      }
      // mk = bio_make rows with ts/sector/utid non-null
      const bm = bioMake.data;
      const bmN = nrows(bioMake);
      const mkOp = parseRwbs(col(bioMake, 'rwbs'));
      const mk = [];   // indices into bioMake rows
      for (let i = 0; i < bmN; i++) {
        if (!isNull(bm.ts[i]) && !isNull(bm.sector[i]) &&
            !isNull(bm.utid[i])) mk.push(i);
      }
      // cand = req rows with t_key and iutid non-null
      const cand = [];
      for (let i = 0; i < n; i++) {
        if (!isNull(tKey[i]) && !isNull(iutid[i])) cand.push(i);
      }
      // joint (iutid, sector) group codes over the union, pandas
      // ngroup(sort=True) semantics: codes assigned in sorted key order.
      const gkeyOf = new Map();   // 'iutid\x01sector' -> code
      {
        const pairs = [];
        for (const i of cand) {
          pairs.push([iutid[i], d.sector[i]]);
        }
        for (const i of mk) {
          pairs.push([bm.utid[i], bm.sector[i]]);
        }
        pairs.sort(function (a, b) {
          return (a[0] - b[0]) || (a[1] - b[1]);
        });
        let code = 0;
        for (const p of pairs) {
          const k = p[0] + '\x01' + p[1];
          if (!gkeyOf.has(k)) gkeyOf.set(k, code++);
        }
      }
      // per-op merge_asof (each cand row belongs to exactly one op group)
      const candByOp = new Map();
      for (const i of cand) {
        const op = d.op[i];
        let a = candByOp.get(op);
        if (!a) { a = []; candByOp.set(op, a); }
        a.push(i);
      }
      const mkByOp = new Map();
      for (const i of mk) {
        const op = mkOp.op[i];
        let a = mkByOp.get(op);
        if (!a) { a = []; mkByOp.set(op, a); }
        a.push(i);
      }
      for (const [op, lidx] of candByOp) {
        const ridx = mkByOp.get(op);
        if (!ridx || !ridx.length) continue;
        // sort left by t_key, right by mk_ts — both stable
        const lOrder = frame.argsort(
          [lidx.map(function (i) { return tKey[i]; })], lidx.length);
        const lOn = new Array(lidx.length), lBy = new Array(lidx.length),
          lids = new Array(lidx.length);
        for (let k = 0; k < lOrder.length; k++) {
          const i = lidx[lOrder[k]];
          lids[k] = i;
          lOn[k] = tKey[i];
          lBy[k] = frame.encodeKeyVal(
            gkeyOf.get(iutid[i] + '\x01' + d.sector[i]));
        }
        const rOrder = frame.argsort(
          [ridx.map(function (i) { return bm.ts[i]; })], ridx.length);
        const rOn = new Array(ridx.length), rBy = new Array(ridx.length);
        for (let k = 0; k < rOrder.length; k++) {
          const i = ridx[rOrder[k]];
          rOn[k] = bm.ts[i];
          rBy[k] = frame.encodeKeyVal(
            gkeyOf.get(bm.utid[i] + '\x01' + bm.sector[i]));
        }
        const hit = frame.mergeAsof({
          leftOn: lOn, rightOn: rOn, leftBy: lBy, rightBy: rBy,
          direction: 'backward', tolerance: MAKE_MATCH_TOL_NS });
        for (let k = 0; k < hit.length; k++) {
          const j = hit[k];
          if (j < 0) continue;
          const mi = ridx[rOrder[j]];
          const li = lids[k];
          d.t_make[li] = bm.ts[mi];
          d.mk_pid[li] = bm.pid[mi];
          d.mk_utid[li] = bm.utid[mi];
          d.cls[li] = bm['class'][mi];
          d.lvl[li] = bm.priority[mi];
          const u1 = isNull(bm.is_ux_task[mi]) ? 0 : bm.is_ux_task[mi];
          const u2 = isNull(bm.is_ux_loop[mi]) ? 0 : bm.is_ux_loop[mi];
          d.ux[li] = (u1 | u2) | 0;
          d.fg_meta[li] = bm.FG_META[mi];
        }
      }
    }

    // submitter utid: tid -> utid via threads (range disambiguation),
    // then mk_utid, ins_utid, iss_utid.
    const utid = new Array(n).fill(null);
    let anyPid = false;
    for (let i = 0; i < n; i++) {
      if (!isNull(d.mk_pid[i])) { anyPid = true; break; }
    }
    if (n && anyPid && nrows(threads)) {
      const th = threads.data;
      const tr = threadRanges ? threadRanges.data : null;
      const trMap = new Map();   // utid -> [[ts_min, ts_max], ...]
      if (tr && nrows(threadRanges)) {
        for (let i = 0; i < nrows(threadRanges); i++) {
          const u = tr.utid[i];
          if (isNull(u)) continue;
          let a = trMap.get(u);
          if (!a) { a = []; trMap.set(u, a); }
          a.push([tr.ts_min[i], tr.ts_max[i]]);
        }
      }
      // by_tid: tid -> [[utid, ts_min, ts_max], ...] in threads row order
      const byTid = new Map();
      for (let i = 0; i < nrows(threads); i++) {
        const tid = th.tid[i];
        if (isNull(tid)) continue;
        const ranges = trMap.get(th.utid[i]) || [[null, null]];
        for (const rg of ranges) {
          const lo = isNull(rg[0]) ? -Infinity : rg[0];
          const hi = isNull(rg[1]) ? Infinity : rg[1];
          let a = byTid.get(tid);
          if (!a) { a = []; byTid.set(tid, a); }
          a.push([th.utid[i], lo, hi]);
        }
      }
      const single = new Map();
      for (const [tid, cands2] of byTid) {
        if (cands2.length === 1) single.set(tid, cands2[0][0]);
      }
      for (let i = 0; i < n; i++) {
        const pid = d.mk_pid[i];
        if (isNull(pid)) continue;
        const u = single.get(pid);
        if (u !== undefined && !isNull(u)) {
          utid[i] = u;
          continue;
        }
        // pandas multi: utid.isna() & pids.notna() & pids.isin(by_tid)
        const cands2 = byTid.get(pid);
        if (!cands2) continue;
        const tMk = d.t_make[i];
        let hit = null;
        for (const c of cands2) {
          if (c[1] <= tMk && tMk <= c[2]) { hit = c[0]; break; }
        }
        if (hit === null) {
          // max(cands, key=ts_min) — first max on ties
          let best = cands2[0];
          for (const c of cands2) {
            if (c[1] > best[1]) best = c;
          }
          hit = best[0];
        }
        utid[i] = hit;
      }
    }
    const ucol = new Array(n);
    for (let i = 0; i < n; i++) {
      ucol[i] = !isNull(utid[i]) ? utid[i]
        : !isNull(d.mk_utid[i]) ? d.mk_utid[i]
        : !isNull(d.ins_utid[i]) ? d.ins_utid[i]
        : d.iss_utid[i];
    }
    d.utid = ucol;
    req.columns.push('utid');
  }
  model.matchMakeRequests = matchMakeRequests;

  /* enrich_requests: req_tag from mq_complete; requeue count/reason +
   * requeue event list (design 3.1 tail). Mutates req; returns requeues
   * table {ts, req, reason}. */
  function enrichRequests(req, mqComplete, mqRequeue, tMax) {
    const d = req.data, n = frame.nrows(req);
    d.req_id = new Array(n);
    d.tag = new Array(n).fill(null);
    d.rq_n = new Array(n);
    d.rq_reason = new Array(n).fill(null);
    req.columns.push('req_id', 'tag', 'rq_n', 'rq_reason');
    for (let i = 0; i < n; i++) {
      d.req_id[i] = i;
      const ic = isNull(d.issue_count[i]) ? 0 : d.issue_count[i];
      d.rq_n[i] = Math.max(ic - 1, 0);
    }
    const requeues = { columns: ['ts', 'req', 'reason'],
      data: { ts: [], req: [], reason: [] } };

    let haveCmp = false;
    for (let i = 0; i < n; i++) {
      if (!isNull(d.t_cmp[i])) { haveCmp = true; break; }
    }
    if (nrows(mqComplete) && haveCmp) {
      const mc = mqComplete.data;
      // left = req rows with t_cmp sorted by t_cmp; right = mq_complete
      // sorted by ts. by = (dev, sector); nearest within 1 ms.
      const lidx = [];
      for (let i = 0; i < n; i++) if (!isNull(d.t_cmp[i])) lidx.push(i);
      const lOrder = frame.argsort(
        [lidx.map(function (i) { return d.t_cmp[i]; })], lidx.length);
      const lOn = new Array(lidx.length), lBy = new Array(lidx.length),
        lids = new Array(lidx.length);
      for (let k = 0; k < lOrder.length; k++) {
        const i = lidx[lOrder[k]];
        lids[k] = i;
        lOn[k] = d.t_cmp[i];
        lBy[k] = frame.byKey([d.dev[i], d.sector[i]]);
      }
      const rn = nrows(mqComplete);
      const rOrder = frame.argsort([mc.ts], rn);
      const rOn = new Array(rn), rBy = new Array(rn);
      for (let k = 0; k < rn; k++) {
        const i = rOrder[k];
        rOn[k] = mc.ts[i];
        rBy[k] = frame.byKey([mc.dev[i], mc.sector[i]]);
      }
      const hit = frame.mergeAsof({
        leftOn: lOn, rightOn: rOn, leftBy: lBy, rightBy: rBy,
        direction: 'nearest', tolerance: TAG_MATCH_TOL_NS });
      for (let k = 0; k < hit.length; k++) {
        const j = hit[k];
        if (j >= 0) d.tag[lids[k]] = mc.req_tag[rOrder[j]];
      }
    }

    if (nrows(mqRequeue) && n) {
      const rq = mqRequeue.data;
      const rn = nrows(mqRequeue);
      const reason = new Array(rn).fill(null);
      for (let i = 0; i < rn; i++) {
        const log = rq.rq_log[i];
        if (isNull(log)) continue;
        const m = REQUEUE_RE.exec(String(log));
        if (m) {
          const v = Number(m[1]);
          if (!Number.isNaN(v)) reason[i] = v;
        }
      }
      // base = req rows with t_start = t_ins.fillna(t_iss0) non-null
      const bidx = [];
      const tStart = new Array(n);
      for (let i = 0; i < n; i++) {
        tStart[i] = isNull(d.t_ins[i]) ? d.t_iss0[i] : d.t_ins[i];
        if (!isNull(tStart[i])) bidx.push(i);
      }
      // left = requeue events sorted by ts; right = base sorted t_start;
      // backward, by (dev, sector) — the request a requeue belongs to is
      // the latest one that started on the key.
      const lOrder = frame.argsort([rq.ts], rn);
      const lOn = new Array(rn), lBy = new Array(rn);
      for (let k = 0; k < rn; k++) {
        const i = lOrder[k];
        lOn[k] = rq.ts[i];
        lBy[k] = frame.byKey([rq.dev[i], rq.sector[i]]);
      }
      const rOrder = frame.argsort(
        [bidx.map(function (i) { return tStart[i]; })], bidx.length);
      const rOn = new Array(bidx.length), rBy = new Array(bidx.length);
      for (let k = 0; k < rOrder.length; k++) {
        const i = bidx[rOrder[k]];
        rOn[k] = tStart[i];
        rBy[k] = frame.byKey([d.dev[i], d.sector[i]]);
      }
      const hit = frame.mergeAsof({
        leftOn: lOn, rightOn: rOn, leftBy: lBy, rightBy: rBy,
        direction: 'backward' });
      // ok = matched && ts <= (t_cmp || t_max); iterate in ts order
      const cnt = new Map();
      for (let k = 0; k < hit.length; k++) {
        const j = hit[k];
        if (j < 0) continue;
        const ri = bidx[rOrder[j]];
        const lts = rq.ts[lOrder[k]];
        const end = isNull(d.t_cmp[ri]) ? tMax : d.t_cmp[ri];
        if (!(lts <= end)) continue;
        const rid = d.req_id[ri];
        cnt.set(rid, (cnt.get(rid) || 0) + 1);
        d.rq_reason[ri] = reason[lOrder[k]];   // last in ts order wins
        requeues.data.ts.push(lts);
        requeues.data.req.push(rid);
        requeues.data.reason.push(reason[lOrder[k]]);
      }
      for (const [rid, c] of cnt) {
        if (c > d.rq_n[rid]) d.rq_n[rid] = c;
      }
    }
    return requeues;
  }
  model.enrichRequests = enrichRequests;

  // ------------------------------------------------------------- slots

  /* assign_slots: greedy lowest-free-slot per dev over
   * [t_iss, t_cmp | min(t_max, t_iss + 200ms)]; cmp_lost = zero length.
   * Returns {slot: Array(n|null), lanes: Map(dev -> n_slots)}. */
  function assignSlots(req, tMax) {
    const d = req.data, n = frame.nrows(req);
    const slot = new Array(n).fill(null);
    const lanes = new Map();
    const lostCol = d.cmp_lost || new Array(n).fill(0);
    // g_in = rows with t_iss, grouped by dev (pandas: sorted dev order)
    const groups = frame.groupBy([d.dev.map(function (v, i) {
      return isNull(d.t_iss[i]) ? null : v;
    })], n);
    const tupleCmp = function (a, b) {
      return (a[0] - b[0]) || (a[1] - b[1]);
    };
    const numCmp = function (a, b) { return a - b; };
    for (const g of groups) {
      const dev = g.key;
      const idxs = g.idxs;
      const order = frame.argsort(
        [idxs.map(function (i) { return d.t_iss[i]; })], idxs.length);
      const busy = new frame.Heap(tupleCmp);   // [end, slot]
      const free = new frame.Heap(numCmp);     // slot ids
      let nSlots = 0;
      for (const oi of order) {
        const idx = idxs[oi];
        const start = d.t_iss[idx];
        const lost = lostCol[idx] ? 1 : 0;
        let end;
        if (lost) end = start;
        else if (isNull(d.t_cmp[idx])) {
          end = Math.min(tMax, start + SLOT_INCOMPLETE_NS);
        } else end = d.t_cmp[idx];
        while (busy.size && busy.peek()[0] <= start) {
          free.push(busy.pop()[1]);
        }
        let s;
        if (free.size) s = free.pop();
        else { s = nSlots; nSlots += 1; }
        busy.push([end, s]);
        slot[idx] = s;
      }
      lanes.set(dev, nSlots);
    }
    return { slot: slot, lanes: lanes };
  }
  model.assignSlots = assignSlots;

  // ------------------------------------------------- build orchestrator

  /* buildReqs: the P4a slice of model.build_model — pair, rwbs, make
   * match, prio, timings, enrich, slots. Input = extracted JSON (the
   * dump/extractAll shape). Returns {req, requeues, counters}. */
  function buildReqs(ex) {
    const T = ex.tables || ex;
    const tMax = ex.t_max || 0;
    const paired = pairRequests(T.rq_insert, T.rq_issue, T.rq_complete);
    const req = paired.req;
    const counters = paired.counters;
    const n = frame.nrows(req);
    let requeues = { columns: ['ts', 'req', 'reason'],
      data: { ts: [], req: [], reason: [] } };

    if (n) {
      const d = req.data;
      const parsed = parseRwbs(d.rwbs);
      d.op = parsed.op;
      d.cat = categorize(parsed);
      req.columns.push('op', 'cat');
      matchMakeRequests(req, T.bio_make, T.threads, T.thread_ranges);
      d.prio = prioFlags(parsed, d.cls, d.ux, d.fg_meta);
      req.columns.push('prio');
      // q_ns / svc_ns / total_ns
      d.q_ns = new Array(n);
      d.svc_ns = new Array(n);
      d.total_ns = new Array(n);
      req.columns.push('q_ns', 'svc_ns', 'total_ns');
      for (let i = 0; i < n; i++) {
        d.q_ns[i] = isNull(d.t_iss0[i]) || isNull(d.t_ins[i]) ? null
          : d.t_iss0[i] - d.t_ins[i];
        d.svc_ns[i] = isNull(d.t_cmp[i]) || isNull(d.t_iss[i]) ? null
          : d.t_cmp[i] - d.t_iss[i];
        const t0 = !isNull(d.t_make[i]) ? d.t_make[i]
          : !isNull(d.t_ins[i]) ? d.t_ins[i]
          : d.t_iss0[i];
        d.total_ns[i] = isNull(d.t_cmp[i]) || isNull(t0) ? null
          : d.t_cmp[i] - t0;
      }
      requeues = enrichRequests(req, T.mq_complete, T.mq_requeue, tMax);
      const sl = assignSlots(req, tMax);
      d.slot = sl.slot;
      d.lanes = new Array(n);
      req.columns.push('slot', 'lanes');
      for (let i = 0; i < n; i++) {
        const l = sl.lanes.get(d.dev[i]);
        d.lanes[i] = l === undefined ? 0 : l;
      }
    } else {
      // pandas build_model: assign cat/prio/req_id/op, then NaN-fill the
      // same column list (mk_utid is never created on the empty path —
      // mirrored exactly).
      const addCols = ['cat', 'prio', 'req_id', 'op', 't_make', 'mk_pid',
        'cls', 'lvl', 'ux', 'fg_meta', 'utid', 'q_ns', 'svc_ns',
        'total_ns', 'tag', 'rq_n', 'rq_reason', 'slot', 'lanes',
        'file', 'foff', 'flen', 'fsrc', 'batch'];
      for (const c of addCols) {
        if (req.columns.indexOf(c) < 0) {
          req.columns.push(c);
          req.data[c] = [];
        }
      }
    }
    return { req: req, requeues: requeues, counters: counters };
  }
  model.buildReqs = buildReqs;

  model.PAIR_COLS = PAIR_COLS;
  model.MAKE_MATCH_TOL_NS = MAKE_MATCH_TOL_NS;
  model.TAG_MATCH_TOL_NS = TAG_MATCH_TOL_NS;
  model.SLOT_INCOMPLETE_NS = SLOT_INCOMPLETE_NS;
})();
