'use strict';
/* stats.js: IOT.stats(w0, w1, opts) — THE single accounting
   implementation for all analysis tabs (design 5.5).

   Window W = [w0, w1] (ns, relative t0). Request interval
   [s,e] = [t_iss, t_cmp], incomplete e = min(dur, t_iss+200ms);
   requests without t_iss are not counted.
   f = |[s,e] ∩ W| / (e−s)  (e==s: f=1 iff s ∈ W else 0).
   bytes_in = bytes × f; request count = #requests with f>0.
   R→read, W→write, D/F/N→other (by rwbs op letter).
   rate = bytes_in / (w1−w0) (bytes/ns -> MB/s at display).
   q/svc/total averaged (unweighted) over f>0 requests.
   D-state time = Σ |seg ∩ W| over D segments of IO threads.
   Device filter: disk-only unless opts.inclLoop. */
IOT.statsMod = (function () {
  function procNameOf(D, upid) {
    const pi = D.procOf.get(upid);
    return pi != null ? D.strs[D.procs.name[pi]] : 'upid:' + upid;
  }

  function newAgg() {
    return { n: 0, total: 0, read: 0, write: 0, other: 0,
             qSum: 0, qMax: -1, qN: 0, sSum: 0, sMax: -1, sN: 0, d: 0 };
  }

  function stats(w0, w1, opts) {
    const D = IOT.data.D, R = D.req;
    const inclLoop = !!(opts && opts.inclLoop);
    const W0 = Math.max(0, Math.min(w0, w1));
    const W1 = Math.min(D.dur, Math.max(w0, w1));
    const span = Math.max(1, W1 - W0);

    const out = Object.assign(newAgg(), {
      w0: W0, w1: W1, inclLoop,
      procs: {},        // upid -> agg + name
      threads: {},      // utid -> agg + name/tid/pname
      files: {},        // file id -> {read,n,svcAvg,procs:Set,thrRead:{}}
      fns: {},          // fn str idx -> {segs,dur,iow,max,thr:Set}
      unassoc: { n: 0, bytes: 0, svcSum: 0, svcN: 0 },
      meta: { n: 0, bytes: 0, svcSum: 0, svcN: 0 },
      slow: [],         // {id,total} for total >= D.slowNs
      dTime: {},        // utid -> D ns overlapped W
      latency: [],      // {id,q,s,t,cat} for t_cmp in W
      keyThreads: [],   // {utid,tid,pname,name,d,iowD,wSegs,wTotal,longest}
    });

    // ---- requests
    for (let i = 0; i < D.nReq; i++) {
      const s = R.t_iss[i];
      if (s < 0) continue;
      // cmp_lost requests are zero-length (e == s, f = s∈W ? 1 : 0);
      // the +200ms incomplete rule applies only to cmp_lost = 0
      const e = R.t_cmp[i] >= 0 ? R.t_cmp[i]
        : (R.lost[i] ? s : Math.min(D.t1, s + 200e6));
      const ov = e > s ? Math.min(e, W1) - Math.max(s, W0) : 0;
      const f = e > s ? Math.max(0, ov) / (e - s)
        : (s >= W0 && s <= W1 ? 1 : 0);
      const di = D.devIdx.get(R.dev[i]);
      const devOk = inclLoop || (di != null && D.diskDev[di]);
      const inside = f > 0;
      if (!devOk) {
        // latency tab still uses full set? spec: W + dev filter — keep
        // consistent: filtered everywhere
        continue;
      }
      if (!inside) continue;

      const b = R.bytes[i] * f;
      const op = D.rwbsOp[i];
      out.n++; out.total += b;
      if (op === 1) out.read += b;
      else if (op === 2) out.write += b;
      else out.other += b;

      const utid = R.utid[i];
      const ti = D.tidOf.get(utid);
      const upid = ti != null ? D.threads.upid[ti] : -1;
      const pname = procNameOf(D, upid);

      let p = out.procs[upid] || (out.procs[upid] =
        Object.assign(newAgg(), { upid, name: pname }));
      let t = out.threads[utid] || (out.threads[utid] =
        Object.assign(newAgg(), {
          utid, name: ti != null ? D.strs[D.threads.name[ti]] : 'utid:' + utid,
          tid: ti != null ? D.threads.tid[ti] : -1, pname }));

      for (const a of [p, t]) {
        a.n++; a.total += b;
        if (op === 1) a.read += b; else if (op === 2) a.write += b;
        else a.other += b;
      }
      if (R.t_ins[i] >= 0 && R.t_iss0[i] >= 0) {
        const q = R.t_iss0[i] - R.t_ins[i];
        for (const a of [p, t, out]) {
          a.qSum += q; a.qN++; if (q > a.qMax) a.qMax = q;
        }
      }
      if (R.t_cmp[i] >= 0) {
        const sv = R.t_cmp[i] - R.t_iss[i];
        for (const a of [p, t, out]) {
          a.sSum += sv; a.sN++; if (sv > a.sMax) a.sMax = sv;
        }
        const total = R.t_cmp[i] - D.tSub[i];
        if (total >= D.slowMs * 1e6) out.slow.push({ id: i, total });
      }
      // latency tab population: completed requests with t_cmp in W
      if (R.t_cmp[i] >= 0 && R.t_cmp[i] >= W0 && R.t_cmp[i] < W1) {
        out.latency.push({
          id: i, cat: R.cat[i],
          q: (R.t_ins[i] >= 0 && R.t_iss0[i] >= 0) ?
            R.t_iss0[i] - R.t_ins[i] : -1,
          s: R.t_cmp[i] - R.t_iss[i],
          t: R.t_cmp[i] - D.tSub[i],
        });
      }

      // files: associated reads only
      const fi = R.file[i];
      if (R.fsrc[i] > 0 && fi >= 0) {
        const isMeta = D.files.meta[fi] === 1;
        let fe = out.files[fi] || (out.files[fi] = {
          fi, name: D.strs[D.files.name[fi]],
          hint: D.strs[D.files.hint[fi]] || '', meta: isMeta,
          read: 0, n: 0, svcSum: 0, svcN: 0, procs: {}, thrRead: {} });
        fe.read += b; fe.n++;
        fe.procs[upid] = 1;
        fe.thrRead[utid] = (fe.thrRead[utid] || 0) + b;
        if (R.t_cmp[i] >= 0) {
          fe.svcSum += R.t_cmp[i] - R.t_iss[i]; fe.svcN++;
        }
        if (isMeta) {
          out.meta.n++; out.meta.bytes += b;
          if (R.t_cmp[i] >= 0) {
            out.meta.svcSum += R.t_cmp[i] - R.t_iss[i]; out.meta.svcN++;
          }
        }
      } else if (op === 1 && R.fsrc[i] === 0) {
        out.unassoc.n++; out.unassoc.bytes += b;
        if (R.t_cmp[i] >= 0) {
          out.unassoc.svcSum += R.t_cmp[i] - R.t_iss[i];
          out.unassoc.svcN++;
        }
      }
    }

    // ---- D segments of IO threads: overlap with W
    const DS = D.dst;
    for (let i = 0; i < DS.utid.length; i++) {
      const a = DS.ts[i], e = a + DS.dur[i];
      const ov = Math.min(e, W1) - Math.max(a, W0);
      if (ov <= 0) continue;
      const utid = DS.utid[i];
      out.dTime[utid] = (out.dTime[utid] || 0) + ov;
      const fi = DS.fn[i];
      let fe = out.fns[fi] || (out.fns[fi] =
        { fn: D.strs[fi] || '(未知)', segs: 0, dur: 0, iow: 0, max: -1,
          thr: {} });
      fe.segs++; fe.dur += ov;
      if (DS.iow[i] === 1) fe.iow++;
      if (ov > fe.max) fe.max = ov;
      fe.thr[utid] = 1;
      // roll into thread/proc aggregates (create rows for D-only threads)
      const ti = D.tidOf.get(utid);
      const upid = ti != null ? D.threads.upid[ti] : -1;
      let t = out.threads[utid] || (out.threads[utid] =
        Object.assign(newAgg(), {
          utid, name: ti != null ? D.strs[D.threads.name[ti]] : 'utid:' + utid,
          tid: ti != null ? D.threads.tid[ti] : -1,
          pname: procNameOf(D, upid) }));
      t.d += ov;
      let p = out.procs[upid] || (out.procs[upid] =
        Object.assign(newAgg(), { upid, name: procNameOf(D, upid) }));
      p.d += ov;
      out.d += ov;
    }

    // ---- key threads: main (tid==pid) + RenderThread of non-kernel
    //      IO processes (procs.kt filters kworker & co.)
    for (const pg of D.procList) {
      if (pg.kt) continue;
      for (const th of pg.threads) {
        const isMain = th.tid === pg.pid;
        const isRender = th.name === 'RenderThread';
        if (!isMain && !isRender) continue;
        const ds = D.thrD.get(th.utid) || [];
        let d = 0, iowD = 0, wSegs = 0, wTotal = 0, longest = -1, longestId = -1;
        for (const i of ds) {
          const a = DS.ts[i], e = a + DS.dur[i];
          const ov = Math.min(e, W1) - Math.max(a, W0);
          if (ov <= 0) continue;
          d += ov;
          if (DS.iow[i] === 1) iowD += ov;
          if (ov > longest) { longest = ov; longestId = i; }
          const w0i = D.waitOff[i], w1i = D.waitOff[i + 1];
          if (w1i > w0i) {
            wSegs++;
            for (let k = w0i; k < w1i; k++) {
              const r = D.waitReq[k];
              if (R.t_cmp[r] >= 0) wTotal += R.t_cmp[r] - D.tSub[r];
            }
          }
        }
        out.keyThreads.push({ utid: th.utid, tid: th.tid,
          pname: pg.name, name: th.name, d, iowD, wSegs, wTotal,
          longest, longestId });
      }
    }
    out.keyThreads.sort((a, b) => b.d - a.d);
    return out;
  }

  // JSON-safe projection for tests / cross-checks; procs keyed by upid,
  // files keyed by file id (same-name entities stay separate)
  function statsJson(w0, w1, opts) {
    const s = stats(w0, w1, opts);
    const procs = {}, files = {};
    for (const k in s.procs)
      procs[k] = { name: s.procs[k].name, total: s.procs[k].total,
                   n: s.procs[k].n, read: s.procs[k].read };
    for (const k in s.files)
      files[k] = { name: s.files[k].name + ' · ' + s.files[k].hint,
                   read: s.files[k].read };
    return { n: s.n, total: s.total, read: s.read, write: s.write,
             other: s.other, procs, files, dTime: s.dTime,
             keyThreads: s.keyThreads };
  }

  // read/write speed ranking for the 当前选择 area summary:
  // kind 'proc'|'thr', op 'read'|'write'; up to n entities with prorated
  // bytes > 0 for that op, sorted by bytes desc (rate = bytes/span, B/ns;
  // share = fraction of S[op])
  function topN(S, kind, op, n) {
    const span = Math.max(1, S.w1 - S.w0);
    const denom = op === 'read' ? S.read : S.write;
    const src = kind === 'proc' ? S.procs : S.threads;
    const out = [];
    for (const k in src) {
      const a = src[k];
      const bytes = a[op];
      if (!(bytes > 0)) continue;
      out.push({
        key: kind === 'proc' ? a.upid : a.utid,
        name: kind === 'proc' ? a.name
          : `${a.name} (${a.tid}) · ${a.pname}`,
        bytes, rate: bytes / span,
        share: denom > 0 ? bytes / denom : 0,
      });
    }
    out.sort((x, y) => y.bytes - x.bytes || x.key - y.key);
    return out.slice(0, n);
  }

  // reverse index: req id -> [dst ids] that waited on it (built once)
  function buildReverse() {
    const D = IOT.data.D;
    D.reqDsegs = new Map();
    for (let i = 0; i < D.dst.utid.length; i++) {
      for (let k = D.waitOff[i]; k < D.waitOff[i + 1]; k++) {
        const r = D.waitReq[k];
        let a = D.reqDsegs.get(r);
        if (!a) { a = []; D.reqDsegs.set(r, a); }
        a.push(i);
      }
    }
  }

  return { stats, statsJson, buildReverse, topN };
})();

IOT.stats = IOT.statsMod.stats;
