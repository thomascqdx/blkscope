#!/usr/bin/env python
"""UI smoke test for a generated blkscope HTML (design 5.x dev tool).

Usage: .venv\\Scripts\\python scripts\\ui_smoke.py <html> [--shots outdir]

Opens the file in Edge (channel=msedge, no browser download), waits for
window.IOT.ready, records load time + console/page errors, runs IOT.bench,
performs scripted interactions and screenshots each step into work/ui/.
Exits non-zero on any console error / page error.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import re
import sys
import time
from pathlib import Path


def load_payload(html_path: str) -> dict:
    """Extract the embedded payload: base64 -> gzip -> JSON."""
    text = Path(html_path).read_text(encoding="utf-8")
    m = re.search(r'id="payload">([^<]+)</script>', text)
    assert m, "payload element not found"
    return json.loads(gzip.decompress(base64.b64decode(m.group(1))))


def py_stats(P: dict, w0: float, w1: float) -> dict:
    """Independent re-implementation of the design-5.5 accounting rules
    (disk-only window stats) — for cross-checking IOT.stats."""
    strs = P["strs"]
    R = P["req"]
    kind = {d["dev"]: d["kind"] for d in P["devs"]}
    dur = P["meta"]["dur"]
    upid_of = {u: P["threads"]["upid"][i]
               for i, u in enumerate(P["threads"]["utid"])}
    pname = {P["procs"]["upid"][i]: strs[P["procs"]["name"][i]]
             for i in range(len(P["procs"]["upid"]))}
    lost = R.get("lost") or [0] * len(R["dev"])
    tot = rd = wr = ot = 0.0
    n = 0
    pb: dict[str, float] = {}
    fr: dict[str, float] = {}
    prw: dict[str, list] = {}   # upid -> [read, write] prorated bytes
    trw: dict[str, list] = {}   # utid -> [read, write] prorated bytes
    for i in range(len(R["dev"])):
        s = R["t_iss"][i]
        if s < 0:
            continue
        # cmp_lost requests are zero-length; +200ms only for real incompletes
        e = R["t_cmp"][i] if R["t_cmp"][i] >= 0 \
            else (s if lost[i] else min(dur, s + 200e6))
        if e > s:
            ov = min(e, w1) - max(s, w0)
            f = max(0.0, ov) / (e - s)
        else:
            f = 1.0 if w0 <= s <= w1 else 0.0
        if f <= 0:
            continue
        if kind.get(R["dev"][i]) != "disk":
            continue
        b = R["bytes"][i] * f
        n += 1
        tot += b
        op = 0
        for ch in strs[R["rwbs"][i]] or "":
            if ch == "R":
                op = 1
                break
            if ch == "W":
                op = 2
                break
            if ch in "DN":
                break
        if op == 1:
            rd += b
        elif op == 2:
            wr += b
        else:
            ot += b
        upid = upid_of.get(R["utid"][i], -1)
        pb[upid] = pb.get(upid, 0.0) + b
        pr = prw.setdefault(upid, [0.0, 0.0])
        tr = trw.setdefault(R["utid"][i], [0.0, 0.0])
        if op == 1:
            pr[0] += b
            tr[0] += b
        elif op == 2:
            pr[1] += b
            tr[1] += b
        fi = R["file"][i]
        if R["fsrc"][i] > 0 and fi >= 0:
            fr[fi] = fr.get(fi, 0.0) + b
    return {"n": n, "total": tot, "read": rd, "write": wr, "other": ot,
            "procs": pb, "files": fr, "pname": pname,
            "procs_rw": prw, "thrs_rw": trw}


def py_main_thread_dtime(P: dict, top_name: str, w0: float, w1: float):
    """D-state overlap of the top process's main thread (tid==pid)."""
    strs = P["strs"]
    upid = None
    for i, u in enumerate(P["procs"]["upid"]):
        if strs[P["procs"]["name"][i]] == top_name:
            pid = P["procs"]["pid"][i]
            upid = u
            break
    if upid is None:
        return None, 0.0
    utid = None
    for i, u in enumerate(P["threads"]["utid"]):
        if P["threads"]["upid"][i] == upid and P["threads"]["tid"][i] == pid:
            utid = u
            break
    if utid is None:
        return None, 0.0
    DS = P["dst"]
    d = 0.0
    for i, u in enumerate(DS["utid"]):
        if u != utid:
            continue
        d += max(0.0, min(DS["ts"][i] + DS["dur"][i], w1)
                 - max(DS["ts"][i], w0))
    return utid, d


def strs_file_name(P: dict, fi: int) -> str:
    strs = P["strs"]
    h = P["files"]["hint"][fi]
    hint = strs[h] if 0 <= h < len(strs) else ""
    return strs[P["files"]["name"][fi]] + " · " + hint


def close(a: float, b: float, rel: float = 1e-9) -> bool:
    return abs(a - b) <= rel * max(1.0, abs(a), abs(b))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("html")
    ap.add_argument("--shots", default="work/ui")
    ap.add_argument("--load-only", action="store_true",
                  help="only load + check console errors (for empty/degraded "
                       "payloads where interactions have no data)")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    shots = Path(args.shots)
    shots.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 950})
        page.on("console", lambda m: (
            errors.append(f"console.{m.type}: {m.text}")
            if m.type in ("error",) else None))
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        t0 = time.time()
        page.goto(Path(args.html).resolve().as_uri())
        page.wait_for_function("window.IOT && window.IOT.ready === true",
                               timeout=120_000)
        load_ms = (time.time() - t0) * 1000
        page.wait_for_timeout(300)

        def shot(name):
            p = shots / f"{name}.png"
            page.screenshot(path=str(p))
            print(f"  [shot] {p}")

        def log(*a):
            print(*a, flush=True)

        log(f"load->ready: {load_ms:.0f} ms")
        shot("01_initial")

        if args.load_only:
            # overlays must open/close without errors on an empty or
            # degraded payload too (design 5.6)
            for sel, ov in (("#legendbtn", "legendov"),
                            ("#manualbtn", "manualov")):
                page.locator(sel).click()
                page.wait_for_timeout(150)
                assert page.evaluate(
                    f"document.getElementById('{ov}')"
                    ".classList.contains('open')"), f"{ov} did not open"
                page.keyboard.press("Escape")
                page.wait_for_timeout(80)
                assert not page.evaluate(
                    f"document.getElementById('{ov}')"
                    ".classList.contains('open')"), f"{ov} did not close"
            log("legend/manual open-close on degraded payload: OK")
            log(f"errors: {len(errors)}")
            for e in errors:
                print("  ", e)
            print("OK" if not errors else "FAILED")
            browser.close()
            return 1 if errors else 0

        # assertion: first frame is complete — the 8:32 slot lanes must
        # have non-background pixels at ~90% of the canvas width
        nbg = page.evaluate("""(() => {
          const cv = document.getElementById('canvas');
          const c = cv.getContext('2d');
          const lanes = IOT.tracks.T.rows.filter(r => r.type === 'lane');
          if (!lanes.length) return -1;
          const y0 = Math.round(lanes[0].y0);
          const y1 = Math.round(lanes[lanes.length-1].y0 +
                                lanes[lanes.length-1].h);
          const x0 = Math.round(cv.width * .85);
          const img = c.getImageData(x0, y0, cv.width - x0, y1 - y0);
          let n = 0;
          for (let i = 0; i < img.data.length; i += 4)
            if (img.data[i] > 60 || img.data[i+1] > 60 || img.data[i+2] > 60)
              n++;
          return n; })()""")
        log(f"lane pixels @>85% width: {nbg}")
        assert nbg > 100, "first-frame lane band is empty at right side"

        # bench at full-trace view, dev 8:32 + top-3 proc groups expanded
        page.evaluate(
            "IOT.debug.expand('dev2080');"
            "for (const g of IOT.tracks.T.groups.filter(g=>g.kind==='proc')"
            "                 .slice(0,3)) IOT.tracks.setExpanded(g.id,true);")
        page.wait_for_timeout(200)
        shot("02_expanded")
        bench = page.evaluate("IOT.bench(60)")
        log(f"bench(60) avg: {bench:.2f} ms")

        rect = page.evaluate("IOT.debug.canvasRect()")

        # hold W ~600ms over canvas centre (continuous zoom)
        cx, cy = rect["x"] + rect["w"] * .6, rect["y"] + rect["h"] * .4
        page.mouse.move(cx, cy)
        page.keyboard.down("w")
        page.wait_for_timeout(600)
        page.keyboard.up("w")
        page.wait_for_timeout(100)
        shot("03_zoom_in_W")

        # A/D pans
        for k, name in (("a", "04_pan_A"), ("d", "05_pan_D")):
            page.keyboard.down(k)
            page.wait_for_timeout(300)
            page.keyboard.up(k)
            page.wait_for_timeout(80)
            shot(name)

        # Ctrl+wheel zoom
        page.mouse.move(cx, cy)
        page.keyboard.down("Control")
        page.mouse.wheel(0, -240)
        page.keyboard.up("Control")
        page.wait_for_timeout(120)
        shot("06_ctrl_wheel")

        # drag-select an area across the device lanes
        ax = rect["x"]
        ay0 = rect["y"] + 30          # inside the canvas (device lanes)
        ay1 = rect["y"] + rect["h"] * .35
        page.mouse.move(ax + rect["w"] * .3, ay0)
        page.mouse.down()
        page.mouse.move(ax + rect["w"] * .8, ay1, steps=12)
        page.mouse.up()
        page.wait_for_timeout(120)
        shot("07_area_select")
        sel = page.evaluate("IOT.state.area ? {t0:IOT.state.area.t0,"
                            "t1:IOT.state.area.t1} : null")
        log("area:", sel)

        # click a request in a slot lane -> details populated
        page.keyboard.press("Escape")
        pt = page.evaluate("""(() => {
            const D = IOT.data.D;
            for (let i = 0; i < D.nReq; i++)
              if (R_ok(i)) return IOT.debug.locateRequest(i);
            function R_ok(i){
              return D.req.dev[i] === 2080 && D.req.slot[i] >= 0 &&
                     D.req.t_iss[i] > IOT.ts.V.v0 + (IOT.ts.V.v1-IOT.ts.V.v0)*.2 &&
                     D.req.t_iss[i] < IOT.ts.V.v1 - (IOT.ts.V.v1-IOT.ts.V.v0)*.2;
            }
            return null; })()""")
        log("req locate:", pt)
        if pt:
            cv = page.evaluate(
                "document.getElementById('canvas')"
                ".getBoundingClientRect().toJSON()")
            hx, hy = pt["x"] - cv["x"], pt["y"] - cv["y"]
            log("hitAt:", page.evaluate(
                f"IOT.input.hitAt({hx}, {hy})"))
            page.mouse.click(pt["x"], pt["y"])
            page.wait_for_timeout(120)
            shot("08_req_selected")
            sel_info = page.evaluate("IOT.state.sel")
            log("sel:", sel_info)

        # click a D segment of top process's main thread
        page.keyboard.press("Escape")
        dpid = page.evaluate("IOT.debug.mainThreadD()")
        pt2 = page.evaluate(f"IOT.debug.locateD({dpid})") if dpid >= 0 else None
        log("D locate:", pt2)
        if pt2:
            page.mouse.click(pt2["x"], pt2["y"])
            page.wait_for_timeout(120)
            shot("09_dstate_selected")
            log("sel:", page.evaluate("IOT.state.sel"))

        # F zoom to selection
        page.keyboard.press("f")
        page.wait_for_timeout(120)
        shot("10_zoom_to_sel")

        # M mark
        page.keyboard.press("m")
        page.wait_for_timeout(80)
        shot("11_mark")

        # ? help -> overlay must be open
        page.keyboard.press("Shift+/")
        page.wait_for_timeout(120)
        help_open = page.evaluate(
            "document.getElementById('helpov').classList.contains('open')")
        log("help open after '?':", help_open)
        assert help_open, "help overlay did not open on '?'"
        shot("12_help")

        # Esc -> help closes; second Esc clears selection
        page.keyboard.press("Escape")
        page.wait_for_timeout(80)
        help_open = page.evaluate(
            "document.getElementById('helpov').classList.contains('open')")
        log("help open after Esc:", help_open)
        assert not help_open, "help overlay did not close on Esc"
        page.keyboard.press("Escape")
        page.wait_for_timeout(80)
        log("sel after 2nd Esc:", page.evaluate("IOT.state.sel"))
        assert page.evaluate("IOT.state.sel") is None
        shot("13_esc")

        # (a) target app (com.opera.mini.native else top proc): expand its
        # group, main thread tid==pid (instance with most D time), center a
        # ~20ms window on its longest D segment that has waited requests
        pick = page.evaluate("""(() => {
          const D = IOT.data.D;
          const named = D.procList.filter(
            p => p.name === 'com.opera.mini.native');
          const cands = named.length ? named : [D.procList[0]];
          let best = null;
          for (const p of cands) {
            const main = p.threads.find(t => t.tid === p.pid)
                      || p.threads[0];
            if (!main) continue;
            let dt = 0;
            for (const i of (D.thrD.get(main.utid) || []))
              dt += D.dst.dur[i];
            if (!best || dt > best.dt) best = { p, main, dt };
          }
          const ds = D.thrD.get(best.main.utid) || [];
          let pick = -1, pd = -1;
          for (const i of ds) {
            if (D.waitOff[i + 1] - D.waitOff[i] < 1) continue;
            if (D.dst.dur[i] > pd) { pd = D.dst.dur[i]; pick = i; }
          }
          if (pick < 0 && ds.length)
            pick = ds.reduce((a, b) => D.dst.dur[a] > D.dst.dur[b] ? a : b);
          const gi = D.procList.indexOf(best.p);
          IOT.tracks.setExpanded('proc' + gi, true);
          IOT.debug.locateD(pick);
          const t = D.dst.ts[pick] + D.dst.dur[pick] / 2;
          IOT.ts.setRange(t - 10e6, t + 10e6);
          IOT.requestRender();
          return { proc: best.p.name, tid: best.main.tid,
                   d: pick, dur: pd };
        })()""")
        log("main thread pick:", pick)
        page.wait_for_timeout(200)
        shot("14_mainthread_20ms")

        # (b) loop / 其他设备 group expanded
        page.evaluate("IOT.tracks.setExpanded('loopgrp', true)")
        page.evaluate("document.getElementById('scroll').scrollTop = 0")
        page.evaluate("IOT.render.renderAll()")
        page.wait_for_timeout(120)
        shot("15_loopgroup")

        # ---- Stage-3 tabs -------------------------------------------------
        def set_area(a, b):
            page.evaluate(f"""(() => {{
              IOT.state.area = {{t0: {a}, t1: {b}}};
              IOT.state.sel = null;
              IOT.render.renderAll();
              IOT.panels.showSelection();
            }})()""")

        def click_tab(label):
            page.locator("#tabs .tab", has_text=label).first.click()
            page.wait_for_timeout(150)

        def click_sub(label):
            page.locator(".subtab", has_text=label).first.click()
            page.wait_for_timeout(120)

        # reset to full view for stats screenshots
        page.evaluate("IOT.ts.init(IOT.data.D.dur); IOT.requestRender()")
        # area [5s, 8s] selected -> 区域统计 tabs
        set_area(5e9, 8e9)
        click_tab("区域统计")
        active = page.evaluate(
            "document.querySelector('#tabs .tab.active').textContent")
        log("active tab:", active)
        assert "区域统计" in active, f"tab highlight wrong: {active}"
        shot("16_stats_process")
        click_sub("文件")
        shot("17_stats_file")
        click_sub("阻塞函数")
        shot("18_stats_blockfn")
        click_tab("延迟分布")
        shot("19_latency")
        click_tab("慢 IO")
        shot("20_slowio")
        click_tab("关键线程阻塞")
        shot("21_keythreads")
        page.evaluate("""document.getElementById('panelbody').scrollTop = 0""")

        # ---- panel text selection + Top N + Q drawer + thead click --------
        # text selection: in 区域统计 thread view a horizontal drag across a
        # row selects text and must NOT navigate; a plain click does
        click_tab("区域统计")
        click_sub("线程")
        page.evaluate("""for (const g of IOT.tracks.T.groups)
          if (g.kind === 'proc') IOT.tracks.setExpanded(g.id, false);""")
        page.wait_for_timeout(100)

        def snap():
            return page.evaluate("""(() => ({
              top: document.getElementById('scroll').scrollTop,
              exp: IOT.tracks.T.groups.filter(g => g.expanded)
                     .map(g => g.id).sort() }))()""")

        us = page.evaluate(
            "getComputedStyle(document.querySelector("
            "'#panelbody table.stab td')).userSelect")
        log("panelbody td user-select:", us)
        assert us == "text", f"panel text not selectable: {us}"
        cell = page.evaluate("""(() => {
          const td = document.querySelector(
            '#panelbody table.stab tr.clk td');
          if (!td) return null;
          const r = td.getBoundingClientRect();
          return { x: r.left + 2, y: r.top + r.height / 2,
                   x2: r.right + 40 }; })()""")  # into the next cell
        assert cell, "no clickable row in 线程 view"
        s0 = snap()
        page.mouse.move(cell["x"], cell["y"])
        page.mouse.down()
        page.mouse.move(cell["x2"], cell["y"], steps=6)
        page.mouse.up()
        page.wait_for_timeout(120)
        stext = page.evaluate("window.getSelection().toString()")
        s1 = snap()
        log("panel text selection:", (stext or "").strip()[:60])
        assert stext and stext.strip(), "drag did not select panel text"
        assert s1 == s0, f"text drag navigated: {s0} -> {s1}"
        shot("21a_text_select")
        page.mouse.click(cell["x"], cell["y"])
        page.wait_for_timeout(150)
        s2 = snap()
        assert s2 != s1, "plain click on table row did not navigate"

        # 当前选择 area summary: stats key/value table + two Top N tables
        click_tab("当前选择")
        txt = page.evaluate("document.getElementById('panelbody').innerText")
        for kw in ("读速度", "写速度", "总速度", "读速度 Top", "写速度 Top"):
            assert kw in txt, f"area summary missing {kw!r}"
        nreq = page.evaluate("""(() => {
          for (const tr of document.querySelectorAll('#panelbody table tr')){
            const k = tr.querySelector('td.k');
            if (k && k.textContent.trim() === '请求数')
              return parseInt(tr.children[1].textContent, 10);
          }
          return -1; })()""")
        jsn = page.evaluate("IOT.stats(5e9, 8e9, {inclLoop:false}).n")
        log("area summary 请求数:", nreq, "| IOT.stats n:", jsn)
        assert nreq == jsn, "area summary 请求数 != IOT.stats().n"
        shot("21b_sel_area_topn")

        # Ctrl+A after a mousedown inside the panel selects the panel text
        # and must not touch the trace area selection
        page.locator("#panelbody .winnote").first.click()
        page.keyboard.down("Control")
        page.keyboard.press("a")
        page.keyboard.up("Control")
        page.wait_for_timeout(80)
        atxt = page.evaluate("window.getSelection().toString()")
        assert atxt and "请求数" in atxt, \
            f"Ctrl+A in panel selected: {str(atxt)[:80]!r}"
        assert page.evaluate("IOT.state.area.t0") == 5e9, \
            "Ctrl+A inside the panel changed the trace area"

        # Q collapses the panel to its tab bar; canvas grows; Q restores
        h0 = page.evaluate("document.getElementById('canvas').clientHeight")
        page.keyboard.press("q")
        page.wait_for_timeout(150)
        st = page.evaluate("""(() => ({
          col: document.getElementById('panel')
                 .classList.contains('collapsed'),
          pbH: document.getElementById('panelbody').offsetHeight,
          cvH: document.getElementById('canvas').clientHeight }))()""")
        log("after Q:", st, "| canvas was", h0)
        assert st["col"] and st["pbH"] == 0 and st["cvH"] > h0, st
        shot("21c_panel_collapsed")
        page.keyboard.press("q")
        page.wait_for_timeout(150)
        st = page.evaluate("""(() => ({
          col: document.getElementById('panel')
                 .classList.contains('collapsed'),
          cvH: document.getElementById('canvas').clientHeight }))()""")
        assert not st["col"] and abs(st["cvH"] - h0) < 2, st
        shot("21d_panel_expanded")

        # click a thread header row -> per-thread queue/service rollup
        th = page.evaluate("""(() => {
          const g = IOT.tracks.T.groups.find(g => g.kind === 'proc');
          IOT.tracks.setExpanded(g.id, true);
          const row = IOT.tracks.T.rows.find(r => r.type === 'thead');
          if (!row) return null;
          const scroll = document.getElementById('scroll');
          scroll.scrollTop = Math.max(0, row.y0 - 160);
          IOT.state.scrollTop = scroll.scrollTop;
          IOT.render.renderAll();
          const rc = document.getElementById('canvas')
                       .getBoundingClientRect();
          return { x: rc.left + rc.width * .5,
                   y: rc.top + row.y0 + row.h / 2 - scroll.scrollTop };
        })()""")
        assert th, "no thead row found"
        page.mouse.click(th["x"], th["y"])
        page.wait_for_timeout(150)
        st = page.evaluate("""(() => ({
          ty: IOT.state.sel && IOT.state.sel.type,
          rt: IOT.state.sel && IOT.state.sel.row &&
              IOT.state.sel.row.type,
          txt: document.getElementById('panelbody').innerText }))()""")
        assert st["ty"] == "row" and st["rt"] == "thead", st
        assert "排队（≈Runnable）" in st["txt"], "thread rollup missing"
        shot("21e_thread_head")

        # ---- flow arrows --------------------------------------------------
        # collapse 概览 + all proc groups; expand the target app's proc
        # group (com.opera.mini.native else top, instance with most D time)
        flow = page.evaluate("""(() => {
          const D = IOT.data.D;
          for (const g of IOT.tracks.T.groups)
            if (g.expanded && (g.kind === 'proc' || g.id === 'ov'))
              IOT.tracks.setExpanded(g.id, false);
          const named = D.procList.filter(
            p => p.name === 'com.opera.mini.native');
          const cands = named.length ? named : [D.procList[0]];
          let best = null;
          for (const p of cands) {
            const main = p.threads.find(t => t.tid === p.pid)
                      || p.threads[0];
            if (!main) continue;
            let dt = 0;
            for (const i of (D.thrD.get(main.utid) || []))
              dt += D.dst.dur[i];
            if (!best || dt > best.dt) best = { p, main, dt };
          }
          const ds = D.thrD.get(best.main.utid) || [];
          let pick = -1, pd = -1;
          for (const i of ds)
            if (D.waitOff[i + 1] - D.waitOff[i] >= 2 &&
                D.dst.dur[i] > pd) { pd = D.dst.dur[i]; pick = i; }
          if (pick < 0 && ds.length)
            pick = ds.reduce((a, b) =>
              (D.waitOff[b + 1] - D.waitOff[b]) >
              (D.waitOff[a + 1] - D.waitOff[a]) ? b : a);
          const gi = D.procList.indexOf(best.p);
          IOT.tracks.setExpanded('proc' + gi, true);
          IOT.debug.locateD(pick);
          IOT.state.area = null;             // a real sel clears the area
          IOT.state.sel = { type: 'd', id: pick, row:
            IOT.tracks.T.rows.find(r => r.type === 'dstate' &&
              r.utid === best.main.utid) };
          IOT.render.renderAll(); IOT.panels.showSelection();
          return { d: pick, dur: pd, proc: best.p.name };
        })()""")
        log("flow D seg:", flow)
        # F zoom to the segment, then zoom out to ~1/3 of the width
        page.keyboard.press("f")
        page.wait_for_timeout(120)
        page.evaluate(f"""(() => {{
          const D = IOT.data.D, i = {flow['d']};
          const mid = D.dst.ts[i] + D.dst.dur[i] / 2;
          const span = D.dst.dur[i] * 3.4;      // seg ~ 1/3 of view
          IOT.ts.setRange(mid - span / 2, mid + span / 2);
          IOT.requestRender();
        }})()""")
        page.wait_for_timeout(150)
        shot("22_flow_dstate")

        # 23: click a waited request on the thread IO row -> thread->lane
        pt = page.evaluate(f"""(() => {{
          const D = IOT.data.D, i = {flow['d']};
          const rid = D.waitReq[D.waitOff[i]];
          const row = IOT.tracks.T.rows.find(x => x.type === 'treq' &&
            x.utid === D.req.utid[rid] && x.ids.indexOf(rid) >= 0);
          if (!row) return null;
          const scroll = document.getElementById('scroll');
          scroll.scrollTop = Math.max(0, row.y0 - 180);
          IOT.state.scrollTop = scroll.scrollTop;
          IOT.render.renderAll();
          const cv = document.getElementById('canvas');
          const rc = cv.getBoundingClientRect();
          const x = (Math.floor(IOT.ts.tToPx(D.tSub[rid])) +
                     Math.ceil(IOT.ts.tToPx(D.svcEnd[rid]))) / 2;
          return {{ x: rc.left + x, y: rc.top + row.y0 + row.h / 2
                    - scroll.scrollTop }};
        }})()""")
        log("waited req pt:", pt)
        if pt:
            page.mouse.click(pt["x"], pt["y"])
            page.wait_for_timeout(150)
            shot("23_flow_request")
            log("sel:", page.evaluate(
                "IOT.state.sel ? IOT.state.sel.type + ' ' + IOT.state.sel.id"
                " : null"))
            active = page.evaluate(
                "document.querySelector('#tabs .tab.active').textContent")
            log("active tab after timeline click:", active)
            assert "当前选择" in active, \
                f"timeline click did not switch to 当前选择: {active}"

        # ---- color modes --------------------------------------------------
        page.keyboard.press("Escape")
        page.keyboard.press("c")
        page.wait_for_timeout(150)
        shot("24_color_priority")
        page.keyboard.press("c")   # -> 进程
        page.keyboard.press("c")   # -> 延迟
        page.wait_for_timeout(150)
        shot("25_color_latency")
        page.keyboard.press("c")   # -> back to 类别
        page.wait_for_timeout(80)

        # ---- lifecycle segments (design 5.3.1) ---------------------------
        seg = page.evaluate("""(() => {
          const D = IOT.data.D, R = D.req;
          let r1 = -1, r2 = -1;
          for (let i = 0; i < D.nReq && (r1 < 0 || r2 < 0); i++) {
            if (r1 < 0 && R.rq_n[i] > 0 && R.t_ins[i] >= 0 &&
                R.t_cmp[i] >= 0 &&
                R.t_iss[i] > R.t_iss0[i]) r1 = i;   // real requeue wait
            if (r2 < 0 && R.t_ins[i] < 0 && R.rq_n[i] === 0 &&
                R.t_iss[i] >= 0 && R.t_cmp[i] >= 0) r2 = i;
          }
          return { r1, r2, s1: r1 >= 0 ? IOT.debug.reqSegments(r1) : null,
                   s2: r2 >= 0 ? IOT.debug.reqSegments(r2) : null,
                   sub1: r1 >= 0 ? D.tSub[r1] : 0,
                   end1: r1 >= 0 ? D.svcEnd[r1] : 0 };
        })()""")
        log("segments r1:", seg["s1"])
        assert seg["r1"] >= 0, "no requeued+inserted request found"
        s1 = seg["s1"]
        # phases ordered + contiguous + spanning t_sub..svcEnd
        assert s1[0]["t0"] == seg["sub1"], "segments must start at t_sub"
        assert s1[-1]["t1"] == seg["end1"], "segments must end at svcEnd"
        for a, b in zip(s1, s1[1:]):
            assert a["t1"] == b["t0"], \
                f"phases not contiguous: {a} -> {b}"
        phases = [p["phase"] for p in s1]
        order = ["bio", "queue", "requeue", "service"]
        assert phases == sorted(phases, key=order.index), phases
        assert "queue" in phases and "requeue" in phases \
            and "service" in phases
        log("segments r2:", seg["s2"])
        if seg["r2"] >= 0:
            assert [p["phase"] for p in seg["s2"]] == ["service"], \
                "direct-issue request should have only the service segment"
        log("lifecycle segment assertions: OK")
        log("qPeak:", page.evaluate(
            "IOT.debug.qPeak().filter(q => q.kind === 'disk' "
            "&& q.lanes > 0)"))

        # 26_lifecycle: opera main thread, req with largest queue time and
        # rq_n>0, selected, spanning ~half the width, 调度队列 expanded
        pick = page.evaluate("""(() => {
          const D = IOT.data.D, R = D.req;
          for (const g of IOT.tracks.T.groups)
            if (g.expanded && (g.kind === 'proc' || g.id === 'ov'))
              IOT.tracks.setExpanded(g.id, false);
          const named = D.procList.filter(
            p => p.name === 'com.opera.mini.native');
          const cands = named.length ? named : [D.procList[0]];
          let best = null;
          for (const p of cands) {
            const main = p.threads.find(t => t.tid === p.pid)
                      || p.threads[0];
            if (!main) continue;
            let dt = 0;
            for (const i of (D.thrD.get(main.utid) || []))
              dt += D.dst.dur[i];
            if (!best || dt > best.dt) best = { p, main, dt };
          }
          const e = D.thrReqs.get(best.main.utid);
          let r = -1, q = -1;
          for (const i of e.ids) {          // prefer requeued reqs on 8:32
            if (R.dev[i] !== 2080 || R.t_ins[i] < 0 || R.t_iss[i] < 0)
              continue;
            const qq = R.t_iss[i] - R.t_ins[i];
            if (R.rq_n[i] > 0 && qq > q) { q = qq; r = i; }
          }
          if (r < 0)                        // else largest queue time
            for (const i of e.ids) {
              if (R.dev[i] !== 2080 || R.t_ins[i] < 0 || R.t_iss[i] < 0)
                continue;
              const qq = R.t_iss[i] - R.t_ins[i];
              if (qq > q) { q = qq; r = i; }
            }
          const gi = D.procList.indexOf(best.p);
          IOT.tracks.setExpanded('proc' + gi, true);
          IOT.tracks.setExpanded('dev2080', true);
          IOT.tracks.setExpanded('dev2080_qh', true);  // queue subgroup
          const mid = (D.tSub[r] + D.svcEnd[r]) / 2;
          const span = (D.svcEnd[r] - D.tSub[r]) * 2.1;
          IOT.ts.setRange(mid - span / 2, mid + span / 2);
          IOT.state.sel = { type: 'req', id: r, row: null };
          IOT.state.area = null;
          // with all other groups collapsed, queue lanes + slot lanes +
          // the thread row fit one screen when scrolled to top
          const scroll = document.getElementById('scroll');
          scroll.scrollTop = 0;
          IOT.state.scrollTop = 0;
          IOT.render.renderAll(); IOT.panels.showSelection();
          const qp = D.reqQLane.get(r);
          return { r, proc: best.p.name, q, rq_n: R.rq_n[r],
                   qlane: qp ? 'dev' + qp.dev + '_q' + qp.lane : null,
                   ins: R.t_ins[r], iss: R.t_iss[r] };
        })()""")
        log("lifecycle pick:", pick)
        assert pick["r"] >= 0 and pick["qlane"], \
            "no queue-interval request found on dev 2080"
        # 26a: top of the track list — queue lanes + slot lanes + the
        # queue->lane arrow of the selected request
        shot("26a_lifecycle_queue")

        # 26b: same viewport/selection scrolled down so the target thread's
        # D 状态 / IO 请求 / 文件读取 rows show; hover the queue phase
        page.evaluate(f"""(() => {{
          const D = IOT.data.D, r = {pick['r']};
          const e = D.thrReqs.get(D.req.utid[r]);
          const si = e.sub.findIndex(s => s.indexOf(r) >= 0);
          const pi = D.procList.findIndex(p =>
            p.threads.some(t => t.utid === D.req.utid[r]));
          const row = IOT.tracks.T.rows.find(x => x.id ===
            'proc' + pi + '_r' + D.req.utid[r] + '_' + si);
          const scroll = document.getElementById('scroll');
          scroll.scrollTop = Math.max(0, row.y0 - 150);
          IOT.state.scrollTop = scroll.scrollTop;
          IOT.render.renderAll();
        }})()""")
        hpt = page.evaluate(f"""(() => {{
          const D = IOT.data.D, r = {pick['r']};
          const e = D.thrReqs.get(D.req.utid[r]);
          const si = e.sub.findIndex(s => s.indexOf(r) >= 0);
          const pi = D.procList.findIndex(p =>
            p.threads.some(t => t.utid === D.req.utid[r]));
          const row = IOT.tracks.T.rows.find(x => x.id ===
            'proc' + pi + '_r' + D.req.utid[r] + '_' + si);
          const scroll = document.getElementById('scroll');
          const rc = document.getElementById('canvas')
            .getBoundingClientRect();
          const a = IOT.ts.tToPx(D.req.t_ins[r]);
          const b = IOT.ts.tToPx(D.req.t_iss[r]);
          return {{ x: rc.left + (a + b) / 2,
                    y: rc.top + row.y0 + row.h / 2 - scroll.scrollTop }};
        }})()""")
        page.mouse.move(hpt["x"], hpt["y"])
        page.wait_for_timeout(200)
        tip = page.evaluate(
            "document.getElementById('tooltip').textContent")
        log("tooltip:", (tip or "").splitlines()[:2])
        assert tip and ("排队" in tip or "requeue" in tip), \
            f"tooltip should show a queue/requeue phase: {tip!r}"
        shot("26b_lifecycle_thread")

        # 27_queue_collapsed: whole trace, 8:32 expanded, queue collapsed
        page.evaluate("""(() => {
          IOT.input.hideTip();
          IOT.state.sel = null;
          IOT.ts.init(IOT.data.D.dur);
          IOT.tracks.setExpanded('dev2080_qh', false);
          IOT.tracks.setExpanded('dev2080', true);
          document.getElementById('scroll').scrollTop = 0;
          IOT.state.scrollTop = 0;
          IOT.render.renderAll();
        })()""")
        page.wait_for_timeout(150)
        shot("27_queue_collapsed")

        # ---- legend & manual overlays (design 5.6) -------------------------
        page.locator("#legendbtn").click()
        page.wait_for_timeout(150)
        assert page.evaluate(
            "document.getElementById('legendov').classList.contains('open')"), \
            "legend overlay did not open"
        # swatches are styled straight from PAL (single colour source)
        sw_ok = page.evaluate("""(() => {
          const P = IOT.render.PAL;
          const rgb = h => {
            const n = parseInt(h.slice(1), 16);
            return 'rgb(' + (n >> 16) + ', ' + ((n >> 8) & 255) +
                   ', ' + (n & 255) + ')';
          };
          const bgs = [...document.querySelectorAll('#legendov .lg-sw')]
            .map(e => getComputedStyle(e).backgroundColor);
          return [P.ctr.read, P.ctr.write, P.cat[0], P.cat[3]]
            .every(h => bgs.includes(rgb(h)));
        })()""")
        log("legend swatches match PAL:", sw_ok)
        assert sw_ok, "legend swatches don't match PAL colours"
        shot("28_legend")
        # C while the legend is open: mode cycles and the 「当前」tag follows
        page.keyboard.press("c")
        page.wait_for_timeout(120)
        cur = page.evaluate("""(() => {
          const m = [...document.querySelectorAll('#legendov .lg-mode')]
            .filter(d => d.querySelector('.lg-cur'));
          return m.length ? m[0].textContent : ''; })()""")
        log("legend current mode after C:", cur)
        assert "优先级" in cur, f"「当前」did not move to 优先级: {cur}"
        page.keyboard.press("Escape")
        page.wait_for_timeout(80)
        assert not page.evaluate(
            "document.getElementById('legendov').classList.contains('open')"), \
            "legend did not close on Esc"
        # L toggles the legend
        page.keyboard.press("l")
        page.wait_for_timeout(80)
        assert page.evaluate(
            "document.getElementById('legendov').classList.contains('open')"), \
            "legend did not open on L"
        page.keyboard.press("l")
        page.wait_for_timeout(80)
        assert not page.evaluate(
            "document.getElementById('legendov').classList.contains('open')"), \
            "legend did not close on second L"

        # manual overlay: opens with TOC, clicking an entry scrolls the
        # article; single keys are inert while a modal overlay is open
        v_before = page.evaluate("[IOT.ts.V.v0, IOT.ts.V.v1]")
        page.locator("#manualbtn").click()
        page.wait_for_timeout(200)
        assert page.evaluate(
            "document.getElementById('manualov').classList.contains('open')"), \
            "manual overlay did not open"
        n_toc = page.evaluate(
            "document.querySelectorAll('#manualtoc div').length")
        log("manual TOC entries:", n_toc)
        assert n_toc >= 10, f"manual TOC too short: {n_toc}"
        sc0 = page.evaluate("document.getElementById('manualbody').scrollTop")
        page.locator("#manualtoc div").nth(5).click()
        page.wait_for_timeout(120)
        sc1 = page.evaluate("document.getElementById('manualbody').scrollTop")
        log("manual scrollTop:", sc0, "->", sc1)
        assert sc1 != sc0, "TOC click did not scroll the article"
        shot("29_manual")
        page.keyboard.down("w")
        page.wait_for_timeout(300)
        page.keyboard.up("w")
        page.wait_for_timeout(80)
        v_after = page.evaluate("[IOT.ts.V.v0, IOT.ts.V.v1]")
        assert v_after == v_before, \
            f"view changed while manual open: {v_before} -> {v_after}"
        page.keyboard.press("Escape")
        page.wait_for_timeout(80)
        assert not page.evaluate(
            "document.getElementById('manualov').classList.contains('open')"), \
            "manual did not close on Esc"

        # ---- stats timing -------------------------------------------------
        stats_ms = page.evaluate("""(() => {
          const t0 = performance.now();
          for (let i = 0; i < 5; i++) IOT.stats(0, IOT.data.D.dur, {});
          return (performance.now() - t0) / 5; })()""")
        log(f"IOT.stats whole-trace recompute: {stats_ms:.1f} ms")

        # ---- cross-check vs independent Python implementation -------------
        payload = load_payload(args.html)
        dur = payload["meta"]["dur"]
        mismatches = []
        for wname, w0, w1 in (("whole", 0.0, dur), ("[5s,8s]", 5e9, 8e9)):
            py = py_stats(payload, w0, w1)
            js = page.evaluate(
                f"IOT.statsMod.statsJson({w0}, {w1}, {{inclLoop:false}})")
            log(f"-- stats {wname}: py n={py['n']} total={py['total']:.0f} "
                f"read={py['read']:.0f} write={py['write']:.0f} "
                f"other={py['other']:.0f}")
            log(f"           js n={js['n']} total={js['total']:.0f} "
                f"read={js['read']:.0f} write={js['write']:.0f} "
                f"other={js['other']:.0f}")
            if js["n"] != py["n"]:
                mismatches.append(f"{wname} n: js={js['n']} py={py['n']}")
            for k in ("total", "read", "write", "other"):
                if not close(py[k], js[k]):
                    mismatches.append(
                        f"{wname} {k}: js={js[k]} py={py[k]}")
            # per-process top-5 (keyed by upid on both sides)
            pname = py["pname"]
            pt = sorted(py["procs"].items(), key=lambda x: -x[1])[:5]
            jt = sorted(js["procs"].items(), key=lambda x: -x[1]["total"])[:5]
            log("  procs top5 py:",
                [(pname.get(k, str(k)), round(v)) for k, v in pt])
            log("           js:",
                [(v["name"], round(v["total"])) for k, v in jt])
            for (uk, v), (jk, jv) in zip(pt, jt):
                if str(uk) != jk or not close(v, jv["total"]):
                    mismatches.append(
                        f"{wname} proc {uk}!={jk} {v:.0f}!={jv['total']:.0f}")
            # file top-5 (keyed by file id)
            pf = sorted(py["files"].items(), key=lambda x: -x[1])[:5]
            jf = sorted(js["files"].items(), key=lambda x: -x[1]["read"])[:5]
            log("  files top5 py:",
                [(strs_file_name(payload, k), round(v)) for k, v in pf])
            log("           js:",
                [(v["name"], round(v["read"])) for k, v in jf])
            for (fk, v), (jk, jv) in zip(pf, jf):
                if str(fk) != jk or not close(v, jv["read"]):
                    mismatches.append(
                        f"{wname} file {fk}!={jk} {v:.0f}!={jv['read']:.0f}")
            # D time of top proc's main thread
            top_py = max(py["procs"].items(), key=lambda x: x[1])[0] \
                if py["procs"] else None
            if top_py is not None:
                top_name = pname.get(top_py)
                utid, pd = py_main_thread_dtime(payload, top_name, w0, w1)
                jd = js["dTime"].get(str(utid), 0.0) if utid is not None else 0
                log(f"  D time main thread {top_py} utid={utid}: "
                    f"py={pd:.0f} js={jd}")
                if utid is not None and not close(pd, jd):
                    mismatches.append(
                        f"{wname} dtime {utid}: js={jd} py={pd}")
            # Top-N rankings (当前选择 area summary) vs Python
            if wname == "[5s,8s]":
                tn = page.evaluate(f"""(() => {{
                  const S = IOT.stats({w0}, {w1}, {{inclLoop:false}});
                  return {{ read: S.read, write: S.write,
                    pr: IOT.statsMod.topN(S, 'proc', 'read', 10),
                    pw: IOT.statsMod.topN(S, 'proc', 'write', 10),
                    tr: IOT.statsMod.topN(S, 'thr', 'read', 10) }}; }})()""")
                if not (close(tn["read"], py["read"])
                        and close(tn["write"], py["write"])):
                    mismatches.append(
                        f"{wname} S.read/write: js "
                        f"{tn['read']}/{tn['write']} vs py "
                        f"{py['read']}/{py['write']}")

                def py_top(d, i):
                    # same order as JS topN: bytes desc, key asc on ties
                    return [(k, v[i]) for k, v in sorted(
                            (kv for kv in d.items() if kv[1][i] > 0),
                            key=lambda x: (-x[1][i], x[0]))][:10]

                for label, plist, jlist in (
                    ("proc.read", py_top(py["procs_rw"], 0), tn["pr"]),
                    ("proc.write", py_top(py["procs_rw"], 1), tn["pw"]),
                    ("thr.read", py_top(py["thrs_rw"], 0), tn["tr"]),
                ):
                    log(f"  topN {label} py: "
                        f"{[(k, round(v)) for k, v in plist[:5]]}")
                    log(f"             js: "
                        f"{[(j['key'], round(j['bytes']))
                            for j in jlist[:5]]}")
                    if len(plist) != len(jlist):
                        mismatches.append(
                            f"{wname} topN {label} len: "
                            f"js={len(jlist)} py={len(plist)}")
                        continue
                    for (pk, pv), j in zip(plist, jlist):
                        if j["key"] != pk or not close(pv, j["bytes"]):
                            mismatches.append(
                                f"{wname} topN {label}: py {pk}/{pv:.0f}"
                                f" != js {j['key']}/{j['bytes']:.0f}")
        assert not mismatches, "stats cross-check failed: " + \
            "; ".join(mismatches)
        log("stats cross-check: OK")

        browser.close()

    print(f"errors: {len(errors)}")
    for e in errors:
        print("  ", e)
    print("OK" if not errors else "FAILED")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
