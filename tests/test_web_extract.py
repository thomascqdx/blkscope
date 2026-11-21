"""Parity test: web/model/extract.js vs blkscope.extract.extract_all.

Runs extractAll in headless Edge on the sample trace (wasm engine) and
compares a digest of every extracted table against the same digest
computed in Python from dump_extracted.dump(extract_all(...)). Digest
spec lives in tests/_web_helpers.py and tests/web/extract_check.html.

Skipped when tools/wasm, tools/trace_processor_shell.exe, playwright or the
sample trace are missing.
"""

import json
import os
import sys
import time

import pytest

from _web_helpers import (ROOT, SAMPLE, WORK, extract_digest, missing_paths,
                          run_page, start_httpd)

sys.path.insert(0, os.path.join(ROOT, "scripts"))
import dump_extracted  # noqa: E402

playwright = pytest.importorskip("playwright.sync_api")

pytestmark = pytest.mark.skipif(
    bool(missing_paths()),
    reason="missing tools/wasm, trace_processor_shell or sample trace")


@pytest.fixture(scope="module")
def httpd():
    srv, t, base = start_httpd()
    try:
        yield base
    finally:
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


@pytest.fixture(scope="module")
def py_extract():
    """Python-side extract_all -> dumped shape + digest + duration."""
    from blkscope import tp as blktp
    from blkscope import extract
    proc = blktp.open_trace(SAMPLE)
    try:
        t0 = time.time()
        ex = extract.extract_all(proc)  # no path: textlog not ported (§8)
        py_ms = (time.time() - t0) * 1000
    finally:
        proc.close()
    dumped = dump_extracted.dump(ex)
    return {"digest": extract_digest(dumped), "ms": py_ms}


def test_extract_parity(py_extract, httpd, browser):
    page = browser.new_page()
    result = run_page(page, f"{httpd}/tests/web/extract_check.html",
                      queries=None)
    page.close()

    assert result["memory64"] is True, "memory64 wasm not used in Edge"

    js = result["digest"]
    py = py_extract["digest"]

    # JSON may round-trip an integral float sum as int; spec says float.
    for d in (js, py):
        for t in d["tables"].values():
            for cd in t["cols"].values():
                cd["sum"] = float(cd["sum"])

    # exact scalar fields
    for k in ("device", "stats", "t_min", "t_max", "trace_start"):
        assert js[k] == py[k], f"{k}: {js[k]!r} != {py[k]!r}"

    assert js["tables"].keys() == py["tables"].keys()
    for attr, jt in js["tables"].items():
        pt = py["tables"][attr]
        assert jt["rows"] == pt["rows"], f"{attr}: rows"
        assert jt["columns"] == pt["columns"], f"{attr}: columns"
        for c in pt["columns"]:
            assert jt["cols"][c] == pt["cols"][c], \
                f"{attr}.{c}: {jt['cols'][c]!r} != {pt['cols'][c]!r}"

    os.makedirs(WORK, exist_ok=True)
    report = {
        "memory64": result["memory64"],
        "traceLoadMs": result["traceLoadMs"],
        "jsExtractMs": result["extractMs"],
        "pyExtractMs": py_extract["ms"],
    }
    with open(os.path.join(WORK, "web_extract.json"), "w") as f:
        json.dump(report, f, indent=2)
    print("web extract:", report)
