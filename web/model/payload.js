/* BLK.payload: JS port of src/blkscope/payload.py build_payload (P4b).
 *
 * Model -> columnar payload identical in structure/values to the Python
 * build_payload: requests sorted by t_iss0.fillna(t_ins).fillna(inf)
 * (stable), ids remapped, strings pooled in "strs" in EXACTLY the
 * Python intern order (procs.name -> threads.name -> files.name ->
 * files.hint -> dst.fn -> req.rwbs), times relative to t0 = m.t_min,
 * missing ints = -1.
 *
 * The text-log `script` key is never produced (requirements section 8).
 *
 * BLK.payload.build(model, {name, source, toolVersion, generated})
 * BLK.analyze(ex, opts) = buildModel(ex) + payload.build(model, opts)
 *
 * Load order: frame.js, req.js, files.js, dstate.js, model.js, then this.
 * Classic script. Exposes globalThis.BLK.payload / BLK.analyze.
 */
(function () {
  'use strict';
  const BLK = (globalThis.BLK = globalThis.BLK || {});
  const frame = BLK.frame;
  const model = (BLK.model = BLK.model || {});
  const isNull = frame.isNull;
  const pyToNumber = frame.pyToNumber;

  function Strings() {
    this.pool = [];
    this.idx = new Map();
  }
  Strings.prototype.intern = function (s) {
    const v = isNull(s) || (typeof s === 'number' && Number.isNaN(s))
      ? '' : String(s);
    let i = this.idx.get(v);
    if (i === undefined) {
      i = this.pool.length;
      this.idx.set(v, i);
      this.pool.push(v);
    }
    return i;
  };
  Strings.prototype.col = function (arr) {
    const out = new Array(arr ? arr.length : 0);
    for (let i = 0; i < out.length; i++) out[i] = this.intern(arr[i]);
    return out;
  };

  /* _ints: to_numeric coerce, NaN -> missing, trunc toward zero, -t0. */
  function ints(arr, t0, missing) {
    t0 = t0 || 0;
    missing = missing === undefined ? -1 : missing;
    const out = new Array(arr ? arr.length : 0);
    for (let i = 0; i < out.length; i++) {
      const v = pyToNumber(arr[i]);
      out[i] = Number.isNaN(v) ? missing : Math.trunc(v) - t0;
    }
    return out;
  }

  /* _trace_start_abs: trace_bounds start if 0 < ts <= t0 else t0. */
  function traceStartAbs(traceStart, t0) {
    const ts = Math.trunc(traceStart || 0);
    return (ts > 0 && ts <= t0) ? ts : t0;
  }

  /* datetime.now(utc).isoformat(timespec='seconds') equivalent. */
  function isoNow() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
  }

  const payload = (BLK.payload = BLK.payload || {});

  payload.build = function (m, opts) {
    opts = opts || {};
    const st = new Strings();
    const req = m.req;
    const t0 = m.t_min;
    const n = frame.nrows(req);
    const rd = req.data || {};

    // requests sorted by t_iss0.fillna(t_ins).fillna(inf), stable
    const key = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = rd.t_iss0 ? rd.t_iss0[i] : null;
      const b = rd.t_ins ? rd.t_ins[i] : null;
      key[i] = !isNull(a) ? a : !isNull(b) ? b : Infinity;
    }
    const order = n ? frame.argsort([key], n) : [];
    const remap = new Array(n).fill(0);
    // req.data column already in payload (sorted) order
    function rget(name) {
      const c = rd[name];
      const out = new Array(n);
      for (let k = 0; k < n; k++) out[k] = c ? c[order[k]] : null;
      return out;
    }
    if (n) {
      const rid = rget('req_id');
      for (let k = 0; k < n; k++) remap[Math.trunc(rid[k])] = k;
    }

    // threads / procs
    const th = m.threads;
    const tn = frame.nrows(th);
    const procs = { upid: [], pid: [], name: [], kt: [] };
    const threads = { utid: [], tid: [], name: [], upid: [] };
    if (tn) {
      const t = th.data;
      const kt = model.procKernelFlag(th);
      // up = dropna(upid).drop_duplicates(upid), first occurrence order
      const seen = new Set();
      const uIdx = [];
      for (let i = 0; i < tn; i++) {
        const u = t.upid[i];
        if (isNull(u) || seen.has(u)) continue;
        seen.add(u);
        uIdx.push(i);
      }
      procs.upid = ints(uIdx.map(function (i) { return t.upid[i]; }));
      procs.pid = ints(uIdx.map(function (i) { return t.pid[i]; }));
      procs.name = st.col(uIdx.map(function (i) {
        return t.process_name[i];
      }));
      procs.kt = ints(uIdx.map(function (i) {
        const v = kt.get(t.upid[i]);
        return v === undefined ? 0 : v;
      }));
      threads.utid = ints(t.utid);
      threads.tid = ints(t.tid);
      threads.name = st.col(t.thread_name);
      threads.upid = ints(t.upid);
    }

    const files = { name: [], dev: [], ino: [], meta: [], hint: [] };
    if (frame.nrows(m.files)) {
      const f = m.files.data;
      files.name = st.col(f.name);
      files.dev = ints(f.s_dev);
      files.ino = ints(f.ino);
      files.meta = ints(f.is_meta);
      files.hint = st.col(f.hint);
    }

    const batches = { utid: [], ts: [], end: [], file: [], page0: [],
      pages: [], start: [] };
    if (frame.nrows(m.batches)) {
      const b = m.batches.data;
      batches.utid = ints(b.utid);
      batches.ts = ints(b.ts, t0);
      batches.end = ints(b.t_last_add, t0);
      batches.file = ints(b.file_id);
      batches.page0 = ints(b.page_first);
      batches.pages = ints(b.page_count);
      batches.start = ints(b.has_start);
    }

    const dst = { utid: [], ts: [], dur: [], fn: [], fn_ok: [], iow: [],
      wait_off: [], wait_req: [], wait_src: [] };
    if (frame.nrows(m.dst)) {
      const d = m.dst.data;
      dst.utid = ints(d.utid);
      dst.ts = ints(d.ts, t0);
      dst.dur = ints(d.dur);
      dst.fn = st.col(d.fn);
      dst.fn_ok = ints(d.fn_ok);
      dst.iow = ints(d.iow);
      dst.wait_off = (m.wait_off || []).map(function (v) {
        return Math.trunc(v);
      });
      dst.wait_req = (m.wait_req || []).map(function (v) {
        return remap[Math.trunc(v)];
      });
      dst.wait_src = (m.wait_src || []).map(function (v) {
        return Math.trunc(v);
      });
    }

    const requeues = { ts: [], req: [], reason: [] };
    if (frame.nrows(m.requeues)) {
      const r = m.requeues.data;
      requeues.ts = ints(r.ts, t0);
      requeues.req = (r.req || []).map(function (v) {
        return remap[Math.trunc(v)];
      });
      requeues.reason = ints(r.reason);
    }

    const devs = (m.devs || []).map(function (r) {
      return { dev: Math.trunc(r.dev), name: r.name, kind: r.kind,
        lanes: Math.trunc(r.lanes),
        slot_limit: isNull(r.slot_limit) ? null : Math.trunc(r.slot_limit) };
    });

    const reqCols = {
      dev: ints(rget('dev')), sector: ints(rget('sector')),
      bytes: ints(rget('bytes')), rwbs: st.col(rget('rwbs')),
      cat: ints(rget('cat')), prio: ints(rget('prio')),
      cls: ints(rget('cls')), lvl: ints(rget('lvl')),
      t_make: ints(rget('t_make'), t0), t_ins: ints(rget('t_ins'), t0),
      t_iss0: ints(rget('t_iss0'), t0), t_iss: ints(rget('t_iss'), t0),
      t_cmp: ints(rget('t_cmp'), t0), utid: ints(rget('utid')),
      slot: ints(rget('slot')), tag: ints(rget('tag')),
      rq_n: ints(rget('rq_n')), rq_reason: ints(rget('rq_reason')),
      err: ints(rget('err')), file: ints(rget('file')),
      foff: ints(rget('foff')), flen: ints(rget('flen')),
      fsrc: ints(rget('fsrc')), batch: ints(rget('batch')),
      lost: ints(rget('cmp_lost').map(function (v) {
        return isNull(v) ? 0 : v;
      })),
    };

    const device = {};
    for (const k of Object.keys(m.device || {})) {
      const v = m.device[k];
      device[k] = (typeof v === 'number' && Number.isInteger(v)) ||
        typeof v === 'boolean' ? Math.trunc(v) : v;
    }

    return {
      v: 1,
      meta: {
        name: opts.name,
        source: opts.source,
        t0_abs: Math.trunc(t0),
        trace_start_abs: traceStartAbs(m.trace_start, Math.trunc(t0)),
        dur: Math.trunc(m.t_max - t0),
        device: device,
        generated: opts.generated || isoNow(),
        tool_version: opts.toolVersion || null,
      },
      quality: m.quality,
      strs: st.pool,
      procs: procs,
      threads: threads,
      devs: devs,
      req: reqCols,
      files: files,
      batches: batches,
      dst: dst,
      requeues: requeues,
    };
  };

  /* BLK.analyze(ex, opts): model + payload in one call.
   * opts = {name, source, toolVersion, generated}. */
  BLK.analyze = function (ex, opts) {
    const m = model.buildModel(ex);
    return { model: m, payload: payload.build(m, opts || {}) };
  };
})();
