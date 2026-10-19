#!/usr/bin/env python
"""UI smoke test for a generated iotrace HTML (design 5.x dev tool).

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
    tot = rd = wr = ot = 0.0
    n = 0
    pb: dict[str, float] = {}
    fr: dict[str, float] = {}
    for i in range(len(R["dev"])):
        s = R["t_iss"][i]
        if s < 0:
            continue
        e = R["t_cmp"][i] if R["t_cmp"][i] >= 0 else min(dur, s + 200e6)
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
        fi = R["file"][i]
        if R["fsrc"][i] > 0 and fi >= 0:
            fr[fi] = fr.get(fi, 0.0) + b
    return {"n": n, "total": tot, "read": rd, "write": wr, "other": ot,
            "procs": pb, "files": fr, "pname": pname}


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
