#!/usr/bin/env python3
"""Build the deployable blkscope site directory (design 8, §部署).

`build(out_dir)` produces <out>/ (default dist/web/):
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

`build_offline(path)` produces the single-file offline build
(blkscope-offline-<ver>.html): the same index.html plus the worker
bundle, engine bundle, both wasm files and the (gzip+base64) report
template embedded as base64 inside non-executing
<script type="application/octet-stream" id="blk-*"> elements — double-
clickable from file:// with no server. site.js detects them by id.

CLI: `--out DIR` changes the dist/web output dir; `--offline` writes only
the offline file (default: both dist/web and dist/blkscope-offline-<ver>.html).
"""

import argparse
import base64
import gzip
import os
import shutil
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "src"))

from blkscope import __version__  # noqa: E402
from blkscope.html import (  # noqa: E402
    load_manifest, render_html, render_site, web_dir)

WASM_DIR = os.path.join(REPO, "tools", "wasm")
WASM_FILES = ["engine_bundle.js", "trace_processor.wasm",
              "trace_processor_memory64.wasm", "LICENSE"]
NAME_TOKEN = "BLKSCOPE_EXPORT_NAME_TOKEN"
PAYLOAD_TOKEN = "BLKSCOPE_EXPORT_PAYLOAD_TOKEN"

EMBED = [  # (element id, producer) for the offline single file
    "blk-worker", "blk-engine", "blk-wasm32", "blk-wasm64",
    "blk-report-template",
]


def _check_wasm():
    missing = [f for f in WASM_FILES
               if not os.path.exists(os.path.join(WASM_DIR, f))]
    if missing:
        raise FileNotFoundError(
            f"missing {missing} under tools/wasm — run "
            f"scripts/fetch_tp_wasm.py first")


def _read(wdir, rel):
    with open(os.path.join(wdir, rel), encoding="utf-8") as f:
        return f.read()


def _worker_bundle(wdir, manifest):
    return "\n".join(_read(wdir, rel) for rel in manifest["worker"]) \
        + "\n" + _read(wdir, os.path.join("site", "worker.js"))


def _report_template():
    tpl = render_html(PAYLOAD_TOKEN, NAME_TOKEN)
    assert tpl.count(NAME_TOKEN) == 1, \
        f"{NAME_TOKEN} occurs {tpl.count(NAME_TOKEN)}x in report template"
    assert tpl.count(PAYLOAD_TOKEN) == 1, \
        f"{PAYLOAD_TOKEN} occurs {tpl.count(PAYLOAD_TOKEN)}x in template"
    return tpl


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def build(out_dir: str, wdir: str = None) -> dict:
    wdir = wdir or web_dir()
    manifest = load_manifest(wdir)
    _check_wasm()
    os.makedirs(out_dir, exist_ok=True)

    made = {
        "index.html": render_site(wdir),
        "analysis_worker.js": _worker_bundle(wdir, manifest),
        "report_template.html": _report_template(),
    }
    for rel, text in made.items():
        with open(os.path.join(out_dir, rel), "w", encoding="utf-8") as f:
            f.write(text)
    for f in WASM_FILES:
        shutil.copyfile(os.path.join(WASM_DIR, f),
                        os.path.join(out_dir, f))
    return {"out": os.path.abspath(out_dir),
            "files": sorted(os.listdir(out_dir))}


def build_offline(out_path: str, wdir: str = None) -> dict:
    """Single-file offline site: index.html + blk-* embedded assets."""
    wdir = wdir or web_dir()
    manifest = load_manifest(wdir)
    _check_wasm()

    index = render_site(wdir)
    tpl = _report_template()

    def wb(name):
        with open(os.path.join(WASM_DIR, name), "rb") as f:
            return f.read()

    parts = [
        ("blk-worker",
         _b64(_worker_bundle(wdir, manifest).encode("utf-8"))),
        ("blk-engine",
         _b64(wb("engine_bundle.js"))),
        ("blk-wasm32", _b64(wb("trace_processor.wasm"))),
        ("blk-wasm64", _b64(wb("trace_processor_memory64.wasm"))),
        ("blk-report-template",
         _b64(gzip.compress(tpl.encode("utf-8"), compresslevel=6))),
    ]
    embed = []
    for eid, content in parts:
        # base64 alphabet contains no '<': embedded content can never
        # terminate its <script> element.
        assert "<" not in content, eid
        assert f'id="{eid}"' not in index, f"{eid} already in index.html"
        embed.append(f'<script type="application/octet-stream" id="{eid}">'
                     f"{content}</script>")
    idx = index.rfind("</body>")
    assert idx > 0, "index.html missing </body>"
    html = index[:idx] + "\n".join(embed) + "\n" + index[idx:]

    out_dir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    return {"out": os.path.abspath(out_path),
            "size": os.path.getsize(out_path)}


def default_offline_path():
    return os.path.join(REPO, "dist",
                        f"blkscope-offline-{__version__}.html")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default=os.path.join(REPO, "dist", "web"),
                    help="output directory (default: dist/web)")
    ap.add_argument("--offline", action="store_true",
                    help="build only the offline single-file html")
    args = ap.parse_args(argv)

    if not args.offline:
        info = build(args.out)
        print("built", info["out"])
        for f in info["files"]:
            p = os.path.join(info["out"], f)
            print(f"  {f:<34} {os.path.getsize(p):>12,} B")
    off = build_offline(default_offline_path())
    print(f"  {os.path.basename(off['out']):<34}"
          f" {off['size']:>12,} B  -> {off['out']}")


if __name__ == "__main__":
    main()
