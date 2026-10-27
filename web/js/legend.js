'use strict';
/* legend.js: colour legend overlay (design 5.6).
   Swatches are styled straight from IOT.render.PAL — no duplicated colour
   constants here. Content is rebuilt on every open so the slow-IO
   threshold and the current paint mode tag stay live. */
IOT.legend = (function () {
  const U = IOT.util;

  // ---------- swatch builders (each returns a .lg-sw span) ----------
  function sw() {
    const s = document.createElement('span');
    s.className = 'lg-sw';
    return s;
  }
  function solid(color) {
    const s = sw(); s.style.background = color; return s;
  }
  // partial-height / translucent phase bar (lifecycle segments)
  function phase(color, alpha, frac, hatch) {
    const s = sw();
    const b = document.createElement('span');
    b.style.cssText = `width:100%;height:${Math.round(frac * 100)}%;` +
      `background:${color};opacity:${alpha};` +
      (hatch ? 'background-image:repeating-linear-gradient(45deg,' +
        'rgba(255,255,255,.5) 0 1px,transparent 1px 5px);' : '');
    s.appendChild(b);
    return s;
  }
  // corner triangle via clip-path: 'tl' | 'tr'
  function tri(color, corner) {
    const s = sw();
    const t = document.createElement('span');
    t.style.cssText = `position:absolute;${corner === 'tl' ? 'left:0;top:0'
      : 'right:0;top:0'};width:0;height:0;` +
      `border-style:solid;border-width:8px 8px 0 0;border-color:` +
      (corner === 'tl'
        ? `${color} transparent transparent transparent`
        : `transparent ${color} transparent transparent`);
    // base bar so it reads as "on a request"
    const base = document.createElement('span');
    base.style.cssText = 'width:100%;height:100%;background:#3a3f4a;';
    s.appendChild(base);
    s.appendChild(t);
    return s;
  }
  // top stripe / bottom-right dot / outline boxes on a dim base bar
  function topBar(color) {
    const s = sw();
    s.style.background = '#3a3f4a';
    s.style.borderTop = `3px solid ${color}`;
    return s;
  }
  function dot(color) {
    const s = sw();
    s.style.background = '#3a3f4a';
    const d = document.createElement('span');
    d.style.cssText = `position:absolute;right:2px;bottom:2px;width:4px;` +
      `height:3px;background:${color};`;
    s.appendChild(d);
    return s;
  }
  function outline(color, fill) {
    const s = sw();
    s.style.border = `1.5px solid ${color}`;
    if (fill) s.style.background = fill;
    return s;
  }
  // straight / dashed horizontal line (flow arrows, limits, marks)
  function line(color, dashed, thick) {
    const s = sw();
    s.style.height = '0';
    s.style.borderTop = `${thick || 2}px ${dashed ? 'dashed' : 'solid'} ` +
      color;
    return s;
  }
  // small bottom tick (requeue marks on queue depth)
  function tick(color) {
    const s = sw();
    const t = document.createElement('span');
    t.style.cssText = `position:absolute;bottom:0;left:45%;width:2px;` +
      `height:4px;background:${color};`;
    s.appendChild(t);
    return s;
  }
  function gradient(css) {
    const s = sw(); s.style.background = css; return s;
  }
  // heat strip: rgba(base, .15 -> 1) left-to-right
  function heat(base) {
    return gradient(`linear-gradient(90deg,` +
      `rgba(${base},.15),rgba(${base},1))`);
  }
  // slot-limit row: dark bg + orange dashed separator
  function limitLane(base) {
    const s = sw();
    s.style.background = '#241d21';
    s.style.borderTop = `2px dashed rgba(${base},.8)`;
    s.style.height = '10px';
    return s;
  }
  function markBand(hex) {
    const s = sw();
    s.style.background = hxRgb(hex, .18);
    s.style.borderLeft = `1px solid ${hex}`;
    return s;
  }
  function hxRgb(hex, a) {        // '#rrggbb' + alpha -> rgba() string
    return `rgba(${parseInt(hex.slice(1, 3), 16)},` +
      `${parseInt(hex.slice(3, 5), 16)},` +
      `${parseInt(hex.slice(5, 7), 16)},${a})`;
  }

  // ---------- row / section helpers ----------
  function sec(card, title) {
    const s = U.el('div', 'lg-sec', card);
    U.el('h4', '', s).textContent = title;
    return s;
  }
  function row(parent, swEl, label) {
    const r = U.el('div', 'lg-row', parent);
    r.appendChild(swEl);
    const t = U.el('span', 'lg-txt', r);
    t.textContent = label;
    return r;
  }
  function note(parent, text) {
    const d = U.el('div', 'lg-note', parent);
    d.textContent = text;
    return d;
  }
  function modeHead(parent, label, current) {
    const d = U.el('div', 'lg-mode', parent);
    d.textContent = label;
    if (current) {
      const c = U.el('span', 'lg-cur', d);
      c.textContent = '当前';
    }
    return d;
  }
  function grp(parent, label) {
    const d = U.el('div', 'lg-grp', parent);
    d.textContent = label;
    return d;
  }

  // latency gradient: sample latColorNs on the 0.1ms -> 20ms log range
  function latGradient() {
    const stops = [];
    for (let k = 0; k <= 11; k++) {
      const ns = Math.pow(10, 5 + 2.3 * k / 11);
      stops.push(IOT.render.latColorNs(ns));
    }
    return `linear-gradient(90deg,${stops.join(',')})`;
  }

  function build() {
    const ov = document.getElementById('legendov');
    if (!ov) return;
    ov.innerHTML = '';
    const card = U.el('div', 'card', ov);
    const P = IOT.render.PAL;
    const D = IOT.data && IOT.data.D;
    const slowMs = D && D.slowMs != null ? D.slowMs : 10;
    const mode = (IOT.paint && IOT.paint.mode) || 'cat';
    const ML = IOT.render.MODE_LABEL ||
      { cat: '类别', prio: '优先级', proc: '进程', lat: '延迟' };

    U.el('h3', '', card).textContent = '图例';
    note(card, `当前配色：${ML[mode] || mode}　·　按 C 切换配色模式　` +
      '·　Esc / 点击空白处关闭');

    // ① 请求颜色 ---------------------------------------------------------
    const s1 = sec(card, '① 请求颜色（四种配色模式）');
    modeHead(s1, '类别（rwbs 操作 + 标志位）', mode === 'cat');
    grp(s1, '读');
    row(s1, solid(P.cat[0]), '同步读 sync_read — R，非预读非元数据');
    row(s1, solid(P.cat[1]), '预读 readahead — R + A 标志');
    row(s1, solid(P.cat[2]), '元数据 meta — 含 M，读写都算');
    grp(s1, '写');
    row(s1, solid(P.cat[3]), '写 write — W，含 FUA 写');
    grp(s1, '其他');
    row(s1, solid(P.cat[4]), 'flush — F 前缀 / N（无数据 flush）');
    row(s1, solid(P.cat[5]), 'discard · other — 同为灰色');
    modeHead(s1, '优先级', mode === 'prio');
    row(s1, solid(P.prio.rt), 'RT（ioprio class = RT）');
    row(s1, solid(P.prio.ux), 'UX（is_ux_task / is_ux_loop）');
    row(s1, solid(P.prio.fg), 'FG_META（前台元数据）');
    row(s1, solid(P.prio.sync), 'SYNC（rwbs 含 S）');
    row(s1, solid(P.prio.idle), 'IDLE（ioprio class = IDLE）');
    row(s1, solid(P.prio.async), '其余异步');
    note(s1, '按此顺序取第一个命中的标志。');
    modeHead(s1, '进程', mode === 'proc');
    row(s1, gradient('linear-gradient(90deg,hsl(0,45%,45%),' +
      'hsl(90,45%,45%),hsl(200,45%,45%),hsl(300,45%,45%))'),
      '按进程（提交者所属进程）哈希取色');
    modeHead(s1, '延迟', mode === 'lat');
    row(s1, gradient(latGradient()),
      '总耗时（提交→完成）：0.1ms 绿 → 20ms 红，对数刻度');

    // ② 计数器与顶部缩略图 -------------------------------------------------
    const s2 = sec(card, '② 计数器与顶部缩略图');
    row(s2, solid(P.ctr.read), '读 MB/s —— 顶部缩略图中：蓝 = 读');
    row(s2, solid(P.ctr.write), '写 MB/s —— 顶部缩略图中：橙 = 写');
    row(s2, solid(P.ctr.iops), 'IOPS');
    row(s2, solid(P.ctr.ind), '在途深度（issue→complete）');
    row(s2, line(P.limit, true), '设备槽位上限（在途深度上的红色虚线）');
    row(s2, solid(P.ctr.qdep), '排队深度（insert→issue）');
    row(s2, tick(P.ctr.qdep), 'requeue 时刻（排队深度底部品红刻度）');

    // ③ 生命周期分段 -------------------------------------------------------
    const s3 = sec(card, '③ 生命周期分段（线程「IO 请求」行）');
    row(s3, phase(P.cat[0], .3, .4, false), 'bio 提交 — t_make→insert，淡、细');
    row(s3, phase(P.cat[0], .55, .6, false),
      '调度排队 — insert→首次 issue，≈ Runnable');
    row(s3, phase(P.cat[0], .55, .6, true),
      'requeue 等待 — 首次 issue→最后 issue，斜线');
    row(s3, phase(P.cat[0], 1, 1, false),
      '设备服务 — issue→complete，实色满高，≈ Running');
    note(s3, '请求宽度 < 3px 时不分段，画成实色细条。');

    // ④ 角标与描边 ---------------------------------------------------------
    const s4 = sec(card, '④ 角标与描边');
    row(s4, topBar(P.prio.rt), 'RT：顶部红条');
    row(s4, tri(P.prio.ux, 'tl'), 'UX：左上角品红三角');
    row(s4, tri(P.prio.fg, 'tr'), 'FG_META：右上角黄三角');
    row(s4, dot(P.fua), 'FUA：右下角白点');
    row(s4, phase(P.cat[0], 1, 1, true),
      '斜线 = 未完成（槽位矩形 / 设备服务段）');
    row(s4, outline(P.slow),
      `慢 IO：红框（总耗时 ≥ 当前阈值 ${slowMs} ms，标题栏可改）`);
    row(s4, outline(P.sel), '选中：蓝框');

    // ⑤ 线程轨道 -----------------------------------------------------------
    const s5 = sec(card, '⑤ 线程轨道');
    row(s5, solid(P.d), 'D 状态（不可中断睡眠，多为 IO 等待）');
    row(s5, solid(P.dIow), 'D 状态 io_wait=1（内核确认在等 IO）');
    row(s5, gradient('linear-gradient(90deg,hsl(40,45%,42%),' +
      'hsl(150,45%,42%),hsl(260,45%,42%))'),
      '文件读取：按文件名取色，同名同色（文件关联为推测）');

    // ⑥ 热力条与设备上限 ---------------------------------------------------
    const s6 = sec(card, '⑥ 热力条与设备上限（折叠行的摘要）');
    row(s6, heat(P.heatDev), '设备组折叠 = 在途深度');
    row(s6, heat(P.heatQueue), '调度队列折叠 = 排队深度');
    row(s6, heat(P.heatProc), '进程组折叠 = 请求字节密度');
    row(s6, limitLane(P.heatDev),
      '槽位 ≥ 上限：底色加深 + 橙色虚线「设备上限 N」');

    // ⑦ 叠加标记 -----------------------------------------------------------
    const s7 = sec(card, '⑦ 叠加标记');
    row(s7, line(P.flow, false), 'flow 箭头 / 描边：实线 = 确定');
    row(s7, line(P.flow, true), '虚线 = 推测（wait_src=2，等待其他线程的请求）');
    row(s7, outline(P.sel, hxRgb(P.sel, .12)),
      '区域选择（拖动框选）');
    row(s7, markBand(P.markTemp), '临时标记 — M（只保留一个）');
    row(s7, markBand(P.markPersist), '持久标记 — Shift+M（可多个）');
  }

  function toggle(force) {
    const ov = document.getElementById('legendov');
    if (!ov) return;
    const open = force !== undefined ? force
      : !ov.classList.contains('open');
    if (open) {
      // overlays are mutually exclusive (design 5.6)
      if (IOT.panels && IOT.panels.toggleHelp) IOT.panels.toggleHelp(false);
      if (IOT.manual && IOT.manual.toggle) IOT.manual.toggle(false);
      if (IOT.input && IOT.input.toggleGoto) IOT.input.toggleGoto(false);
      build();
    }
    ov.classList.toggle('open', open);
  }
  // rebuild while open so the 「当前」mode tag follows C key presses
  function refresh() {
    const ov = document.getElementById('legendov');
    if (ov && ov.classList.contains('open')) build();
  }

  return { toggle, refresh };
})();
