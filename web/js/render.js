'use strict';
/* render.js: canvas drawing — rows, ruler, overview, marks, selection */
IOT.render = (function () {
  const U = IOT.util;
  const TS = IOT.ts;
  const TR = IOT.tracks;

  const CAT_COLORS = ['#4e79a7', '#59a5a8', '#9c6ade', '#f28e2b',
                      '#9c755f', '#9e9e9e', '#9e9e9e'];
  const D_COLOR = '#e8763a', D_IOWAIT = '#c0392b';
  const CTR_COLORS = { read: '#4e79a7', write: '#f28e2b', iops: '#8fbf6f',
                       ind: '#e8763a', qdep: '#c66db3' };
  let hatch = null;

  function ctx2d(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== (w * dpr | 0) || cv.height !== (h * dpr | 0)) {
      cv.width = w * dpr | 0; cv.height = h * dpr | 0;
    }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return c;
  }

  // ---- request rect painting -------------------------------------------
  // color modes (design 5.5): cat -> prio -> proc -> lat, cycled by C
  const MODE_ORDER = ['cat', 'prio', 'proc', 'lat'];
  const MODE_LABEL = { cat: '类别', prio: '优先级', proc: '进程',
                       lat: '延迟' };
  IOT.paint = IOT.paint || {};
  IOT.paint.mode = 'cat';
  IOT.paint.cycle = function () {
    const i = MODE_ORDER.indexOf(IOT.paint.mode);
    IOT.paint.mode = MODE_ORDER[(i + 1) % MODE_ORDER.length];
    const el = document.getElementById('cmode');
    if (el) el.textContent = '配色: ' + MODE_LABEL[IOT.paint.mode];
  };

  function procColor(i) {
    const D = IOT.data.D;
    const ti = D.tidOf.get(D.req.utid[i]);
    const upid = ti != null ? D.threads.upid[ti] : -1;
    return `hsl(${U.hashHue(String(upid))}, 45%, 45%)`;
  }
  function latColor(i) {
    const D = IOT.data.D;
    const t = D.svcEnd[i] - D.tSub[i];
    const f = U.clamp((Math.log10(Math.max(1, t)) - 5) / 2.3, 0, 1);
    return `hsl(${Math.round(120 * (1 - f))}, 75%, 45%)`;
  }

  function rectColor(i) {
    const R = IOT.data.D.req;
    switch (IOT.paint.mode) {
      case 'prio': {
        const p = R.prio[i];
        if (p & 1) return '#e02b2b';         // RT red
        if (p & 4) return '#e84fd8';         // UX magenta
        if (p & 8) return '#f4cf3f';         // FG_META yellow
        if (p & 16) return '#4e79a7';        // SYNC blue
        if (p & 2) return '#4a4f57';         // IDLE dark gray
        return '#9e9e9e';                    // other async gray
      }
      case 'proc': return procColor(i);
      case 'lat': return latColor(i);
      default:
        return CAT_COLORS[R.cat[i]] || '#9e9e9e';
    }
  }

  function drawReqRect(c, i, x0, x1, y, h, clipLabel) {
    const D = IOT.data.D, R = D.req;
    const w = x1 - x0;
    c.fillStyle = rectColor(i);
    c.fillRect(x0, y + 1, Math.max(1, w), h - 2);
    const slow = R.t_cmp[i] >= 0 &&
      (R.t_cmp[i] - D.tSub[i]) >= D.slowMs * 1e6;
    if (w >= 4) {
      const prio = R.prio[i];
      if (prio & 1) {                        // RT: 2px red top bar
        c.fillStyle = '#e02b2b';
        c.fillRect(x0, y + 1, Math.max(1, w), 2);
      }
      if (prio & 4) {                        // UX: magenta tri top-left
        c.fillStyle = '#e84fd8';
        c.beginPath(); c.moveTo(x0, y + 1); c.lineTo(x0 + 6, y + 1);
        c.lineTo(x0, y + 7); c.fill();
      }
      if (prio & 8) {                        // FG_META: yellow tri top-right
        c.fillStyle = '#f4cf3f';
        c.beginPath(); c.moveTo(x1, y + 1); c.lineTo(x1 - 6, y + 1);
        c.lineTo(x1, y + 7); c.fill();
      }
      if (prio & 64) {                       // FUA: small marker bottom-right
        c.fillStyle = '#fff';
        c.fillRect(x1 - 3, y + h - 4, 3, 2);
      }
      if (R.t_cmp[i] < 0) {                  // incomplete: hatch
        c.save();
        c.beginPath();
        c.rect(x0, y + 1, Math.max(1, w), h - 2);
        c.clip();
        c.strokeStyle = 'rgba(255,255,255,.45)';
        c.lineWidth = 1;
        for (let d = -h; d < w; d += 4) {
          c.beginPath(); c.moveTo(x0 + d, y + h); c.lineTo(x0 + d + h, y);
          c.stroke();
        }
        c.restore();
      }
      if (slow) {                            // slow IO: red outline
        c.strokeStyle = '#ff3b30'; c.lineWidth = 1;
        c.strokeRect(x0 + .5, y + 1.5, Math.max(1, w) - 1, h - 3);
      }
      if (w > 30 && clipLabel !== false) {
        c.save();
        c.beginPath(); c.rect(x0, y, w, h); c.clip();
        c.fillStyle = 'rgba(255,255,255,.9)';
        c.fillText(reqLabel(i), x0 + 3, y + h / 2 + 3);
        c.restore();
      }
    }
    const s = IOT.state && IOT.state.sel;
    if (s && s.type === 'req' && s.id === i) {
      c.strokeStyle = '#6db3f2'; c.lineWidth = 1.5;
      c.strokeRect(x0 - .5, y + .5, Math.max(2, w) + 1, h - 1);
    }
  }

  function reqLabel(i) {
    const D = IOT.data.D, R = D.req;
    return `${D.strs[R.rwbs[i]] || ''} ${U.fmtBytes(R.bytes[i])}`;
  }

  // ---- lifecycle segments (design 5.3.1) --------------------------------
  const qStartOf = i => {
    const R = IOT.data.D.req;
    return R.t_ins[i] >= 0 ? R.t_ins[i] : R.t_iss0[i];
  };

  function hatchSeg(c, x0, x1, yy, ph) {
    c.save();
    c.beginPath(); c.rect(x0, yy, Math.max(1, x1 - x0), ph); c.clip();
    c.strokeStyle = 'rgba(255,255,255,.45)'; c.lineWidth = 1;
    for (let d = -ph; d < x1 - x0; d += 4) {
      c.beginPath();
      c.moveTo(x0 + d, yy + ph); c.lineTo(x0 + d + ph, yy); c.stroke();
    }
    c.restore();
  }

  // badges (RT/UX/FG_META/FUA) + slow-IO outline + selection outline,
  // all on the whole-request extent [xA, xB]
  function reqOverlays(c, i, xA, xB, y, h) {
    const R = IOT.data.D.req;
    const w = xB - xA;
    const slow = R.t_cmp[i] >= 0 &&
      (R.t_cmp[i] - IOT.data.D.tSub[i]) >= IOT.data.D.slowMs * 1e6;
    if (w >= 4) {
      const prio = R.prio[i];
      if (prio & 1) {
        c.fillStyle = '#e02b2b';
        c.fillRect(xA, y + 1, Math.max(1, w), 2);
      }
      if (prio & 4) {
        c.fillStyle = '#e84fd8';
        c.beginPath(); c.moveTo(xA, y + 1); c.lineTo(xA + 6, y + 1);
        c.lineTo(xA, y + 7); c.fill();
      }
      if (prio & 8) {
        c.fillStyle = '#f4cf3f';
        c.beginPath(); c.moveTo(xB, y + 1); c.lineTo(xB - 6, y + 1);
        c.lineTo(xB, y + 7); c.fill();
      }
      if (prio & 64) {
        c.fillStyle = '#fff';
        c.fillRect(xB - 3, y + h - 4, 3, 2);
      }
    }
    if (slow) {
      c.strokeStyle = '#ff3b30'; c.lineWidth = 1;
      c.strokeRect(xA + .5, y + 1.5, Math.max(1, w) - 1, h - 3);
    }
    const s = IOT.state && IOT.state.sel;
    if (s && s.type === 'req' && s.id === i) {
      c.strokeStyle = '#6db3f2'; c.lineWidth = 1.5;
      c.strokeRect(xA - .5, y + .5, Math.max(2, w) + 1, h - 1);
    }
  }

  // segmented lifecycle paint for the thread 'IO 请求' row:
  // bio 30%/40%h, queue 55%/60%h, requeue 55%/60%h+hatch, service solid
  function drawReqPhases(c, i, y, h, withLabel) {
    const D = IOT.data.D, R = D.req;
    const xA = TS.tToPx(D.tSub[i]), xB = TS.tToPx(D.svcEnd[i]);
    const w = xB - xA;
    const base = rectColor(i);
    if (w < 3) {                       // too small: solid bar, no phases
      c.fillStyle = base;
      c.fillRect(xA, y + 1, Math.max(1, w), h - 2);
    } else {
      const fillSeg = (a, b, alpha, frac, hatch) => {
        if (a < 0 || b < 0 || b <= a) return;
        const xa = TS.tToPx(a), xb = TS.tToPx(b);
        if (xb - xa < .5) return;
        const ph = frac >= 1 ? h - 2 : Math.max(1, Math.round(h * frac));
        const yc = frac >= 1 ? y + 1 : y + (h - ph) / 2;
        c.globalAlpha = alpha;
        c.fillStyle = base;
        c.fillRect(xa, yc, xb - xa, ph);
        c.globalAlpha = 1;
        if (hatch) hatchSeg(c, xa, xb, yc, ph);
      };
      fillSeg(R.t_make[i], R.t_ins[i], .30, .4, false);     // bio 提交
      fillSeg(R.t_ins[i], R.t_iss0[i], .55, .6, false);     // 调度排队
      if (R.rq_n[i] > 0)                                    // requeue 等待
        fillSeg(R.t_iss0[i], R.t_iss[i], .55, .6, true);
      fillSeg(R.t_iss[i], D.svcEnd[i], 1, 1, R.t_cmp[i] < 0); // 设备服务
    }
    reqOverlays(c, i, xA, xB, y, h);
    // label on the service segment, or the whole rect when service <30px
    const xs = R.t_iss[i] >= 0 ? TS.tToPx(R.t_iss[i]) : xA;
    const ws = xB - xs;
    let lx = 0, lw = 0;
    if (!withLabel) return;            // overflow sub-row: rects overlap
    if (R.t_iss[i] >= 0 && ws > 30) { lx = xs; lw = ws; }
    else if (w > 30) { lx = xA; lw = w; }
    if (lw) {
      c.save(); c.beginPath(); c.rect(lx, y, lw, h); c.clip();
      c.fillStyle = 'rgba(255,255,255,.9)';
      c.fillText(reqLabel(i), lx + 3, y + h / 2 + 3);
      c.restore();
    }
  }

  // queue-row segment: [t_ins, t_iss0] queue + [t_iss0, t_iss] requeue
  function drawQueueSeg(c, i, y, h) {
    const D = IOT.data.D, R = D.req;
    const base = rectColor(i);
    const ph = Math.max(1, Math.round(h * .6));
    const yc = y + (h - ph) / 2;
    const seg = (a, b, hatch) => {
      if (a < 0 || b < 0 || b <= a) return;
      const xa = TS.tToPx(a), xb = TS.tToPx(b);
      if (xb - xa < .5) return;
      c.globalAlpha = .55; c.fillStyle = base;
      c.fillRect(xa, yc, xb - xa, ph); c.globalAlpha = 1;
      if (hatch) hatchSeg(c, xa, xb, yc, ph);
    };
    if (R.t_ins[i] >= 0) seg(R.t_ins[i], R.t_iss0[i], false);
    if (R.rq_n[i] > 0) seg(R.t_iss0[i], R.t_iss[i], true);
    const s = IOT.state && IOT.state.sel;
    if (s && s.type === 'req' && s.id === i) {
      const xA = TS.tToPx(qStartOf(i)), xB = TS.tToPx(R.t_iss[i]);
      c.strokeStyle = '#6db3f2'; c.lineWidth = 1.5;
      c.strokeRect(xA - .5, y + .5, Math.max(2, xB - xA) + 1, h - 1);
    }
  }

  // generic interval-row painter with sub-pixel merging
  function drawIntervals(c, ids, startOf, endOf, y, h, w, draw) {
    const D = IOT.data.D, V = TS.V;
    let px = -2, lastI = -1;
    for (const i of ids) {
      const a = startOf(i), b = endOf(i);
      const x1 = TS.tToPx(Math.max(b, a) ), x0 = TS.tToPx(a);
      if (x1 < -1 || x0 > w + 1) { if (x0 > w + 1) break; continue; }
      const p0 = Math.max(-1, x0 | 0);
      if (x1 - x0 < 1 && p0 === px) { lastI = i; continue; } // merge to 1px
      px = p0; lastI = i;
      draw(i, Math.round(x0 * 2) / 2, Math.round(Math.max(1, x1 - x0) * 2) / 2);
    }
  }

  function laneItems(r, v0, v1) {
    const D = IOT.data.D, l = D.devLanes[r.di][r.slot];
    if (!l._ts) l._ts = Float64Array.from(l, i => D.req.t_iss[i]);
    let i0 = U.lowerBound(l._ts, v0);
    while (i0 > 0 && D.svcEnd[l[i0 - 1]] >= v0) i0--;
    const i1 = U.upperBound(l._ts, v1);
    return l.slice(i0, i1);
  }

  // ---- row painters -----------------------------------------------------
  function paintRow(c, r, w) {
    const D = IOT.data.D, V = TS.V;
    const y = r.y0 - IOT.state.scrollTop;
    if (y + r.h < 0 || y > c.canvas.clientHeight) return;
    const v0 = V.v0, v1 = V.v1;

    switch (r.type) {
      case 'group': {
        const g = r.g;
        c.fillStyle = g.kind === 'proc' ? '#232328'
          : g.kind === 'dev' ? '#21242b' : '#20242e';
        c.fillRect(0, y, w, r.h);
        // collapsed groups draw their summary strip in the header row
        if (!g.expanded && g.kind === 'dev')
          paintDevSum(c, g.di, y, r.h, w, v0, v1);
        else if (!g.expanded && g.kind === 'proc')
          paintProcSum(c, g.pi, y, r.h, w, v0, v1);
        c.fillStyle = '#101014';
        c.fillRect(0, y + r.h - 1, w, 1);
        break;
      }
      case 'subgroup': {                      // loop/other dev header
        c.fillStyle = '#1f222a';
        c.fillRect(0, y, w, r.h);
        if (!r.sg.expanded) paintDevSum(c, r.sg.di, y, r.h, w, v0, v1);
        c.fillStyle = '#101014';
        c.fillRect(0, y + r.h - 1, w, 1);
        break;
      }
      case 'qgroup': {                        // 调度队列 subgroup header
        c.fillStyle = '#1b2027';
        c.fillRect(0, y, w, r.h);
        if (!r.qExp) paintQueueSum(c, r.di, y, r.h, w, v0, v1);
        c.fillStyle = '#101014';
        c.fillRect(0, y + r.h - 1, w, 1);
        break;
      }
      case 'qlane': {                         // scheduler queue lane
        c.fillStyle = (r.slot & 1) ? '#1e1f24' : '#1d1e22';
        c.fillRect(0, y, w, r.h);
        const l = D.devQueue[r.di][r.slot];
        const vis = clipIds(l, qStartOf, i => D.req.t_iss[i], v0, v1);
        drawIntervals(c, vis, qStartOf, i => D.req.t_iss[i], y, r.h, w,
          (i) => drawQueueSeg(c, i, y, r.h));
        break;
      }

      case 'ctr': paintCtr(c, r, y, w, v0, v1); break;

      case 'lane': {
        const d = D.devs[r.di];
        c.fillStyle = (d.slot_limit != null && r.slot >= d.slot_limit)
          ? '#241d21' : ((r.slot & 1) ? '#1f1f23' : '#1e1e1e');
        c.fillRect(0, y, w, r.h);
        const items = laneItems(r, v0, v1);
        drawIntervals(c, items,
          i => D.req.t_iss[i], i => D.svcEnd[i], y, r.h, w,
          (i, x0, ww) => drawReqRect(c, i, x0, x0 + ww, y, r.h, true));
        break;
      }

      case 'treq': {
        c.fillStyle = '#1e1f24';
        c.fillRect(0, y, w, r.h);
        const vis = clipIds(r.ids, i => D.tSub[i], i => D.svcEnd[i], v0, v1);
        drawIntervals(c, vis, i => D.tSub[i], i => D.svcEnd[i], y, r.h, w,
          (i) => drawReqPhases(c, i, y, r.h, !r.overflow));
        break;
      }

      case 'dstate': {
        c.fillStyle = '#201e1f';
        c.fillRect(0, y, w, r.h);
        const ids = clipIds(r.ids, i => D.dst.ts[i],
                            i => D.dst.ts[i] + D.dst.dur[i], v0, v1);
        c.font = '10px sans-serif';
        for (const i of ids) {
          const a = D.dst.ts[i], b = a + D.dst.dur[i];
          const x0 = TS.tToPx(a), x1 = TS.tToPx(b);
          const rw = Math.max(1, x1 - x0);
          c.fillStyle = D.dst.iow[i] === 1 ? D_IOWAIT : D_COLOR;
          c.fillRect(x0, y + 1, rw, r.h - 2);
          if (rw > 30) {
            c.save(); c.beginPath(); c.rect(x0, y, rw, r.h); c.clip();
            c.fillStyle = '#fff';
            c.fillText(D.strs[D.dst.fn[i]] || '', x0 + 3, y + r.h / 2 + 3);
            c.restore();
          }
          markSel(c, { type: 'd', id: i }, i, x0, rw, y, r.h);
        }
        break;
      }

      case 'files': {
        c.fillStyle = '#1d2124';
        c.fillRect(0, y, w, r.h);
        const ids = clipIds(r.ids, i => D.batches.ts[i],
                            i => D.batches.end[i], v0, v1);
        c.font = '10px sans-serif';
        for (const i of ids) {
          const a = D.batches.ts[i], b = D.batches.end[i];
          const x0 = TS.tToPx(a), x1 = TS.tToPx(Math.max(b, a));
          const rw = Math.max(1, x1 - x0);
          const fi = D.batches.file[i];
          const nm = fi >= 0 ? (D.strs[D.files.name[fi]] || '?') : '?';
          const hint = fi >= 0 ? D.strs[D.files.hint[fi]] || '' : '';
          c.fillStyle = `hsl(${U.hashHue(nm)},45%,42%)`;
          c.fillRect(x0, y + 1, rw, r.h - 2);
          if (rw > 30) {
            c.save(); c.beginPath(); c.rect(x0, y, rw, r.h); c.clip();
            c.fillStyle = '#eee';
            c.fillText(`${nm}${hint ? ' · ' + hint : ''} +` +
              U.fmtBytes(D.batches.page0[i] * 4096) +
              ` (${D.batches.pages[i]}页)`,
              x0 + 3, y + r.h / 2 + 3);
            c.restore();
          }
          markSel(c, { type: 'batch', id: i }, i, x0, rw, y, r.h);
        }
        break;
      }

      case 'thead':
        c.fillStyle = '#252529'; c.fillRect(0, y, w, r.h);
        c.fillStyle = '#17171a'; c.fillRect(0, y + r.h - 1, w, 1);
        break;
      default:
        c.fillStyle = '#1e1e1e'; c.fillRect(0, y, w, r.h);
    }
    // slot_limit separator + label between lane rows
    if (r.type === 'lane') {
      const d = IOT.data.D.devs[r.di];
      if (d.slot_limit != null && r.slot === d.slot_limit) {
        c.strokeStyle = 'rgba(232,118,58,.8)'; c.setLineDash([4, 3]);
        c.beginPath(); c.moveTo(0, y + .5); c.lineTo(w, y + .5); c.stroke();
        c.setLineDash([]);
        c.fillStyle = '#e8763a'; c.font = '10px sans-serif';
        c.fillText('设备上限 ' + d.slot_limit, w - 70, y + 11);
      }
    }
  }

  function markSel(c, sel, id, x0, w, y, h) {
    const s = IOT.state.sel;
    if (s && s.type === sel.type && s.id === id) {
      c.strokeStyle = '#6db3f2'; c.lineWidth = 1.5;
      c.strokeRect(x0, y + .5, w, h - 1);
    }
  }

  // ids sorted by keyOf; clip to [v0,v1] (end may extend left of v0)
  function clipIds(ids, keyOf, endOf, v0, v1) {
    if (!ids._keys) ids._keys = Float64Array.from(ids, keyOf);
    let i0 = U.lowerBound(ids._keys, v0);
    while (i0 > 0 && endOf(ids[i0 - 1]) >= v0) i0--;
    const i1 = U.upperBound(ids._keys, v1);
    return ids.slice(i0, i1);
  }

  function paintCtr(c, r, y, w, v0, v1) {
    const D = IOT.data.D;
    const set = D.counters[D.inclLoop ? 'all' : 'disk'];
    const ctr = set[r.metric];
    const isDepth = r.metric === 'ind' || r.metric === 'qdep';
    const np = (v1 - v0) / w;
    const li = IOT.data.levelFor(ctr, np);
    const bs = IOT.data.levelBinNs(ctr, li);
    const arr = ctr.levels[li];

    // peak: for scaling use max over window (cheap scan of level);
    // for rates normalize stored bin-sum to a rate (per ns)
    let mx = 1e-9;
    const i0 = Math.max(0, Math.floor(v0 / bs)),
      i1 = Math.min(arr.length - 1, Math.floor(v1 / bs));
    for (let i = i0; i <= i1; i++) if (arr[i] > mx) mx = arr[i];
    const mxRate = isDepth ? mx : mx / bs;
    c.fillStyle = '#22252c'; c.fillRect(0, y, w, r.h);
    c.fillStyle = CTR_COLORS[r.metric];
    c.globalAlpha = .85;
    for (let x = 0; x < w; x++) {
      const a = v0 + x * np, b = a + np;
      const v = IOT.data.agg(ctr, li, a, b, isDepth);
      if (v <= 0) continue;
      const val = isDepth ? v : v;      // agg already returns rate (per ns)
      const hh = Math.min(r.h - 2, (val / mxRate) * (r.h - 2));
      c.fillRect(x, y + r.h - 1 - hh, 1, hh);
    }
    c.globalAlpha = 1;
    // scale label
    c.fillStyle = 'rgba(255,255,255,.55)'; c.font = '9px sans-serif';
    const label = isDepth ? mx.toFixed(0)
      : r.metric === 'iops' ? U.fmtIops(mxRate)
        : U.fmtRate(mxRate);
    c.fillText(label, 4, y + 10);
    // slot_limit dashed line on in-flight depth
    if (r.dashLimit != null) {
      const ly = y + r.h - 1 - (r.dashLimit / mx) * (r.h - 2);
      c.strokeStyle = '#e05a5a'; c.setLineDash([4, 3]);
      c.beginPath(); c.moveTo(0, ly + .5); c.lineTo(w, ly + .5); c.stroke();
      c.setLineDash([]);
    }
    // requeue tick marks on queue depth row
    if (r.ticks && r.ticks.length) {
      const j0 = U.lowerBound(r.ticks, v0), j1 = U.upperBound(r.ticks, v1);
      c.fillStyle = '#c66db3';
      for (let j = j0; j < j1; j++) {
        const x = TS.tToPx(r.ticks[j]);
        c.fillRect(x, y + r.h - 3, 1, 2);
      }
    }
  }

  // collapsed dev group header: in-flight depth heat strip
  function paintDevSum(c, di, y, hh, w, v0, v1) {
    const D = IOT.data.D;
    const np = (v1 - v0) / w;
    const acc = new Float64Array(w);
    for (const lane of D.devLanes[di]) {
      const ids = lane, l = ids._ts ||
        (ids._ts = Float64Array.from(ids, i => D.req.t_iss[i]));
      let i0 = U.lowerBound(l, v0 - 210e6);
      for (let k = i0; k < ids.length; k++) {
        const i = ids[k], a = D.req.t_iss[i], b = D.svcEnd[i];
        if (a > v1) break;
        const x0 = U.clamp(Math.floor((a - v0) / np), 0, w - 1);
        const x1 = U.clamp(Math.ceil((b - v0) / np), 0, w);
        for (let x = x0; x < x1; x++) acc[x] += 1;
      }
    }
    let mx = 1;
    for (let x = 0; x < w; x++) mx = Math.max(mx, acc[x]);
    for (let x = 0; x < w; x++) {
      if (!acc[x]) continue;
      const t = acc[x] / mx;
      c.fillStyle = `rgba(232,118,58,${0.15 + 0.85 * t})`;
      c.fillRect(x, y + 2, 1, hh - 4);
    }
  }

  // collapsed 调度队列 header: queue-depth heat strip
  function paintQueueSum(c, di, y, hh, w, v0, v1) {
    const D = IOT.data.D;
    const np = (v1 - v0) / w;
    const acc = new Float64Array(w);
    for (const lane of D.devQueue[di]) {
      const ks = lane._qs ||
        (lane._qs = Float64Array.from(lane, i => qStartOf(i)));
      let i0 = U.lowerBound(ks, v0 - 210e6);
      for (let k = i0; k < lane.length; k++) {
        const i = lane[k], a = qStartOf(i), b = D.req.t_iss[i];
        if (a > v1) break;
        const x0 = U.clamp(Math.floor((a - v0) / np), 0, w - 1);
        const x1 = U.clamp(Math.ceil((b - v0) / np), 0, w);
        for (let x = x0; x < x1; x++) acc[x] += 1;
      }
    }
    let mx = 1;
    for (let x = 0; x < w; x++) mx = Math.max(mx, acc[x]);
    for (let x = 0; x < w; x++) {
      if (!acc[x]) continue;
      const t = acc[x] / mx;
      c.fillStyle = `rgba(150,170,255,${0.15 + 0.85 * t})`;
      c.fillRect(x, y + 2, 1, hh - 4);
    }
  }

  // collapsed proc group header: request density strip
  function paintProcSum(c, pi, y, hh, w, v0, v1) {
    const D = IOT.data.D, p = D.procList[pi];
    const np = (v1 - v0) / w;
    const acc = new Float64Array(w);
    for (const th of p.threads) {
      const e = D.thrReqs.get(th.utid);
      if (!e) continue;
      const keys = e._k || (e._k = Float64Array.from(e.ids, i => D.tSub[i]));
      let i0 = U.lowerBound(keys, v0 - 210e6);
      for (let k = i0; k < e.ids.length; k++) {
        const i = e.ids[k], a = D.tSub[i], b = D.svcEnd[i];
        if (a > v1) break;
        const x0 = U.clamp(Math.floor((a - v0) / np), 0, w - 1);
        const x1 = U.clamp(Math.ceil((b - v0) / np), 0, w);
        for (let x = x0; x < x1; x++) acc[x] += R_bytesOf(i);
      }
    }
    let mx = 1;
    for (let x = 0; x < w; x++) mx = Math.max(mx, acc[x]);
    for (let x = 0; x < w; x++) {
      if (!acc[x]) continue;
      const t = Math.min(1, acc[x] / mx);
      c.fillStyle = `rgba(109,179,242,${0.15 + 0.85 * t})`;
      c.fillRect(x, y + 2, 1, hh - 4);
    }
  }
  function R_bytesOf(i) { return IOT.data.D.req.bytes[i]; }

  // ---- names column ----------------------------------------------------
  function renderNames() {
    const T = TR.T;
    const host = document.getElementById('namesinner');
    // rebuild only when the row list changed (relayout); arrows are
    // already correct then, so no per-frame update pass is needed
    if (host._gen !== T.rows) {
      host.innerHTML = '';
      for (const r of T.rows) {
        const d = U.el('div',
          r.type === 'group' ? 'gname'
            : r.type === 'subgroup' ? 'gname subgrp'
            : r.type === 'thead' ? 'tname'
            : r.type === 'lane' ? 'tname sub lane' : 'tname sub',
          host);
        d.style.top = r.y0 + 'px';
        d.style.height = r.h + 'px';
        d.dataset.rid = r.id;
        if (r.type === 'group' || r.type === 'subgroup') {
          const ar = U.el('span', 'arrow', d);
          const exp = r.type === 'group' ? r.g.expanded : r.sg.expanded;
          ar.textContent = exp ? '▾' : '▸';
          const lb = U.el('span', 'lbl', d);
          lb.textContent = r.label;
        } else {
          d.textContent = r.label;
        }
      }
      host._gen = T.rows;
      host._selRid = undefined;          // rebuild cleared highlights
    }
    // highlight the row of the current selection (e.g. a clicked thead)
    const selRow = IOT.state.sel && IOT.state.sel.row;
    const rid = selRow ? selRow.id : null;
    if (rid !== host._selRid) {
      for (const d of host.children)
        d.classList.toggle('sel', d.dataset.rid === rid);
      host._selRid = rid;
    }
    host.style.height = T.totalH + 'px';
    host.style.transform = `translateY(${-IOT.state.scrollTop}px)`;
  }

  // ---- ruler -------------------------------------------------------------
  function renderRuler() {
    const cv = document.getElementById('ruler');
    const c = ctx2d(cv);
    const w = cv.clientWidth, h = cv.clientHeight;
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#2a2a2a'; c.fillRect(0, 0, w, h);
    const V = TS.V, ns = TS.nsPerPx();
    const step = pickStep(ns * 90);          // target ~90px between ticks
    const fmt = tickFormat(step);            // unit + decimals from step
    const t0 = Math.floor(V.v0 / step) * step;
    c.font = '9px sans-serif'; c.textBaseline = 'top';
    let lastLabelX = -1e9;
    for (let t = t0; t <= V.v1; t += step) {
      const x = TS.tToPx(t);
      c.fillStyle = '#666'; c.fillRect(x + .5, h - 8, 1, 8);
      const label = fmt(t);
      const lw = c.measureText(label).width;
      if (x + 3 > lastLabelX + 4) {          // skip colliding labels
        c.fillStyle = '#aaa';
        c.fillText(label, x + 3, 2);
        lastLabelX = x + 3 + lw;
      }
    }
    // selection range shading + duration
    const s = IOT.state;
    if (s.area) {
      const x0 = TS.tToPx(s.area.t0), x1 = TS.tToPx(s.area.t1);
      c.fillStyle = 'rgba(109,179,242,.25)';
      c.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      c.fillStyle = '#6db3f2'; c.font = '9px sans-serif';
      c.fillText(U.fmtNs(s.area.t1 - s.area.t0), (x0 + x1) / 2 + 4, h - 11);
    }
    // marks: vertical band + flag
    for (const m of s.marks.concat(s.transient ? [s.transient] : [])) {
      const x = TS.tToPx(m.t0);
      c.fillStyle = m.persistent ? '#f4cf3f' : '#7ec8f0';
      c.fillRect(x - .5, 0, 1, h);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x + 6, 4); c.lineTo(x, 8);
      c.fill();
    }
    // hover time label
    if (s.hoverT != null) {
      const x = TS.tToPx(s.hoverT);
      c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(x, 0, 1, h);
      c.fillStyle = '#fff'; c.font = '9px sans-serif';
      c.fillText(U.fmtNs(s.hoverT), x + 4, h - 11);
    }
  }

  // unit + decimals so adjacent tick labels always differ; below 1ms
  // step use seconds with enough decimals (Perfetto-style)
  function tickFormat(step) {
    let div, suf;
    if (step < 1e6) { div = 1e9; suf = 's'; }
    else if (step < 1e9) { div = 1e6; suf = 'ms'; }
    else { div = 1e9; suf = 's'; }
    const dec = Math.max(0, Math.ceil(-Math.log10(step / div)));
    return t => (t / div).toFixed(dec) + suf;
  }

  function pickStep(target) {
    // largest 1/2/5*10^k <= target
    let best = 1;
    for (let k = 0; k < 13; k++)
      for (const b of [1, 2, 5]) {
        const v = b * Math.pow(10, k);
        if (v <= target) best = v;
      }
    return best;
  }

  // ---- overview strip -----------------------------------------------------
  function renderOverview() {
    const cv = document.getElementById('overview');
    const c = ctx2d(cv);
    const w = cv.clientWidth, h = cv.clientHeight;
    c.clearRect(0, 0, w, h);
    const D = IOT.data.D;
    const set = D.counters[D.inclLoop ? 'all' : 'disk'];
    const np = D.dur / w;
    const layers = { read: set.read, write: set.write };
    for (const key of ['read', 'write']) {
      const ctr = layers[key];
      const li = IOT.data.levelFor(ctr, np);
      const bs = IOT.data.levelBinNs(ctr, li);
      const arr = ctr.levels[li];
      let mx = 1e-9;
      for (const v of arr) mx = Math.max(mx, v);
      c.fillStyle = CTR_COLORS[key];
      c.globalAlpha = .8;
      for (let x = 0; x < w; x++) {
        const v = IOT.data.agg(ctr, li, x * np, (x + 1) * np, false);
        if (v <= 0) continue;
        // agg already returns bytes/ns; mx/binNs is the peak rate
        const hh = (v / (mx / bs)) * (h - 4);
        c.fillRect(x, h - 2 - hh, 1, hh);
      }
      c.globalAlpha = 1;
    }
    updateBrush();
  }

  function updateBrush() {
    const ov = document.getElementById('overwrap');
    const w = ov.clientWidth;
    const D = IOT.data.D, V = TS.V;
    const x0 = V.v0 / D.dur * w, x1 = V.v1 / D.dur * w;
    const b = document.getElementById('brush');
    b.style.left = x0 + 'px';
    b.style.width = Math.max(4, x1 - x0) + 'px';
  }

  // ---- marks & selection bands on main canvas ------------------------------
  function paintOverlays(c, w, h) {
    const s = IOT.state;
    // area selection
    if (s.area) {
      const x0 = TS.tToPx(s.area.t0), x1 = TS.tToPx(s.area.t1);
      c.fillStyle = 'rgba(109,179,242,.12)';
      c.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      c.strokeStyle = '#6db3f2';
      c.strokeRect(x0 + .5, .5, Math.max(1, x1 - x0) - 1, h - 1);
    }
    // marks
    for (const m of s.marks.concat(s.transient ? [s.transient] : [])) {
      const x = TS.tToPx(m.t0);
      c.fillStyle = m.persistent ? 'rgba(244,207,63,.18)'
                                 : 'rgba(126,200,240,.18)';
      c.fillRect(x - 8, 0, 16, h);
      c.fillStyle = m.persistent ? '#f4cf3f' : '#7ec8f0';
      c.fillRect(x - .5, 0, 1, h);
    }
    // Stage-3 hooks (flow arrows etc.)
    if (IOT.overlayFns) for (const f of IOT.overlayFns) f(c, w, h);
    // hover crosshair
    if (s.hoverX != null) {
      c.strokeStyle = 'rgba(255,255,255,.25)';
      c.beginPath();
      c.moveTo(s.hoverX + .5, 0); c.lineTo(s.hoverX + .5, h); c.stroke();
      if (s.hoverY != null) {
        c.beginPath();
        c.moveTo(0, s.hoverY + .5); c.lineTo(w, s.hoverY + .5); c.stroke();
      }
    }
  }

  // ---- main ---------------------------------------------------------------
  function renderAll() {
    const cv = document.getElementById('canvas');
    const scroll = document.getElementById('scroll');
    const inner = document.getElementById('scrollinner');
    const T = TR.T;
    inner.style.height = T.totalH + 'px';
    cv.style.height = scroll.clientHeight + 'px';
    cv.style.width = scroll.clientWidth + 'px';
    // canvas width follows the scroll container exactly; reading
    // cv.clientWidth before its style width applies gives the
    // intrinsic 300px and scales everything ~4.5x too wide
    TS.V.width = scroll.clientWidth;
    const c = ctx2d(cv);
    const w = cv.clientWidth, h = cv.clientHeight;
    c.fillStyle = '#1e1e1e'; c.fillRect(0, 0, w, h);
    c.font = '10px sans-serif';
    for (const r of T.rows) {
      const y = r.y0 - IOT.state.scrollTop;
      if (y + r.h < 0 || y > h) continue;
      paintRow(c, r, w);
    }
    paintOverlays(c, w, h);
    renderNames();
    renderRuler();
  }

  return { renderAll, renderRuler, renderOverview, updateBrush,
           pickStep, ctx2d, reqLabel, CAT_COLORS };
})();
