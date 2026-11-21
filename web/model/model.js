/* BLK.model.buildModel: JS port of model.build_model (the P4b slice on
 * top of buildReqs): files -> batches -> associate -> hints -> batch
 * t_last_add extension -> io_utids -> dstate -> devs -> quality ->
 * final missing-column fill.
 *
 * Returns a plain object mirroring the Python Model dataclass fields:
 *   req, files, batches, dst, wait_off, wait_req, wait_src, devs,
 *   requeues, quality, device, stats, counters, threads,
 *   t_min, t_max, trace_start, script (always null: text-log replay is
 *   not ported — requirements section 8).
 *
 * m.devs is an ARRAY of row objects {dev, name, kind, lanes,
 * slot_limit} (Python keeps a DataFrame; payload only iterates it).
 * m.wait_off/wait_req/wait_src are plain arrays.
 *
 * Load order: frame.js, req.js, files.js, dstate.js, then this.
 * Classic script. Exposes globalThis.BLK.model.buildModel.
 */
(function () {
  'use strict';
  const BLK = (globalThis.BLK = globalThis.BLK || {});
  const frame = BLK.frame;
  const model = (BLK.model = BLK.model || {});
  const isNull = frame.isNull;
  const nrows = model._nrows;

  model.buildModel = function (ex) {
    const T = ex.tables || {};
    const m = {};
    m.device = ex.device || {};
    m.stats = ex.stats || {};
    m.threads = T.threads || frame.emptyTable([]);
    m.t_min = ex.t_min || 0;
    m.t_max = ex.t_max || 0;
    m.trace_start = ex.trace_start || 0;
    m.script = null;

    const br = model.buildReqs(ex);
    const req = br.req;
    m.counters = br.counters;
    m.requeues = br.requeues;
    const n = frame.nrows(req);

    const fb = model.buildFiles(T.pc_start, T.fm_add);
    m.files = fb.files;
    const key2id = fb.key2id;
    const bb = model.buildBatches(T.pc_start, T.fm_add, key2id);
    m.batches = bb.batches;
    if (n) model.associateFiles(req, bb.fa, T.pc_start, key2id);
    const hint = model.buildFileHints(req, m.files, m.threads);
    m.files.columns.push('hint');
    m.files.data.hint = hint;

    // a batch's slice extends to the t_cmp of associated requests:
    // np.maximum(t_last_add, batch_id.map(bend).fillna(-inf))
    const nb = nrows(m.batches);
    if (nb && n && req.data.batch &&
        req.data.batch.some(function (v) { return !isNull(v); })) {
      const bend = new Map();
      for (let i = 0; i < n; i++) {
        const b = req.data.batch[i], c = req.data.t_cmp[i];
        if (isNull(b) || isNull(c)) continue;
        const cur = bend.get(b);
        if (cur === undefined || c > cur) bend.set(b, c);
      }
      const bts = m.batches.data.batch_id;
      const tla = m.batches.data.t_last_add;
      for (let i = 0; i < nb; i++) {
        const e = bend.get(bts[i]);
        const mapped = e === undefined ? -Infinity : e;
        // np.maximum: NaN propagates; -inf loses
        tla[i] = isNull(tla[i]) ? null : Math.max(tla[i], mapped);
      }
    }

    // io_utids: request utids + batch utids (ints)
    const ioUtids = new Set();
    if (n) {
      for (const u of req.data.utid) if (!isNull(u)) ioUtids.add(u);
    }
    if (nb) {
      for (const u of m.batches.data.utid) {
        if (!isNull(u)) ioUtids.add(u);
      }
    }
    const ds = model.buildDstate(T.dstate, T.blocked, req, ioUtids,
      m.threads);
    m.dst = ds.dst;
    m.wait_off = ds.waitOff;
    m.wait_req = ds.waitReq;
    m.wait_src = ds.waitSrc;

    // per-dev summary: lanes + kind + per-dev slot_limit (design 3.8)
    const limByDev = model.slotLimits(T.mq_complete, T.mq_requeue);
    m.devs = [];
    if (n) {
      const devSet = new Set();
      for (const v of req.data.dev) {
        if (!isNull(v)) devSet.add(v);
      }
      const devs = Array.from(devSet).sort(function (a, b) {
        return a - b;
      });
      const hasLanes = req.columns.indexOf('lanes') >= 0;
      for (const dev of devs) {
        let lanes = 0;
        if (hasLanes) {
          for (let i = 0; i < n; i++) {
            if (req.data.dev[i] === dev &&
                req.data.lanes[i] > lanes) lanes = req.data.lanes[i];
          }
        }
        const sl = limByDev.get(dev);
        m.devs.push({ dev: dev, name: model.newDecodeDev(dev),
          kind: model.devKind(dev), lanes: lanes,
          slot_limit: sl === undefined ? null : sl });
      }
    }

    m.quality = model.buildQuality(ex, m.counters, m.t_min, m.t_max);

    // final missing-column fill (NaN in pandas -> null)
    for (const c of ['t_make', 'mk_pid', 'cls', 'lvl', 'ux', 'fg_meta',
        'utid', 'prio', 'q_ns', 'svc_ns', 'total_ns', 'tag', 'rq_n',
        'rq_reason', 'slot', 'lanes', 'op', 'cat', 'file', 'foff',
        'flen', 'fsrc', 'batch', 'req_id', 'incomplete']) {
      if (req.columns.indexOf(c) < 0) {
        req.columns.push(c);
        req.data[c] = new Array(n).fill(null);
      }
    }
    m.req = req;
    return m;
  };
})();
