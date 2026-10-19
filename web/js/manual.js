'use strict';
/* manual.js: embedded user-manual overlay (design 5.6).
   The body HTML is rendered at build time into #manualbody; the TOC is
   built lazily on first open from its h2/h3 headings (ids m-<n>). */
IOT.manual = (function () {
  const U = IOT.util;
  let tocBuilt = false;

  function buildToc() {
    const toc = document.getElementById('manualtoc');
    const body = document.getElementById('manualbody');
    if (!toc || !body) return;
    toc.innerHTML = '';
    const hs = body.querySelectorAll('h2, h3');
    if (!hs.length) {
      const d = U.el('div', 'mtoc-empty', toc);
      d.textContent = '（此文件未内嵌手册）';
    }
    for (const h of hs) {
      const a = U.el('div', 'mtoc-' + h.tagName.toLowerCase(), toc);
      a.textContent = h.textContent;
      a.addEventListener('click', () => {
        body.scrollTop = Math.max(0, h.offsetTop - 8);
      });
    }
    tocBuilt = true;
  }

  function toggle(force) {
    const ov = document.getElementById('manualov');
    if (!ov) return;
    const open = force !== undefined ? force
      : !ov.classList.contains('open');
    if (open) {
      // overlays are mutually exclusive (design 5.6)
      if (IOT.panels && IOT.panels.toggleHelp) IOT.panels.toggleHelp(false);
      if (IOT.legend && IOT.legend.toggle) IOT.legend.toggle(false);
      if (!tocBuilt) buildToc();
    }
    ov.classList.toggle('open', open);
  }

  return { toggle };
})();
