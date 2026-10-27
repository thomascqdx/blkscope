'use strict';
/* app.js: boot sequence, IOT.state/ready/bench/debug test hooks */
IOT.app = (function () {
  IOT.state = {
    sel: null,            // {type,id,row,t?}
    area: null,           // {t0,t1,rows:Set|null}
    marks: [],            // persistent marks {t0,t1,persistent}
    transient: null,      // transient mark
    scrollTop: 0,
    hoverX: null, hoverY: null, hoverT: null,
  };
  IOT.ready = false;
  IOT.overlayFns = IOT.overlayFns || [];   // Stage-3 flow-arrow hook
  IOT.paint = IOT.paint || null;           // Stage-3 color-mode hook

  function qualityBanner() {
    const D = IOT.data.D;
    const host = document.getElementById('quality');
    const warns = D.quality.filter(q => q.level === 'warn');
    if (!D.quality.length) { host.style.display = 'none'; return; }
    host.classList.add('collapsed');
    const head = IOT.util.el('div', 'qhead', host);
    head.textContent = `数据质量：${warns.length} 条警告，` +
      `${D.quality.length - warns.length} 条提示（点击展开）`;
    head.addEventListener('mousedown', () =>
      host.classList.toggle('collapsed'));
    const body = IOT.util.el('div', 'qbody', host);
    for (const q of D.quality) {
      const d = IOT.util.el('div', 'qitem ' + q.level, body);
      d.textContent = `[${q.level}] ${q.code}：${q.msg}`;
    }
  }

  function header() {
    const D = IOT.data.D, m = D.meta;
    document.getElementById('title').textContent = m.name || 'blkscope';
    const dv = m.device || {};
    const bits = [dv.android_device_manufacturer, dv.android_soc_model,
                  dv.android_build_fingerprint]
      .filter(Boolean).join(' · ');
    document.getElementById('devinfo').textContent =
      bits + (m.dur ? `  |  时长 ${IOT.util.fmtNs(m.dur)}` : '');
    const tv = document.getElementById('toolver');
    tv.textContent = m.tool_version ? `blkscope v${m.tool_version}` : '';
    tv.title = m.generated ? `生成时间 ${m.generated}` : '';
  }

  // ---------------- test hooks ----------------
  IOT.bench = function (n) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) IOT.render.renderAll();
    return (performance.now() - t0) / n;
  };

  function locateInRow(row, a, b) {
    const scroll = document.getElementById('scroll');
    const t = (a + b) / 2;
    // bring the entity into view horizontally + vertically
    const V = IOT.ts.V;
    if (t < V.v0 || t > V.v1) {
      const span = V.v1 - V.v0;
      V.v0 = t - span / 2; V.v1 = t + span / 2;
      IOT.ts.clampView();
    }
    const y = row.y0 + row.h / 2 - IOT.state.scrollTop;
    if (y < 0 || y > scroll.clientHeight)
      scroll.scrollTop = row.y0 - scroll.clientHeight / 2;
    IOT.state.scrollTop = scroll.scrollTop;
    IOT.render.renderAll();
    const cv = document.getElementById('canvas');
    const rc = cv.getBoundingClientRect();
    const x = insidePx(a, b);
    return { x: rc.left + x, y: rc.top + (row.y0 + row.h / 2) -
              scroll.scrollTop };
  }

  // pixel centre guaranteed inside [a,b] even for sub-pixel rects
  function insidePx(a, b) {
    return (Math.floor(IOT.ts.tToPx(a)) + Math.ceil(IOT.ts.tToPx(b))) / 2;
  }

  IOT.debug = {
    locateRequest(id) {
      const D = IOT.data.D, R = D.req;
      const di = D.devIdx.get(R.dev[id]);
      if (di == null || R.slot[id] < 0) return null;
      let g = IOT.tracks.T.byId.get('dev' + D.devs[di].dev);
      if (!g) {
        // loop/other devs live as subgroups inside 'loopgrp'
        const lg = IOT.tracks.T.byId.get('loopgrp');
        if (!lg) return null;
        if (!lg.expanded) IOT.tracks.setExpanded('loopgrp', true);
        g = lg.subs.find(s => s.id === 'dev' + D.devs[di].dev);
        if (!g) return null;
        if (!g.expanded) { g.expanded = true; IOT.tracks.relayout(); }
      } else if (!g.expanded) IOT.tracks.setExpanded(g.id, true);
      const row = IOT.tracks.T.rows.find(r =>
        r.type === 'lane' && r.di === di && r.slot === R.slot[id]);
      if (!row) return null;
      return locateInRow(row, R.t_iss[id], D.svcEnd[id]);
    },
    locateD(id) {
      const D = IOT.data.D, utid = D.dst.utid[id];
      // find its process group and expand
      for (const g of IOT.tracks.T.groups) {
        if (g.kind !== 'proc') continue;
        const p = D.procList[g.pi];
        if (p.threads.some(t => t.utid === utid)) {
          if (!g.expanded) IOT.tracks.setExpanded(g.id, true);
          break;
        }
      }
      const row = IOT.tracks.T.rows.find(r =>
        r.type === 'dstate' && r.utid === utid);
      if (!row) return null;
      return locateInRow(row, D.dst.ts[id], D.dst.ts[id] + D.dst.dur[id]);
    },
    expand(id) { IOT.tracks.setExpanded(id, true);
                 IOT.requestRender(); },
    canvasRect() {
      const r = document.getElementById('canvas').getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    topProcGroup() {
      const g = IOT.tracks.T.groups.find(g => g.kind === 'proc');
      return g ? g.id : null;
    },
    mainThreadD() {
      // first D seg of the main thread (tid==pid) of the top process
      const D = IOT.data.D, p = D.procList[0];
      if (!p) return -1;
      const main = p.threads.find(t => t.tid === p.pid) || p.threads[0];
      const ds = D.thrD.get(main.utid) || [];
      return ds.length ? ds[0] : -1;
    },
    // lifecycle phase boundaries of request id (design 5.3.1) —
    // a phase is emitted only when both endpoints exist and t1 > t0
    reqSegments(id) {
      const D = IOT.data.D, R = D.req;
      const out = [];
      const push = (phase, a, b) => {
        if (a >= 0 && b >= 0 && b > a) out.push({ phase, t0: a, t1: b });
      };
      push('bio', R.t_make[id], R.t_ins[id]);
      push('queue', R.t_ins[id], R.t_iss0[id]);
      if (R.rq_n[id] > 0) push('requeue', R.t_iss0[id], R.t_iss[id]);
      push('service', R.t_iss[id], D.svcEnd[id]);
      return out;
    },
    // peak queue lanes per device
    qPeak() {
      return IOT.data.D.devQueue.map((l, di) => ({
        dev: IOT.data.D.devs[di].name, kind: IOT.data.D.devs[di].kind,
        lanes: l.length }));
    },
  };

  async function boot() {
    try {
      await IOT.data.load();
      IOT.ts.init(IOT.data.D.dur);
      IOT.tracks.build();
      header();
      qualityBanner();
      IOT.panels.init();
      IOT.input.init();
      IOT.render.renderOverview();
      IOT.render.renderAll();
      IOT.ready = true;
    } catch (err) {
      console.error('blkscope init failed:', err);
      document.body.innerHTML =
        `<div style="padding:20px;color:#f66">加载失败: ` +
        `${String(err && err.stack || err)}</div>`;
    }
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
