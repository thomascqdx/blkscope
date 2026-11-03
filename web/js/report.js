'use strict';
/* report.js: Block RQ 报告 Tab (design 5.7).
   Recomputes block_rq_pars_enhanced.py's metric set on the live tool model
   (FIFO paired requests) and, for text logs, shows the script's original
   numbers side by side so old reports can be compared. */
IOT.report = (function () {
  const U = IOT.util;
  let kind = 'thr';          // 'thr' | 'proc'  (script prints comm = thread)
  let topN = 5;
  let histMax = 40;          // 40 | 200 ms
  let scriptOpen = false;

  const PHASES = [
    ['insert→首次 issue（排队）', 'queue', false],
    ['首次→末次 issue（requeue）', 'requeue', false],
    ['末次 issue→完成（服务）', 'svc', false],
    ['参考：insert→末次 issue（脚本定义）', 'insLast', true],
  ];

  function init() {
    IOT.panels.registerTab('report', 'Block RQ 报告', render);
  }

  function win() { return IOT.panels.statsWindow(); }

  /* Same request mask as IOT.stats (design 5.5 / v0.4): lane/qlane/treq/
     files leaf keys mark requests; dstate and ctr keys do not. */
  function reqMask(tracks) {
    const D = IOT.data.D, R = D.req;
    if (!tracks) return null;
    const mask = new Uint8Array(D.nReq);
    for (const k of tracks) {
      const c = k.indexOf(':');
      if (c < 0) continue;
      const p = k.slice(0, c), rest = k.slice(c + 1);
      if (p === 'lane') {
        const [di, s] = rest.split(':').map(Number);
        const l = D.devLanes[di] && D.devLanes[di][s];
        if (l) for (const i of l) mask[i] = 1;
      } else if (p === 'qlane') {
        const [di, s] = rest.split(':').map(Number);
        const l = D.devQueue[di] && D.devQueue[di][s];
        if (l) for (const i of l) mask[i] = 1;
      } else if (p === 'treq') {
        const e = D.thrReqs.get(+rest);
        if (e) for (const i of e.ids) mask[i] = 1;
      } else if (p === 'files') {
        const e = D.thrReqs.get(+rest);
        if (e) for (const i of e.ids)
          if (R.fsrc[i] > 0 && R.file[i] >= 0) mask[i] = 1;
      }
    }
    return mask;
  }

  /* Collect completed disk reads whose completion is in the window.
     The script's phase stats are read-only; keep that scope. */
  function collect(w0, w1, inclLoop, tracks) {
    const D = IOT.data.D, R = D.req;
    const mask = reqMask(tracks);
    const out = { nRead: 0, nWrite: 0, readBytes: 0, writeBytes: 0,
                  queue: [], requeue: [], svc: [], insLast: [],
                  slow25: 0, noInsert: 0 };
    for (let i = 0; i < D.nReq; i++) {
      if (mask && !mask[i]) continue;
      const tc = R.t_cmp[i];
      // script's time filter keeps both endpoints; IOT.stats also counts
      // a request completing exactly at the window end (overlap > 0)
      if (tc < 0 || tc < w0 || tc > w1) continue;
      const di = D.devIdx.get(R.dev[i]);
      if (!inclLoop && (di == null || !D.diskDev[di])) continue;
      const op = D.rwbsOp[i];
      if (op === 2) {
        out.nWrite++;
        out.writeBytes += R.bytes[i];
        continue;
      }
      if (op !== 1) continue;
      out.nRead++;
      out.readBytes += R.bytes[i];
      const tins = R.t_ins[i], tiss0 = R.t_iss0[i], tiss = R.t_iss[i];
      if (tins >= 0 && tiss0 >= 0) out.queue.push(tiss0 - tins);
      else out.noInsert++;
      if (tiss0 >= 0 && tiss > tiss0) out.requeue.push(tiss - tiss0);
      if (tins >= 0 && tiss >= 0) out.insLast.push(tiss - tins);
      const sv = tc - tiss;
      out.svc.push(sv);
      if (sv >= 25e6) out.slow25++;
    }
    return out;
  }

  function summarize(a) {
    if (!a.length) return null;
    let sum = 0, mx = -1, mn = Infinity, l1 = 0, l3 = 0, l5 = 0;
    let g10 = 0, g25 = 0;
    for (const v of a) {
      sum += v;
      if (v > mx) mx = v;
      if (v < mn) mn = v;
      const ms = v / 1e6;
      if (ms < 1) l1++;
      if (ms < 3) l3++;
      if (ms < 5) l5++;
      if (ms >= 10) g10++;
      if (ms >= 25) g25++;
    }
    const n = a.length;
    return { n, avg: sum / n, min: mn, max: mx,
             lt1: 100 * l1 / n, lt3: 100 * l3 / n, lt5: 100 * l5 / n,
             ge10: 100 * g10 / n, ge25: g25 };
  }

  function fmtMs(ns) {
    const ms = ns / 1e6;
    if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s';
    if (ms >= 100) return ms.toFixed(1) + ' ms';
    if (ms >= 1) return ms.toFixed(2) + ' ms';
    if (ms >= 0.01) return ms.toFixed(3) + ' ms';
    return ms.toFixed(4) + ' ms';
  }
  const fmtScriptMs = ms => (ms == null ? '-' : ms.toFixed(2) + ' ms');
  const pct = v => v.toFixed(1) + '%';
  const rate = (b, span) => ((b / span) * 1e9 / 1048576).toFixed(1) + ' MB/s';

  function el(tag, cls, parent) { return U.el(tag, cls, parent); }

  function clickable(tr, fn) {
    if (!fn) return;
    tr.classList.add('clk');
    IOT.panels.onTextClick(tr, fn);
  }

  function table(host, cols, rows) {
    const tb = el('table', 'stab rq-table', host);
    const tr = el('tr', '', tb);
    for (const c of cols) {
      const th = el('th', c.num ? 'num' : '', tr);
      th.textContent = c.label;
    }
    for (const r of rows) {
      const tr2 = el('tr', r.cls || '', tb);
      if (r.title) tr2.title = r.title;
      for (const c of cols) {
        const td = el('td', c.num ? 'num' : '', tr2);
        const vs = String(r.vals[c.k]);
        if (vs.length > 38) {
          const sp = el('span', 'cap', td);
          sp.textContent = vs;
          sp.title = vs;
        } else td.textContent = vs;
      }
      if (r.onClick) clickable(tr2, r.onClick);
    }
    return tb;
  }

  function kv(host, rows) {
    const tb = el('table', 'rq-kv', host);
    for (const [k, v] of rows) {
      const tr = el('tr', '', tb);
      el('td', 'k', tr).textContent = k;
      el('td', '', tr).textContent = v;
    }
  }

  function subBtn(ctl, label, on, fn, tip) {
    const b = el('div', 'subtab' + (on ? ' active' : ''), ctl);
    b.textContent = label;
    if (tip) b.title = tip;
    b.addEventListener('mousedown', fn);
    return b;
  }

  function winNote(host, w0, w1) {
    const D = IOT.data.D;
    const n = el('div', 'winnote', host);
    if (IOT.state.area) {
      const A = IOT.state.area;
      n.textContent = `窗口: ${U.fmtT(w0)} ~ ${U.fmtT(w1)}` +
        (D.inclLoop ? ' · 含 loop 设备' : ' · 仅 disk 设备') +
        (A.tracks == null ? ' · 轨道: 全部'
                          : ` · 已选 ${A.tracks.size} 条轨道`);
    } else {
      n.textContent = '未框选，统计全 trace' +
        (D.inclLoop ? ' · 含 loop 设备' : ' · 仅 disk 设备');
    }
  }

  function controls(host) {
    const ctl = el('div', 'subsel rq-ctl', host);
    subBtn(ctl, '进程', kind === 'proc', () => {
      kind = 'proc'; IOT.panels.showSelection();
    });
    subBtn(ctl, '线程', kind === 'thr', () => {
      kind = 'thr'; IOT.panels.showSelection();
    });
    el('span', 'subgap', ctl);
    for (const n of [5, 10, 20]) {
      subBtn(ctl, 'Top ' + n, topN === n, () => {
        topN = n; IOT.panels.showSelection();
      });
    }
    el('span', 'subgap', ctl);
    subBtn(ctl, '0–40 ms', histMax === 40, () => {
      histMax = 40; IOT.panels.showSelection();
    });
    subBtn(ctl, '0–200 ms', histMax === 200, () => {
      histMax = 200; IOT.panels.showSelection();
    });
    el('span', 'subgap', ctl);
    const copy = el('div', 'subtab rq-copy', ctl);
    copy.textContent = '复制报告';
    copy.title = '复制脚本风格的纯文本报告';
    const stat = el('span', 'rq-copystat', ctl);
    copy.addEventListener('click', () => copyText(stat));
  }

  function histBlock(host, label, vals, color) {
    const block = el('div', 'rq-hist', host);
    el('div', 'rq-hlabel', block).textContent = label;
    if (!vals.length) {
      const d = el('div', 'rq-nodata', block);
      d.textContent = '无数据';
      return;
    }
    const nb = histMax + 1;
    const cnt = new Array(nb).fill(0);
    for (const v of vals) {
      let bi = Math.floor(v / 1e6);
      if (bi > histMax) bi = histMax;
      if (bi < 0) bi = 0;
      cnt[bi]++;
    }
    const mx = Math.max(1, ...cnt);
    const bars = el('div', 'rq-bars', block);
    const tip = document.getElementById('tooltip');
    for (let i = 0; i < nb; i++) {
      const col = el('div', 'rq-col', bars);
      const bar = el('div', 'rq-bar', col);
      bar.style.height = (cnt[i] ? Math.max(2, Math.round(cnt[i] / mx * 66))
                                 : 0) + 'px';
      bar.style.background = color;
      const lo = i === histMax ? `≥${histMax}` : `${i}–${i + 1}`;
      col.addEventListener('mouseenter', () => {
        tip.textContent = `${label} ${lo} ms：${cnt[i]} 个 ` +
          `(${(100 * cnt[i] / vals.length).toFixed(1)}%)`;
        tip.style.display = 'block';
        const r = col.getBoundingClientRect();
        tip.style.left = Math.min(r.left, innerWidth - 320) + 'px';
        tip.style.top = (r.top - 34) + 'px';
      });
      col.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    }
    const axis = el('div', 'rq-axis', block);
    const step = histMax <= 40 ? 5 : 20;
    for (let i = 0; i < nb; i++) {
      const s = el('span', '', axis);
      if (i === histMax) s.textContent = `≥${histMax}`;
      else if (i % step === 0) s.textContent = String(i);
    }
  }

  function phaseTable(host, c) {
    const cols = [
      { k: 'name', label: '阶段' },
      { k: 'n', label: '样本', num: 1 },
      { k: 'avg', label: '平均', num: 1 },
      { k: 'min', label: '最小', num: 1 },
      { k: 'max', label: '最大', num: 1 },
      { k: 'lt1', label: '<1ms', num: 1 },
      { k: 'lt3', label: '<3ms', num: 1 },
      { k: 'lt5', label: '<5ms', num: 1 },
      { k: 'ge10', label: '≥10ms', num: 1 },
      { k: 'ge25', label: '≥25ms', num: 1 },
    ];
    const rows = PHASES.map(([name, key, dim]) => {
      const s = summarize(c[key]);
      return {
        cls: dim ? 'rq-dim' : '',
        title: dim ? '脚本把 insert→issue 定义为 最后一次 issue − insert；' +
          '这里按工具模型（FIFO 配对）计算，和上面的排队+requeue 对应。' : '',
        vals: {
          name, n: s ? s.n : 0,
          avg: s ? fmtMs(s.avg) : '-',
          min: s ? fmtMs(s.min) : '-',
          max: s ? fmtMs(s.max) : '-',
          lt1: s ? pct(s.lt1) : '-',
          lt3: s ? pct(s.lt3) : '-',
          lt5: s ? pct(s.lt5) : '-',
          ge10: s ? pct(s.ge10) : '-',
          ge25: s ? s.ge25 : 0,
        },
      };
    });
    table(host, cols, rows);
    const note = el('div', 'rq-hint', host);
    note.textContent = '占比为累计：<1ms 的请求也计入 <3ms / <5ms。' +
      (c.noInsert ? `  ${c.noInsert} 个读请求没有 insert，排队两行不计入。` : '');
  }

  function histCard(host, c) {
    const card = el('div', 'rq-card', host);
    el('h4', '', card).textContent = `延迟分布（1 ms 分桶，0–${histMax} ms）`;
    histBlock(card, 'insert→首次 issue（排队）', c.queue, '#8ab4f8');
    histBlock(card, '末次 issue→完成（服务）', c.svc, '#f28e2b');
    el('div', 'rq-hint', card).textContent =
      '最后一根柱是 ≥' + histMax + ' ms 的溢出柱，不丢样本；悬停柱子看区间与占比。';
  }

  function topItems(S, k) {
    const src = (k || kind) === 'proc' ? S.procs : S.threads;
    const items = [];
    for (const key in src) {
      const a = src[key];
      if (a.n > 0 && a.total > 0) items.push(a);
    }
    items.sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1));
    return items;
  }

  function topCard(host, S) {
    const D = IOT.data.D;
    const card = el('div', 'rq-card', host);
    el('h4', '', card).textContent =
      `Top ${topN} ${kind === 'proc' ? '进程' : '线程'} IO`;
    const items = topItems(S).slice(0, topN);
    const cols = [
      { k: 'rank', label: '#', num: 1 },
      { k: 'name', label: '名称' },
      { k: 'proc', label: kind === 'proc' ? 'PID' : '进程' },
      { k: 'read', label: '读', num: 1 },
      { k: 'write', label: '写', num: 1 },
      { k: 'total', label: '合计', num: 1 },
      { k: 'share', label: '占比', num: 1 },
      { k: 'n', label: '请求数', num: 1 },
    ];
    const rows = items.map((a, i) => {
      let upid, pid = -1, name, proc;
      if (kind === 'proc') {
        upid = a.upid;
        name = a.name;
        const pi = D.procOf.get(upid);
        pid = pi != null ? D.procs.pid[pi] : -1;
        proc = String(pid);
      } else {
        const ti = D.tidOf.get(a.utid);
        upid = ti != null ? D.threads.upid[ti] : -1;
        name = `${a.name} (${a.tid})`;
        proc = a.pname || '-';
      }
      const pi = D.procOf.get(upid);
      if (pid < 0 && pi != null) pid = D.procs.pid[pi];
      return {
        vals: {
          rank: i + 1, name, proc,
          read: U.fmtBytes(a.read), write: U.fmtBytes(a.write),
          total: U.fmtBytes(a.total),
          share: S.total > 0 ? pct(a.total / S.total * 100) : '-',
          n: a.n,
        },
        onClick: () => IOT.panels.jumpTo(upid,
          kind === 'thr' ? a.utid : null),
      };
    });
    if (!rows.length) {
      const d = el('div', 'rq-nodata', card);
      d.textContent = '窗口内没有 IO（检查设备过滤或选区）';
    } else {
      table(card, cols, rows);
    }
    el('div', 'rq-hint', card).textContent =
      '字节/请求数按 issue→complete 与窗口重叠分摊（与区域统计同口径，' +
      '含轨道过滤）；点击行定位到对应轨道。' +
      (D.script ? ' 脚本 Top N 在 insert 与 issue 两处累加，约为实际值的 2 倍。'
                : '');
  }

  function scriptBlock(host, w0, w1) {
    const D = IOT.data.D;
    if (!D.script) return;
    const s = D.script;
    const cAll = collect(w0, w1, true, null);
    const SAll = IOT.stats(w0, w1, { inclLoop: true, tracks: null });
    const top = topItems(SAll, 'thr');   // script Top N is comm (thread)
    const wrap = el('div', 'rq-script', host);
    const head = el('div', 'rq-shead', wrap);
    const body = el('div', 'rq-sbody', wrap);
    function setOpen(v) {
      scriptOpen = v;
      head.textContent = (v ? '▾ ' : '▸ ') +
        '脚本原值（全 trace，含 loop；按 block_rq_pars_enhanced.py 复算）';
      body.style.display = v ? 'block' : 'none';
    }
    setOpen(scriptOpen);
    head.addEventListener('click', () => setOpen(!scriptOpen));

    const si = summarize(cAll.svc), il = summarize(cAll.insLast);
    const ins = s.ins_iss, isc = s.iss_cmp;
    const toolTop = top.length ? top[0] : null;
    const cmp = [
      ['读请求数', String(s.read_n), String(cAll.nRead)],
      ['读总量', U.fmtBytes((s.read_mb || 0) * 1048576),
       U.fmtBytes(SAll.read)],
      ['insert→issue 平均',
       fmtScriptMs(ins && ins.avg_ms),
       il ? fmtMs(il.avg) : '-'],
      ['issue→complete 平均',
       fmtScriptMs(isc && isc.avg_ms), si ? fmtMs(si.avg) : '-'],
      ['≥25ms 慢读',
       isc ? String(isc.ge25) : '-', String(cAll.slow25)],
      ['Top 1',
       s.top && s.top.length
         ? `${s.top[0].name.trim()} ${U.fmtBytes(s.top[0].total_kb * 1024)}`
         : '-',
       toolTop
         ? `${toolTop.name} ${U.fmtBytes(toolTop.total)}`
         : '-'],
    ];
    table(body, [{ k: 'k', label: '指标' },
                 { k: 's', label: '脚本原值' },
                 { k: 't', label: '工具（含 loop，当前窗口）' }],
      cmp.map(r => ({ vals: { k: r[0], s: r[1], t: r[2] } })));

    if (s.top && s.top.length) {
      el('div', 'rq-hlabel', body).textContent = '脚本 Top 5（原值）';
      table(body, [
        { k: 'rank', label: '#', num: 1 }, { k: 'name', label: '名称' },
        { k: 'read', label: '读', num: 1 }, { k: 'write', label: '写', num: 1 },
        { k: 'total', label: '合计', num: 1 },
      ], s.top.map((t, i) => ({
        vals: {
          rank: i + 1, name: t.name,
          read: U.fmtBytes(t.read_kb * 1024),
          write: U.fmtBytes(t.write_kb * 1024),
          total: U.fmtBytes(t.total_kb * 1024),
        },
      })));
    }
    const note = el('div', 'rq-hint', body);
    note.textContent = '脚本原值在构建时按原算法对文本日志复算：全 trace、' +
      '不做设备/轨道过滤、按 (dev,sector) 覆盖配对；工具列为了对齐改用' +
      '「含 loop + 全轨道」并跟随当前窗口，Top 1 用线程口径（脚本 comm）。' +
      '脚本 Top N 在 insert 与 issue 两处累加（约 2×），读总量只累加 issue；' +
      '同一扇区并发时 insert→issue 会被后一个请求的 issue 覆盖而偏大，' +
      '工具用 FIFO 配对（见上表）。';
  }

  function footer(host, c) {
    const note = el('div', 'rq-note', host);
    const A = IOT.state.area;
    note.textContent = '口径：完成时间落在窗口内的读请求；' +
      '字节/速度按 issue→complete 与窗口重叠分摊（与区域统计一致）；' +
      '占比为累计（<1ms 也计入 <3/<5）；' +
      (A && A.tracks != null
        ? `轨道过滤生效（已选 ${A.tracks.size} 条）。`
        : '轨道: 全部。') +
      (IOT.data.D.script ? '  「脚本原值」是旧脚本的全 trace 结果，不是工具口径。' : '');
  }

  function emptyHint(host) {
    const d = el('div', 'rq-empty', host);
    d.textContent = '该 trace 没有 block_rq_* 请求。若是 .atrace / systrace ' +
      '文本，请确认抓取配置包含 block:block_rq_insert/issue/complete；' +
      '文本日志会自动启用回退解析，二进制 trace 请确认抓包事件开启。';
  }

  function render(host) {
    const D = IOT.data.D;
    const [w0, w1] = win();
    const tracks = IOT.panels.areaTracks();
    const S = IOT.stats(w0, w1, { inclLoop: D.inclLoop, tracks });
    const c = collect(w0, w1, D.inclLoop, tracks);
    winNote(host, w0, w1);
    controls(host);
    if (!D.nReq) emptyHint(host);

    const top = el('div', 'rq-top', host);
    const ov = el('div', 'rq-card rq-ov', top);
    el('h4', '', ov).textContent = '概览';
    kv(ov, [
      ['读请求数（完成）', String(c.nRead) + (D.inclLoop ? '' : '（仅 disk）')],
      ['读总量', U.fmtBytes(S.read)],
      ['写总量', U.fmtBytes(S.write)],
      ['读速度', rate(S.read, Math.max(1, w1 - w0))],
      ['写速度', rate(S.write, Math.max(1, w1 - w0))],
      ['≥25ms 慢读', String(c.slow25)],
      ['请求数（全部）', String(S.n)],
    ]);
    const ph = el('div', 'rq-card rq-grow', top);
    el('h4', '', ph).textContent = '阶段耗时（读请求）';
    phaseTable(ph, c);
    histCard(host, c);
    topCard(host, S);
    scriptBlock(host, w0, w1);
    footer(host, c);
  }

  /* ---------------- copy as the script's text layout ---------------- */
  function reportText() {
    const D = IOT.data.D;
    const [w0, w1] = win();
    const span = Math.max(1, w1 - w0);
    const tracks = IOT.panels.areaTracks();
    const S = IOT.stats(w0, w1, { inclLoop: D.inclLoop, tracks });
    const c = collect(w0, w1, D.inclLoop, tracks);
    const L = [];
    L.push('===== Block RQ 报告 =====');
    L.push(`窗口: ${U.fmtT(w0)} ~ ${U.fmtT(w1)} (${U.fmtNs(w1 - w0)})`);
    L.push(`设备: ${D.inclLoop ? '含 loop' : '仅 disk'}`);
    L.push(`轨道: ${tracks == null ? '全部' : `已选 ${tracks.size} 条`}`);
    L.push(`读请求数: ${c.nRead}`);
    L.push(`读总量: ${U.fmtBytes(S.read)}`);
    L.push(`写总量: ${U.fmtBytes(S.write)}`);
    L.push(`读速度: ${rate(S.read, span)}  写速度: ${rate(S.write, span)}`);
    L.push('');
    L.push('[阶段耗时] 读请求；占比为累计');
    L.push(['阶段', '样本', '平均', '最小', '最大', '<1ms', '<3ms',
            '<5ms', '>=10ms', '>=25ms'].join('\t'));
    for (const [name, key] of PHASES) {
      const s = summarize(c[key]);
      L.push([name, s ? s.n : 0, s ? fmtMs(s.avg) : '-',
              s ? fmtMs(s.min) : '-', s ? fmtMs(s.max) : '-',
              s ? pct(s.lt1) : '-', s ? pct(s.lt3) : '-',
              s ? pct(s.lt5) : '-', s ? pct(s.ge10) : '-',
              s ? s.ge25 : 0].join('\t'));
    }
    L.push('');
    const items = topItems(S).slice(0, topN);
    L.push(`Top ${topN} ${kind === 'proc' ? '进程' : '线程'}`);
    L.push(['#', '名称', '读', '写', '合计', '占比', '请求数'].join('\t'));
    items.forEach((a, i) => {
      L.push([i + 1, kind === 'proc' ? a.name : `${a.name} (${a.tid})`,
              U.fmtBytes(a.read), U.fmtBytes(a.write), U.fmtBytes(a.total),
              S.total > 0 ? pct(a.total / S.total * 100) : '-', a.n]
        .join('\t'));
    });
    L.push('');
    L.push('口径: 完成时间在窗口内的读请求；字节/速度按 overlap 分摊；' +
           '占比为累计；脚本原值见 HTML 报告页。');
    if (D.script) {
      L.push(`脚本原值: 读 ${D.script.read_n} / ` +
             `${U.fmtBytes((D.script.read_mb || 0) * 1048576)}; ` +
             `insert→issue ${fmtScriptMs(D.script.ins_iss &&
               D.script.ins_iss.avg_ms)}; ` +
             `issue→complete ${fmtScriptMs(D.script.iss_cmp &&
               D.script.iss_cmp.avg_ms)}`);
    }
    return L.join('\n');
  }

  function copyText(stat) {
    const text = reportText();
    const ok = () => {
      stat.textContent = '已复制';
      setTimeout(() => { stat.textContent = ''; }, 1500);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        ok();
      } catch (e) {
        stat.textContent = '复制失败';
      }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok).catch(fallback);
    } else fallback();
  }

  return { init, render, collect, reportText, PHASES };
})();
