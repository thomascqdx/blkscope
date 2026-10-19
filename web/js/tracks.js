'use strict';
/* tracks.js: track tree -> flat visible row list (design 5.3)

   Tree: 概览 counters (expanded) > disk dev groups (expanded, sorted by
   request count desc) > one "loop / 其他设备" group (collapsed, each dev
   a collapsible subgroup) > process groups (collapsed, thread subgroups
   inside). Collapsed groups occupy a single header row which itself
   draws the summary heat/density strip. */
IOT.tracks = (function () {
  const T = { rows: [], groups: [], byId: new Map() };

  const H = { ctr: 28, lane: 10, thead: 16, dstate: 16, treq: 16,
              files: 16, group: 22, subgroup: 18 };

  function row(id, type, h, label, data) {
    return Object.assign({ id, type, h, label, y0: 0 }, data || {});
  }

  function devLabel(d, lanes) {
    let s = `${d.name} (${d.kind}) · ${lanes} 槽位`;
    if (d.slot_limit != null) s += ` · 上限 ${d.slot_limit}`;
    return s;
  }

  function devGroup(d, di, expanded) {
    const D = IOT.data.D;
    const lanes = D.devLanes[di].length;
    return {
      id: 'dev' + d.dev, label: devLabel(d, lanes),
      expanded, kind: 'dev', di,
      mkRows() {
        const rr = [];
        for (let s = 0; s < D.devLanes[di].length; s++) {
          // 10px lanes: label only every 4th to avoid overlap
          rr.push(row(this.id + '_s' + s, 'lane', H.lane,
                      s % 4 === 0 ? '槽位 ' + s : '', { di, slot: s }));
        }
        return rr.length ? rr : [row(this.id + '_e', 'empty', H.lane,
                                     '（无请求）')];
      },
    };
  }

  function build() {
    const D = IOT.data.D;
    T.groups = [];
    T.byId = new Map();

    // 1) overview group
    T.groups.push({
      id: 'ov', label: '概览', expanded: true, kind: 'ctr',
      mkRows() {
        return [
          row('ctr_read', 'ctr', H.ctr, '读 MB/s', { metric: 'read' }),
          row('ctr_write', 'ctr', H.ctr, '写 MB/s', { metric: 'write' }),
          row('ctr_iops', 'ctr', H.ctr, 'IOPS', { metric: 'iops' }),
          row('ctr_ind', 'ctr', H.ctr, '在途深度',
              { metric: 'ind', dashLimit: D.devs
                  .filter(d => d.kind === 'disk' && d.slot_limit != null)
                  .map(d => d.slot_limit)[0] }),
          row('ctr_qdep', 'ctr', H.ctr, '排队深度',
              { metric: 'qdep', ticks: D.requeueTs }),
        ];
      },
    });

    // 2) device groups: disks first (by request count desc), then ONE
    //    "loop / 其他设备" group whose devs are collapsible subgroups
    const reqCount = D.devs.map((d, di) =>
      D.devLanes[di].reduce((a, l) => a + l.length, 0));
    const disks = [], others = [];
    D.devs.forEach((d, di) =>
      (d.kind === 'disk' ? disks : others).push(di));
    disks.sort((a, b) => reqCount[b] - reqCount[a]);
    for (const di of disks)
      T.groups.push(devGroup(D.devs[di], di, true));

    if (others.length) {
      const subs = others.map(di => devGroup(D.devs[di], di, false));
      T.groups.push({
        id: 'loopgrp', kind: 'loopgroup',
        label: `loop / 其他设备 (${others.length})`,
        expanded: false,
        subs,
        mkRows() {
          const rr = [];
          for (const sg of subs) {
            rr.push(row(sg.id + '_h', 'subgroup', H.subgroup, sg.label,
                        { sg }));
            if (sg.expanded) for (const r of sg.mkRows()) rr.push(r);
          }
          return rr;
        },
      });
    }

    // 3) process groups (collapsed default)
    D.procList.forEach((p, pi) => {
      T.groups.push({
        id: 'proc' + pi, label: p.name + (p.pid >= 0 ? ` (${p.pid})` : ''),
        expanded: false, kind: 'proc', pi,
        mkRows() {
          const rr = [];
          for (const th of p.threads) {
            const reqs = D.thrReqs.get(th.utid);
            const dsegs = D.thrD.get(th.utid) || [];
            const bts = D.thrBatches.get(th.utid) || [];
            if (!((reqs && reqs.sub.length) || dsegs.length || bts.length))
              continue;
            rr.push(row(this.id + '_th' + th.utid, 'thead', H.thead,
                        `${th.name} (${th.tid})`, { utid: th.utid }));
            if (dsegs.length)
              rr.push(row(this.id + '_d' + th.utid, 'dstate', H.dstate,
                          'D 状态', { utid: th.utid, ids: dsegs }));
            if (reqs) {
              reqs.sub.forEach((ids, si) => rr.push(row(
                this.id + '_r' + th.utid + '_' + si, 'treq', H.treq,
                si === 0 ? `IO 请求 (${reqs.ids.length})` : '',
                { utid: th.utid, ids })));
            }
            if (bts.length)
              rr.push(row(this.id + '_f' + th.utid, 'files', H.files,
                          '文件读取', { utid: th.utid, ids: bts }));
          }
          return rr;
        },
      });
    });
    for (const g of T.groups) T.byId.set(g.id, g);
    relayout();
  }

  function toggle(id) {
    // id may be a top group or a '<sgid>_h' subgroup header
    const g = T.byId.get(id);
    if (g) { g.expanded = !g.expanded; relayout(); return; }
    for (const lg of T.groups) {
      if (lg.kind !== 'loopgroup' || !lg.subs) continue;
      const sg = lg.subs.find(s => s.id + '_h' === id);
      if (sg) { sg.expanded = !sg.expanded; relayout(); return; }
    }
  }
  function setExpanded(id, on) {
    const g = T.byId.get(id);
    if (g && g.expanded !== on) { g.expanded = on; relayout(); return; }
    for (const lg of T.groups) {
      if (lg.kind !== 'loopgroup' || !lg.subs) continue;
      const sg = lg.subs.find(s => s.id + '_h' === id);
      if (sg && sg.expanded !== on) { sg.expanded = on; relayout(); }
    }
  }

  function relayout() {
    T.rows = [];
    let y = 0;
    for (const g of T.groups) {
      const hr = row(g.id, 'group', H.group, g.label, { g });
      hr.y0 = y; y += hr.h;
      T.rows.push(hr);
      if (g.expanded)
        for (const r of g.mkRows()) { r.y0 = y; y += r.h; T.rows.push(r); }
    }
    T.totalH = y;
  }

  function rowAt(y) {
    const rows = T.rows;
    let lo = 0, hi = rows.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >>> 1, r = rows[m];
      if (y < r.y0) hi = m - 1;
      else if (y >= r.y0 + r.h) lo = m + 1;
      else return r;
    }
    return null;
  }

  return { T, H, build, toggle, setExpanded, relayout, rowAt };
})();
