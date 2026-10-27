'use strict';
window.IOT = window.IOT || {};

IOT.util = (function () {
  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  // time relative to t0, adaptive unit (s / ms / µs / ns)
  function fmtNs(ns) {
    if (ns == null || !isFinite(ns)) return '-';
    const a = Math.abs(ns);
    if (a >= 1e9) return (ns / 1e9).toFixed(3) + ' s';
    if (a >= 1e6) return (ns / 1e6).toFixed(3) + ' ms';
    if (a >= 1e3) return (ns / 1e3).toFixed(3) + ' µs';
    return Math.round(ns) + ' ns';
  }
  function fmtNsShort(ns) {
    const a = Math.abs(ns);
    if (a >= 1e9) return (ns / 1e9).toFixed(2) + 's';
    if (a >= 1e6) return (ns / 1e6).toFixed(1) + 'ms';
    if (a >= 1e3) return (ns / 1e3).toFixed(0) + 'µs';
    return ns + 'ns';
  }
  // absolute-relative time with µs precision (detail views)
  function fmtNsPrec(ns) {
    if (ns == null || !isFinite(ns) || ns < 0) return '-';
    if (ns >= 1e9) return (ns / 1e9).toFixed(6) + ' s';
    if (ns >= 1e6) return (ns / 1e6).toFixed(3) + ' ms';
    if (ns >= 1e3) return (ns / 1e3).toFixed(0) + ' µs';
    return Math.round(ns) + ' ns';
  }

  function fmtBytes(b) {
    if (b == null || b < 0) return '-';
    if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + ' MB';
    if (b >= 1 << 10) return (b / (1 << 10)).toFixed(1) + ' KB';
    return b + ' B';
  }
  function fmtRate(bytesPerNs) {
    const mbps = bytesPerNs * 1e3; // B/ns -> GB/s; *1e9/1e6
    return mbps.toFixed(mbps >= 100 ? 0 : mbps >= 10 ? 1 : 2) + ' MB/s';
  }
  function fmtIops(perNs) {
    return (perNs * 1e9).toFixed(perNs * 1e9 >= 1000 ? 0 : 1) + ' IOPS';
  }

  // first index with arr[i] >= v (sorted ascending)
  function lowerBound(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (arr[m] < v) lo = m + 1; else hi = m;
    }
    return lo;
  }
  // first index with arr[i] > v
  function upperBound(arr, v) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (arr[m] <= v) lo = m + 1; else hi = m;
    }
    return lo;
  }

  // deterministic hue for a string
  function hashHue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return ((h >>> 0) % 360);
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ---- time base (display only; all data stays window-relative ns) -------
  // mode: 'perfetto' = Perfetto UI origin (meta.trace_start_abs), shown as
  //       Perfetto timecode [Nd]HH:MM:SS.mmm uuu nnn
  //       'raw'      = absolute ns integer (== Perfetto 'Raw' format)
  //       'window'   = relative to the ftrace window start (meta.t0_abs)
  const TB = { mode: 'perfetto', t0: 0, tstart: 0 };
  const TBASE_LABEL = { perfetto: 'Perfetto', raw: '原始 ns',
                        window: '窗口相对' };
  const TBASE_ORDER = ['perfetto', 'raw', 'window'];

  function initTimeBase(meta) {
    TB.t0 = (meta && meta.t0_abs) || 0;
    TB.tstart = (meta && meta.trace_start_abs) || TB.t0;
    TB.mode = 'perfetto';
  }
  function timeMode() { return TB.mode; }
  function timeModeLabel() { return TBASE_LABEL[TB.mode]; }
  function setTimeMode(m) { if (TBASE_LABEL[m]) TB.mode = m; }
  function cycleTimeMode() {
    setTimeMode(TBASE_ORDER[(TBASE_ORDER.indexOf(TB.mode) + 1) % 3]);
    return TB.mode;
  }
  // absolute origin of the current mode (raw mode's origin is 0 = absolute)
  function timeOriginAbs() {
    return TB.mode === 'perfetto' ? TB.tstart
         : TB.mode === 'window' ? TB.t0 : 0;
  }
  // add to a window-relative t to get the current mode's coordinate
  function timeBaseOffset() { return TB.t0 - timeOriginAbs(); }
  function absNs(t) { return Math.round(TB.t0 + t); }
  // window-relative t -> ns since the Perfetto (trace_bounds) origin
  function perfettoNs(t) { return t + (TB.t0 - TB.tstart); }

  // Perfetto Timecode: [-][Nd]HH:MM:SS.mmm uuu nnn
  function fmtTimecode(absNs) {
    if (absNs == null || !isFinite(absNs)) return '-';
    let ns = Math.round(absNs);
    const neg = ns < 0;
    if (neg) ns = -ns;
    const ss = Math.floor(ns / 1e9), rem = ns - ss * 1e9;
    const p2 = n => String(n).padStart(2, '0');
    const p3 = n => String(n).padStart(3, '0');
    const d = Math.floor(ss / 86400);
    return (neg ? '-' : '') + (d ? d + 'd' : '') +
      `${p2(Math.floor(ss / 3600) % 24)}:${p2(Math.floor(ss / 60) % 60)}:` +
      `${p2(ss % 60)}.${p3(Math.floor(rem / 1e6))} ` +
      `${p3(Math.floor(rem / 1e3) % 1000)} ${p3(rem % 1000)}`;
  }

  // point-in-time formatter for a window-relative ns value
  function fmtT(t) {
    if (t == null || !isFinite(t) || t < 0) return '-';
    switch (TB.mode) {
      case 'perfetto': return fmtTimecode(t + (TB.t0 - TB.tstart));
      case 'raw': return String(absNs(t));
      default: return fmtNsPrec(t);
    }
  }

  // parse a user-entered time -> window-relative ns ({t}) or {err}
  const TC_RE =
    /^(-)?(?:(\d+)d)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,9}))?$/;
  function parseT(str0) {
    if (typeof str0 !== 'string') return { err: '无法识别的时间格式' };
    const s = str0.trim().replace(/[\s_]+/g, '');
    if (!s) return { err: '请输入时间' };
    let m = TC_RE.exec(s);
    if (m) {                            // timecode: always Perfetto origin
      const B = BigInt;
      let ns = ((B(m[2] || 0) * 86400n + B(m[3] || 0) * 3600n +
                 B(m[4]) * 60n + B(m[5])) * 1000000000n +
                B((m[6] || '').padEnd(9, '0') || '0'));
      if (m[1]) ns = -ns;
      return { t: Number(ns - B(TB.t0 - TB.tstart)) };
    }
    if (/^\d[\d,]*$/.test(s))           // pure integer: absolute raw ns
      return { t: Number(BigInt(s.replace(/,/g, '')) - BigInt(TB.t0)) };
    m = /^(-?)(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s)?$/i.exec(s);
    if (m) {                            // number+unit (bare decimal = s):
      const num = m[2];                 // relative to the current origin
      const mult = { ns: 1n, 'µs': 1000n, us: 1000n, ms: 1000000n,
                     s: 1000000000n }[m[3] ? m[3].toLowerCase() : 's'];
      const dot = num.indexOf('.');
      const frac = dot < 0 ? '' : num.slice(dot + 1);
      const den = 10n ** BigInt(frac.length);
      let ns = BigInt(dot < 0 ? num : num.slice(0, dot)) * mult +
        (BigInt(frac || '0') * mult + den / 2n) / den;
      if (m[1]) ns = -ns;
      return { t: Number(ns - BigInt(timeBaseOffset())) };
    }
    return { err: '无法识别的时间格式' };
  }

  return {
    el, fmtNs, fmtNsShort, fmtNsPrec, fmtBytes, fmtRate, fmtIops,
    lowerBound, upperBound, hashHue, clamp,
    initTimeBase, timeMode, timeModeLabel, setTimeMode, cycleTimeMode,
    timeOriginAbs, timeBaseOffset, absNs, perfettoNs, fmtTimecode,
    fmtT, parseT,
  };
})();
