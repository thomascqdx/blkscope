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

  return {
    el, fmtNs, fmtNsShort, fmtNsPrec, fmtBytes, fmtRate, fmtIops,
    lowerBound, upperBound, hashHue, clamp,
  };
})();
