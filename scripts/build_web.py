#!/usr/bin/env python3
"""Build the deployable blkscope site directory (design 8, §部署).

Output <out>/ (default dist/web/):
  index.html            site build of web/index.html: report assets +
                        manifest "site" section inlined, empty payload,
                        landing markup in place of <!--__SITE__-->
  analysis_worker.js    manifest "worker" list concatenated, site/worker.js
                        appended last
  engine_bundle.js      Perfetto engine worker (copied from tools/wasm)
  trace_processor.wasm          32-bit build
  trace_processor_memory64.wasm 64-bit build
  LICENSE               Perfetto Apache-2.0 licence
  report_template.html  CLI-format report rendered with unique
                        BLKSCOPE_EXPORT_NAME_TOKEN / _PAYLOAD_TOKEN for
                        the site's 「导出报告」 substitution

P6 will add the offline single-file build and release integration.
"""

import argparse
import os
import shutil
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "src"))

from blkscope.html import load_manifest, render_html, render_site  # noqa: E402

WASM_DIR = os.path.join(REPO, "tools", "wasm")
WASM_FILES = ["engine_bundle.js", "trace_processor.wasm",
              "trace_processor_memory64.wasm", "LICENSE"]
NAME_TOKEN = "BLKSCOPE_EXPORT_NAME_TOKEN"
PAYLOAD_TOKEN = "BLKSCOPE_EXPORT_PAYLOAD_TOKEN"


def build(out_dir: str, wdir: str = None) -> dict:
    from blkscope.html import web_dir
    wdir = wdir or web_dir()
    manifest = load_manifest(wdir)

    missing = [f for f in WASM_FILES
               if not os.path.exists(os.path.join(WASM_DIR, f))]
    if missing:
        raise FileNotFoundError(
            f"missing {missing} under tools/wasm — run "
            f"scripts/fetch_tp_wasm.py first")

    os.makedirs(out_dir, exist_ok=True)
    made = {}

    index = render_site(wdir)
    made["index.html"] = index

    worker = "\n".join(
        open(os.path.join(wdir, rel), encoding="utf-8").read()
        for rel in manifest["worker"])
    worker += "\n" + open(os.path.join(wdir, "site", "worker.js"),
                          encoding="utf-8").read()
    made["analysis_worker.js"] = worker

    tpl = render_html(PAYLOAD_TOKEN, NAME_TOKEN)
    assert tpl.count(NAME_TOKEN) == 1, \
        f"{NAME_TOKEN} occurs {tpl.count(NAME_TOKEN)}x in report template"
    assert tpl.count(PAYLOAD_TOKEN) == 1, \
        f"{PAYLOAD_TOKEN} occurs {tpl.count(PAYLOAD_TOKEN)}x in template"
    made["report_template.html"] = tpl

    for rel, text in made.items():
        with open(os.path.join(out_dir, rel), "w", encoding="utf-8") as f:
            f.write(text)
    for f in WASM_FILES:
        shutil.copyfile(os.path.join(WASM_DIR, f),
                        os.path.join(out_dir, f))
    return {"out": os.path.abspath(out_dir),
            "files": sorted(os.listdir(out_dir))}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=os.path.join(REPO, "dist", "web"),
                    help="output directory (default: dist/web)")
    args = ap.parse_args(argv)
    info = build(args.out)
    print("built", info["out"])
    for f in info["files"]:
        p = os.path.join(info["out"], f)
        print(f"  {f:<34} {os.path.getsize(p):>12,} B")


if __name__ == "__main__":
    main()
