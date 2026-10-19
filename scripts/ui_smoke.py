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
import sys
import time
from pathlib import Path


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

        # (a) top process expanded, main thread zoomed to ~20ms
        gid = page.evaluate("IOT.debug.topProcGroup()")
        log("top proc:", gid)
        page.evaluate(f"IOT.tracks.setExpanded('{gid}', true)")
        did = page.evaluate("IOT.debug.mainThreadD()")
        page.evaluate(f"IOT.debug.locateD({did})")
        page.evaluate(f"""(() => {{
          const t = IOT.data.D.dst.ts[{did}];
          IOT.ts.setRange(t - 8e6, t + 12e6);
          IOT.requestRender();
        }})()""")
        page.wait_for_timeout(200)
        shot("14_mainthread_20ms")

        # (b) loop / 其他设备 group expanded
        page.evaluate("IOT.tracks.setExpanded('loopgrp', true)")
        page.evaluate("document.getElementById('scroll').scrollTop = 0")
        page.evaluate("IOT.render.renderAll()")
        page.wait_for_timeout(120)
        shot("15_loopgroup")

        browser.close()

    print(f"errors: {len(errors)}")
    for e in errors:
        print("  ", e)
    print("OK" if not errors else "FAILED")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
