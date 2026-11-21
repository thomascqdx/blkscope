'use strict';
/* site.js: drag-and-drop landing + analysis-worker orchestration (§8).
 *
 * Runs on the main thread of the site page (dist/web/index.html). The
 * report renderer is untouched: once the worker posts the payload the
 * landing overlay is hidden and app's start(payload) renders it.
 */
window.IOT = window.IOT || {};
IOT.site = (function () {
  const SNIFF_LEN = 8192;                    // same as loader._SNIFF_LEN
  const GB = 1024 * 1024 * 1024;
  const timings = {};                        // ms per stage + total
  let startFn = null;
  let worker = null;
  let workerCount = 0;                       // test hook: workers started
  let t0All = 0;
  let tickTimer = null;
  let tickT0 = 0;
  let curStage = null;

  function $(id) { return document.getElementById(id); }

  function siteVersion() {
    const m = document.querySelector('meta[name="generator"]');
    const mm = /^blkscope\s+(.*)$/.exec((m && m.content) || '');
    return mm ? mm[1] : '';
  }

  function stemOf(fname) {
    const base = String(fname).split(/[\\/]/).pop();
    const i = base.lastIndexOf('.');
    return i > 0 ? base.slice(0, i) : base;  // os.path.splitext semantics
  }

  function fmtBytes(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
    return n + ' B';
  }

  function fmtMs(ms) {
    return ms < 1000 ? Math.round(ms) + ' ms'
                     : (ms / 1000).toFixed(1) + ' s';
  }

  // ------------------------------ sniff --------------------------------
  // Port of the text-marker part of loader.looks_like_trace: blkscope's
  // own HTML report is recognised first; gzip/zip and other binary magic
  // skip the text test; the head must decode as UTF-8 and match one of
  // the _TEXT_TRACE_MARKERS regexes to count as a text systrace.
  const REPORT_META = '<meta name="generator" content="blkscope';
  const NON_TRACE_MAGIC = [
    [0x89, 0x50, 0x4e, 0x47],                                  // PNG
    [0xff, 0xd8, 0xff],                                        // JPEG
    [0x25, 0x50, 0x44, 0x46],                                  // %PDF
    [0x47, 0x49, 0x46, 0x38],                                  // GIF8
    [0x7f, 0x45, 0x4c, 0x46],                                  // ELF
    // "SQLite format 3"
    [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f,
     0x72, 0x6d, 0x61, 0x74, 0x20, 0x33],
    [0x50, 0x4b, 0x03, 0x04],                                  // zip
  ];
  const TEXT_MARKERS = [
    /^\s*<[^>]+>-\d+\s+\[?\d*\]?\s*[\d.]+:\s*\w+:/m,   // sched line
    /TRACE:/i,
    /^#\s*tracer/m,
    /tracing_mark_write/,
    /systrace/i,
    /trace-viewer|trace2html|perfetto/i,
    /\bB\|\d+\|/,                                              // atrace B|
  ];

  function hasMagic(u8, magic) {
    if (u8.length < magic.length) return false;
    for (let i = 0; i < magic.length; i++) {
      if (u8[i] !== magic[i]) return false;
    }
    return true;
  }

  /* 'report' | 'text' | 'engine' */
  async function sniff(file) {
    const head = new Uint8Array(await file.slice(0, SNIFF_LEN)
      .arrayBuffer());
    if (!head.length) return 'engine';
    const text = new TextDecoder('utf-8').decode(head);
    if (text.indexOf(REPORT_META) >= 0) return 'report';
    if (hasMagic(head, [0x1f, 0x8b])) return 'engine';       // gzip
    for (const m of NON_TRACE_MAGIC) {
      if (hasMagic(head, m)) return 'engine';
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(head);
    } catch (e) {
      return 'engine';                                       // binary
    }
    for (const re of TEXT_MARKERS) {
      if (re.test(text)) return 'text';
    }
    return 'engine';
  }

  // --------------------------- progress UI -----------------------------
  function stageRow(st) {
    return document.querySelector('.stage[data-st="' + st + '"]');
  }

  function setStage(st, state, info, ms) {
    const row = stageRow(st);
    if (!row) return;
    row.classList.remove('active', 'done');
    if (state) row.classList.add(state);
    if (info !== undefined && info !== null) {
      row.querySelector('.st-info').textContent = info;
    }
    if (ms !== undefined) {
      row.querySelector('.st-time').textContent = fmtMs(ms);
    }
  }

  function stageTick(st) {
    stopTick();
    curStage = st;
    tickT0 = performance.now();
    tickTimer = setInterval(function () {
      const row = stageRow(st);
      if (row) row.querySelector('.st-time').textContent =
        fmtMs(performance.now() - tickT0);
    }, 250);
  }

  function stopTick() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function hideIdle() {
    $('dropzone').style.display = 'none';
    const notes = document.querySelector('#landcard .notes');
    if (notes) notes.style.display = 'none';
    $('chooser').hidden = true;
  }

  function resetLanding() {
    if (worker) { worker.terminate(); worker = null; }
    stopTick();
    $('siteerr').hidden = true;
    $('progress').hidden = true;
    $('chooser').hidden = true;
    $('pgwarn').hidden = true;
    $('dropzone').style.display = '';
    const notes = document.querySelector('#landcard .notes');
    if (notes) notes.style.display = '';
  }

  function showMsg(msg, hint, detail) {
    $('progress').hidden = true;
    $('siteerr').hidden = false;
    $('errmsg').textContent = msg;
    $('errhint').textContent = hint ||
      '建议使用 CLI 版 blkscope 分析该文件。';
    $('errdet').style.display = detail ? '' : 'none';
    $('errstack').textContent = detail || '';
  }

  function fail(msg, detail) {
    stopTick();
    if (worker) { worker.terminate(); worker = null; }
    showMsg(msg, '', detail || msg);
  }

  // ----------------------------- analysis ------------------------------
  function sizeWarning(file) {
    const m64 = BLK.engine && BLK.engine.memory64Supported &&
                BLK.engine.memory64Supported();
    if (!m64 && file.size > 1.5 * GB) {
      return '文件超过 1.5 GB，且当前浏览器不支持 memory64 —— 很可能因' +
        '内存不足失败，建议使用 CLI 版 blkscope。';
    }
    if (file.size > GB) {
      return '文件超过 1 GB，解析可能较慢或占用大量内存。';
    }
    return '';
  }

  async function begin(file) {
    $('chooser').hidden = true;
    $('siteerr').hidden = true;
    let verdict = 'engine';
    try { verdict = await sniff(file); } catch (e) { /* -> engine */ }
    if (verdict === 'report') {
      hideIdle();
      showMsg('这是 blkscope 已生成的报告 HTML，' +
              '直接用浏览器打开它即可查看。', '', '');
      return;
    }
    if (verdict === 'text') {
      hideIdle();
      showMsg('文本格式 systrace 的块设备事件暂不支持网页版，' +
              '请使用 CLI 版 blkscope', '', '');
      return;
    }
    startAnalysis(file);
  }

  function onFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (files.length === 1) { begin(files[0]); return; }
    hideIdle();
    const list = $('chlist');
    list.textContent = '';
    for (const f of files) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ch-item';
      const nm = document.createElement('span');
      nm.textContent = f.name;
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = fmtBytes(f.size);
      b.appendChild(nm);
      b.appendChild(sz);
      b.addEventListener('click', function () { begin(f); });
      list.appendChild(b);
    }
    $('chooser').hidden = false;
  }

  function startAnalysis(file) {
    hideIdle();
    const warn = sizeWarning(file);
    if (warn) {
      $('pgwarn').hidden = false;
      $('pgwarn').textContent = warn;
    }
    $('pgfile').textContent = file.name + '  ·  ' + fmtBytes(file.size);
    for (const st of ['parse', 'extract', 'model', 'render']) {
      setStage(st, '', '', '');
    }
    $('progress').hidden = false;
    t0All = performance.now();
    setStage('parse', 'active');
    stageTick('parse');

    worker = new Worker('analysis_worker.js');
    workerCount++;
    worker.onmessage = onWorkerMsg;
    worker.onerror = function (e) {
      fail('分析线程出错', (e && e.message) || 'worker error');
    };
    worker.postMessage({
      file: file,
      engine: {
        engineUrl: 'engine_bundle.js',
        wasmUrl32: 'trace_processor.wasm',
        wasmUrl64: 'trace_processor_memory64.wasm',
      },
      name: stemOf(file.name),
      source: file.name,
      toolVersion: siteVersion(),
    });
  }

  function onWorkerMsg(ev) {
    const m = ev.data || {};
    if (m.type === 'progress') {
      if (m.stage === 'parse') {
        const pct = m.total ? Math.floor(100 * m.done / m.total) : 0;
        setStage('parse', 'active',
          pct + '% · ' + fmtBytes(m.done) + ' / ' + fmtBytes(m.total));
      } else if (m.stage === 'extract') {
        setStage('parse', 'done');
        setStage('extract', 'active');
        stageTick('extract');
      } else if (m.stage === 'model') {
        setStage('extract', 'done');
        setStage('model', 'active');
        stageTick('model');
      }
    } else if (m.type === 'payload') {
      onPayload(m);
    } else if (m.type === 'error') {
      fail(curStage === 'parse'
        ? '无法解析该文件（不是可识别的 trace，或文件已损坏）'
        : '分析过程中出错',
        m.message + '\n' + (m.detail || ''));
    }
  }

  async function onPayload(m) {
    const t = m.timings || {};
    timings.parse = t.parse;
    timings.extract = t.extract;
    timings.model = t.model;
    setStage('parse', 'done', null, t.parse);
    setStage('extract', 'done', null, t.extract);
    setStage('model', 'done', null, t.model);
    setStage('render', 'active');
    stageTick('render');
    if (worker) { worker.terminate(); worker = null; }
    $('site').style.display = 'none';
    const t0 = performance.now();
    await startFn(m.payload);
    timings.render = performance.now() - t0;
    timings.total = performance.now() - t0All;
    stopTick();
    setStage('render', 'done', null, timings.render);
    if (IOT.ready) addTopbarButtons();
  }

  // ------------------------- topbar / export ---------------------------
  function addTopbarButtons() {
    const tb = document.getElementById('topbar');
    if (!tb || document.getElementById('openbtn')) return;
    const anchor = tb.querySelector('.spacer').nextSibling;
    function mk(id, text, title, fn) {
      const b = document.createElement('button');
      b.id = id;
      b.className = 'sitebtn';
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', fn);
      tb.insertBefore(b, anchor);
    }
    mk('exportbtn', '导出报告',
       '导出与 CLI 版相同格式的单文件报告', exportReport);
    mk('openbtn', '打开其他 trace',
       '返回拖放页选择其他 trace 文件',
       function () { location.reload(); });
  }

  /* Kept behind one function so the offline single-file build (P6) can
   * substitute an embedded template instead of a fetch. */
  async function fetchTemplate() {
    const r = await fetch('report_template.html');
    if (!r.ok) {
      throw new Error('report_template.html: HTTP ' + r.status);
    }
    return r.text();
  }

  /* Python html.escape(s, quote=True) equivalent — the same escaping
   * html.py applies to __TITLE__. */
  function escapeName(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  function u8ToB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  async function exportReport() {
    const btn = document.getElementById('exportbtn');
    if (btn) btn.disabled = true;
    try {
      const tpl = await fetchTemplate();
      const payload = IOT.data.D.payload;
      const raw = new TextEncoder().encode(JSON.stringify(payload));
      const gz = new Uint8Array(await new Response(
        new Blob([raw]).stream()
          .pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
      const html = tpl
        .split('BLKSCOPE_EXPORT_NAME_TOKEN')
        .join(escapeName((payload.meta && payload.meta.name) || 'blkscope'))
        .split('BLKSCOPE_EXPORT_PAYLOAD_TOKEN')
        .join(u8ToB64(gz));
      const url = URL.createObjectURL(
        new Blob([html], { type: 'text/html;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = ((payload.meta && payload.meta.name) || 'blkscope') +
        '.html';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    } catch (e) {
      alert('导出报告失败：' + String((e && e.message) || e));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ------------------------------- init --------------------------------
  function init(start) {
    startFn = start;
    const ver = siteVersion();
    $('sitever').textContent = ver ? 'v' + ver : '';
    const dz = $('dropzone');
    const pick = $('filepick');
    dz.addEventListener('click', function () { pick.click(); });
    pick.addEventListener('change', function (e) {
      onFiles(e.target.files);
      e.target.value = '';
    });
    dz.addEventListener('dragover', function (e) {
      e.preventDefault();
      dz.classList.add('hover');
    });
    dz.addEventListener('dragleave', function () {
      dz.classList.remove('hover');
    });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove('hover');
      onFiles(e.dataTransfer.files);
    });
    // stray drops anywhere on the overlay should not navigate away
    const site = $('site');
    site.addEventListener('dragover', function (e) { e.preventDefault(); });
    site.addEventListener('drop', function (e) {
      e.preventDefault();
      onFiles(e.dataTransfer.files);
    });
    $('errback').addEventListener('click', resetLanding);
  }

  return { init: init, timings: timings, exportReport: exportReport,
           get workerCount() { return workerCount; } };
})();
