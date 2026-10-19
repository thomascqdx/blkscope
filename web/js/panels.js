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
      d.addEventListener('mousedown', () => { active = t.id; refresh(); });
    }
  }
  function refresh() {
    const host = document.getElementById('panelbody');
    host.innerHTML = '';
    const t = tabs.find(x => x.id === active) || tabs[0];
    if (t) t.render(host);
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
    const w0 = D.waitOff[id], w1 = D.waitOff[id + 1];
    if (w1 > w0) {
      const parts = [];
      for (let k = w0; k < w1; k++) {
        parts.push(`#${D.waitReq[k]}（${D.waitSrc[k] === 1 ?
          '本线程' : '推测·跨线程'}）`);
      }
      rows.push(['等待的请求', parts.join('  '),
                 { guess: D.waitSrc[w0] === 2 }]);
    } else rows.push(['等待的请求', '无匹配']);
    table(host, rows);
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
    ['?', '显示 / 隐藏本帮助'],
    ['点击组标题', '展开 / 折叠轨道组'],
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
    active = 'sel';
    rebuildTabs();
    refresh();
    document.getElementById('helpov').addEventListener('mousedown', e => {
      if (e.target.id === 'helpov') toggleHelp(false);
    });
  }

  return { init, registerTab, showSelection, toggleHelp };
})();
