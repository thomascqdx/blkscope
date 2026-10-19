'use strict';
/* data.js: payload decode -> typed arrays, indexes, counters (design 5.2) */
IOT.data = (function () {
  const D = {};                        // exported data container
  const TS_COLS = new Set(['t_make', 't_ins', 't_iss0', 't_iss', 't_cmp',
                           'ts', 'dur', 'end', 't0_abs']);
  const BIG_COLS = new Set(['sector', 'foff', 'flen', 'bytes']);
  const BIN_NS = 100e3;                // 100 us base bin
  const MIP = 10;                      // mipmap ratio
  const COUNTER_DEFS = ['read', 'write', 'iops', 'ind', 'qdep'];

  async function load() {
    const b64 = document.getElementById('payload').textContent.trim();
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    D.payload = JSON.parse(text);
    build();
    return D;
  }

  function cols(obj) {
    const out = {};
    for (const k in obj) {
      out[k] = TS_COLS.has(k) || BIG_COLS.has(k)
        ? Float64Array.from(obj[k]) : Int32Array.from(obj[k]);
    }
    return out;
  }

  function build() {
    const P = D.payload;
    D.strs = P.strs;
    D.meta = P.meta;
    D.dur = P.meta.dur;                // window duration (ns), t0 == 0
    D.t1 = D.dur;
    D.quality = P.quality || [];
    D.devs = P.devs || [];
    D.devIdx = new Map(D.devs.map((d, i) => [d.dev, i]));
    D.req = cols(P.req);
    D.nReq = D.req.dev.length;
    D.files = cols(P.files);
    D.batches = cols(P.batches);
    D.dst = cols(P.dst);
    D.requeues = cols(P.requeues);
    D.procs = cols(P.procs);
    D.threads = cols(P.threads);
    D.waitOff = Int32Array.from(P.dst.wait_off || []);
    D.waitReq = Int32Array.from(P.dst.wait_req || []);
    D.waitSrc = Int32Array.from(P.dst.wait_src || []);

    const R = D.req, B = D.batches, DS = D.dst;
    D.rwbsOp = new Int8Array(D.nReq);  // 'R'->1, 'W'->2, else 0
    D.tSub = new Float64Array(D.nReq); // t_make|t_ins|t_iss0
    D.svcEnd = new Float64Array(D.nReq); // t_cmp | min(t1, t_iss+200ms)
    D.slowMs = 10;                     // slow-IO threshold (Stage-3 editable)
    for (let i = 0; i < D.nReq; i++) {
      const s = D.strs[R.rwbs[i]] || '';
      let op = 0;
      for (const ch of s) {
        if (ch === 'R') { op = 1; break; }
        if (ch === 'W') { op = 2; break; }
        if (ch === 'D' || ch === 'N') break;
      }
      D.rwbsOp[i] = op;
      D.tSub[i] = R.t_make[i] >= 0 ? R.t_make[i]
        : (R.t_ins[i] >= 0 ? R.t_ins[i] : R.t_iss0[i]);
      // zero-length for cmp_lost requests (design 3.8): end = t_iss,
      // no +200ms; only genuinely-incomplete ones get the extension
      D.svcEnd[i] = R.t_cmp[i] >= 0 ? R.t_cmp[i]
        : (R.lost[i] ? R.t_iss[i]
                     : Math.min(D.t1, R.t_iss[i] + 200e6));
    }

    // ---- maps
    D.tidOf = new Map();               // utid -> threads index
    for (let i = 0; i < D.threads.utid.length; i++)
      D.tidOf.set(D.threads.utid[i], i);
    D.procOf = new Map();              // upid -> procs index
    for (let i = 0; i < D.procs.upid.length; i++)
      D.procOf.set(D.procs.upid[i], i);

    // ---- per-dev per-slot request lists (sorted by t_iss)
    D.devLanes = D.devs.map(() => []);
    for (let i = 0; i < D.nReq; i++) {
      if (R.slot[i] < 0 || R.t_iss[i] < 0) continue;
      const di = D.devIdx.get(R.dev[i]);
      if (di == null) continue;
      const lanes = D.devLanes[di];
      while (lanes.length <= R.slot[i]) lanes.push([]);
      lanes[R.slot[i]].push(i);
    }
    for (const lanes of D.devLanes)
      for (const l of lanes) l.sort((a, b) => R.t_iss[a] - R.t_iss[b]);

    // ---- per-dev scheduler queue lanes (design 5.3.1): requests packed
    //      greedily lowest-free-lane over [t_ins | t_iss0, t_iss];
    //      lane count = peak simultaneous queue depth.
    D.devQueue = D.devs.map(() => []);
    D.reqQLane = new Map();                // req id -> {dev, lane}
    {
      const items = [];
      for (let i = 0; i < D.nReq; i++) {
        const a = R.t_ins[i] >= 0 ? R.t_ins[i] : R.t_iss0[i];
        const b = R.t_iss[i];
        if (a < 0 || b < 0 || b <= a) continue;
        const di = D.devIdx.get(R.dev[i]);
        if (di == null) continue;
        items.push([a, i, di]);
      }
      items.sort((x, y) => x[0] - y[0]);
      const laneEnds = D.devs.map(() => []);
      for (const [a, i, di] of items) {
        const le = laneEnds[di];
        let placed = false;
        for (let r = 0; r < le.length; r++) {
          if (le[r] <= a) {
            D.devQueue[di][r].push(i); le[r] = R.t_iss[i];
            D.reqQLane.set(i, { dev: R.dev[i], lane: r });
            placed = true; break;
          }
        }
        if (!placed) {
          le.push(R.t_iss[i]);
          D.devQueue[di].push([i]);
          D.reqQLane.set(i, { dev: R.dev[i], lane: le.length - 1 });
        }
      }
    }

    // ---- per-utid request sub-rows (packed [t_sub, t_cmp]), batches, D segs
    D.thrReqs = new Map();             // utid -> {ids sorted by tSub, sub[][]}
    for (let i = 0; i < D.nReq; i++) {
      const u = R.utid[i];
      if (u < 0 || D.tSub[i] < 0) continue;
      let e = D.thrReqs.get(u);
      if (!e) { e = { ids: [], sub: [] }; D.thrReqs.set(u, e); }
      e.ids.push(i);
    }
    const SUBROW_CAP = 4;              // IO 请求 sub-rows capped at 4;
    for (const e of D.thrReqs.values()) {  // overflow shares the last one
      e.ids.sort((a, b) => D.tSub[a] - D.tSub[b]);
      const ends = [];
      for (const i of e.ids) {
        const end = D.svcEnd[i];
        let placed = false;
        for (let r = 0; r < ends.length; r++) {
          if (ends[r] <= D.tSub[i]) {
            e.sub[r].push(i); ends[r] = end; placed = true; break;
          }
        }
        if (!placed) {
          if (e.sub.length < SUBROW_CAP) {
            e.sub.push([i]); ends.push(end);
          } else {
            e.sub[SUBROW_CAP - 1].push(i);
            e.ovIdx = SUBROW_CAP - 1;
            ends[SUBROW_CAP - 1] = Math.max(ends[SUBROW_CAP - 1], end);
          }
        }
      }
    }
    D.thrBatches = new Map();          // utid -> batch idx sorted by ts
    for (let i = 0; i < B.utid.length; i++) {
      let e = D.thrBatches.get(B.utid[i]);
      if (!e) { e = []; D.thrBatches.set(B.utid[i], e); }
      e.push(i);
    }
    for (const e of D.thrBatches.values()) e.sort((a, b) => B.ts[a] - B.ts[b]);
    D.thrD = new Map();                // utid -> dst idx sorted by ts
    for (let i = 0; i < DS.utid.length; i++) {
      let e = D.thrD.get(DS.utid[i]);
      if (!e) { e = []; D.thrD.set(DS.utid[i], e); }
      e.push(i);
    }
    for (const e of D.thrD.values()) e.sort((a, b) => DS.ts[a] - DS.ts[b]);

    // ---- processes ordered by disk IO bytes (design 3.8/5.2)
    D.diskDev = new Uint8Array(D.devs.length);
    for (let i = 0; i < D.devs.length; i++)
      D.diskDev[i] = D.devs[i].kind === 'disk' ? 1 : 0;
    const thrBytes = new Float64Array(D.threads.utid.length);
    for (let i = 0; i < D.nReq; i++) {
      const di = D.devIdx.get(R.dev[i]);
      if (di == null || !D.diskDev[di]) continue;
      const ti = D.tidOf.get(R.utid[i]);
      if (ti != null) thrBytes[ti] += R.bytes[i];
    }
    const procsMap = new Map();        // upid -> {threads, bytes}
    for (let ti = 0; ti < D.threads.utid.length; ti++) {
      const u = D.threads.utid[ti];
      const hasReq = thrBytes[ti] > 0;
      const hasBatch = (D.thrBatches.get(u) || []).length > 0;
      if (!hasReq && !hasBatch) continue;   // only threads with IO
      const upid = D.threads.upid[ti];
      let pg = procsMap.get(upid);
      if (!pg) { pg = { upid, bytes: 0, threads: [] }; procsMap.set(upid, pg); }
      pg.bytes += thrBytes[ti];
      pg.threads.push({
        ti, utid: u, bytes: thrBytes[ti],
        name: D.strs[D.threads.name[ti]] || ('utid:' + u),
        tid: D.threads.tid[ti],
      });
    }
    D.procList = [...procsMap.values()]
      .sort((a, b) => b.bytes - a.bytes)
      .map(p => {
        const pi = D.procOf.get(p.upid);
        p.name = pi != null ? D.strs[D.procs.name[pi]] : ('upid:' + p.upid);
        p.pid = pi != null ? D.procs.pid[pi] : -1;
        p.kt = pi != null && D.procs.kt ? D.procs.kt[pi] : 0;
        p.threads.sort((a, b) => b.bytes - a.bytes);
        return p;
      });

    // ---- requeue tick marks
    D.requeueTs = Float64Array.from(D.requeues.ts || []).sort();

    // ---- counters: {disk, all} each {read,write,iops,ind,qdep} -> levels[]
    D.counters = { disk: buildCounters(true), all: buildCounters(false) };
    D.inclLoop = false;
    IOT.statsMod.buildReverse();       // req id -> [dst ids] (flow overlay)
    return D;
  }

  function buildCounters(diskOnly) {
    const R = D.req, n = D.nReq;
    const nBins = Math.ceil(D.dur / BIN_NS) + 1;
    const read = new Float64Array(nBins), write = new Float64Array(nBins),
      iops = new Float64Array(nBins);
    const ind = new Float64Array(nBins), qdep = new Float64Array(nBins);
    const inEv = [], qEv = [];

    for (let i = 0; i < n; i++) {
      const di = D.devIdx.get(R.dev[i]);
      if (diskOnly && (di == null || !D.diskDev[di])) continue;
      const a = R.t_iss[i];
      if (a >= 0) {
        // rates: bytes/IOP apportioned by overlap share of [t_iss, t_cmp]
        const b = Math.max(R.t_cmp[i] >= 0 ? R.t_cmp[i] : D.svcEnd[i], a + 1);
        const span = b - a;
        const b0 = Math.max(0, Math.floor(a / BIN_NS));
        const b1 = Math.min(nBins - 1, Math.floor((b - 1) / BIN_NS));
        for (let j = b0; j <= b1; j++) {
          const ov = Math.min((j + 1) * BIN_NS, b) - Math.max(j * BIN_NS, a);
          if (ov <= 0) continue;
          const share = ov / span;
          const op = D.rwbsOp[i];
          if (op === 1) read[j] += R.bytes[i] * share;
          else if (op === 2) write[j] += R.bytes[i] * share;
          iops[j] += share;
        }
        inEv.push(a, 1); inEv.push(b, -1);        // in-flight step
      }
      if (R.t_ins[i] >= 0 && R.t_iss0[i] >= 0) {  // queue depth step
        qEv.push(R.t_ins[i], 1); qEv.push(R.t_iss0[i], -1);
      }
    }
    fillDepth(ind, inEv);
    fillDepth(qdep, qEv);
    return buildMip({ read, write, iops, ind, qdep }, nBins);
  }

  // step events [t, delta] -> per-bin max of the exact step function
  function fillDepth(arr, ev) {
    const pts = [];
    for (let i = 0; i < ev.length; i += 2) pts.push([ev[i], ev[i + 1]]);
    pts.sort((a, b) => a[0] - b[0]);
    const has = new Uint8Array(arr.length);
    let cur = 0;
    for (const [t, d] of pts) {
      const j = Math.max(0, Math.min(arr.length - 1, Math.floor(t / BIN_NS)));
      if (cur > arr[j]) arr[j] = cur;   // pre-delta (carry-in) value
      cur += d;
      if (cur > arr[j]) arr[j] = cur;   // post-delta value
      has[j] = 1;
    }
    cur = 0;
    let ei = 0;
    for (let j = 0; j < arr.length; j++) {   // plateau bins
      while (ei < pts.length && pts[ei][0] < (j + 1) * BIN_NS) {
        cur += pts[ei][1]; ei++;
      }
      if (!has[j]) arr[j] = cur;
    }
  }

  function buildMip(c, nBins) {
    const out = {};
    for (const k of COUNTER_DEFS) {
      const isDepth = k === 'ind' || k === 'qdep';
      const levels = [c[k]];
      let arr = c[k];
      while (arr.length > 2000) {
        const n2 = Math.ceil(arr.length / MIP);
        const nx = new Float64Array(n2);
        for (let j = 0; j < n2; j++) {
          const b0 = j * MIP, b1 = Math.min(arr.length, b0 + MIP);
          let v = 0;
          for (let c2 = b0; c2 < b1; c2++)
            v = isDepth ? Math.max(v, arr[c2]) : v + arr[c2];
          nx[j] = v;
        }
        levels.push(nx);
        arr = nx;
      }
      out[k] = { levels, binNs: BIN_NS };
    }
    return out;
  }

  // choose mip level whose bin is >= nsPerPx (else finest/coarsest)
  function levelFor(ctr, nsPerPx) {
    const lv = ctr.levels;
    for (let i = 0; i < lv.length; i++) {
      if (ctr.binNs * Math.pow(MIP, i) >= nsPerPx) return i;
    }
    return lv.length - 1;
  }
  function levelBinNs(ctr, li) { return ctr.binNs * Math.pow(MIP, li); }

  // aggregate a counter level over [t0,t1] -> per the metric's semantic:
  // rates: sum bytes / span; depth: max
  function agg(ctr, li, t0, t1, isDepth) {
    const arr = ctr.levels[li], bs = levelBinNs(ctr, li);
    const i0 = Math.max(0, Math.floor(t0 / bs));
    const i1 = Math.min(arr.length - 1, Math.floor(t1 / bs));
    let v = 0;
    if (isDepth) {
      for (let i = i0; i <= i1; i++) v = Math.max(v, arr[i]);
    } else {
      for (let i = i0; i <= i1; i++) v += arr[i];
      v /= ((i1 - i0 + 1) * bs);
    }
    return v;
  }

  return { load, D, BIN_NS, MIP, COUNTER_DEFS, levelFor, levelBinNs, agg };
})();
