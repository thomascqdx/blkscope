'use strict';
/* input.js: mouse + keyboard interactions (design 5.4) */
IOT.input = (function () {
  const U = IOT.util, TS = IOT.ts, TR = IOT.tracks;
  let D;                              // data shortcut (set in init)
  const keys = new Set();
  let rafId = 0;

  const qStartOf = i =>
    D.req.t_ins[i] >= 0 ? D.req.t_ins[i] : D.req.t_iss0[i];

  // which lifecycle phase contains time t? (design 5.3.1)
  function reqPhaseAt(i, t) {
    const R = D.req;
    if (R.t_make[i] >= 0 && R.t_ins[i] >= 0 &&
        t >= R.t_make[i] && t < R.t_ins[i])
      return ['bio 提交', R.t_ins[i] - R.t_make[i]];
    if (R.t_ins[i] >= 0 && R.t_iss0[i] >= 0 && t < R.t_iss0[i])
      return ['调度排队', R.t_iss0[i] - R.t_ins[i]];
    if (R.rq_n[i] > 0 && R.t_iss0[i] >= 0 && t < R.t_iss[i])
      return ['requeue 等待', R.t_iss[i] - R.t_iss0[i]];
    if (R.t_iss[i] >= 0 && t >= R.t_iss[i])
      return ['设备服务', D.svcEnd[i] - R.t_iss[i]];
    return ['调度排队', Math.max(0, R.t_iss[i] - qStartOf(i))];
  }

  function init() {
    D = IOT.data.D;
    const cv = document.getElementById('canvas');
    const scroll = document.getElementById('scroll');
    const ruler = document.getElementById('ruler');
    const over = document.getElementById('overwrap');
    const names = document.getElementById('namescol');
    const split = document.getElementById('split');

    scroll.addEventListener('scroll', () => {
      IOT.state.scrollTop = scroll.scrollTop;
      requestRender();
    });

    cv.addEventListener('mousemove', onHover);
    cv.addEventListener('mouseleave', () => {
      IOT.state.hoverX = IOT.state.hoverY = IOT.state.hoverT = null;
      hideTip(); requestRender();
    });
    cv.addEventListener('mousedown', e => onDown(e, 'canvas'));
    ruler.addEventListener('mousedown', e => onDown(e, 'ruler'));
    names.addEventListener('mousedown', onNameDown);
    over.addEventListener('mousedown', onBrushDown);
    split.addEventListener('mousedown', onSplitDown);
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    // remember whether the latest mousedown was inside the bottom panel —
    // Ctrl+A there selects panel text instead of the whole trace
    window.addEventListener('mousedown', e => {
      mouseInPanel = !!(e.target && e.target.closest &&
                        e.target.closest('#panel'));
    }, true);
    window.addEventListener('keyup', e => keys.delete(e.code));
    window.addEventListener('blur', () => keys.clear());

    document.getElementById('loopchk').addEventListener('change', e => {
      D.inclLoop = e.target.checked;
      requestRender(); IOT.render.renderOverview();
      IOT.panels.showSelection();
    });
    const slowIn = document.getElementById('slowms');
    slowIn.addEventListener('change', () => {
      const v = parseFloat(slowIn.value);
      if (isFinite(v) && v >= 0) { D.slowMs = v; requestRender(); }
      IOT.panels.showSelection();
    });
    document.getElementById('helpbtn').addEventListener('click',
      () => IOT.panels.toggleHelp());
    document.getElementById('legendbtn').addEventListener('click',
      () => IOT.legend.toggle());
    document.getElementById('manualbtn').addEventListener('click',
      () => IOT.manual.toggle());
    document.getElementById('cmode').addEventListener('click',
      () => IOT.legend.toggle());
    // backdrop click closes the modal overlays (same as help)
    document.getElementById('legendov').addEventListener('mousedown', e => {
      if (e.target.id === 'legendov') IOT.legend.toggle(false);
    });
    document.getElementById('manualov').addEventListener('mousedown', e => {
      if (e.target.id === 'manualov') IOT.manual.toggle(false);
    });
    window.addEventListener('resize', requestRender);
  }

  // ---------------- helpers ----------------
  function requestRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      IOT.render.renderAll();
      IOT.render.updateBrush();
    });
  }
  IOT.requestRender = requestRender;

  function evtPos(e, el) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // hit-test a canvas position -> entity descriptor; tol makes sub-pixel
  // rects clickable (a drawn rect covers whole pixels it touches)
  function hitAt(x, yCanvas) {
    const y = yCanvas + IOT.state.scrollTop;
    const r = TR.rowAt(y);
    if (!r) return null;
    const t = TS.pxToT(x);
    const tol = TS.nsPerPx() * .6;
    switch (r.type) {
      case 'lane': {
        const l = D.devLanes[r.di][r.slot];
        if (!l || !l.length) return null;
        if (!l._ts) l._ts = Float64Array.from(l, i => D.req.t_iss[i]);
        return hitIds(l, l._ts, i => D.req.t_iss[i],
                      i => D.svcEnd[i], t, tol, 'req', r);
      }
      case 'treq': {
        if (!r.ids._keys) r.ids._keys =
          Float64Array.from(r.ids, i => D.tSub[i]);
        return hitIds(r.ids, r.ids._keys, i => D.tSub[i],
                      i => D.svcEnd[i], t, tol, 'req', r);
      }
      case 'qlane': {
        const l = D.devQueue[r.di][r.slot];
        if (!l || !l.length) return null;
        if (!l._qs) l._qs =
          Float64Array.from(l, i => qStartOf(i));
        return hitIds(l, l._qs, qStartOf,
                      i => D.req.t_iss[i], t, tol, 'req', r);
      }
      case 'dstate': {
        if (!r.ids._keys) r.ids._keys =
          Float64Array.from(r.ids, i => D.dst.ts[i]);
        return hitIds(r.ids, r.ids._keys, i => D.dst.ts[i],
                      i => D.dst.ts[i] + D.dst.dur[i], t, tol, 'd', r);
      }
      case 'files': {
        if (!r.ids._keys) r.ids._keys =
          Float64Array.from(r.ids, i => D.batches.ts[i]);
        return hitIds(r.ids, r.ids._keys, i => D.batches.ts[i],
                      i => D.batches.end[i], t, tol, 'batch', r);
      }
      case 'ctr':
        return { type: 'ctr', metric: r.metric, t, row: r };
      case 'group':
      case 'subgroup':
      case 'qgroup':
        return { type: 'group', gid: r.id, row: r };
      default:
        return { type: 'row', row: r, t };
    }
  }

  // nearest covering interval within tol; ids sorted by start
  function hitIds(ids, starts, startOf, endOf, t, tol, type, row) {
    const i = U.upperBound(starts, t) - 1;
    if (i >= 0 && t <= endOf(ids[i]) + tol && t >= startOf(ids[i]) - tol)
      return { type, id: ids[i], row };
    if (i + 1 < ids.length) {
      const j = ids[i + 1];
      if (t >= startOf(j) - tol && t <= endOf(j) + tol)
        return { type, id: j, row };
    }
    return null;
  }

  // ---------------- hover / tooltip ----------------
  function onHover(e) {
    const cv = document.getElementById('canvas');
    const p = evtPos(e, cv);
    IOT.state.hoverX = p.x;
    IOT.state.hoverY = p.y;
    IOT.state.hoverT = TS.pxToT(p.x);
    const hit = hitAt(p.x, p.y);
    if (hit && hit.type !== 'group') showTip(e.clientX, e.clientY,
      tipText(hit));
    else hideTip();
    requestRender();
  }

  function tipText(h) {
    const R = D.req;
    switch (h.type) {
      case 'req': {
        const i = h.id;
        const L = [];
        if (IOT.state.hoverT != null) {         // phase under the cursor
          const [pn, pd] = reqPhaseAt(i, IOT.state.hoverT);
          L.push(`${pn} ${U.fmtNs(pd)}`);
        }
        L.push(`${D.strs[R.rwbs[i]]} ${U.fmtBytes(R.bytes[i])}  ` +
          `dev ${D.devs[D.devIdx.get(R.dev[i])] ?
            D.devs[D.devIdx.get(R.dev[i])].name : R.dev[i]}:` +
          `${R.sector[i]}`);
        if (R.t_iss[i] >= 0 && R.t_cmp[i] >= 0)
          L.push(`svc ${U.fmtNs(R.t_cmp[i] - R.t_iss[i])}` +
            (R.t_ins[i] >= 0 ? `  q ${U.fmtNs(R.t_iss0[i] - R.t_ins[i])}` : ''));
        if (R.t_cmp[i] < 0) L.push('未完成');
        if (R.file[i] >= 0)
          L.push('文件: ' + D.strs[D.files.name[R.file[i]]] +
            '（推测）');
        const ti = D.tidOf.get(R.utid[i]);
        if (ti != null)
          L.push(`${D.strs[D.threads.name[ti]]} · ` +
            procName(D.threads.upid[ti]));
        return L.join('\n');
      }
      case 'd': {
        const i = h.id;
        const ti = D.tidOf.get(D.dst.utid[i]);
        return `D 状态 ${U.fmtNs(D.dst.dur[i])}\n` +
          `${D.strs[D.dst.fn[i]] || '(未知函数)'}` +
          (D.dst.iow[i] === 1 ? '\nio_wait' : '') +
          (ti != null ? `\n${D.strs[D.threads.name[ti]]}` : '');
      }
      case 'batch': {
        const i = h.id, fi = D.batches.file[i];
        const nm = fi >= 0 ? D.strs[D.files.name[fi]] : '?';
        const hint = fi >= 0 ? D.strs[D.files.hint[fi]] : '';
        return `读取 ${nm}${hint ? ' · ' + hint : ''}\n` +
          `${D.batches.pages[i]} 页  +${U.fmtBytes(D.batches.page0[i] * 4096)}` +
          (D.batches.start[i] ? '' : '（无起点）');
      }
      case 'ctr':
        return `${h.row.label}\n` +
          `${U.fmtNs(h.t)}\n值 ${ctrValueText(h)}`;
      default:
        return h.row ? h.row.label : '';
    }
  }
  function ctrValueText(h) {
    const set = D.counters[D.inclLoop ? 'all' : 'disk'];
    const ctr = set[h.metric];
    const li = IOT.data.levelFor(ctr, TS.nsPerPx());
    const isDepth = h.metric === 'ind' || h.metric === 'qdep';
    const bs = IOT.data.levelBinNs(ctr, li);
    const v = IOT.data.agg(ctr, li, h.t - bs / 2, h.t + bs / 2, isDepth);
    return isDepth ? v.toFixed(0)
      : h.metric === 'iops' ? U.fmtIops(v) : U.fmtRate(v);
  }
  function procName(upid) {
    const pi = D.procOf.get(upid);
    return pi != null ? D.strs[D.procs.name[pi]] : 'upid:' + upid;
  }

  const tip = () => document.getElementById('tooltip');
  function showTip(cx, cy, text) {
    if (!text) { hideTip(); return; }
    const t = tip();
    t.style.display = 'block';
    t.textContent = text;
    t.style.left = Math.min(cx + 14, innerWidth - 400) + 'px';
    t.style.top = Math.min(cy + 14, innerHeight - 120) + 'px';
  }
  function hideTip() { tip().style.display = 'none'; }

  // ---------------- mouse drags ----------------
  let drag = null;   // {kind, x0, y0, v0, v1, area?...}
  let mouseInPanel = false;
  function onDown(e, zone) {
    if (e.button !== 0) return;
    const el = zone === 'ruler' ? document.getElementById('ruler')
      : document.getElementById('canvas');
    const p = evtPos(e, el);
    if (e.shiftKey || e.button === 1) {
      drag = { kind: 'pan', x0: p.x };
    } else if (zone === 'ruler') {
      drag = { kind: 'seltime', x0: p.x };
    } else {
      const hit = hitAt(p.x, p.y);
      if (hit && hit.type === 'group') { TR.toggle(hit.gid); requestRender();
        return; }
      drag = { kind: 'selarea', x0: p.x, y0: p.y, hit };
    }
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!drag) return;
    const cv = document.getElementById('canvas');
    const scroll = document.getElementById('scroll');
    if (drag.kind === 'pan') {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left;
      TS.panByPx(drag.x0 - x);
      drag.x0 = x;
      requestRender();
      return;
    }
    if (drag.kind === 'split') {
      const h = innerHeight - e.clientY;
      document.getElementById('panel').style.height =
        U.clamp(h, 34, innerHeight * .8) + 'px';
      requestRender();
      return;
    }
    if (drag.kind === 'brush-move' || drag.kind === 'brush-l' ||
        drag.kind === 'brush-r' || drag.kind === 'brush-new') {
      brushMove(e);
      return;
    }
    // area select (canvas) / time select (ruler)
    const p = evtPos(e, cv);
    const dx = Math.abs(p.x - drag.x0), dy = Math.abs(p.y - (drag.y0 || 0));
    if (drag.kind === 'selarea' && dx + dy < 4) return;   // still a click
    drag.moved = true;                    // a real drag, not a click
    const t0 = TS.pxToT(Math.min(drag.x0, p.x));
    const t1 = TS.pxToT(Math.max(drag.x0, p.x));
    if (drag.kind === 'seltime') {
      const rp = evtPos(e, document.getElementById('ruler'));
      const a = Math.min(drag.x0, rp.x), b = Math.max(drag.x0, rp.x);
      IOT.state.area = { t0: TS.pxToT(a), t1: TS.pxToT(b), tracks: null };
      IOT.state.sel = null;
    } else {
      const yTop = Math.min(drag.y0, p.y) + IOT.state.scrollTop;
      const yBot = Math.max(drag.y0, p.y) + IOT.state.scrollTop;
      const tracks = new Set();
      for (const r of TR.T.rows)
        if (r.y0 + r.h > yTop && r.y0 < yBot)
          for (const k of TR.rowDragLeaves(r)) tracks.add(k);
      IOT.state.area = { t0, t1, tracks };
      TR.sel.set(tracks);             // all-covered -> null (no filter)
      IOT.state.sel = null;
    }
    IOT.panels.showSelection();
    requestRender();
  }

  function onDragEnd(e) {
    if (!drag) return;
    const cv = document.getElementById('canvas');
    if (drag.kind === 'selarea' && !drag.moved) {
      // plain click: select entity; empty click clears sel + area
      const p = evtPos(e, cv);
      const hit = hitAt(p.x, p.y);
      IOT.state.sel = hit && hit.type !== 'group' ? hit : null;
      IOT.state.area = null;
      if (IOT.state.sel) IOT.panels.activate('sel');
      else IOT.panels.showSelection();
      requestRender();
    } else if ((drag.kind === 'selarea' || drag.kind === 'seltime') &&
               drag.moved) {
      if (IOT.state.area) IOT.panels.activate('area');
      else IOT.panels.showSelection();
    }
    drag = null;
  }

  // ---------------- overview brush ----------------
  function onBrushDown(e) {
    const ov = document.getElementById('overwrap');
    const p = evtPos(e, ov);
    const w = ov.clientWidth;
    const x0 = TS.V.v0 / D.dur * w, x1 = TS.V.v1 / D.dur * w;
    if (p.x >= x0 - 4 && p.x <= x0 + 4)
      drag = { kind: 'brush-l', x: p.x };
    else if (p.x >= x1 - 4 && p.x <= x1 + 4)
      drag = { kind: 'brush-r', x: p.x };
    else if (p.x > x0 && p.x < x1)
      drag = { kind: 'brush-move', x: p.x };
    else drag = { kind: 'brush-new', x: p.x };
    e.preventDefault();
  }
  function brushMove(e) {
    const ov = document.getElementById('overwrap');
    const p = evtPos(e, ov);
    const w = ov.clientWidth;
    const V = TS.V;
    if (drag.kind === 'brush-move') {
      const d = (p.x - drag.x) / w * D.dur;
      V.v0 += d; V.v1 += d;
    } else if (drag.kind === 'brush-l') {
      V.v0 = Math.min(V.v1 - 1, p.x / w * D.dur);
    } else if (drag.kind === 'brush-r') {
      V.v1 = Math.max(V.v0 + 1, p.x / w * D.dur);
    } else {                                     // brush-new
      V.v0 = Math.min(drag.x, p.x) / w * D.dur;
      V.v1 = Math.max(drag.x, p.x) / w * D.dur;
    }
    drag.x = p.x;
    TS.clampView();
    requestRender();
  }

  // ---------------- names column / splitter ----------------
  function onNameDown(e) {
    // track checkbox: toggles the row's leaves in the area filter;
    // must NOT toggle group expansion
    if (e.target.classList && e.target.classList.contains('chk')) {
      const d = e.target.closest('[data-rid]');
      const r = d && d._row;
      if (r) {
        TR.sel.toggleRow(r);
        IOT.panels.showSelection();
        requestRender();
      }
      e.preventDefault();
      return;
    }
    const names = document.getElementById('namesinner');
    const y = e.clientY - names.getBoundingClientRect().top;
    const r = TR.rowAt(y);
    if (r && r.type === 'group') { TR.toggle(r.id); requestRender(); }
  }
  function onSplitDown(e) {
    document.getElementById('panel').classList.remove('collapsed');
    drag = { kind: 'split' };
    e.preventDefault();
  }

  // ---------------- wheel ----------------
  function onWheel(e) {
    const onCv = e.target === document.getElementById('canvas');
    const onRuler = e.target === document.getElementById('ruler');
    const onNames = e.target.closest && e.target.closest('#namescol');
    if (!onCv && !onRuler && !onNames) return;
    e.preventDefault();
    const cv = document.getElementById('canvas');
    const p = evtPos(e, cv);
    if (e.ctrlKey) {                          // zoom at cursor
      TS.zoomAt(Math.pow(1.0015, e.deltaY), p.x);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      TS.panByPx(e.deltaX || e.deltaY);       // horizontal pan
    } else {
      const sc = document.getElementById('scroll');
      sc.scrollTop += e.deltaY;               // vertical scroll
    }
    requestRender();
  }

  // ---------------- keyboard ----------------
  function editable(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
                 t.isContentEditable);
  }

  // which modal overlay is open (they are mutually exclusive)
  function openOverlay() {
    if (document.getElementById('helpov').classList.contains('open'))
      return 'help';
    if (document.getElementById('legendov').classList.contains('open'))
      return 'legend';
    if (document.getElementById('manualov').classList.contains('open'))
      return 'manual';
    return null;
  }
  function closeOverlay(name) {
    if (name === 'help') IOT.panels.toggleHelp(false);
    else if (name === 'legend' && IOT.legend) IOT.legend.toggle(false);
    else if (name === 'manual' && IOT.manual) IOT.manual.toggle(false);
  }

  function onKeyDown(e) {
    if (editable(e)) return;
    const ov = openOverlay();
    // ctrl/meta combos first — they must not fall into the WASD
    // hold-key switch below (Ctrl+A would pan left otherwise)
    if (e.ctrlKey || e.metaKey) {
      if (e.code === 'KeyA') {
        if (ov === 'manual') {               // select all manual text
          const r = document.createRange();
          r.selectNodeContents(document.getElementById('manualbody'));
          const s = getSelection();
          s.removeAllRanges(); s.addRange(r);
        } else if (mouseInPanel) {           // select all panel text
          const r = document.createRange();
          r.selectNodeContents(document.getElementById('panelbody'));
          const s = getSelection();
          s.removeAllRanges(); s.addRange(r);
        } else {                             // select whole trace
          IOT.state.area = { t0: 0, t1: D.dur, tracks: null };
          IOT.state.sel = null;
          IOT.panels.activate('area');
          requestRender();
        }
        e.preventDefault();
      }
      return;
    }
    // while an overlay is open only Esc / ? / L are handled;
    // every other single-key shortcut is ignored (design 5.6).
    // exception: C stays live inside the legend so its 「当前」tag
    // can follow the mode change (legend.refresh via paint.cycle).
    if (ov) {
      switch (e.code) {
        case 'Escape': closeOverlay(ov); break;
        case 'KeyL': if (IOT.legend) IOT.legend.toggle(); break;
        case 'KeyC':
          if (ov === 'legend') { IOT.paint.cycle(); requestRender(); }
          break;
        case 'Slash':
          if (e.shiftKey || e.key === '?') IOT.panels.toggleHelp();
          break;
        default:
          if (e.key === '?') IOT.panels.toggleHelp();
          break;
      }
      return;
    }
    switch (e.code) {
      case 'KeyW': case 'KeyS': case 'KeyA': case 'KeyD':
        keys.add(e.code); startHold();
        e.preventDefault();
        return;
      default: break;
    }
    switch (e.code) {
      case 'KeyF': {                          // zoom to selection
        const s = IOT.state.sel, a = IOT.state.area;
        if (s) {
          const r = selRange(s);
          if (r) TS.zoomToRange(r[0], r[1]);
        } else if (a) TS.zoomToRange(a.t0, a.t1);
        requestRender(); break;
      }
      case 'Escape':
        if (document.activeElement &&
            document.activeElement.id === 'search') {
          document.activeElement.blur();
        } else {
          IOT.state.sel = null; IOT.state.area = null;
        }
        IOT.panels.showSelection();
        requestRender(); break;
      case 'KeyR': {                          // entity -> area
        const s = IOT.state.sel;
        if (s) {
          const r = selRange(s);
          if (r) {
            const lv = s.row ? TR.rowAllLeaves(s.row) : [];
            IOT.state.area = { t0: r[0], t1: r[1],
                               tracks: lv.length ? new Set(lv) : null };
            IOT.state.sel = null;
            IOT.panels.activate('area');
          }
        }
        requestRender(); break;
      }
      case 'KeyM': {
        const s = IOT.state;
        let t0 = null, t1 = null;
        if (s.area) { t0 = s.area.t0; t1 = s.area.t1; }
        else if (s.sel) { const r = selRange(s.sel); if (r) { t0 = r[0]; t1 = r[1]; } }
        if (t0 == null) t0 = s.hoverT != null ? s.hoverT : (TS.V.v0 + TS.V.v1) / 2;
        const m = { t0, t1: t1 != null ? t1 : t0,
                    persistent: e.shiftKey };
        if (e.shiftKey) s.marks.push(m);
        else s.transient = m;
        requestRender(); break;
      }
      case 'BracketLeft': navStep(-1); break;
      case 'BracketRight': navStep(1); break;
      case 'KeyQ':                            // collapse/expand panel
        IOT.panels.togglePanel(); break;
      case 'KeyC':
        IOT.paint.cycle();
        requestRender(); break;
      case 'KeyL':
        if (IOT.legend) IOT.legend.toggle();
        break;
      case 'Slash':
        // '?' is Shift+/ on US layouts (and dispatched key may be '/')
        if (e.shiftKey || e.key === '?') {
          IOT.panels.toggleHelp();
        } else {
          e.preventDefault();
          document.getElementById('search').focus();
        }
        break;
      default:
        if (e.key === '?') IOT.panels.toggleHelp();
        break;
    }
  }

  function selRange(s) {
    switch (s.type) {
      case 'req': return [D.tSub[s.id], D.svcEnd[s.id]];
      case 'd': return [D.dst.ts[s.id], D.dst.ts[s.id] + D.dst.dur[s.id]];
      case 'batch': return [D.batches.ts[s.id], D.batches.end[s.id]];
      case 'ctr': return [s.t, s.t];
      default: return null;
    }
  }

  // W/S/A/D continuous while held (rAF)
  function startHold() {
    if (holdRaf) return;
    let last = performance.now();
    const step = now => {
      if (!keys.size) { holdRaf = 0; return; }
      const dt = Math.min(.05, (now - last) / 1000);
      last = now;
      const cx = IOT.state.hoverX != null ? IOT.state.hoverX
        : TS.V.width / 2;
      if (keys.has('KeyW')) TS.zoomAt(Math.exp(-dt * 1.8), cx);
      if (keys.has('KeyS')) TS.zoomAt(Math.exp(dt * 1.8), cx);
      const panV = (TS.V.v1 - TS.V.v0) * 0.8 * dt / TS.nsPerPx();
      if (keys.has('KeyA')) TS.panByPx(-panV);
      if (keys.has('KeyD')) TS.panByPx(panV);
      requestRender();
      holdRaf = requestAnimationFrame(step);
    };
    holdRaf = requestAnimationFrame(step);
  }
  let holdRaf = 0;

  // [ / ] prev-next item in the selected entity's row
  function navStep(dir) {
    const s = IOT.state.sel;
    if (!s || !s.row) return;
    const r = s.row;
    let ids = null, keyOf = null;
    if (r.type === 'lane') { ids = D.devLanes[r.di][r.slot];
      keyOf = i => D.req.t_iss[i]; }
    else if (r.type === 'treq') { ids = r.ids; keyOf = i => D.tSub[i]; }
    else if (r.type === 'dstate') { ids = r.ids; keyOf = i => D.dst.ts[i]; }
    else if (r.type === 'files') { ids = r.ids; keyOf = i => D.batches.ts[i]; }
    if (!ids) return;
    const cur = keyOf(s.id);
    let i;
    if (!ids._k2) ids._k2 = Float64Array.from(ids, keyOf);
    i = dir > 0 ? U.upperBound(ids._k2, cur) : U.lowerBound(ids._k2, cur) - 1;
    if (i < 0 || i >= ids.length) return;
    const nid = ids[i];
    IOT.state.sel = Object.assign({}, s, { id: nid });
    // follow: ensure visible horizontally + vertically
    const k = keyOf(nid), V = TS.V;
    if (k < V.v0 || k > V.v1) {
      const span = V.v1 - V.v0;
      V.v0 = k - span * .3; V.v1 = k + span * .7; TS.clampView();
    }
    const sc = document.getElementById('scroll');
    if (r.y0 < IOT.state.scrollTop || r.y0 > IOT.state.scrollTop + sc.clientHeight)
      sc.scrollTop = r.y0 - sc.clientHeight / 3;
    IOT.panels.showSelection();
    requestRender();
  }

  return { init, hitAt, requestRender, hideTip };
})();
