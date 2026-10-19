'use strict';
/* panels.js: bottom panel (tab registry — Stage 3 plugs in more tabs),
   '当前选择' details, help overlay */
IOT.panels = (function () {
  const U = IOT.util;
  const tabs = [];             // {id,label,render(host)}
  let active = null;

  function registerTab(id, label, render) {
    tabs.push({ id, label, render });
    rebuildTabs();
  }
  function rebuildTabs() {
    const host = document.getElementById('tabs');
    host.innerHTML = '';
    for (const t of tabs) {
      const d = U.el('div', 'tab' + (t.id === active ? ' active' : ''), host);
      d.textContent = t.label;
      d.dataset.tid = t.id;
      d.addEventListener('mousedown', () => activate(t.id));
    }
  }
  function refresh() {
    const host = document.getElementById('panelbody');
    host.innerHTML = '';
    const t = tabs.find(x => x.id === active) || tabs[0];
    if (t) t.render(host);
    // keep the tab bar in sync with `active`
    for (const d of document.getElementById('tabs').children)
      d.classList.toggle('active', d.dataset.tid ===
        (t ? t.id : null));
  }
  // switch the visible tab (click or programmatic auto-switch)
  function activate(id) {
    if (tabs.some(t => t.id === id)) active = id;
    refresh();
  }
  function showSelection() { refresh(); }

  // ---------------- details renderers ----------------
  function table(host, rows) {
    const tb = U.el('table', '', host);
    for (const [k, v, opts] of rows) {
      const tr = U.el('tr', '', tb);
      const kd = U.el('td', 'k', tr); kd.textContent = k;
      const vd = U.el('td', '', tr);
      if (opts && opts.guess) {
        vd.textContent = v + ' ';
        const g = U.el('span', 'guess', vd);
        g.textContent = '推测';
      } else vd.textContent = v;
      if (opts && opts.mark) vd.classList.add('mark');
    }
    return tb;
  }

  function prFlags(p) {
    const L = [];
    if (p & 1) L.push('RT'); if (p & 2) L.push('IDLE');
    if (p & 4) L.push('UX'); if (p & 8) L.push('FG_META');
    if (p & 16) L.push('SYNC'); if (p & 32) L.push('META');
    if (p & 64) L.push('FUA');
    return L.length ? L.join(' ') : '-';
  }

  function reqDetail(host, id) {
    const D = IOT.data.D, R = D.req;
    const dev = D.devs[D.devIdx.get(R.dev[id])];
    const ti = D.tidOf.get(R.utid[id]);
    const tsub = D.tSub[id];
    const rows = [
      ['请求 id', String(id)],
      ['设备', dev ? `${dev.name} (${dev.kind})` : String(R.dev[id])],
      ['扇区', String(R.sector[id])],
      ['大小', U.fmtBytes(R.bytes[id])],
      ['rwbs', D.strs[R.rwbs[id]] || ''],
      ['类别', CAT_NAME[R.cat[id]] || String(R.cat[id])],
      ['优先级', prFlags(R.prio[id])],
      ['class / lvl', `${R.cls[id]} / ${R.lvl[id]}`],
      ['提交线程', ti != null ?
        `${D.strs[D.threads.name[ti]]} (${D.threads.tid[ti]}) · ` +
        procName(D, D.threads.upid[ti]) : `utid ${R.utid[id]}`],
      ['t_make', U.fmtNsPrec(R.t_make[id])],
      ['t_insert', U.fmtNsPrec(R.t_ins[id])],
      ['t_issue_first', U.fmtNsPrec(R.t_iss0[id])],
      ['t_issue', U.fmtNsPrec(R.t_iss[id])],
      ['t_complete', R.t_cmp[id] >= 0 ? U.fmtNsPrec(R.t_cmp[id]) : '未完成'],
      ['make→insert', R.t_make[id] >= 0 && R.t_ins[id] >= 0 ?
        U.fmtNs(R.t_ins[id] - R.t_make[id]) : '-'],
      ['insert→issue', R.t_ins[id] >= 0 && R.t_iss0[id] >= 0 ?
        U.fmtNs(R.t_iss0[id] - R.t_ins[id]) : '-'],
      ['issue→complete', R.t_cmp[id] >= 0 && R.t_iss[id] >= 0 ?
        U.fmtNs(R.t_cmp[id] - R.t_iss[id]) : '-'],
      ['排队 q', R.t_ins[id] >= 0 && R.t_iss0[id] >= 0 ?
        U.fmtNs(R.t_iss0[id] - R.t_ins[id]) : '-'],
      ['服务 svc', R.t_cmp[id] >= 0 && R.t_iss[id] >= 0 ?
        U.fmtNs(R.t_cmp[id] - R.t_iss[id]) : '-'],
      ['总耗时', R.t_cmp[id] >= 0 ? U.fmtNs(R.t_cmp[id] - tsub) : '-'],
      ['槽位', R.slot[id] >= 0 ? String(R.slot[id]) : '-'],
      ['req_tag', R.tag[id] >= 0 ? String(R.tag[id]) : '-'],
      ['requeue', R.rq_n[id] > 0 ?
        `${R.rq_n[id]} 次` + (R.rq_reason[id] >= 0 ?
          ` (reason ${R.rq_reason[id]})` : '') : '-'],
      ['error', R.err[id] !== 0 ? String(R.err[id]) : '0'],
    ];
    if (R.file[id] >= 0) {
      const fi = R.file[id];
      const nm = D.strs[D.files.name[fi]];
      const hint = D.strs[D.files.hint[fi]] || '';
      rows.push(['文件', `${nm}${hint ? ' · ' + hint : ''}`, { guess: true }]);
      rows.push(['偏移 / 范围',
        `+${U.fmtBytes(R.foff[id])} / ${U.fmtBytes(R.flen[id])}`]);
      rows.push(['批次', R.batch[id] >= 0 ? '#' + R.batch[id] : '-']);
      rows.push(['关联来源', R.fsrc[id] === 1 ? 'fm_add 模式' : 'pc_start 回溯',
                 { guess: true }]);
    } else if (R.fsrc[id] === 0) {
      rows.push(['文件', '未关联']);
    }
    if (R.t_cmp[id] < 0) rows.push(['状态', '未完成（画到窗口末尾/截断）',
                                    { mark: true }]);
    table(host, rows);
    // clickable list of D segments that waited on this request
    const waits = (D.reqDsegs && D.reqDsegs.get(id)) || [];
    if (waits.length) {
      const wl = U.el('div', 'waitlist', host);
      U.el('span', 'k', wl).textContent = '等待它的 D 段 ';
      for (const di of waits) {
        const a = U.el('span', 'lk', wl);
        a.textContent = `#${di}`;
        a.addEventListener('mousedown', () => {
          IOT.state.sel = { type: 'd', id: di, row: null };
          IOT.state.area = null;
          IOT.debug.locateD(di);
          IOT.panels.showSelection();
        });
      }
    }
  }

  function dDetail(host, id) {
    const D = IOT.data.D, S = D.dst;
    const ti = D.tidOf.get(S.utid[id]);
    const fnOk = S.fn_ok[id];
    const rows = [
      ['D 段', '#' + id],
      ['线程', ti != null ?
        `${D.strs[D.threads.name[ti]]} (${D.threads.tid[ti]}) · ` +
        procName(D, D.threads.upid[ti]) : `utid ${S.utid[id]}`],
      ['开始', U.fmtNsPrec(S.ts[id])],
      ['时长', U.fmtNs(S.dur[id])],
      ['block function', D.strs[S.fn[id]] || '(未知)'],
      ['符号化', fnOk ? '是' : 'caller#id（未解析，见质量提示）'],
      ['io_wait', S.iow[id] >= 0 ? String(S.iow[id]) : '-'],
    ];
    table(host, rows);
    // clickable waited-request links
    const w0 = D.waitOff[id], w1 = D.waitOff[id + 1];
    const wl = U.el('div', 'waitlist', host);
    U.el('span', 'k', wl).textContent = '等待的请求 ';
    if (w1 > w0) {
      for (let k = w0; k < w1; k++) {
        const rid = D.waitReq[k], src = D.waitSrc[k];
        const a = U.el('span', 'lk', wl);
        a.textContent = `#${rid}`;
        if (src === 2) {
          const g = U.el('span', 'guess', a);
          g.textContent = '推测';
        }
        a.addEventListener('mousedown', () => {
          IOT.state.sel = { type: 'req', id: rid, row: null };
          IOT.state.area = null;
          IOT.debug.locateRequest(rid);
          IOT.panels.showSelection();
        });
      }
    } else {
      const d = U.el('span', '', wl);
      d.style.color = '#888'; d.textContent = '无匹配';
    }
  }

  function batchDetail(host, id) {
    const D = IOT.data.D, B = D.batches;
    const fi = B.file[id];
    const nm = fi >= 0 ? D.strs[D.files.name[fi]] : '?';
    const hint = fi >= 0 ? D.strs[D.files.hint[fi]] : '';
    const rows = [
      ['批次', '#' + id],
      ['文件', `${nm}${hint ? ' · ' + hint : ''}` +
        (fi >= 0 && D.files.meta[fi] ? '（元数据）' : '')],
      ['开始', U.fmtNsPrec(B.ts[id])],
      ['结束', U.fmtNsPrec(B.end[id])],
      ['页范围', `+${U.fmtBytes(B.page0[id] * 4096)}，${B.pages[id]} 页`],
      ['有 pc_start', B.start[id] ? '是' : '否（无起点批次）'],
    ];
    const ti = D.tidOf.get(B.utid[id]);
    rows.push(['线程', ti != null ?
      `${D.strs[D.threads.name[ti]]} (${D.threads.tid[ti]})` :
      `utid ${B.utid[id]}`]);
    table(host, rows);
  }

  function ctrDetail(host, sel) {
    const set = IOT.data.D.counters[IOT.data.D.inclLoop ? 'all' : 'disk'];
    const ctr = set[sel.metric];
    const isDepth = sel.metric === 'ind' || sel.metric === 'qdep';
    const bs = 1e6; // sample ±0.5ms window
    const v = IOT.data.agg(ctr, IOT.data.levelFor(ctr, bs),
                           sel.t - bs / 2, sel.t + bs / 2, isDepth);
    const name = { read: '读带宽', write: '写带宽', iops: 'IOPS',
                   ind: '在途深度', qdep: '排队深度' }[sel.metric];
    table(host, [
      ['计数器', name],
      ['时间', U.fmtNs(sel.t)],
      ['值', isDepth ? v.toFixed(0)
        : sel.metric === 'iops' ? U.fmtIops(v) : U.fmtRate(v)],
      ['口径', IOT.data.D.inclLoop ? '含 loop 设备' : '仅 disk 设备'],
    ]);
  }

  function areaDetail(host, area) {
    const D = IOT.data.D, R = D.req;
    let nReq = 0, bytes = 0;
    for (let i = 0; i < D.nReq; i++) {         // cheap count for now
      if (R.t_iss[i] < 0) continue;
      if (R.t_iss[i] < area.t1 && D.svcEnd[i] > area.t0) {
        nReq++; bytes += R.bytes[i];
      }
    }
    table(host, [
      ['选区范围', `${U.fmtNsPrec(area.t0)} ~ ${U.fmtNsPrec(area.t1)}`],
      ['时长', U.fmtNs(area.t1 - area.t0)],
      ['覆盖轨道', area.rows ? String(area.rows.size) : '全部'],
      ['覆盖请求', `${nReq}（共 ${U.fmtBytes(bytes)}）`],
    ]);
  }

  function procName(D, upid) {
    const pi = D.procOf.get(upid);
    return pi != null ? D.strs[D.procs.name[pi]] : 'upid:' + upid;
  }

  // ============ Stage-3 analysis tabs (design 5.5) ============

  // current stats window: area time range, else whole trace
  function statsWindow() {
    const D = IOT.data.D;
    if (IOT.state.area)
      return [IOT.state.area.t0, IOT.state.area.t1];
    return [0, D.dur];
  }

  function winNote(host) {
    const D = IOT.data.D;
    const note = U.el('div', 'winnote', host);
    if (IOT.state.area) {
      note.textContent = `窗口: ${U.fmtNsPrec(IOT.state.area.t0)} ~ ` +
        `${U.fmtNsPrec(IOT.state.area.t1)}` +
        (D.inclLoop ? ' · 含 loop 设备' : ' · 仅 disk 设备');
    } else {
      note.textContent = '未框选，统计全 trace' +
        (D.inclLoop ? ' · 含 loop 设备' : ' · 仅 disk 设备');
    }
  }

  // sortable table: cols [{k,label,num}], rows [{vals:{}, raw:{},
  //   onClick, guess}]; st = {key,dir}; st=null disables sorting
  function sTable(host, cols, rows, st) {
    const tb = U.el('table', 'stab', host);
    const tr = U.el('tr', '', tb);
    for (const c of cols) {
      const th = U.el('th', c.num ? 'num' : '', tr);
      th.textContent = c.label +
        (st && st.key === c.k ? (st.dir < 0 ? ' ▼' : ' ▲') : '');
      if (st) th.addEventListener('mousedown', () => {
        if (st.key === c.k) st.dir = -st.dir;
        else { st.key = c.k; st.dir = c.num ? -1 : 1; }
        refresh();
      });
    }
    for (const r of rows) {
      const tr2 = U.el('tr', r.head ? 'head' : '', tb);
      for (const c of cols) {
        const td = U.el('td', c.num ? 'num' : '', tr2);
        const v = r.vals[c.k];
        const vs = String(v);
        // cap long text (file/proc names) with ellipsis + full title
        const cap = vs.length > 40 ? U.el('span', 'cap', td) : null;
        if (cap) cap.title = vs;
        const tgt = cap || td;
        if (c.k === 'name' && r.guess) {
          tgt.textContent = v + ' ';
          const g = U.el('span', 'guess', tgt); g.textContent = '推测';
        } else tgt.textContent = v;
      }
      if (r.onClick) {
        tr2.classList.add('clk');
        tr2.addEventListener('mousedown', r.onClick);
      }
    }
    return tb;
  }

  const fmtB = b => U.fmtBytes(b);
  const fmtRateMBs = (b, span) =>
    ((b / span) * 1e9 / 1048576).toFixed(1) + ' MB/s';

  // scroll the canvas so a row is vertically centered
  function scrollToRow(r) {
    if (!r) return;
    const scroll = document.getElementById('scroll');
    scroll.scrollTop = Math.max(0, r.y0 - scroll.clientHeight / 3);
  }
  function expandProcAndScroll(pi, utid) {
    IOT.tracks.setExpanded('proc' + pi, true);
    IOT.requestRender();
    const T = IOT.tracks.T;
    let r = null;
    if (utid != null) {
      r = T.rows.find(x => x.utid === utid &&
        (x.type === 'thead' || x.type === 'files' || x.type === 'treq'));
    }
    if (!r) r = T.byId.get('proc' + pi);
    scrollToRow(r);
    IOT.render.renderAll();
  }
  function procListIdx(upid) {
    const L = IOT.data.D.procList;
    for (let i = 0; i < L.length; i++) if (L[i].upid === upid) return i;
    return -1;
  }

  // ---------------- Tab 2: 区域统计 ----------------
  let areaView = 'proc';
  const sortSt = {
    proc: { key: 'total', dir: -1 },
    thr: { key: 'total', dir: -1 },
    file: { key: 'read', dir: -1 },
    fn: { key: 'dur', dir: -1 },
    slow: { key: 'total', dir: -1 },
    key: { key: 'd', dir: -1 },
  };

  const PT_COLS = [
    { k: 'name', label: '名称' },
    { k: 'total', label: '总量', num: 1 },
    { k: 'read', label: '读', num: 1 },
    { k: 'write', label: '写', num: 1 },
    { k: 'other', label: '其他', num: 1 },
    { k: 'rate', label: '速度', num: 1 },
    { k: 'share', label: '占比', num: 1 },
    { k: 'n', label: '请求数', num: 1 },
    { k: 'qAvg', label: '平均排队', num: 1 },
    { k: 'qMax', label: '最大排队', num: 1 },
    { k: 'sAvg', label: '平均服务', num: 1 },
    { k: 'sMax', label: '最大服务', num: 1 },
    { k: 'd', label: 'D 状态时长', num: 1 },
  ];
  function ptVals(S, a, name, span) {
    return {
      name, total: fmtB(a.total), read: fmtB(a.read),
      write: fmtB(a.write), other: fmtB(a.other),
      rate: fmtRateMBs(a.total, span),
      share: (S.total ? a.total / S.total * 100 : 0).toFixed(1) + '%',
      n: a.n,
      qAvg: a.qN ? U.fmtNs(a.qSum / a.qN) : '-',
      qMax: a.qMax >= 0 ? U.fmtNs(a.qMax) : '-',
      sAvg: a.sN ? U.fmtNs(a.sSum / a.sN) : '-',
      sMax: a.sMax >= 0 ? U.fmtNs(a.sMax) : '-',
      d: a.d ? U.fmtNs(a.d) : '-',
    };
  }
  // numeric sort keys must use raw values — carry them on the row
  function ptRow(S, a, name, span, onClick) {
    return { vals: ptVals(S, a, name, span), onClick,
      raw: { total: a.total, read: a.read, write: a.write, other: a.other,
             rate: a.total / span, share: a.total, n: a.n,
             qAvg: a.qN ? a.qSum / a.qN : -1, qMax: a.qMax,
             sAvg: a.sN ? a.sSum / a.sN : -1, sMax: a.sMax, d: a.d } };
  }

  const FILE_COLS = [
    { k: 'name', label: '文件' },
    { k: 'read', label: '读量', num: 1 },
    { k: 'n', label: '请求数', num: 1 },
    { k: 'procs', label: '进程数', num: 1 },
    { k: 'sAvg', label: '平均服务', num: 1 },
  ];

  const FN_COLS = [
    { k: 'name', label: 'block function' },
    { k: 'segs', label: 'D 段数', num: 1 },
    { k: 'dur', label: 'D 总时长', num: 1 },
    { k: 'iow', label: 'io_wait 段数', num: 1 },
    { k: 'avg', label: '平均时长', num: 1 },
    { k: 'max', label: '最大时长', num: 1 },
    { k: 'nThr', label: '线程数', num: 1 },
  ];

  function renderArea(host) {
    const D = IOT.data.D;
    winNote(host);
    // sub-view selector
    const sel = U.el('div', 'subsel', host);
    for (const [id, label] of [['proc', '进程'], ['thr', '线程'],
                               ['file', '文件'], ['fn', '阻塞函数']]) {
      const b = U.el('div', 'subtab' + (areaView === id ? ' active' : ''),
                     sel);
      b.textContent = label;
      b.addEventListener('mousedown', () => { areaView = id; refresh(); });
    }
    const S = IOT.stats(statsWindow()[0], statsWindow()[1],
                        { inclLoop: D.inclLoop });
    const span = Math.max(1, S.w1 - S.w0);

    if (areaView === 'proc' || areaView === 'thr') {
      const st = sortSt[areaView];
      const src = areaView === 'proc' ? S.procs : S.threads;
      const rows = [ptRow(S, S, '全部', span, null)];
      rows[0].head = true;
      const list = Object.values(src);
      for (const a of list) {
        a.raw = { total: a.total, read: a.read, write: a.write,
                  other: a.other, rate: a.total / span, share: a.total,
                  n: a.n, qAvg: a.qN ? a.qSum / a.qN : -1, qMax: a.qMax,
                  sAvg: a.sN ? a.sSum / a.sN : -1, sMax: a.sMax, d: a.d };
      }
      list.sort((a, b) => {
        const x = a.raw[st.key], y = b.raw[st.key];
        const d = (typeof x === 'number' && typeof y === 'number')
          ? x - y : String(x).localeCompare(String(y));
        return d * st.dir;
      });
      for (const a of list) {
        const name = areaView === 'proc' ? a.name
          : `${a.name} (${a.tid}) · ${a.pname}`;
        const upid = a.upid != null ? a.upid
          : (D.tidOf.get(a.utid) != null
             ? D.threads.upid[D.tidOf.get(a.utid)] : -1);
        const pi = procListIdx(upid);
        rows.push(ptRow(S, a, name, span,
          pi >= 0 ? () => expandProcAndScroll(pi,
            areaView === 'thr' ? a.utid : null) : null));
      }
      sTable(host, PT_COLS, rows, st);
    } else if (areaView === 'file') {
      const st = sortSt.file;
      const rows = [];
      const list = Object.values(S.files);
      for (const f of list) {
        f.raw = { read: f.read, n: f.n, procs: Object.keys(f.procs).length,
                  sAvg: f.svcN ? f.svcSum / f.svcN : -1 };
      }
      const sorted = list.sort((a, b) => (a.raw[st.key] - b.raw[st.key]) *
        st.dir);
      for (const f of sorted) {
        // click: scroll to the thread that read this file the most
        let bestU = null, bestV = -1;
        for (const u in f.thrRead)
          if (f.thrRead[u] > bestV) { bestV = f.thrRead[u]; bestU = +u; }
        const ti = bestU != null ? D.tidOf.get(bestU) : null;
        const pi = ti != null ? procListIdx(D.threads.upid[ti]) : -1;
        rows.push({
          vals: {
            name: f.name + (f.hint ? ' · ' + f.hint : ''),
            read: fmtB(f.read), n: f.n,
            procs: Object.keys(f.procs).length,
            sAvg: f.svcN ? U.fmtNs(f.svcSum / f.svcN) : '-',
          },
          guess: true,
          onClick: pi >= 0 ? () => expandProcAndScroll(pi, bestU) : null,
        });
      }
      // aggregate rows: 未关联 / FS元数据
      rows.push({ vals: {
        name: '未关联', read: fmtB(S.unassoc.bytes), n: S.unassoc.n,
        procs: '-', sAvg: S.unassoc.svcN ?
          U.fmtNs(S.unassoc.svcSum / S.unassoc.svcN) : '-',
      } });
      rows.push({ vals: {
        name: 'FS元数据', read: fmtB(S.meta.bytes), n: S.meta.n,
        procs: '-', sAvg: S.meta.svcN ?
          U.fmtNs(S.meta.svcSum / S.meta.svcN) : '-',
      } });
      sTable(host, FILE_COLS, rows, st);
    } else {
      const st = sortSt.fn;
      const rows = [];
      const list = Object.values(S.fns);
      for (const f of list) {
        f.raw = { segs: f.segs, dur: f.dur, iow: f.iow,
                  avg: f.segs ? f.dur / f.segs : 0, max: f.max,
                  nThr: Object.keys(f.thr).length };
      }
      const sorted = list.sort((a, b) => (a.raw[st.key] - b.raw[st.key]) *
        st.dir);
      for (const f of sorted) {
        rows.push({ vals: {
          name: f.fn, segs: f.segs, dur: U.fmtNs(f.dur), iow: f.iow,
          avg: U.fmtNs(f.dur / Math.max(1, f.segs)),
          max: U.fmtNs(f.max), nThr: Object.keys(f.thr).length,
        } });
      }
      sTable(host, FN_COLS, rows, st);
    }
  }

  // ---------------- Tab 3: 延迟分布 ----------------
  const LAT_EDGES = [1e3, 1e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7,
                     2e7, 5e7, 1e8, Infinity];
  const LAT_LBL = ['≤1µs', '10µs', '50µs', '100µs', '200µs', '500µs',
                   '1ms', '2ms', '5ms', '10ms', '20ms', '50ms', '100ms',
                   '≥100ms'];
  const LAT_CATS = [['all', '全部'], ['sync_read', '同步读'],
                    ['readahead', '预读'], ['meta', '元数据'],
                    ['write', '写']];
  let latCat = 'all';
  const CAT_IDX = { sync_read: 0, readahead: 1, meta: 2, write: 3,
                    flush: 4, discard: 5, other: 6 };

  function pct(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1,
      Math.floor(p * sorted.length / 100))];
  }

  function renderLat(host) {
    const D = IOT.data.D;
    winNote(host);
    const sel = U.el('div', 'subsel', host);
    for (const [id, label] of LAT_CATS) {
      const b = U.el('div', 'subtab' + (latCat === id ? ' active' : ''),
                     sel);
      b.textContent = label;
      b.addEventListener('mousedown', () => { latCat = id; refresh(); });
    }
    const S = IOT.stats(statsWindow()[0], statsWindow()[1],
                        { inclLoop: D.inclLoop });
    const q = [], s = [], t = [];
    for (const e of S.latency) {
      if (latCat !== 'all' && e.cat !== CAT_IDX[latCat]) continue;
      if (e.q >= 0) q.push(e.q);
      s.push(e.s); t.push(e.t);
    }
    const metrics = [['排队', q, '#8ab4f8'], ['服务', s, '#59a5a8'],
                     ['总耗时', t, '#f28e2b']];
    const tip = document.getElementById('tooltip');
    for (const [name, vals, color] of metrics) {
      vals.sort((a, b) => a - b);
      const cnt = new Array(LAT_EDGES.length).fill(0);
      for (const v of vals) {
        let bi = LAT_EDGES.findIndex(e => v < e);
        if (bi < 0) bi = LAT_EDGES.length - 1;
        cnt[bi]++;
      }
      const mx = Math.max(1, ...cnt);
      const block = U.el('div', 'latblock', host);
      U.el('div', 'latname', block).textContent = name;
      const bars = U.el('div', 'latbars', block);
      for (let i = 0; i < LAT_EDGES.length; i++) {
        const col = U.el('div', 'latcol', bars);
        const num = U.el('div', 'latcnt', col);
        if (cnt[i]) num.textContent = String(cnt[i]);
        const bar = U.el('div', 'latbar', col);
        bar.style.height = Math.max(cnt[i] ? 2 : 0,
          Math.round(cnt[i] / mx * 70)) + 'px';
        bar.style.background = color;
        const lab = U.el('div', 'latlab', col);
        lab.textContent = LAT_LBL[i];
        const lo = i === 0 ? '0' : U.fmtNs(LAT_EDGES[i - 1]);
        const hi = i === LAT_EDGES.length - 1 ? '∞'
          : U.fmtNs(LAT_EDGES[i]);
        col.addEventListener('mouseenter', () => {
          tip.textContent = `${name} ${lo} ~ ${hi}: ${cnt[i]} 个请求 ` +
            `(${(cnt[i] / Math.max(1, vals.length) * 100).toFixed(1)}%)`;
          tip.style.display = 'block';
          const r = col.getBoundingClientRect();
          tip.style.left = Math.min(r.left, innerWidth - 320) + 'px';
          tip.style.top = (r.top - 34) + 'px';
        });
        col.addEventListener('mouseleave',
          () => { tip.style.display = 'none'; });
      }
      const st = U.el('div', 'latstats', block);
      st.textContent =
        `p50 ${U.fmtNs(pct(vals, 50))} / p90 ${U.fmtNs(pct(vals, 90))}` +
        ` / p99 ${U.fmtNs(pct(vals, 99))}` +
        ` / max ${U.fmtNs(vals.length ? vals[vals.length - 1] : 0)}` +
        `（${vals.length} 个请求）`;
    }
  }

  // ---------------- Tab 4: 慢 IO ----------------
  const SLOW_COLS = [
    { k: 'ts', label: '开始时间' },
    { k: 'total', label: '总耗时', num: 1 },
    { k: 'q', label: '排队', num: 1 },
    { k: 'svc', label: '服务', num: 1 },
    { k: 'bytes', label: '大小', num: 1 },
    { k: 'rwbs', label: 'rwbs' },
    { k: 'prio', label: '优先级' },
    { k: 'pt', label: '进程 · 线程' },
    { k: 'file', label: '文件' },
  ];

  function renderSlow(host) {
    const D = IOT.data.D, R = D.req;
    winNote(host);
    const S = IOT.stats(statsWindow()[0], statsWindow()[1],
                        { inclLoop: D.inclLoop });
    const rows = [];
    const sorted = S.slow.slice()
      .sort((a, b) => b.total - a.total).slice(0, 500);
    for (const e of sorted) {
      const i = e.id;
      const ti = D.tidOf.get(R.utid[i]);
      const pt = ti != null ?
        `${procName(D, D.threads.upid[ti])} · ` +
        `${D.strs[D.threads.name[ti]]}` : `utid ${R.utid[i]}`;
      const fi = R.file[i];
      const fname = fi >= 0 ?
        D.strs[D.files.name[fi]] +
          (D.strs[D.files.hint[fi]] ? ' · ' + D.strs[D.files.hint[fi]] : '')
        : (R.fsrc[i] === 0 ? '(未关联)' : '-');
      rows.push({
        vals: {
          ts: U.fmtNsPrec(D.tSub[i]), total: U.fmtNs(e.total),
          q: R.t_ins[i] >= 0 && R.t_iss0[i] >= 0 ?
            U.fmtNs(R.t_iss0[i] - R.t_ins[i]) : '-',
          svc: R.t_cmp[i] >= 0 ? U.fmtNs(R.t_cmp[i] - R.t_iss[i]) : '-',
          bytes: fmtB(R.bytes[i]), rwbs: D.strs[R.rwbs[i]] || '',
          prio: prFlags(R.prio[i]), pt, file: fname,
        },
        guess: fi >= 0,
        raw: { total: e.total },
        onClick: () => {
          IOT.state.sel = { type: 'req', id: i, row: null };
          IOT.state.area = null;
          IOT.debug.locateRequest(i);
          IOT.panels.showSelection();
        },
      });
    }
    sTable(host, SLOW_COLS, rows, null);
  }

  // ---------------- Tab 5: 关键线程阻塞 ----------------
  const KEY_COLS = [
    { k: 'proc', label: '进程' },
    { k: 'thr', label: '线程' },
    { k: 'd', label: 'D 时长', num: 1 },
    { k: 'iowD', label: 'io_wait 时长', num: 1 },
    { k: 'wSegs', label: '等待请求的段', num: 1 },
    { k: 'wTotal', label: '等待请求总耗时', num: 1 },
    { k: 'longest', label: '最长 D 段', num: 1 },
  ];

  function renderKey(host) {
    winNote(host);
    const S = IOT.stats(statsWindow()[0], statsWindow()[1],
                        { inclLoop: IOT.data.D.inclLoop });
    const st = sortSt.key;
    const list = S.keyThreads.slice();
    list.sort((a, b) => (a[st.key] - b[st.key]) * st.dir);
    const rows = list.map(k => ({
      vals: {
        proc: k.pname, thr: `${k.name} (${k.tid})`,
        d: U.fmtNs(k.d), iowD: U.fmtNs(k.iowD), wSegs: k.wSegs,
        wTotal: U.fmtNs(k.wTotal),
        longest: k.longestId >= 0 ? U.fmtNs(k.longest) : '-',
      },
      onClick: k.longestId >= 0 ? () => {
        IOT.state.sel = { type: 'd', id: k.longestId, row: null };
        IOT.state.area = null;
        IOT.debug.locateD(k.longestId);
        IOT.panels.showSelection();
      } : null,
    }));
    sTable(host, KEY_COLS, rows, null);
  }

  const CAT_NAME = ['sync_read', 'readahead', 'meta', 'write', 'flush',
                    'discard', 'other'];

  function renderSelection(host) {
    const s = IOT.state;
    if (s.area) { areaDetail(host, s.area); return; }
    if (!s.sel) {
      const d = U.el('div', '', host);
      d.style.color = '#777';
      d.textContent = '未选择条目。单击矩形选择，拖动框选时间范围。';
      return;
    }
    switch (s.sel.type) {
      case 'req': reqDetail(host, s.sel.id); break;
      case 'd': dDetail(host, s.sel.id); break;
      case 'batch': batchDetail(host, s.sel.id); break;
      case 'ctr': ctrDetail(host, s.sel); break;
      case 'devsum':
      case 'procsum':
      case 'group': {
        const g = s.sel.row && s.sel.row.g ? s.sel.row.g : null;
        table(host, [['分组', g ? g.label : s.sel.type]]);
        break;
      }
      default:
        table(host, [['类型', s.sel.type]]);
    }
  }

  // ---------------- help overlay ----------------
  const HELP_ROWS = [
    ['W / S', '以鼠标位置为中心放大 / 缩小（按住连续）'],
    ['A / D', '向左 / 右平移（按住连续）'],
    ['Ctrl + 滚轮', '以鼠标为中心缩放'],
    ['滚轮', '纵向滚动；Shift+滚轮 / 触控板横滑 = 横向平移'],
    ['单击', '选中条目（空白处清除）'],
    ['拖动', '区域选择（时间 × 轨道）；刻度尺上拖动 = 全部轨道'],
    ['Shift + 拖动', '平移'],
    ['F', '缩放到当前选中条目或区域'],
    ['Esc', '取消选择 / 关闭帮助'],
    ['Ctrl + A', '选中整个 trace'],
    ['R', '把选中条目转成区域选择'],
    ['M / Shift+M', '临时标记 / 持久标记当前时间范围'],
    ['[ / ]', '跳到同一行上一条 / 下一条目'],
    ['/', '聚焦搜索框'],
    ['C', '切换配色：类别 / 优先级 / 进程 / 延迟'],
    ['?', '显示 / 隐藏本帮助'],
    ['点击组标题', '展开 / 折叠轨道组'],
    ['慢 IO 输入框', '标题栏慢 IO 阈值（ms），影响红色描边和慢 IO Tab'],
  ];
  function toggleHelp(force) {
    const ov = document.getElementById('helpov');
    const open = force !== undefined ? force : !ov.classList.contains('open');
    if (open && !ov.childElementCount) {
      const card = U.el('div', 'card', ov);
      U.el('h3', '', card).textContent = '快捷键';
      const tb = U.el('table', '', card);
      for (const [k, d] of HELP_ROWS) {
        const tr = U.el('tr', '', tb);
        U.el('td', 'k', tr).textContent = k;
        U.el('td', '', tr).textContent = d;
      }
    }
    ov.classList.toggle('open', open);
  }

  function init() {
    registerTab('sel', '当前选择', renderSelection);
    registerTab('area', '区域统计', renderArea);
    registerTab('lat', '延迟分布', renderLat);
    registerTab('slow', '慢 IO', renderSlow);
    registerTab('key', '关键线程阻塞', renderKey);
    active = 'sel';
    rebuildTabs();
    refresh();
    document.getElementById('helpov').addEventListener('mousedown', e => {
      if (e.target.id === 'helpov') toggleHelp(false);
    });
  }

  return { init, registerTab, activate, showSelection, toggleHelp };
})();
