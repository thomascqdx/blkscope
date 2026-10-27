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

  // ---- leaf track keys (area-selection track filter, design 6) ------
  // ctr:<metric> | lane:<di>:<slot> | qlane:<di>:<slot> | treq:<utid>
  // (ONE key per thread covering all its IO 请求 sub-rows) |
  // dstate:<utid> | files:<utid> — stable across expand/collapse.
  const CTR_LEAVES = ['read', 'write', 'iops', 'ind', 'qdep']
    .map(m => 'ctr:' + m);

  function devLeaves(di) {
    const D = IOT.data.D, L = [];
    const q = D.devQueue ? D.devQueue[di] : null;
    if (q) for (let s = 0; s < q.length; s++) L.push(`qlane:${di}:${s}`);
    for (let s = 0; s < D.devLanes[di].length; s++)
      L.push(`lane:${di}:${s}`);
    return L;
  }

  function devQLeaves(di) {
    const D = IOT.data.D, L = [];
    const q = D.devQueue ? D.devQueue[di] : null;
    if (q) for (let s = 0; s < q.length; s++) L.push(`qlane:${di}:${s}`);
    return L;
  }

  // exactly the leaf rows mkRows creates for this thread
  function threadLeaves(utid) {
    const D = IOT.data.D, L = [];
    if ((D.thrD.get(utid) || []).length) L.push('dstate:' + utid);
    const e = D.thrReqs.get(utid);
    if (e && e.sub.length) L.push('treq:' + utid);
    if ((D.thrBatches.get(utid) || []).length) L.push('files:' + utid);
    return L;
  }

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
      leaves() { return this._lv || (this._lv = devLeaves(this.di)); },
      mkRows() {
        const rr = [];
        const q = D.devQueue ? D.devQueue[di] : null;
        if (q && q.length) {
          // 调度队列 subgroup above the slot lanes (design 5.3.1)
          rr.push(row(this.id + '_qh', 'qgroup', H.subgroup,
                      `调度队列 · 峰值 ${q.length}`,
                      { di, qExp: !!this.qExp }));
          if (this.qExp)
            for (let s = 0; s < q.length; s++)
              rr.push(row(this.id + '_q' + s, 'qlane', H.lane,
                          s % 4 === 0 ? '队列 ' + s : '',
                          { di, slot: s }));
        }
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
    _all = null;

    // 1) overview group
    T.groups.push({
      id: 'ov', label: '概览', expanded: true, kind: 'ctr',
      leaves() { return CTR_LEAVES; },
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
        leaves() {
          return this._lv ||
            (this._lv = this.subs.flatMap(s => s.leaves()));
        },
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
        leaves() {
          if (this._lv) return this._lv;
          const L = [];
          for (const th of p.threads) {
            const reqs = IOT.data.D.thrReqs.get(th.utid);
            const dsegs = IOT.data.D.thrD.get(th.utid) || [];
            const bts = IOT.data.D.thrBatches.get(th.utid) || [];
            if (!((reqs && reqs.sub.length) || dsegs.length || bts.length))
              continue;
            L.push(...threadLeaves(th.utid));
          }
          return this._lv = L;
        },
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
                { utid: th.utid, ids, si,
                  overflow: reqs.ovIdx === si })));
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
    // id may be a top group, a '<sgid>_h' subgroup header, or a
    // '<devid>_qh' queue-subgroup header
    const g = T.byId.get(id);
    if (g) { g.expanded = !g.expanded; relayout(); return; }
    if (id.endsWith('_qh')) {
      const dg = T.byId.get(id.slice(0, -3));
      if (dg) { dg.qExp = !dg.qExp; relayout(); return; }
    }
    for (const lg of T.groups) {
      if (lg.kind !== 'loopgroup' || !lg.subs) continue;
      const sg = lg.subs.find(s => s.id + '_h' === id);
      if (sg) { sg.expanded = !sg.expanded; relayout(); return; }
    }
  }
  function setExpanded(id, on) {
    const g = T.byId.get(id);
    if (g && g.expanded !== on) { g.expanded = on; relayout(); return; }
    if (id.endsWith('_qh')) {
      const dg = T.byId.get(id.slice(0, -3));
      if (dg && !!dg.qExp !== on) { dg.qExp = on; relayout(); return; }
    }
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

  // ---- track selection ----------------------------------------------
  function rowKey(r) {
    switch (r.type) {
      case 'ctr': return 'ctr:' + r.metric;
      case 'lane': return `lane:${r.di}:${r.slot}`;
      case 'qlane': return `qlane:${r.di}:${r.slot}`;
      case 'treq': return 'treq:' + r.utid;   // one key covers all sub-rows
      case 'dstate': return 'dstate:' + r.utid;
      case 'files': return 'files:' + r.utid;
      default: return null;                 // 'empty' rows have no leaf
    }
  }

  // all leaves this row stands for (independent of expansion)
  function rowAllLeaves(r) {
    switch (r.type) {
      case 'group': return r.g.leaves ? r.g.leaves() : [];
      case 'subgroup': return r.sg.leaves();
      case 'qgroup': return devQLeaves(r.di);
      case 'thead': return threadLeaves(r.utid);
      default: {
        const k = rowKey(r);
        return k ? [k] : [];
      }
    }
  }

  // leaves a canvas drag over this row selects: the header row of an
  // EXPANDED group/subgroup/qgroup contributes nothing (its visible
  // children decide); collapsed headers contribute all their leaves
  function rowDragLeaves(r) {
    if ((r.type === 'group' && r.g.expanded) ||
        (r.type === 'subgroup' && r.sg.expanded) ||
        (r.type === 'qgroup' && r.qExp)) return [];
    return rowAllLeaves(r);
  }

  let _all = null;                        // cached union of all leaves
  function allLeaves() {
    if (!_all) {
      _all = [];
      for (const g of T.groups)
        for (const k of g.leaves()) _all.push(k);
    }
    return _all;
  }

  // operations on IOT.state.area.tracks (Set<key> | null; null = all
  // tracks = no filter). Never mutate a Set in place — identity change
  // is the change signal; after every op a Set covering all leaves
  // normalizes back to null.
  const sel = {
    rowState(r) {                          // 0 none / 1 partial / 2 all
      const A = IOT.state && IOT.state.area;
      if (!A || A.tracks == null) return 2;
      const L = rowAllLeaves(r);
      if (!L.length) return 0;
      let n = 0;
      for (const k of L) if (A.tracks.has(k)) n++;
      return n === 0 ? 0 : n === L.length ? 2 : 1;
    },
    set(t) {
      const A = IOT.state && IOT.state.area;
      if (!A) return;
      A.tracks = (t == null || t.size === allLeaves().length) ? null : t;
    },
    toggleRow(r) {
      const A = IOT.state && IOT.state.area;
      if (!A) return;
      const t = A.tracks == null ? new Set(allLeaves())
                                 : new Set(A.tracks);
      if (sel.rowState(r) === 2)
        for (const k of rowAllLeaves(r)) t.delete(k);
      else
        for (const k of rowAllLeaves(r)) t.add(k);
      sel.set(t);
    },
    selectAll() {
      const A = IOT.state && IOT.state.area;
      if (A) A.tracks = null;
    },
    invert() {
      const A = IOT.state && IOT.state.area;
      if (!A) return;
      // null (all) -> none; hidden leaves in collapsed groups flip too
      sel.set(A.tracks == null ? new Set()
        : new Set(allLeaves().filter(k => !A.tracks.has(k))));
    },
    clear() { sel.set(new Set()); },
    count() {
      const A = IOT.state && IOT.state.area;
      if (!A) return 0;
      return A.tracks == null ? allLeaves().length : A.tracks.size;
    },
  };

  return { T, H, build, toggle, setExpanded, relayout, rowAt,
           allLeaves, rowAllLeaves, rowDragLeaves, sel };
})();
