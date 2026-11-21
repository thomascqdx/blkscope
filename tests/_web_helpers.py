"""Shared helpers for the headless-Edge web tests (engine + extract parity).

Also defines the extraction DIGEST spec, computed identically in JS
(tests/web/extract_check.html) and here:

  serialize(v):  null -> "\\x00"; number -> integral ? str(int(v))
                 : 17-significant-digit repr (%.17g / toPrecision(17),
                 trailing mantissa zeros stripped, exponent un-padded);
                 string -> itself.
  per column:  {nulls, sum (float of numeric cells), first50, last50,
                fnv1a32 of serialize(v) + "\\x1f" per value}
  per table:   {rows, columns, cols: {name: col_digest}}
"""

import functools
import http.server
import os
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
WASM_DIR = os.path.join(TOOLS, "wasm")
WORK = os.path.join(ROOT, "work")
SAMPLE = os.path.join(
    ROOT, "samples",
    "StartUp_com.opera.mini.native_20261010011312_2477ms"
    "_sn1824615693000400_7.zip")
TP_EXE = os.path.join(TOOLS, "trace_processor_shell.exe")
WASM_FILES = ["engine_bundle.js", "trace_processor.wasm",
              "trace_processor_memory64.wasm"]


def missing_paths():
    need = [TP_EXE, SAMPLE] + [os.path.join(WASM_DIR, f) for f in WASM_FILES]
    return [p for p in need if not os.path.exists(p)]


def start_httpd(root=ROOT):
    """Serve `root` on an ephemeral localhost port. Returns
    (server, thread, base_url)."""
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=root)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, t, f"http://127.0.0.1:{srv.server_address[1]}"


def run_page(page, url, queries=None, sample=SAMPLE, timeout=600_000):
    """goto + set queries + upload sample -> window.__result (raises on
    window.__error)."""
    import json
    page.goto(url)
    if queries is not None:
        page.evaluate("window.__queries = " + json.dumps(queries))
    page.set_input_files("#file", sample)
    page.wait_for_function(
        "window.__result !== null || window.__error !== null",
        timeout=timeout)
    err = page.evaluate("window.__error")
    assert err is None, f"page error: {err}"
    return page.evaluate("window.__result")


# -------------------------- digest (parity spec) --------------------------

import re

_EXP_PAD = re.compile(r"e([+-])0+(\d+)$")


def _fmt17(v):
    s = format(v, ".17g")
    return _EXP_PAD.sub(r"e\1\2", s)


def ser(v):
    if v is None:
        return "\x00"
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else _fmt17(v)
    return v


def _fnv1a32_init():
    return 2166136261


def _fnv1a32_update(h, data):
    for b in data:
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def column_digest(values):
    nulls = 0
    total = 0.0
    h = _fnv1a32_init()
    parts = []
    for v in values:
        if v is None:
            nulls += 1
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            total += float(v)
        s = ser(v)
        parts.append(s)
        h = _fnv1a32_update(h, s.encode("utf-8") + b"\x1f")
    return {
        "nulls": nulls,
        "sum": total,
        "first50": parts[:50],
        "last50": parts[-50:],
        "fnv": format(h, "08x"),
    }


def table_digest(table):
    return {
        "rows": len(table["data"][table["columns"][0]])
        if table["columns"] else 0,
        "columns": table["columns"],
        "cols": {c: column_digest(table["data"][c])
                 for c in table["columns"]},
    }


def extract_digest(dumped):
    """digest of dump_extracted.dump(ex) / BLK.extract.extractAll output."""
    return {
        "tables": {a: table_digest(t)
                   for a, t in dumped["tables"].items()},
        "device": dumped["device"],
        "stats": dumped["stats"],
        "t_min": dumped["t_min"],
        "t_max": dumped["t_max"],
        "trace_start": dumped["trace_start"],
    }
