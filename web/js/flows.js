'use strict';
/* flows.js: flow-arrow overlay (design 5.5)
   - selected D segment: arrow from its wake-up point (seg end) to each
     waited request — to the thread "IO 请求" row rect and to the slot
     lane rect, whichever rows are visible; wait_src=2 dashed.
   - selected request: arrow from its thread-row rect to its slot-lane
     rect; D segments that waited on it are outlined (reverse index).
   Only endpoints with a currently-visible row are drawn. */
IOT.flows = (function () {
  const U = IOT.util;

  function rowById() {
    const T = IOT.tracks.T;
    if (!T._byId || T._byIdGen !== T.rows) {
      T._byId = new Map(T.rows.map(r => [r.id, r]));
      T._byIdGen = T.rows;
    }
    return T._byId;
  }

  // screen y of a row centre, or null when not visible
  function rowY(r) {
    const st = IOT.state.scrollTop;
    const h = document.getElementById('scroll').clientHeight;
    if (!r || r.y0 + r.h < st || r.y0 > st + h) return null;
    return r.y0 + r.h / 2 - st;
  }

  // find the treq row containing req i for thread utid (procList pi)
  function reqRow(byId, utid, i) {
    const D = IOT.data.D;
    const ti = D.tidOf.get(utid);
    if (ti == null) return null;
    const upid = D.threads.upid[ti];
    let pi = -1;
    for (let k = 0; k < D.procList.length; k++)
      if (D.procList[k].upid === upid) { pi = k; break; }
    if (pi < 0) return null;
    const e = D.thrReqs.get(utid);
    if (!e) return null;
    let si = e.sub.findIndex(sub => sub.indexOf(i) >= 0);
    if (si < 0) si = e.sub.length - 1;
    return byId.get('proc' + pi + '_r' + utid + '_' + si) || null;
  }

  function laneRow(byId, dev, slot) {
    return byId.get('dev' + dev + '_s' + slot) || null;
  }

  function dstRow(byId, utid) {
    const D = IOT.data.D;
    const ti = D.tidOf.get(utid);
    if (ti == null) return null;
    const upid = D.threads.upid[ti];
    let pi = -1;
    for (let k = 0; k < D.procList.length; k++)
      if (D.procList[k].upid === upid) { pi = k; break; }
    if (pi < 0) return null;
    return byId.get('proc' + pi + '_d' + utid) || null;
  }

  function arrow(c, x0, y0, x1, y1, dashed) {
    c.save();
    c.strokeStyle = '#f4cf3f'; c.fillStyle = '#f4cf3f';
    c.lineWidth = 1.2;
    c.setLineDash(dashed ? [4, 3] : []);
    c.beginPath(); c.moveTo(x0, y0);
    // slight sag for readability
    c.quadraticCurveTo((x0 + x1) / 2, Math.max(y0, y1) + 10, x1, y1);
    c.stroke();
    c.setLineDash([]);
    c.beginPath(); c.arc(x1, y1, 2.5, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  function draw(c) {
    const s = IOT.state;
    if (!s.sel) return;
    const D = IOT.data.D, R = D.req, DS = D.dst;
    const TS = IOT.ts, byId = rowById();
    const w = c.canvas.clientWidth;

    if (s.sel.type === 'd') {
      const i = s.sel.id;
      const dRow = s.sel.row && s.sel.row.type === 'dstate'
        ? s.sel.row : dstRow(byId, DS.utid[i]);
      const y0 = rowY(dRow);
      if (y0 == null) return;
      const x0 = TS.tToPx(DS.ts[i] + DS.dur[i]);   // wake-up point
      for (let k = D.waitOff[i]; k < D.waitOff[i + 1]; k++) {
        const r = D.waitReq[k];
        const x1 = TS.tToPx(R.t_cmp[r] >= 0 ? R.t_cmp[r] : D.svcEnd[r]);
        const xa = TS.tToPx(R.t_iss[r] >= 0 ? R.t_iss[r] : D.tSub[r]);
        const dashed = D.waitSrc[k] === 2;
        // outline the waited request on every visible row, then the
        // arrow only when the target x is in view
        for (const rw of [reqRow(byId, R.utid[r], r),
                          laneRow(byId, R.dev[r], R.slot[r])]) {
          const ty = rowY(rw);
          if (ty == null) continue;
          c.save();
          c.strokeStyle = '#f4cf3f'; c.lineWidth = 1.4;
          c.setLineDash(dashed ? [3, 2] : []);
          c.strokeRect(Math.max(0, xa), ty - rw.h / 2 + 1,
                       Math.max(2, x1 - xa), rw.h - 2);
          c.restore();
          if (x1 >= -4 && x1 <= w + 4)
            arrow(c, x0, y0, x1, ty, dashed);
        }
      }
    } else if (s.sel.type === 'req') {
      const i = s.sel.id;
      const xB = TS.tToPx(D.svcEnd[i]);
      const tr = reqRow(byId, R.utid[i], i);
      const lr = laneRow(byId, R.dev[i], R.slot[i]);
      const ty = rowY(tr), ly = rowY(lr);
      if (ty != null && ly != null)
        arrow(c, xB, ty, xB, ly, false);
      // queue-lane rect: outline + arrow from its end to the lane start
      const qp = D.reqQLane && D.reqQLane.get(i);
      if (qp) {
        const qr = byId.get('dev' + qp.dev + '_q' + qp.lane);
        const qy = rowY(qr);
        if (qy != null) {
          const xa = TS.tToPx(R.t_ins[i] >= 0 ? R.t_ins[i] : R.t_iss0[i]);
          const xb = TS.tToPx(R.t_iss[i]);
          c.save();
          c.strokeStyle = '#f4cf3f'; c.lineWidth = 1.4;
          c.strokeRect(xa, qy - qr.h / 2 + 1, Math.max(2, xb - xa),
                       qr.h - 2);
          c.restore();
          const lx0 = TS.tToPx(R.t_iss[i]);   // lane rect starts at t_iss
          if (ly != null) arrow(c, xb, qy, lx0, ly, false);
        }
      }
      // highlight D segs that waited on this request
      const ds = D.reqDsegs.get(i) || [];
      c.save();
      c.strokeStyle = '#f4cf3f'; c.lineWidth = 1.4;
      c.setLineDash([3, 2]);
      for (const di of ds) {
        const dr = dstRow(byId, DS.utid[di]);
        const y = rowY(dr);
        if (y == null) continue;
        const xa = TS.tToPx(DS.ts[di]), xb = TS.tToPx(DS.ts[di] + DS.dur[di]);
        if (xb < 0 || xa > w) continue;
        c.strokeRect(xa, y - dr.h / 2, Math.max(2, xb - xa), dr.h);
      }
      c.restore();
    }
  }

  return { draw };
})();

IOT.overlayFns = IOT.overlayFns || [];
IOT.overlayFns.push(IOT.flows.draw);
