"""iotrace CLI: parse input traces -> per-trace single-file HTML.

Multiple inputs are processed independently: each resolved trace (incl. every
trace member inside a .zip) produces <outdir>/<name>.html.  Name collisions
get a numeric suffix; a failed trace does not stop the others; the process
exit code is 1 when any trace failed.
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


class TraceError(Exception):
    """User-facing failure: message is safe to print without a traceback."""


def _process(name: str, path: str, outdir: str, write_json: bool,
             used_names: set) -> dict:
    """One trace -> one output file.  Returns a summary row dict."""
    from .tp import open_trace
    from .extract import extract_all
    from .model import build_model
    from .payload import build_payload, encode_payload

    res = {"name": name, "ok": False, "nreq": 0, "out": "", "size": 0,
           "secs": 0.0, "err": ""}
    t0 = time.time()
    try:
        print(f"[{name}] loading trace ...", flush=True)
        tp = open_trace(path)
        try:
            print(f"[{name}] extracting events ...", flush=True)
            ex = extract_all(tp)
        finally:
            tp.close()
        if ex.t_max <= ex.t_min and not len(ex.threads):
            raise TraceError(
                "文件无法解析为 trace（没有任何事件数据）— "
                "请确认输入是 Perfetto .trace / systrace 文本或包含它们的 zip")

        print(f"[{name}] modelling ...", flush=True)
        model = build_model(ex)
        payload = build_payload(model, name=name,
                                source=os.path.basename(path))
        res["nreq"] = len(model.req)
        for q in model.quality:
            print(f"  [{q['level']}] {q['msg']}", flush=True)

        # unique output name
        base, suff = name, 1
        while base in used_names:
            suff += 1
            base = f"{name}_{suff}"
        used_names.add(base)
        res["name"] = base

        os.makedirs(outdir, exist_ok=True)
        print(f"[{name}] writing {base} ...", flush=True)
        if write_json:
            out = os.path.join(outdir, f"{base}.payload.json")
            with open(out, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False,
                          separators=(",", ":"))
        else:
            out = os.path.join(outdir, f"{base}.html")
            with open(out, "w", encoding="utf-8") as f:
                f.write(render_html(encode_payload(payload), base))
        res.update(ok=True, out=out, size=os.path.getsize(out),
                   secs=time.time() - t0)
        print(f"[{name}] wrote {out} ({res['size'] / 1e6:.1f} MB)",
              flush=True)
    except FileNotFoundError as e:
        res["err"] = str(e)
    except TraceError as e:
        res["err"] = str(e)
    except Exception as e:                       # TP parse failures etc.
        res["err"] = f"{type(e).__name__}: {e}"
    if not res["ok"]:
        res["secs"] = time.time() - t0
        print(f"[{name}] FAIL: {res['err']}", file=sys.stderr, flush=True)
    return res


def _open(path: str) -> None:
    if sys.platform == "win32":
        os.startfile(path)  # noqa: S606 - user requested --open
    else:
        import webbrowser
        webbrowser.open("file://" + os.path.abspath(path))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="iotrace",
        description="Android/Perfetto 块设备 IO trace -> 单文件 HTML 分析页")
    ap.add_argument("inputs", nargs="+",
                    help=".zip / .trace / .pftrace / systrace 文本等")
    ap.add_argument("-o", "--outdir", default="out",
                    help="输出目录 (默认 out/)")
    ap.add_argument("--json", action="store_true",
                    help="输出 <name>.payload.json 而非 HTML")
    ap.add_argument("--open", action="store_true",
                    help="生成后用默认浏览器打开每个 HTML")
    args = ap.parse_args(argv)

    from .loader import resolve_inputs

    try:
        with resolve_inputs(args.inputs) as traces:
            if not traces:
                print("no trace inputs resolved", file=sys.stderr)
                return 1
            results = []
            used = set()
            for name, path in traces:
                res = _process(name, path, args.outdir, args.json, used)
                results.append(res)
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        return 1

    # summary
    print("\n===== 汇总 =====")
    print(f"{'名称':<44} {'请求数':>8} {'大小':>9} {'耗时(s)':>8}  结果")
    nfail = 0
    for r in results:
        if not r["ok"]:
            nfail += 1
        size = f"{r['size'] / 1e6:.1f} MB" if r["ok"] else "-"
        tail = r["out"] if r["ok"] else (r["err"][:60])
        print(f"{r['name']:<44} {r['nreq']:>8} {size:>9} "
              f"{r['secs']:>8.1f}  {'OK ' + tail if r['ok'] else 'FAIL ' + tail}")
    print(f"{len(results) - nfail} succeeded, {nfail} failed")

    if args.open:
        for r in results:
            if r["ok"] and r["out"].endswith(".html"):
                try:
                    _open(r["out"])
                except Exception as e:
                    print(f"cannot open {r['out']}: {e}", file=sys.stderr)
    return 1 if nfail else 0


if __name__ == "__main__":
    sys.exit(main())
