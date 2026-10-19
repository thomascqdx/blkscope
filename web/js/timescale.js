'use strict';
/* timescale.js: viewport state v0..v1 (ns) <-> pixel math, zoom/pan */
IOT.ts = (function () {
  const U = IOT.util;
  const V = { v0: 0, v1: 1, width: 1 };   // ns window + canvas css px width

  function init(dur) { V.v0 = 0; V.v1 = dur; }
  function nsPerPx() { return (V.v1 - V.v0) / Math.max(1, V.width); }
  function tToPx(t) { return (t - V.v0) / (V.v1 - V.v0) * V.width; }
  function pxToT(x) { return V.v0 + x / V.width * (V.v1 - V.v0); }

  function clampView() {
    const dur = IOT.data.D.dur, span = V.v1 - V.v0;
    if (span > dur * 4) {                     // max zoom out
      V.v0 = -dur * 1.5; V.v1 = dur * 2.5;
    }
    const minSpan = 500;                      // 500ns min window
    if (V.v1 - V.v0 < minSpan) {
      const c = (V.v0 + V.v1) / 2;
      V.v0 = c - minSpan / 2; V.v1 = c + minSpan / 2;
    }
    if (V.v0 < -dur) { V.v1 += -dur - V.v0; V.v0 = -dur; }
    if (V.v1 > 2 * dur) { V.v0 -= V.v1 - 2 * dur; V.v1 = 2 * dur; }
    void span;
  }

  function tipStale() {
    // viewport changed: hover tooltip is stale until the mouse moves
    if (IOT.input && IOT.input.hideTip) IOT.input.hideTip();
  }

  // zoom by factor<1 = in, >1 = out, keeping time at px cx fixed
  function zoomAt(f, cx) {
    const t = pxToT(cx);
    V.v0 = t - (t - V.v0) * f;
    V.v1 = t + (V.v1 - t) * f;
    clampView();
    tipStale();
  }
  function panByPx(dpx) {
    const dt = dpx * nsPerPx();
    V.v0 += dt; V.v1 += dt;
    clampView();
    tipStale();
  }
  function setRange(a, b) { V.v0 = a; V.v1 = b; clampView(); tipStale(); }
  function zoomToRange(a, b, margin) {
    const m = margin !== undefined ? margin : 0.08 * (b - a || 1);
    setRange(a - m, b + m);
  }

  return { V, init, nsPerPx, tToPx, pxToT, zoomAt, panByPx, setRange,
           zoomToRange, clampView };
})();
