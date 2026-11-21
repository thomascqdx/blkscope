/* BLK.model file layer: JS port of the device/file/batch part of
 * src/blkscope/model.py (P4b): new_encode_dev/new_decode_dev/dev_kind,
 * build_files, build_batches, associate_files, build_file_hints,
 * proc_kernel_flag, parse_slot_limit, slot_limits.
 *
 * Composite file keys: model.py uses fkey = s_dev * 2**40 + ino which
 * EXCEEDS 2^53 — this port uses the composite string 's_dev\x01ino'
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

  /* File keys. Python has TWO key spaces and they must be mirrored
   * exactly:
   *  - pandas int64 arithmetic (fa['fkey'], win/hit fid computations):
   *    fkey = s_dev * 2**40 + ino wraps two's-complement past 2**63.
   *  - dict keys built in Python ints (fkey2id comprehensions): the
   *    same expression evaluated unbounded — never wraps.
   * So a wrapped column value misses an unwrapped dict key whenever the
   * product overflows (s_dev >~ 8.4M): file_id becomes NaN and file
   * association silently fails — mirrored deliberately for parity.
   * Keys are decimal strings, never Numbers. */
  const _I64 = function (x) { return BigInt.asIntN(64, x); };
  const _FSHIFT = 1n << 40n;
  const fkeyOf = function (sDev, ino) {          // pandas int64 (wraps)
    return _I64(BigInt(Math.trunc(sDev)) * _FSHIFT +
      BigInt(Math.trunc(ino))).toString();
  };
  const fkeyUnwrapped = function (sDev, ino) {   // python int (no wrap)
    return (BigInt(Math.trunc(sDev)) * _FSHIFT +
      BigInt(Math.trunc(ino))).toString();
  };
  /* (s_dev, ino) tuple key — used where Python groups/compares the raw
   * pair, not the arithmetic fkey. */
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
        if (isNull(dev[i])) continue;
        let ut = null;
        if (!isNull(log[i])) {
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
        if (isNull(fb)) continue;
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
      for (let i = 0; i < nrows(fmAdd); i++) {
        keys.add(tupleKey(fa.s_dev[i], fa.i_ino[i]));
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

  /* Python rebuilds fkey2id = {sd*2**40 + ino: fid} from key2id in both
   * build_batches and associate_files — with UNBOUNDED int keys. */
  function fkey2idOf(key2id) {
    const m = new Map();
    for (const [k, fid] of key2id) {
      const [sd, ino] = k.split('\x01').map(Number);
      m.set(fkeyUnwrapped(sd, ino), fid);
    }
    return m;
  }

  /* build_batches: read batches (design 3.4). Returns
   * {batches: table[batch_id,utid,ts,t_last_add,file_id,page_first,
   *  page_count,has_start], fa: fm_add rows + batch_id (sorted
   *  utid,ts)}. fkey is the composite string key throughout. */
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
    const fa = { utid: [], ts: [], s_dev: [], i_ino: [], index: [],
      fkey: [], fkeyNum: [], prev_ts: [], prev_key: [], prev_fkeyNum: [],
      batch_id: [], matched: [] };
    for (const i of order) {
      fa.utid.push(fa0.utid[i]);
      fa.ts.push(fa0.ts[i]);
      fa.s_dev.push(fa0.s_dev[i]);
      fa.i_ino.push(fa0.i_ino[i]);
      fa.index.push(fa0.index ? fa0.index[i] : null);
      const sd = fa0.s_dev[i], ino = fa0.i_ino[i];
      if (isNull(sd) || isNull(ino)) {
        fa.fkey.push(null);
        fa.fkeyNum.push(NaN);   // pandas fkey NaN
      } else {
        const ks = fkeyOf(sd, ino);
        fa.fkey.push(ks);
        fa.fkeyNum.push(Number(BigInt(ks)));
      }
      fa.prev_ts.push(null);
      fa.prev_key.push(null);
      fa.prev_fkeyNum.push(NaN);
      fa.batch_id.push(null);
      fa.matched.push(false);
    }
    const nf = fa.ts.length;
    // groupby('utid').shift() for ts and fkey. NOTE: pandas shift()
    // makes prev_key float64 — the `fkey != prev_key` break test later
    // compares int64 vs float64 as doubles, so inos differing only past
    // float64 precision compare EQUAL. Mirror via fkeyNum (Number of the
    // wrapped int64); NaN keys make `!=` true, like pandas NaN != NaN.
    {
      const last = new Map();
      for (let i = 0; i < nf; i++) {
        const u = fa.utid[i];
        if (isNull(u)) continue;   // pandas groupby drops NaN keys
        if (last.has(u)) {
          fa.prev_ts[i] = last.get(u)[0];
          fa.prev_key[i] = last.get(u)[1];
          fa.prev_fkeyNum[i] = last.get(u)[2];
        }
        last.set(u, [fa.ts[i], fa.fkey[i], fa.fkeyNum[i]]);
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
      // left = fa sorted by ts (lid = fa row index)
      const lOrder = frame.argsort([fa.ts], nf);
      const lOn = new Array(nf), lBy = new Array(nf);
      for (let k = 0; k < nf; k++) {
        lOn[k] = fa.ts[lOrder[k]];
        lBy[k] = frame.encodeKeyVal(fa.utid[lOrder[k]]);
      }
      const rBy = new Array(npc);
      for (let k = 0; k < npc; k++) {
        rBy[k] = frame.encodeKeyVal(pcUtid[k]);
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

      // hit rows (fa order, already utid/ts sorted)
      const hitIdx = [];
      for (let i = 0; i < nf; i++) if (fa.matched[i]) hitIdx.push(i);
      if (hitIdx.length) {
        // head: first per (utid, pc_idx)
        const seen = new Set();
        const head = new Set();
        for (const i of hitIdx) {
          const k = fa.utid[i] + '\x01' + pcIdxOf[i];
          if (!seen.has(k)) { seen.add(k); head.add(i); }
        }
        // anchor + brk + cumsum sub per (utid, pc_idx)
        const anchor = new Array(nf);
        const sub = new Array(nf).fill(0);
        const subMap = new Map();
        for (const i of hitIdx) {
          if (isNull(fa.utid[i])) continue;  // groupby drops NaN keys
          anchor[i] = head.has(i) ? pcTsOf[i]
            : (isNull(fa.prev_ts[i]) ? pcTsOf[i] : fa.prev_ts[i]);
          const brk = (fa.ts[i] - anchor[i]) > BATCH_GAP_NS;
          const gk = fa.utid[i] + '\x01' + pcIdxOf[i];
          const prev = subMap.get(gk) || 0;
          sub[i] = prev + (brk ? 1 : 0);
          subMap.set(gk, sub[i]);
        }
        // batch_code = ngroup(utid, pc_idx, sub) sorted
        const combos = new Set();
        for (const i of hitIdx) {
          if (isNull(fa.utid[i])) continue;
          combos.add(fa.utid[i] + '\x01' + pcIdxOf[i] + '\x01' + sub[i]);
        }
        const comboArr = Array.from(combos).sort(function (a, b) {
          const [ua, pa, sa] = a.split('\x01').map(Number);
          const [ub, pb, sb] = b.split('\x01').map(Number);
          return (ua - ub) || (pa - pb) || (sa - sb);
        });
        const codeOf = new Map();
        comboArr.forEach(function (k, i) { codeOf.set(k, i); });
        for (const i of hitIdx) {
          if (isNull(fa.utid[i])) continue;  // batch_code NaN
          fa.batch_id[i] = codeOf.get(
            fa.utid[i] + '\x01' + pcIdxOf[i] + '\x01' + sub[i]);
        }
        // groupby(batch_code).agg — group order = hit order (sorted by
        // batch_code via sorted key iteration)
        const gbMap = new Map();
        for (const i of hitIdx) {
          const bc = fa.batch_id[i];
          let g = gbMap.get(bc);
          if (!g) {
            g = { batch_id: bc, utid: null, tsMin: Infinity,
              pcMin: Infinity, subMin: Infinity, tMax: -Infinity,
              fkey: null, pageMin: Infinity, n: 0 };
            gbMap.set(bc, g);
          }
          // 'first' = first non-null in group order
          if (g.utid === null && !isNull(fa.utid[i])) g.utid = fa.utid[i];
          if (g.fkey === null && fa.fkey[i] !== null) g.fkey = fa.fkey[i];
          if (fa.ts[i] < g.tsMin) g.tsMin = fa.ts[i];
          if (pcTsOf[i] < g.pcMin) g.pcMin = pcTsOf[i];
          if (sub[i] < g.subMin) g.subMin = sub[i];
          if (fa.ts[i] > g.tMax) g.tMax = fa.ts[i];
          if (!isNull(fa.index[i]) && fa.index[i] < g.pageMin) {
            g.pageMin = fa.index[i];
          }
          g.n += 1;
        }
        const codes = Array.from(gbMap.keys()).sort(function (a, b) {
          return a - b;
        });
        for (const bc of codes) {
          const g = gbMap.get(bc);
          starts.push({
            batch_id: bc,
            utid: g.utid,
            ts: g.subMin === 0 ? g.pcMin : g.tsMin,
            t_last_add: g.tMax,
            fkey: g.fkey,
            page_first: g.pageMin === Infinity ? null : g.pageMin,
            page_count: g.n,
            has_start: g.subMin === 0 ? 1 : 0,
          });
        }
      }
    }

    // no-start batches: consecutive unmatched rows, same fkey,
    // gap <= 5ms, never continuing across a matched row
    const unIdx = [];
    const prevMatched = new Array(nf).fill(false);
    {
      const lastM = new Map();
      for (let i = 0; i < nf; i++) {
        const u = fa.utid[i];
        if (isNull(u)) {           // NaN utid: groupby drops -> NaN->False
          prevMatched[i] = false;
        } else {
          prevMatched[i] = lastM.has(u) ? lastM.get(u) : false;
          lastM.set(u, fa.matched[i]);
        }
        if (!fa.matched[i]) unIdx.push(i);
      }
    }
    {
      const segMap = new Map();
      const seg = new Array(nf).fill(0);
      const combos = new Set();
      for (const i of unIdx) {
        // (fkey != prev_key) | (ts - prev_ts > GAP) | prev_matched;
        // pandas compares the int64 fkey against the float64 shifted
        // prev_key as doubles — fkeyNum reproduces that rounding, and
        // NaN (first row / NaN fkey) makes != true.
        const u = fa.utid[i];
        if (isNull(u)) continue;   // NaN utid: batch_code NaN, no batch
        const brk = fa.fkeyNum[i] !== fa.prev_fkeyNum[i] ||
          (fa.ts[i] - fa.prev_ts[i] > BATCH_GAP_NS) ||
          prevMatched[i];
        const prev = segMap.get(u) || 0;
        seg[i] = prev + (brk ? 1 : 0);
        segMap.set(u, seg[i]);
        combos.add(u + '\x01' + seg[i]);
      }
      const n0 = starts.length;
      const comboArr = Array.from(combos).sort(function (a, b) {
        const [ua, sa] = a.split('\x01').map(Number);
        const [ub, sb] = b.split('\x01').map(Number);
        return (ua - ub) || (sa - sb);
      });
      const codeOf = new Map();
      comboArr.forEach(function (k, i) { codeOf.set(k, i); });
      const gbMap = new Map();
      for (const i of unIdx) {
        if (isNull(fa.utid[i])) continue;
        const bc = n0 + codeOf.get(fa.utid[i] + '\x01' + seg[i]);
        fa.batch_id[i] = bc;
        let g = gbMap.get(bc);
        if (!g) {
          g = { batch_id: bc, utid: null, tsMin: Infinity,
            tMax: -Infinity, fkey: null, pageMin: Infinity, n: 0 };
          gbMap.set(bc, g);
        }
        if (g.utid === null && !isNull(fa.utid[i])) g.utid = fa.utid[i];
        if (g.fkey === null && fa.fkey[i] !== null) g.fkey = fa.fkey[i];
        if (fa.ts[i] < g.tsMin) g.tsMin = fa.ts[i];
        if (fa.ts[i] > g.tMax) g.tMax = fa.ts[i];
        if (!isNull(fa.index[i]) && fa.index[i] < g.pageMin) {
          g.pageMin = fa.index[i];
        }
        g.n += 1;
      }
      for (const g of gbMap.values()) {
        starts.push({
          batch_id: g.batch_id,
          utid: g.utid,
          ts: g.tsMin,
          t_last_add: g.tMax,
          fkey: g.fkey,
          page_first: g.pageMin === Infinity ? null : g.pageMin,
          page_count: g.n,
          has_start: 0,
        });
      }
    }

    starts.sort(function (a, b) { return a.batch_id - b.batch_id; });
    const fkey2id = fkey2idOf(key2id);
    const batches = { columns: BCOLS.slice(), data: {
      batch_id: [], utid: [], ts: [], t_last_add: [], file_id: [],
      page_first: [], page_count: [], has_start: [] } };
    for (const g of starts) {
      batches.data.batch_id.push(g.batch_id);
      batches.data.utid.push(g.utid);
      batches.data.ts.push(g.ts);
      batches.data.t_last_add.push(g.t_last_add);
      const fid = fkey2id.get(g.fkey);
      batches.data.file_id.push(fid === undefined ? null : fid);
      batches.data.page_first.push(g.page_first);
      batches.data.page_count.push(g.page_count);
      batches.data.has_start.push(g.has_start);
    }
    const faTable = { columns: ['utid', 'ts', 's_dev', 'i_ino', 'index',
        'fkey', 'batch_id'],
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
    for (const i of reads) {
      tSub[i] = !isNull(d.t_make[i]) ? d.t_make[i]
        : !isNull(d.t_ins[i]) ? d.t_ins[i]
        : d.t_iss0[i];
      if (!isNull(tSub[i]) && !isNull(d.utid[i])) ridx.push(i);
    }
    // prev_sub: within each utid, previous row in t_sub-sorted order
    const prevSub = new Map();
    {
      const srt = frame.argsort(
        [ridx.map(function (i) { return tSub[i]; })], ridx.length);
      const last = new Map();
      for (const k of srt) {
        const i = ridx[k];
        const u = d.utid[i];
        prevSub.set(i, last.has(u) ? last.get(u) : null);
        last.set(u, tSub[i]);
      }
    }

    if (nrows(fa) && ridx.length) {
      // left = fa rows sorted by ts; right = reads sorted by t_sub;
      // forward: first request submit at/after the add, same utid
      const nfa = nrows(fa);
      const lOrder = frame.argsort([fa.data.ts], nfa);
      const lOn = new Array(nfa), lBy = new Array(nfa);
      for (let k = 0; k < nfa; k++) {
        lOn[k] = fa.data.ts[lOrder[k]];
        lBy[k] = frame.encodeKeyVal(fa.data.utid[lOrder[k]]);
      }
      const rOrder = frame.argsort(
        [ridx.map(function (i) { return tSub[i]; })], ridx.length);
      const rOn = new Array(ridx.length), rBy = new Array(ridx.length);
      for (let k = 0; k < rOrder.length; k++) {
        const i = ridx[rOrder[k]];
        rOn[k] = tSub[i];
        rBy[k] = frame.encodeKeyVal(d.utid[i]);
      }
      const hit = frame.mergeAsof({
        leftOn: lOn, rightOn: rOn, leftBy: lBy, rightBy: rBy,
        direction: 'forward' });
      // asg: matched adds where ts > prev_sub (prev_sub NaN -> -inf)
      // cnt per (req_idx, s_dev, i_ino): n=size, pmin=min page index
      // bm per (req_idx, s_dev, i_ino, batch_id): count -> bmode
      const cnt = new Map();   // 'r\x01sd\x01ino' -> {n, pmin, sd, ino}
      const bm = new Map();    // 'r\x01sd\x01ino\x01b' -> count
      for (let k = 0; k < hit.length; k++) {
        const j = hit[k];
        if (j < 0) continue;
        const ri = ridx[rOrder[j]];
        const ps = prevSub.get(ri);
        const lts = fa.data.ts[lOrder[k]];
        if (!(lts > (ps === null ? -Infinity : ps))) continue;
        const sd = fa.data.s_dev[lOrder[k]];
        const ino = fa.data.i_ino[lOrder[k]];
        if (isNull(sd) || isNull(ino)) continue; // groupby drops NaN keys
        const ck = ri + '\x01' + sd + '\x01' + ino;
        let g = cnt.get(ck);
        if (!g) {
          g = { n: 0, pmin: Infinity, sd: sd, ino: ino, req: ri };
          cnt.set(ck, g);
        }
        g.n += 1;
        const pg = fa.data.index ? fa.data.index[lOrder[k]] : null;
        if (!isNull(pg) && pg < g.pmin) g.pmin = pg;
        const bid = fa.data.batch_id[lOrder[k]];
        if (!isNull(bid)) {
          const bk = ck + '\x01' + bid;
          bm.set(bk, (bm.get(bk) || 0) + 1);
        }
      }
      // bmode: max count per (req_idx, s_dev, i_ino); ties -> smallest
      // batch_id (pandas stable sort keeps groupby's sorted index order)
      const bmode = new Map();
      for (const [bk, c] of bm) {
        const last = bk.lastIndexOf('\x01');
        const ck = bk.slice(0, last);
        const bid = Number(bk.slice(last + 1));
        const cur = bmode.get(ck);
        if (!cur || c > cur.c || (c === cur.c && bid < cur.bid)) {
          bmode.set(ck, { c: c, bid: bid });
        }
      }
      // win: max n per req_idx, tie -> smallest s_dev then smallest i_ino
      const win = new Map();
      for (const g of cnt.values()) {
        const bmE = bmode.get(
          g.req + '\x01' + g.sd + '\x01' + g.ino);
        const cur = win.get(g.req);
        if (!cur || g.n > cur.n ||
            (g.n === cur.n &&
             (g.sd < cur.sd || (g.sd === cur.sd && g.ino < cur.ino)))) {
          win.set(g.req, { n: g.n, pmin: g.pmin, sd: g.sd, ino: g.ino,
            bmode: bmE ? bmE.bid : null });
        }
      }
      const fkey2id = fkey2idOf(key2id);
      for (const [ri, w] of win) {
        const fid = fkey2id.get(fkeyOf(w.sd, w.ino));
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
        if (d.fsrc[i] === 0 && !isNull(tSub[i]) &&
            !isNull(d.utid[i])) miss.push(i);
      }
      if (miss.length) {
        const pc0 = pcStart.data;
        const npc = nrows(pcStart);
        const pcOrder = frame.argsort([pc0.ts], npc);
        const pcTs = new Array(npc), pcBy = new Array(npc),
          pcKey = new Array(npc), pcOff = new Array(npc),
          pcByt = new Array(npc);
        for (let k = 0; k < npc; k++) {
          const i = pcOrder[k];
          pcTs[k] = pc0.ts[i];
          pcBy[k] = frame.encodeKeyVal(pc0.utid[i]);
          /* hit["s_dev"] * 2**40 + hit["ino"] is FLOAT64 in pandas —
           * merge_asof pads s_dev/ino to float64. Plain Number math
           * reproduces it exactly (same IEEE double). */
          pcKey[k] = model.newEncodeDev(pc0.major_dev[i],
            pc0.minor_dev[i]) * 1099511627776 + pc0.ino[i];
          pcOff[k] = pc0.offset[i];
          pcByt[k] = pc0.bytes[i];
        }
        const lOrder = frame.argsort(
          [miss.map(function (i) { return tSub[i]; })], miss.length);
        const lOn = new Array(miss.length), lBy = new Array(miss.length);
        for (let k = 0; k < lOrder.length; k++) {
          const i = miss[lOrder[k]];
          lOn[k] = tSub[i];
          lBy[k] = frame.encodeKeyVal(d.utid[i]);
        }
        const hit = frame.mergeAsof({
          leftOn: lOn, rightOn: pcTs, leftBy: lBy, rightBy: pcBy,
          direction: 'backward', tolerance: PC_FALLBACK_TOL_NS });
        /* fkey2id dict keys are exact Python ints; .map on the float64
         * hit fkeys goes through pandas get_indexer:
         *  - all keys fit int64 -> int64 Index converted to float64:
         *    hit fkeys match the nearest double of each key, later dict
         *    keys win collisions;
         *  - any key beyond int64 -> object Index of Python ints: only
         *    exactly-representable keys can equal a float -> miss
         *    everything else (mirrors pandas, verified empirically). */
        const fkey2idNum = new Map();
        {
          const I64MIN = -(1n << 63n), I64MAX = (1n << 63n) - 1n;
          const ents = [];
          let allI64 = true;
          for (const [k, fid] of key2id) {
            const [sd, ino] = k.split('\x01').map(Number);
            const ex = BigInt(sd) * _FSHIFT + BigInt(ino);
            ents.push([ex, fid]);
            if (ex < I64MIN || ex > I64MAX) allI64 = false;
          }
          for (const [ex, fid] of ents) {
            const n = Number(ex);
            if (allI64 || BigInt(n) === ex) fkey2idNum.set(n, fid);
          }
        }
        for (let k = 0; k < hit.length; k++) {
          const j = hit[k];
          if (j < 0) continue;
          const fid = fkey2idNum.get(pcKey[j]);
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
      if (isNull(u) || seen.has(u)) continue;
      seen.add(u);
      pname.set(u, isNull(t.process_name[i]) ? '' : t.process_name[i]);
    }
    // gb = rf.groupby([file, proc])["bytes"].sum()
    const gb = new Map();   // 'file\x01proc' -> sum
    const procsOfFile = new Map();
    for (let i = 0; i < frame.nrows(req); i++) {
      if (d.op[i] !== 'R') continue;
      if (isNull(d.file[i]) || isNull(d.utid[i])) continue;
      const fid = d.file[i];
      const proc = pname.get(d.utid[i]) || '';
      const k = fid + '\x01' + proc;
      const b = isNull(d.bytes[i]) ? 0 : d.bytes[i];
      gb.set(k, (gb.get(k) || 0) + b);
      let s = procsOfFile.get(fid);
      if (!s) { s = new Set(); procsOfFile.set(fid, s); }
      s.add(proc);
    }
    // idxmax per file: max bytes, tie -> smallest proc (code point)
    for (const [fid, procs] of procsOfFile) {
      let best = null, bestSum = -Infinity;
      for (const p of procs) {
        const s = gb.get(fid + '\x01' + p);
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
