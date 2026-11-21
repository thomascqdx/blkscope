'use strict';
/* analysis_worker (§8): runs inside a Web Worker — boots the Perfetto
 * wasm engine as a nested worker, streams the dropped file through it,
 * runs BLK.extract.extractAll + BLK.analyze, and posts progress/payload
 * messages back to the page.
 *
 * In the built dist/web/analysis_worker.js the manifest "worker" script
 * list is concatenated ahead of this file, so BLK.analyze already exists
 * and the importScripts below is skipped. When this file is served
 * unbundled (dev), it pulls the same list in — keep the paths in sync
 * with manifest.json's "worker" (relative to web/site/). */
if (!self.BLK || !self.BLK.analyze) {
  importScripts(
    '../engine/proto.js',
    '../engine/tp_client.js',
    '../engine/bootstrap.js',
    '../model/frame.js',
    '../model/req.js',
    '../model/files.js',
    '../model/dstate.js',
    '../model/model.js',
    '../model/extract.js',
    '../model/payload.js');
}

(function () {
  function post(m) { self.postMessage(m); }

  async function run(msg) {
    const timings = {};
    let t0 = performance.now();
    // Cache-busting (served mode): this worker is loaded as
    // analysis_worker.js?v=<ver>; forward the same query to the engine and
    // wasm URLs so a stale cache can never mix versions. Blob-URL workers
    // (offline single file) have an empty search and are unaffected.
    const opts = msg.engine || {};
    const q = self.location ? self.location.search : '';
    if (q && opts.engineUrl) {
      opts.engineUrl += q;
      if (opts.wasmUrl32) opts.wasmUrl32 += q;
      if (opts.wasmUrl64) opts.wasmUrl64 += q;
    }
    const eng = await BLK.engine.start(opts);
    const cli = new BLK.TpClient(eng.port);
    eng.onError(function (e) { cli.fail(e); });
    try {
      await cli.loadFile(msg.file, {
        onProgress: function (done, total) {
          post({ type: 'progress', stage: 'parse',
                 done: done, total: total });
        },
      });
      timings.parse = performance.now() - t0;

      post({ type: 'progress', stage: 'extract' });
      t0 = performance.now();
      const ex = await BLK.extract.extractAll(cli);
      timings.extract = performance.now() - t0;

      post({ type: 'progress', stage: 'model' });
      t0 = performance.now();
      const r = BLK.analyze(ex, {
        name: msg.name,
        source: msg.source,
        toolVersion: msg.toolVersion,
      });
      timings.model = performance.now() - t0;

      post({ type: 'payload', payload: r.payload, timings: timings });
    } finally {
      eng.terminate();
    }
  }

  self.onmessage = function (ev) {
    run(ev.data || {}).catch(function (err) {
      post({ type: 'error',
             message: String((err && err.message) || err),
             detail: String((err && err.stack) || err) });
    });
  };
})();
