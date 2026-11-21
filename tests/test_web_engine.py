"""End-to-end check of the web trace_processor engine (web/engine/).

Loads the sample trace in headless Edge through the official Perfetto
engine_bundle.js + wasm (tools/wasm/, fetched by scripts/fetch_tp_wasm.py)
and asserts every query result is identical to the native
trace_processor_shell used via blkscope.tp.open_trace.

Second test repeats one query from a generated all-inlined file:// page
(engine source + wasm base64, blob-URL worker) to prove the offline
single-file build is feasible.

Skipped when tools/wasm, tools/trace_processor_shell.exe, playwright or the
sample trace are missing.
"""

import base64
import functools
import http.server
import json
import os
import threading

import pytest

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

QUERIES = [
    "select name, count(*) c from ftrace_event group by name order by name",
    "select min(ts) mn, max(ts) mx from ftrace_event",
    "select start_ts from trace_bounds",
    "select count(*) from thread_state where state in ('D','DK')",
]


def _bio_make_sql():
    """Mirror extract._events() for the bio_make event table."""
    from blkscope import extract
    event, arg_keys, base_cols = extract._EVENT_QUERIES["bio_make"]
    select = ", ".join(
        f"extract_arg(arg_set_id,'{k}') as \"{k}\"" for k in arg_keys)
    return (f"select {', '.join(base_cols)}, {select} "
            f"from ftrace_event where name='{event}' order by ts")


playwright = pytest.importorskip("playwright.sync_api")


def _missing(*paths):
    return [p for p in paths if not os.path.exists(p)]


pytestmark = pytest.mark.skipif(
    _missing(TP_EXE, SAMPLE, *[os.path.join(WASM_DIR, f) for f in WASM_FILES]),
    reason="missing tools/wasm, trace_processor_shell or sample trace")


def _rows(tp, sql):
    """Query via native trace_processor -> {col: [values]} preserving order."""
    it = tp.query(sql)
    cols = list(it.column_names)
    out = {c: [] for c in cols}
    for row in it:
        for c in cols:
            out[c].append(getattr(row, c))
    return {"columns": cols, "rows": len(out[cols[0]]) if cols else 0,
            "data": out}


def _norm(v):
    """Normalize a cell value for cross-engine comparison."""
    if isinstance(v, bytes):
        return list(v)
    return v


def _assert_same(native, js, sql):
    assert js["columns"] == native["columns"], sql
    assert js["rows"] == native["rows"], sql
    for c in native["columns"]:
        got = js["data"][c]
        exp = [_norm(v) for v in native["data"][c]]
        assert len(got) == len(exp), f"{sql} col {c}: len"
        assert got == exp, f"{sql} col {c}: values differ"


@pytest.fixture(scope="module")
def native_tp():
    from blkscope import tp as blktp
    proc = blktp.open_trace(SAMPLE)
    try:
        yield proc
    finally:
        proc.close()


@pytest.fixture(scope="module")
def httpd():
    """Serve the repo root over localhost so the page can fetch /tools/wasm."""
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    t.join()


@pytest.fixture(scope="module")
def browser():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="msedge", headless=True)
        try:
            yield b
        finally:
            b.close()


def _run_page(page, url, queries, timeout=600_000):
    page.goto(url)
    page.evaluate("window.__queries = " + json.dumps(queries))
    page.set_input_files("#file", SAMPLE)
    page.wait_for_function(
        "window.__result !== null || window.__error !== null",
        timeout=timeout)
    err = page.evaluate("window.__error")
    assert err is None, f"page error: {err}"
    return page.evaluate("window.__result")


def test_wasm_engine_matches_native(native_tp, httpd, browser):
    sql_e = _bio_make_sql()
    page = browser.new_page()
    result = _run_page(page, f"{httpd}/tests/web/engine_check.html",
                       QUERIES + [sql_e])
    page.close()

    assert result["memory64"] is True, "memory64 wasm not used in Edge"

    for sql in QUERIES:
        _assert_same(_rows(native_tp, sql), result["results"][sql], sql)

    js_e = result["results"][sql_e]
    native_e = _rows(native_tp, sql_e)
    assert js_e["rows"] == native_e["rows"]
    for c in native_e["columns"]:
        assert js_e["data"][c][:1000] == \
            [_norm(v) for v in native_e["data"][c][:1000]], \
            f"bio_make col {c}: first 1000 rows differ"
    assert sum(js_e["data"]["sector"]) == \
        sum(native_e["data"]["sector"]), "bio_make sum(sector) differs"

    os.makedirs(WORK, exist_ok=True)
    report = {
        "memory64": result["memory64"],
        "engineInitMs": result["engineInitMs"],
        "traceLoadMs": result["traceLoadMs"],
        "bytes": result["bytes"],
    }
    with open(os.path.join(WORK, "web_engine_wasm.json"), "w") as f:
        json.dump(report, f, indent=2)
    print("wasm engine:", report)


def _offline_html_path():
    """Generate work/web_engine_offline.html inlining engine + wasm."""
    def read(rel):
        with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
            return f.read()

    engine_src = read("tools/wasm/engine_bundle.js")
    with open(os.path.join(WASM_DIR, "trace_processor_memory64.wasm"),
              "rb") as f:
        wasm_b64 = base64.b64encode(f.read()).decode("ascii")
    proto_js = read("web/engine/proto.js")
    client_js = read("web/engine/tp_client.js")
    boot_js = read("web/engine/bootstrap.js")

    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>blkscope offline engine check</title>
</head><body>
<input type="file" id="file">
<script>{proto_js}</script>
<script>{client_js}</script>
<script>{boot_js}</script>
<script>
'use strict';
window.__result = null;
window.__error = null;
const ENGINE_SOURCE = {json.dumps(engine_src)};
const WASM_B64 = {json.dumps(wasm_b64)};
function b64ToU8(b64) {{
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}}
async function __run(file) {{
  const wasm = b64ToU8(WASM_B64);
  const eng = await BLK.engine.start({{
    engineSource: ENGINE_SOURCE, wasmBytes32: wasm, wasmBytes64: wasm,
  }});
  const cli = new BLK.TpClient(eng.port);
  await cli.loadFile(file);
  const results = {{}};
  for (const sql of (window.__queries || [])) {{
    results[sql] = await cli.query(sql);
  }}
  window.__result = {{ memory64: eng.memory64, results }};
  eng.terminate();
}}
document.getElementById('file').addEventListener('change', function (e) {{
  __run(e.target.files[0]).catch(function (err) {{
    window.__error = String((err && err.stack) || err);
  }});
}});
</script></body></html>"""
    os.makedirs(WORK, exist_ok=True)
    path = os.path.join(WORK, "web_engine_offline.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    return path


def test_wasm_engine_offline_file_url(native_tp, browser):
    """file:// page + inlined base64 assets + blob-URL worker."""
    path = _offline_html_path()
    sql = QUERIES[0]
    page = browser.new_page()
    result = _run_page(page, "file:///" + path.replace("\\", "/"), [sql])
    page.close()
    assert result["memory64"] is True
    _assert_same(_rows(native_tp, sql), result["results"][sql], sql)
