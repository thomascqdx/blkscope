/* BLK.engine: start the Perfetto trace_processor wasm engine.
 *
 * The official engine_bundle.js is a self-contained classic Worker. The
 * caller compiles the wasm into a WebAssembly.Module (so the JS engine can
 * reuse tiered-up code across workers) and posts {port, wasmModule} to the
 * worker; the worker then speaks the trace_processor RPC protocol over the
 * port. See web/engine/tp_client.js for the wire format.
 *
 * Classic script, no modules. Works in a page or inside another Worker.
 * Exposes globalThis.BLK.engine.start(opts):
 *   opts = {engineUrl, wasmUrl32, wasmUrl64}
 *       or {engineSource, wasmBytes32, wasmBytes64}  // offline single-file
 *   resolves to {port, memory64, terminate()}.
 */
(function () {
  'use strict';
  const BLK = (globalThis.BLK = globalThis.BLK || {});
  const engine = (BLK.engine = {});

  // Same detection program as engine_bundle.js memory64Supported(): a wasm
  // module declaring a memory64 memory section; compiles only where the
  // memory64 proposal is implemented.
  const MEMORY64_PROBE = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 0,
    0, 8, 4, 110, 97, 109, 101, 2, 1, 0,
  ]);

  let memory64Cache;
  engine.memory64Supported = function () {
    if (memory64Cache !== undefined) return memory64Cache;
    try {
      new WebAssembly.Module(MEMORY64_PROBE);
      return (memory64Cache = true);
    } catch (e) {
      return (memory64Cache = false);
    }
  };

  async function fetchBytes(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error('fetch ' + url + ' failed: HTTP ' + resp.status);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  engine.start = async function (opts) {
    const memory64 = engine.memory64Supported();
    let wasmBytes;
    if (memory64) {
      wasmBytes = opts.wasmBytes64 ||
        (opts.wasmUrl64 ? await fetchBytes(opts.wasmUrl64) : null);
    } else {
      wasmBytes = opts.wasmBytes32 ||
        (opts.wasmUrl32 ? await fetchBytes(opts.wasmUrl32) : null);
    }
    if (!wasmBytes) throw new Error('no wasm bytes/url for memory64=' + memory64);
    const wasmModule = await WebAssembly.compile(wasmBytes);

    let worker;
    let blobUrl = null;
    if (opts.engineUrl) {
      worker = new Worker(opts.engineUrl);
    } else if (opts.engineSource) {
      blobUrl = URL.createObjectURL(
        new Blob([opts.engineSource], { type: 'text/javascript' }));
      try {
        worker = new Worker(blobUrl);
      } catch (e) {
        URL.revokeObjectURL(blobUrl);
        throw e;
      }
    } else {
      throw new Error('engine.start: need engineUrl or engineSource');
    }

    const channel = new MessageChannel();
    // RPC bytes posted before the worker finishes initializing stay queued
    // on the port (the engine wires up onmessage only after init).
    worker.postMessage({ port: channel.port2, wasmModule },
      [channel.port2]);

    return {
      port: channel.port1,
      memory64,
      terminate() {
        worker.terminate();
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      },
    };
  };
})();
