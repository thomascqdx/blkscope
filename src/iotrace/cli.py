"""iotrace CLI: parse input traces -> per-trace payload/HTML output.

Stage 1: `--json` writes <name>.payload.json. HTML generation lands in the
next stage via render_html() below.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time


def render_html(payload_b64: str, name: str) -> str:
    """Inline web/ assets + payload into a single HTML file (design 5.1)."""
    from .html import render_html as _render
    return _render(payload_b64, name)


def _process(name: str, path: str, outdir: str, write_json: bool) -> int:
    from .tp import open_trace
    from .extract import extract_all
    from .model import build_model
    from .payload import build_payload, encode_payload

    t0 = time.time()
    tp = open_trace(path)
    try:
        ex = extract_all(tp)
    finally:
        tp.close()
    model = build_model(ex)
    payload = build_payload(model, name=name, source=os.path.basename(path))
    elapsed = time.time() - t0
    nreq = len(model.req)
    print(f"[{name}] {nreq} requests, {len(model.files)} files, "
          f"{len(model.dst)} D-segments, {len(model.quality)} quality notes "
          f"({elapsed:.1f}s)")
    for q in model.quality:
        print(f"  [{q['level']}] {q['msg']}")

    os.makedirs(outdir, exist_ok=True)
    if write_json:
        out = os.path.join(outdir, f"{name}.payload.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        print(f"  wrote {out} ({os.path.getsize(out) / 1e6:.1f} MB)")
    else:
        try:
            html = render_html(encode_payload(payload), name)
        except NotImplementedError as e:
            print(f"  {e}；如需数据导出请加 --json")
            return 0
        out = os.path.join(outdir, f"{name}.html")
        with open(out, "w", encoding="utf-8") as f:
            f.write(html)
        print(f"  wrote {out}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="iotrace",
        description="Android/Perfetto 块设备 IO trace -> 单文件 HTML 分析页")
    ap.add_argument("inputs", nargs="+", help=".zip/.trace/.pftrace/systrace 等")
    ap.add_argument("-o", "--outdir", default="out", help="输出目录 (默认 out/)")
    ap.add_argument("--json", action="store_true",
                    help="输出 <name>.payload.json（HTML 在后续阶段实现）")
    args = ap.parse_args(argv)

    from .loader import resolve_inputs

    try:
        with resolve_inputs(args.inputs) as traces:
            if not traces:
                print("no trace inputs resolved", file=sys.stderr)
                return 1
            rc = 0
            for name, path in traces:
                try:
                    rc |= _process(name, path, args.outdir, args.json)
                except Exception as e:  # keep going on multi-input
                    print(f"[{name}] failed: {e}", file=sys.stderr)
                    rc = 1
            return rc
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
