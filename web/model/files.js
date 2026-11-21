/* BLK.model file layer: JS port of the device/file/batch part of
 * src/blkscope/model.py (P4b): new_encode_dev/new_decode_dev/dev_kind,
 * build_files, build_batches, associate_files, build_file_hints,
 * proc_kernel_flag, parse_slot_limit, slot_limits.
 *
 * File keys are the (s_dev, ino) pair kept as a composite string
 * 's_dev\x01ino' — exact, matching model.py's key2id tuple dict (the
 * old combined s_dev * 2**40 + ino arithmetic key was dropped in P4c:
 * it overflowed int64 and degraded into float64 comparisons). — this port uses the composite string 's_dev\x01ino'
 * everywhere fkey/fkey2id appears (never a Number).
 *
 * Depends on BLK.frame (frame.js) and BLK.model basics (req.js).
 * Classic script. Exposes functions on globalThis.BLK.model.
 */
(function () {
  'use strict';
  const BLK = (globalThis.BLK = globalThis.BLK || {});
  const frame = BLK.frame;
  const model = (BLK.model = BLK.model || {});
  const isNull = frame.isNull;
  const nrows = model._nrows;
  const col = model._col;

  const BATCH_GAP_NS = 5000000;          // 5 ms between fm_add of a batch
  const PC_FALLBACK_TOL_NS = 20000000;   // 20 ms: pc_start fallback
  const USETAG_RE = /use_tag:\s*(\d+)/;

  /* File key = the (s_dev, ino) pair as a string. model.py dropped the
   * combined s_dev * 2**40 + ino arithmetic key (it overflowed int64
   * and degraded to float64 comparisons in pandas) in favour of the
   * exact pair — same key space here. */
  const tupleKey = function (sDev, ino) {
    return sDev + '\x01' + ino;
  };

  // ------------------------------------------------------------- devices

  /* Linux new_encode_dev: (minor & 0xff) | (major << 8) |
   * ((minor & ~0xff) << 12). Bit fields don't overlap, so exact
   * multiplication works for the real value range — JS '<<' is only
   * 32-bit and must NOT be used for the <<12 term. */
  model.newEncodeDev = function (major, minor) {
    // (minor & ~0xff) << 12 = floor(minor/256) * 256 * 4096
    return (minor % 256) + major * 256 +
      (minor - (minor % 256)) * 4096;
  };

  /* Inverse -> 'major:minor'. */
  model.newDecodeDev = function (dev) {
    dev = Math.trunc(dev);
    const major = Math.floor(dev / 256) % 4096;
    const hi = Math.floor(dev / 4096);
    const minor = (dev % 256) + (hi - (hi % 256));
    return major + ':' + minor;
  };

  model.devMajor = function (dev) {
    return Math.floor(Math.trunc(dev) / 256) % 4096;
  };

  /* major 7 -> 'loop', major 0 -> 'other', else 'disk'. */
  model.devKind = function (dev) {
    const maj = model.devMajor(dev);
    if (maj === 7) return 'loop';
    if (maj === 0) return 'other';
    return 'disk';
  };

  /* proc_kernel_flag: upid -> 1 for kernel processes (pid 0/2 or parent
   * pid 2, i.e. kthreadd and children like kworkers); else 0. */
  model.procKernelFlag = function (threads) {
    const out = new Map();
    if (!nrows(threads) || !threads.data.upid) return out;
    const t = threads.data;
    const seen = new Set();
    for (let i = 0; i < nrows(threads); i++) {
      const upid = t.upid[i];
      if (isNull(upid) || seen.has(upid)) continue;
      seen.add(upid);
      const pid = t.pid ? t.pid[i] : null;
      const ppid = t.parent_pid ? t.parent_pid[i] : null;
      const kt = (!isNull(pid) && (pid === 0 || pid === 2)) ||
        (!isNull(ppid) && ppid === 2);
      out.set(upid, kt ? 1 : 0);
    }
    return out;
  };

  /* parse_slot_limit: max 'use_tag: N' over rq_log strings; null absent. */
  model.parseSlotLimit = function (rqLog) {
    if (!rqLog || !rqLog.length) return null;
    let best = null;
    for (const v of rqLog) {
      if (isNull(v)) continue;
      const m = USETAG_RE.exec(String(v));
      if (m) {
        const x = Number(m[1]);
        if (!Number.isNaN(x) && (best === null || x > best)) best = x;
      }
    }
    return best;
  };

  /* slot_limits: per-dev max use_tag from mq_complete + mq_requeue;
   * devs with no mq events absent; NaN use_tag -> null. */
  model.slotLimits = function (mqComplete, mqRequeue) {
    const lim = new Map();
    for (const t of [mqComplete, mqRequeue]) {
      if (!nrows(t)) continue;
      const dev = t.data.dev, log = t.data.rq_log;
      for (let i = 0; i < nrows(t); i++) {
        if (dev[i] === null || dev[i] !== dev[i]) continue;
        let ut = null;
        if (!(log[i] === null || log[i] !== log[i])) {
          const m = USETAG_RE.exec(String(log[i]));
          if (m) {
            const x = Number(m[1]);
            if (!Number.isNaN(x)) ut = x;
          }
        }
        // pandas groupby().max() ignores NaN but a dev whose only
        // use_tag is NaN still appears with NaN -> null
        const k = Math.trunc(dev[i]);
        const prev = lim.get(k);
        if (prev === undefined) lim.set(k, ut);
        else if (prev === null) lim.set(k, ut);
        else if (ut !== null && ut > prev) lim.set(k, ut);
      }
    }
    return lim;
  };

  // -------------------------------------------------------------- files

  /* build_files: files table keyed (s_dev, ino); name = mode of
   * pc_start.filebuf (pandas mode() -> sorted modes, iloc[0] = smallest
   * in code-point order). Returns {files, key2id} where files is a
   * columnar table [s_dev, ino, name, is_meta] and key2id maps
   * 'sDev\x01ino' -> row index. */
  model.buildFiles = function (pcStart, fmAdd) {
    const names = new Map();   // 'sd\x01ino' -> name
    const keys = new Set();
    const modeCnt = new Map(); // k -> Map(filebuf -> count)
    if (nrows(pcStart)) {
      const pc = pcStart.data;
      for (let i = 0; i < nrows(pcStart); i++) {
        const sd = model.newEncodeDev(pc.major_dev[i], pc.minor_dev[i]);
        const ino = pc.ino[i];
        const k = tupleKey(sd, ino);
        keys.add(k);
        const fb = pc.filebuf[i];
        if (fb === null || fb !== fb) continue;
        // count filebuf frequencies per key for mode()
        let cnt = modeCnt.get(k);
        if (!cnt) { cnt = new Map(); modeCnt.set(k, cnt); }
        cnt.set(fb, (cnt.get(fb) || 0) + 1);
      }
      // resolve modes: max count, tie -> smallest string (code point)
      for (const [k, cnt] of modeCnt) {
        let best = null, bestN = -1;
        for (const [v, n] of cnt) {
          if (n > bestN || (n === bestN && best !== null &&
              frame.cmpStr(v, best) < 0)) {
            best = v; bestN = n;
          }
        }
        if (best !== null) names.set(k, best);
      }
    }
    if (nrows(fmAdd)) {
      const fa = fmAdd.data;
      const nfa = nrows(fmAdd);
      let lastSd = null, lastIno = null;
      for (let i = 0; i < nfa; i++) {
        const sd = fa.s_dev[i], ino = fa.i_ino[i];
        if (sd === lastSd && ino === lastIno) continue;
        lastSd = sd; lastIno = ino;
        keys.add(tupleKey(sd, ino));
      }
    }
    // files rows sorted by (s_dev, ino)
    const sortedKeys = Array.from(keys).sort(function (a, b) {
      const [sa, ia] = a.split('\x01').map(Number);
      const [sb, ib] = b.split('\x01').map(Number);
      return (sa - sb) || (ia - ib);
    });
    const files = { columns: ['s_dev', 'ino', 'name', 'is_meta'],
      data: { s_dev: [], ino: [], name: [], is_meta: [] } };
    const key2id = new Map();
    for (const k of sortedKeys) {
      const [sd, ino] = k.split('\x01').map(Number);
      let name = names.get(k);
      let isMeta = 0;
      if (name === undefined) {
        if (ino === 1 || ino === 2 || ino === 3) {
          name = 'FS元数据';
          isMeta = 1;
        } else {
          name = 'ino:' + ino;
        }
      }
      files.data.s_dev.push(sd);
      files.data.ino.push(ino);
      files.data.name.push(name);
      files.data.is_meta.push(isMeta);
      key2id.set(k, files.data.s_dev.length - 1);
    }
    return { files: files, key2id: key2id };
  };


  /* build_batches: read batches (design 3.4). Returns
   * {batches: table[batch_id,utid,ts,t_last_add,file_id,page_first,
   *  page_count,has_start], fa: fm_add rows + batch_id (sorted
   *  utid,ts)}. (s_dev, i_ino) pairs identify files throughout. */
  model.buildBatches = function (pcStart, fmAdd, key2id) {
    const BCOLS = ['batch_id', 'utid', 'ts', 't_last_add', 'file_id',
      'page_first', 'page_count', 'has_start'];
    const emptyB = { columns: BCOLS.slice(), data: {
      batch_id: [], utid: [], ts: [], t_last_add: [], file_id: [],
      page_first: [], page_count: [], has_start: [] } };
    const nfa = nrows(fmAdd);
    if (!nfa) {
      return { batches: emptyB,
        fa: { columns: (fmAdd.columns || []).concat(['batch_id']),
          data: Object.assign({}, fmAdd.data, { batch_id: [] }) } };
    }

    // fa = fm_add sorted by (utid, ts) — multi-key lexsort is stable
    const fa0 = fmAdd.data;
    const order = frame.argsort([fa0.utid, fa0.ts], nfa);
    const nf = order.length;
    const fa0idx = fa0.index;
    const fa = { utid: new Array(nf), ts: new Array(nf),
      s_dev: new Array(nf), i_ino: new Array(nf), index: new Array(nf),
      prev_ts: new Array(nf).fill(null), prev_sdev: new Array(nf).fill(null),
      prev_ino: new Array(nf).fill(null), batch_id: new Array(nf).fill(null),
      matched: new Array(nf).fill(false) };
    for (let k = 0; k < nf; k++) {
      const i = order[k];
      fa.utid[k] = fa0.utid[i];
      fa.ts[k] = fa0.ts[i];
      fa.s_dev[k] = fa0.s_dev[i];
      fa.i_ino[k] = fa0.i_ino[i];
      fa.index[k] = fa0idx ? fa0idx[i] : null;
    }
    // groupby('utid').shift() for ts, s_dev, i_ino: rows are (utid,ts)
    // sorted so a utid's rows are contiguous — the shifted value is the
    // previous row's when the utid matches (NaN utid rows are dropped
    // by groupby and keep null predecessors).
    {
      const u = fa.utid;
      for (let i = 1; i < nf; i++) {
        if (u[i] !== null && u[i] === u[i - 1]) {
          fa.prev_ts[i] = fa.ts[i - 1];
          fa.prev_sdev[i] = fa.s_dev[i - 1];
          fa.prev_ino[i] = fa.i_ino[i - 1];
        }
      }
    }

    const starts = [];   // aggregated pc-anchored (sub-)batches
    if (nrows(pcStart)) {
      // pc sorted by ts; pc_idx = row index in that sorted frame
      const pc0 = pcStart.data;
      const npc = nrows(pcStart);
      const pcOrder = frame.argsort([pc0.ts], npc);
      const pcTs = new Array(npc), pcUtid = new Array(npc),
        pcSdev = new Array(npc), pcIno = new Array(npc);
      for (let k = 0; k < npc; k++) {
        const i = pcOrder[k];
        pcTs[k] = pc0.ts[i];
        pcUtid[k] = pc0.utid[i];
        pcSdev[k] = model.newEncodeDev(pc0.major_dev[i],
          pc0.minor_dev[i]);
        pcIno[k] = pc0.ino[i];
      }
      // left = fa sorted by ts (lid = fa row index); numeric by-keys
      // with missing -> NaN (same group semantics as encodeKeyVal)
      const lOrder = frame.argsort([fa.ts], nf);
      const lOn = new Array(nf), lBy = new Float64Array(nf);
      for (let k = 0; k < nf; k++) {
        const v = fa.utid[lOrder[k]];
        lOn[k] = fa.ts[lOrder[k]];
        lBy[k] = (v === null || v !== v) ? NaN : v;
      }
      const rBy = new Float64Array(npc);
      for (let k = 0; k < npc; k++) {
        const v = pcUtid[k];
        rBy[k] = (v === null || v !== v) ? NaN : v;
      }
      const hit = frame.mergeAsof({
        leftOn: lOn, rightOn: pcTs, leftBy: lBy, rightBy: rBy,
        direction: 'backward' });
      const pcTsOf = new Array(nf).fill(null),
        pcSdevOf = new Array(nf).fill(null),
        pcInoOf = new Array(nf).fill(null),
        pcIdxOf = new Array(nf).fill(null);
      for (let k = 0; k < nf; k++) {
        const j = hit[k];
        if (j < 0) continue;
        const fi = lOrder[k];
        pcTsOf[fi] = pcTs[j];
        pcSdevOf[fi] = pcSdev[j];
        pcInoOf[fi] = pcIno[j];
        pcIdxOf[fi] = j;
      }
      for (let i = 0; i < nf; i++) {
        fa.matched[i] = pcIdxOf[i] !== null &&
          pcInoOf[i] === fa.i_ino[i] && pcSdevOf[i] === fa.s_dev[i];
      }

      // hit rows (fa order, already utid/ts sorted). Groups (utid,
      // pc_idx) and combos (utid, pc_idx, sub) are non-decreasing along
      // hit order (merge_asof gives non-decreasing pc_idx within a utid
      // and sub is a cumsum), so first-seen order == pandas' sorted
      // ngroup order — batch codes are assigned sequentially with no
      // key strings or combo sorts.
      const hitIdx = [];
      for (let i = 0; i < nf; i++) if (fa.matched[i]) hitIdx.push(i);
      if (hitIdx.length) {
        const gb = [];               // per batch_code aggregates
        let lastU = null, lastP = -1, runSub = 0, code = -1;
        for (const i of hitIdx) {
          const u = fa.utid[i];
          if (u === null || u !== u) continue;  // groupby drops NaN keys
          const p = pcIdxOf[i];
          const newGroup = u !== lastU || p !== lastP;
          const pprev = fa.prev_ts[i];
          const anchor = newGroup ? pcTsOf[i]
            : (pprev === null ? pcTsOf[i] : pprev);
          const brk = (fa.ts[i] - anchor) > BATCH_GAP_NS;
          runSub = newGroup ? (brk ? 1 : 0) : runSub + (brk ? 1 : 0);
          if (newGroup || !gb[code] || runSub !== gb[code].subMax) {
            // new (utid, pc_idx, sub) combo -> next batch code
            code += 1;
            gb.push({ batch_id: code, utid: u, tsMin: Infinity,
              pcMin: Infinity, subMin: Infinity, subMax: -Infinity,
              tMax: -Infinity, sd: null, ino: null,
              pageMin: Infinity, n: 0 });
          }
          fa.batch_id[i] = code;
          const g = gb[code];
          const sdv = fa.s_dev[i], inv = fa.i_ino[i],
            pgv = fa.index[i];
          if (g.sd === null && sdv !== null) g.sd = sdv;
          if (g.ino === null && inv !== null) g.ino = inv;
          if (fa.ts[i] < g.tsMin) g.tsMin = fa.ts[i];
          if (pcTsOf[i] < g.pcMin) g.pcMin = pcTsOf[i];
          if (runSub < g.subMin) g.subMin = runSub;
          if (runSub > g.subMax) g.subMax = runSub;
          if (fa.ts[i] > g.tMax) g.tMax = fa.ts[i];
          if (pgv !== null && pgv < g.pageMin) g.pageMin = pgv;
          g.n += 1;
          lastU = u; lastP = p;
        }
        for (const g of gb) {
          starts.push({
            batch_id: g.batch_id,
            utid: g.utid,
            ts: g.subMin === 0 ? g.pcMin : g.tsMin,
            t_last_add: g.tMax,
            sd: g.sd, ino: g.ino,
            page_first: g.pageMin === Infinity ? null : g.pageMin,
            page_count: g.n,
            has_start: g.subMin === 0 ? 1 : 0,
          });
        }
      }
    }

    // no-start batches: consecutive unmatched rows, same file,
    // gap <= 5ms, never continuing across a matched row. prev_matched
    // is groupby('utid').shift() over the same contiguous utid runs,
    // seg is a cumsum per utid, and (utid, seg) first-seen order is the
    // sorted ngroup order — sequential codes again.
    const unIdx = [];
    for (let i = 0; i < nf; i++) if (!fa.matched[i]) unIdx.push(i);
    {
      const gb = [];
      let lastU = null, lastSeg = -1, code = starts.length - 1;
      for (const i of unIdx) {
        const u = fa.utid[i];
        if (u === null || u !== u) {
          continue;                 // NaN utid: batch_code NaN, no batch
        }
        const prevMatched = i > 0 && u === fa.utid[i - 1]
          ? fa.matched[i - 1] : false;
        // (s_dev != prev_sdev) | (i_ino != prev_ino) |
        // (ts - prev_ts > GAP) | prev_matched; pandas NaN != NaN ->
        // True, so a null on either side breaks.
        const sdv = fa.s_dev[i], inv = fa.i_ino[i],
          pts = fa.prev_ts[i], psd = fa.prev_sdev[i],
          pino = fa.prev_ino[i];
        const sameFile = sdv !== null && sdv === psd &&
          inv !== null && inv === pino;
        const brk = !sameFile || (fa.ts[i] - pts > BATCH_GAP_NS) ||
          prevMatched;
        const seg = u === lastU ? lastSeg + (brk ? 1 : 0)
          : (brk ? 1 : 0);
        if (u !== lastU || seg !== lastSeg) {
          code += 1;
          gb.push({ batch_id: code, utid: u, tsMin: Infinity,
            tMax: -Infinity, sd: null, ino: null,
            pageMin: Infinity, n: 0 });
        }
        fa.batch_id[i] = code;
        const g = gb[gb.length - 1];   // combos are contiguous
        lastU = u; lastSeg = seg;
        if (g.sd === null && sdv !== null) g.sd = sdv;
        if (g.ino === null && inv !== null) g.ino = inv;
        if (fa.ts[i] < g.tsMin) g.tsMin = fa.ts[i];
        if (fa.ts[i] > g.tMax) g.tMax = fa.ts[i];
        const pgv = fa.index[i];
        if (pgv !== null && pgv < g.pageMin) g.pageMin = pgv;
        g.n += 1;
      }
      for (const g of gb) {
        starts.push({
          batch_id: g.batch_id,
          utid: g.utid,
          ts: g.tsMin,
          t_last_add: g.tMax,
          sd: g.sd, ino: g.ino,
          page_first: g.pageMin === Infinity ? null : g.pageMin,
          page_count: g.n,
          has_start: 0,
        });
      }
    }

    starts.sort(function (a, b) { return a.batch_id - b.batch_id; });
    const nst = starts.length;
    const bd = { batch_id: new Array(nst), utid: new Array(nst),
      ts: new Array(nst), t_last_add: new Array(nst),
      file_id: new Array(nst), page_first: new Array(nst),
      page_count: new Array(nst), has_start: new Array(nst) };
    for (let k = 0; k < nst; k++) {
      const g = starts[k];
      bd.batch_id[k] = g.batch_id;
      bd.utid[k] = g.utid;
      bd.ts[k] = g.ts;
      bd.t_last_add[k] = g.t_last_add;
      const fid = (g.sd === null || g.ino === null) ? undefined
        : key2id.get(tupleKey(g.sd, g.ino));
      bd.file_id[k] = fid === undefined ? null : fid;
      bd.page_first[k] = g.page_first;
      bd.page_count[k] = g.page_count;
      bd.has_start[k] = g.has_start;
    }
    const batches = { columns: BCOLS.slice(), data: bd };
    const faTable = { columns: ['utid', 'ts', 's_dev', 'i_ino', 'index',
        'batch_id'],
      data: fa };
    return { batches: batches, fa: faTable };
  };

  /* associate_files: request -> file heuristic for reads (design 3.4).
   * Mutates req (adds file/foff/flen/batch/fsrc). */
  model.associateFiles = function (req, fa, pcStart, key2id) {
    const d = req.data, n = frame.nrows(req);
    for (const c of ['file', 'foff', 'flen', 'batch']) {
      d[c] = new Array(n).fill(null);
      if (req.columns.indexOf(c) < 0) req.columns.push(c);
    }
    d.fsrc = new Array(n);
    if (req.columns.indexOf('fsrc') < 0) req.columns.push('fsrc');
    const reads = [];
    for (let i = 0; i < n; i++) {
      const isR = d.op[i] === 'R';
      d.fsrc[i] = isR ? 0 : -1;
      if (isR) reads.push(i);
    }
    if (!reads.length) return;

    // reads.t_sub = t_make ?? t_ins ?? t_iss0, drop null t_sub/utid
    const tSub = new Array(n).fill(null);
    const ridx = [];
    const rMake = d.t_make, rIns = d.t_ins, rU = d.utid;
    for (const i of reads) {
      const a = rMake[i], b = rIns[i], u = rU[i];
      const t = !(a === null || a !== a) ? a
        : !(b === null || b !== b) ? b : d.t_iss0[i];
      tSub[i] = t;
      if (!(t === null || t !== t) && !(u === null || u !== u)) {
        ridx.push(i);
      }
    }
    // prev_sub: within each utid, previous row in t_sub-sorted order
    const prevSub = new Float64Array(n).fill(-Infinity);  // by req idx;
    // a missing prev_sub means -inf so every add ts passes the filter
    {
      const srt = frame.argsort(
        [ridx.map(function (i) { return tSub[i]; })], ridx.length);
      const last = new Map();
      for (const k of srt) {
        const i = ridx[k];
        const u = d.utid[i];
        const p = last.get(u);
        if (p !== undefined) prevSub[i] = p;
        last.set(u, tSub[i]);
      }
    }

    if (nrows(fa) && ridx.length) {
      // left = fa rows sorted by ts; right = reads sorted by t_sub;
      // forward: first request submit at/after the add, same utid
      const nfa = nrows(fa);
      const lOrder = frame.argsort([fa.data.ts], nfa);
      const lOn = new Array(nfa), lBy = new Float64Array(nfa);
      for (let k = 0; k < nfa; k++) {
        const v = fa.data.utid[lOrder[k]];
        lOn[k] = fa.data.ts[lOrder[k]];
        lBy[k] = (v === null || v !== v) ? NaN : v;
      }
      const rOrder = frame.argsort(
        [ridx.map(function (i) { return tSub[i]; })], ridx.length);
      const rOn = new Array(ridx.length), rBy = new Float64Array(
        ridx.length);
      for (let k = 0; k < rOrder.length; k++) {
        const i = ridx[rOrder[k]];
        const v = d.utid[i];
        rOn[k] = tSub[i];
        rBy[k] = (v === null || v !== v) ? NaN : v;
      }
      const hit = frame.mergeAsof({
        leftOn: lOn, rightOn: rOn, leftBy: lBy, rightBy: rBy,
        direction: 'forward' });
      // asg: matched adds where ts > prev_sub (prev_sub NaN -> -inf).
      // cnt = groupby(req_idx, s_dev, i_ino) size + min page; bmode =
      // modal batch_id per group (max count, tie -> smallest bid). Run
      // both as contiguous runs over a (req, sd, ino, bid) numeric sort:
      // no per-row key strings or hash maps.
      const aRi = [], aSd = [], aIno = [], aPg = [], aBid = [];
      const faTs = fa.data.ts, faSd = fa.data.s_dev,
        faIno = fa.data.i_ino, faIdx = fa.data.index,
        faBid = fa.data.batch_id;
      for (let k = 0; k < hit.length; k++) {
        const j = hit[k];
        if (j < 0) continue;
        const ri = ridx[rOrder[j]];
        if (!(faTs[lOrder[k]] > prevSub[ri])) continue;
        const sd = faSd[lOrder[k]], ino = faIno[lOrder[k]];
        // groupby drops NaN keys
        if (sd === null || sd !== sd || ino === null || ino !== ino) {
          continue;
        }
        aRi.push(ri); aSd.push(sd); aIno.push(ino);
        aPg.push(faIdx ? faIdx[lOrder[k]] : null);
        aBid.push(faBid[lOrder[k]]);
      }
      const win = new Map();   // req_idx -> {n, pmin, sd, ino, bmode}
      {
        const m = aRi.length;
        const so = frame.argsort([aRi, aSd, aIno, aBid], m);
        let i = 0;
        while (i < m) {
          const ri = aRi[so[i]], sd = aSd[so[i]], ino = aIno[so[i]];
          let n = 0, pmin = Infinity, bestC = -1, bestBid = null;
          let j = i;
          while (j < m && aRi[so[j]] === ri && aSd[so[j]] === sd &&
                 aIno[so[j]] === ino) {
            const bid = aBid[so[j]];
            let q = j;
            while (q < m && aRi[so[q]] === ri && aSd[so[q]] === sd &&
                   aIno[so[q]] === ino && aBid[so[q]] === bid) {
              const pg = aPg[so[q]];
              if (pg !== null && pg < pmin) pmin = pg;
              q += 1;
            }
            const c = q - j;
            n += c;
            if (bid !== null && c > bestC) {
              bestC = c;               // runs see bids in sorted order,
              bestBid = bid;           // so first max is the smallest
            }
            j = q;
          }
          i = j;
          const cur = win.get(ri);
          if (!cur || n > cur.n ||
              (n === cur.n &&
               (sd < cur.sd || (sd === cur.sd && ino < cur.ino)))) {
            win.set(ri, { n: n, pmin: pmin, sd: sd, ino: ino,
              bmode: bestBid });
          }
        }
      }
      for (const [ri, w] of win) {
        const fid = key2id.get(tupleKey(w.sd, w.ino));
        if (fid === undefined) continue;
        d.file[ri] = fid;
        d.foff[ri] = (w.pmin === Infinity ? null : w.pmin) * 4096;
        d.flen[ri] = w.n * 4096;
        d.batch[ri] = w.bmode;
        d.fsrc[ri] = 1;
      }
    }

    // fallback: nearest pc_start on same thread within 20 ms before t_sub
    if (nrows(pcStart)) {
      const miss = [];
      for (let i = 0; i < n; i++) {
        const t = tSub[i], u = rU[i];
        if (d.fsrc[i] === 0 && !(t === null || t !== t) &&
            !(u === null || u !== u)) miss.push(i);
      }
      if (miss.length) {
        const pc0 = pcStart.data;
        const npc = nrows(pcStart);
        const pcOrder = frame.argsort([pc0.ts], npc);
        const pcTs = new Array(npc), pcBy = new Float64Array(npc),
          pcKey = new Array(npc), pcOff = new Array(npc),
          pcByt = new Array(npc);
        for (let k = 0; k < npc; k++) {
          const i = pcOrder[k];
          const v = pc0.utid[i];
          pcTs[k] = pc0.ts[i];
          pcBy[k] = (v === null || v !== v) ? NaN : v;
          pcKey[k] = tupleKey(
            model.newEncodeDev(pc0.major_dev[i], pc0.minor_dev[i]),
            pc0.ino[i]);
          pcOff[k] = pc0.offset[i];
          pcByt[k] = pc0.bytes[i];
        }
        const lOrder = frame.argsort(
          [miss.map(function (i) { return tSub[i]; })], miss.length);
        const lOn = new Array(miss.length), lBy = new Float64Array(
          miss.length);
        for (let k = 0; k < lOrder.length; k++) {
          const i = miss[lOrder[k]];
          const v = d.utid[i];
          lOn[k] = tSub[i];
          lBy[k] = (v === null || v !== v) ? NaN : v;
        }
        const hit = frame.mergeAsof({
          leftOn: lOn, rightOn: pcTs, leftBy: lBy, rightBy: pcBy,
          direction: 'backward', tolerance: PC_FALLBACK_TOL_NS });
        for (let k = 0; k < hit.length; k++) {
          const j = hit[k];
          if (j < 0) continue;
          const fid = key2id.get(pcKey[j]);
          if (fid === undefined) continue;
          const ri = miss[lOrder[k]];
          d.file[ri] = fid;
          d.foff[ri] = pcOff[j];
          d.flen[ri] = pcByt[j];
          d.fsrc[ri] = 2;
        }
      }
    }
  };

  /* build_file_hints: files.hint = process name owning the most
   * associated READ bytes of this file; '' when none. Returns array. */
  model.buildFileHints = function (req, files, threads) {
    const nf = nrows(files);
    const hint = new Array(nf).fill('');
    if (!(nf && frame.nrows(req) && nrows(threads))) return hint;
    const d = req.data;
    // pname: utid -> process_name (first row per utid), '' for null
    const pname = new Map();
    const t = threads.data;
    const seen = new Set();
    for (let i = 0; i < nrows(threads); i++) {
      const u = t.utid[i];
      if (u === null || u !== u || seen.has(u)) continue;
      seen.add(u);
      const pn = t.process_name[i];
      pname.set(u, pn === null || pn !== pn ? '' : pn);
    }
    // gb = rf.groupby([file, proc])["bytes"].sum() as nested Maps
    const gb = new Map();   // fid -> Map(proc -> sum)
    const nr = frame.nrows(req);
    const rOp = d.op, rFile = d.file, rU = d.utid, rB = d.bytes;
    for (let i = 0; i < nr; i++) {
      if (rOp[i] !== 'R') continue;
      const fid = rFile[i], u = rU[i];
      if (fid === null || fid !== fid || u === null || u !== u) {
        continue;
      }
      const proc = pname.get(u) || '';
      const b = rB[i];
      let s = gb.get(fid);
      if (!s) { s = new Map(); gb.set(fid, s); }
      s.set(proc, (s.get(proc) || 0) + (b === null || b !== b ? 0 : b));
    }
    // idxmax per file: max bytes, tie -> smallest proc (code point)
    for (const [fid, sums] of gb) {
      let best = null, bestSum = -Infinity;
      for (const [p, s] of sums) {
        if (s > bestSum || (s === bestSum && best !== null &&
            frame.cmpStr(p, best) < 0)) {
          best = p; bestSum = s;
        }
      }
      if (best !== null && fid >= 0 && fid < nf) hint[fid] = best;
    }
    return hint;
  };
})();
