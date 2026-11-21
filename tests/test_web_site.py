"""End-to-end test of the drag-and-drop site (design 8).

Builds dist/web-style output into a tmp dir via scripts/build_web.py,
serves it, and drives headless Edge through the landing -> analysis ->
report flow, the export-report download, and the sniff/error paths.

Skipped when tools/wasm, trace_processor_shell, playwright or the sample
trace are missing.
"""

import base64
import gzip
import json
import os
import re
import sys

import pytest

from _web_helpers import (ROOT, SAMPLE, WORK, missing_paths, start_httpd)

sys.path.insert(0, os.path.join(ROOT, "scripts"))
import build_web  # noqa: E402

from test_model_parity import _sample_dumps  # noqa: E402

playwright = pytest.importorskip("playwright.sync_api")

pytestmark = pytest.mark.skipif(
    bool(missing_paths()),
    reason="missing tools/wasm, trace_processor_shell or sample trace")

FIXTURES = os.path.join(ROOT, "tests", "fixtures")
SYSTRACE = os.path.join(FIXTURES, "block_rq_systrace.atrace")
NOTRACE = os.path.join(FIXTURES, "not_a_trace.txt")
SHOTS = os.path.join(WORK, "site_shots")
IGNORE_META = ("name", "source", "generated")


@pytest.fixture(scope="module")
def site_dir(tmp_path_factory):
    out = tmp_path_factory.mktemp("site") / "dist"
    build_web.build(str(out))
    return str(out)


@pytest.fixture(scope="module")
def httpd(site_dir):
    srv, t, base = start_httpd(site_dir)
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
def report_page(browser, httpd):
    """The full landing -> sample analysis -> rendered report flow.
    Yields (page, payload, timings, console_errors, page_errors)."""
    os.makedirs(SHOTS, exist_ok=True)
    ctx = browser.new_context(accept_downloads=True)
    page = ctx.new_page()
    cerr, perr = [], []
    page.on("console",
            lambda m: cerr.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: perr.append(e))
    page.goto(f"{httpd}/index.html")
    page.screenshot(path=os.path.join(SHOTS, "landing.png"))
    page.set_input_files("#filepick", SAMPLE)
    page.wait_for_selector("#progress:not([hidden])", timeout=30_000)
    page.screenshot(path=os.path.join(SHOTS, "progress.png"))
    page.wait_for_function("window.IOT && window.IOT.ready === true",
                           timeout=600_000)
    page.screenshot(path=os.path.join(SHOTS, "report.png"))
    payload = page.evaluate("IOT.data.D.payload")
    timings = page.evaluate("IOT.site.timings")
    yield page, payload, timings, cerr, perr
    ctx.close()


def _expected_payload():
    _, _, pay_path, _ = _sample_dumps()
    with open(pay_path, encoding="utf-8") as f:
        return json.load(f)


def _strip_meta(p):
    p = dict(p)
    meta = dict(p["meta"])
    for k in IGNORE_META:
        meta.pop(k, None)
    p["meta"] = meta
    return p


def test_site_sample_payload(report_page):
    """(a) sample zip via the landing file input -> IOT.ready, payload
    deep-equals the cached Python payload, timings recorded."""
    _, payload, timings, cerr, perr = report_page
    assert perr == [], f"page errors: {perr}"
    assert cerr == [], f"console errors: {cerr}"
    exp = _strip_meta(_expected_payload())
    got = _strip_meta(payload)
    assert got == exp
    os.makedirs(WORK, exist_ok=True)
    with open(os.path.join(WORK, "web_site_timings.json"), "w") as f:
        json.dump({"timings_ms": timings}, f, indent=2)
    print("site timings:", timings)


def test_site_export_report(report_page, browser, tmp_path):
    """(b) the export button downloads exactly the CLI report format; the
    file contains one payload identical to the page's and renders via
    file://."""
    page, payload, _, _, _ = report_page
    with page.expect_download() as dl:
        page.click("#exportbtn")
    out = tmp_path / "export.html"
    dl.value.save_as(out)
    html = out.read_text(encoding="utf-8")

    payloads = re.findall(
        r'<script type="application/octet-stream" id="payload">(.*?)</script>',
        html, re.S)
    assert len(payloads) == 1, f"payload elements: {len(payloads)}"
    raw = gzip.decompress(base64.b64decode(payloads[0]))
    embedded = _strip_meta(json.loads(raw))
    assert embedded == _strip_meta(payload)

    page2 = browser.new_page()
    cerr2, perr2 = [], []
    page2.on("console",
             lambda m: cerr2.append(m.text) if m.type == "error" else None)
    page2.on("pageerror", lambda e: perr2.append(e))
    page2.goto("file:///" + str(out).replace("\\", "/"))
    page2.wait_for_function("window.IOT && window.IOT.ready === true",
                            timeout=120_000)
    page2.close()
    assert perr2 == [] and cerr2 == [], (perr2, cerr2)


def _fresh_page(browser, httpd):
    page = browser.new_page()
    perr = []
    page.on("pageerror", lambda e: perr.append(e))
    page.goto(f"{httpd}/index.html")
    return page, perr


def test_site_sniff_text_systrace(browser, httpd):
    """(c1) text systrace -> message shown, no worker started."""
    page, perr = _fresh_page(browser, httpd)
    page.set_input_files("#filepick", SYSTRACE)
    page.wait_for_selector("#siteerr:not([hidden])", timeout=30_000)
    msg = page.text_content("#errmsg")
    assert "文本格式" in msg and "CLI" in msg, msg
    assert page.evaluate("IOT.site.workerCount") == 0, \
        "worker must not start for text systrace"
    assert page.evaluate("document.getElementById('progress').hidden")
    os.makedirs(SHOTS, exist_ok=True)
    page.screenshot(path=os.path.join(SHOTS, "error_text.png"))
    page.close()
    assert perr == []


def test_site_sniff_not_a_trace(browser, httpd):
    """(c2) unparseable file -> engine error or empty report, no page
    errors."""
    page, perr = _fresh_page(browser, httpd)
    page.set_input_files("#filepick", NOTRACE)
    page.wait_for_function(
        "(window.IOT && window.IOT.ready === true) || "
        "!document.getElementById('siteerr').hidden",
        timeout=300_000)
    os.makedirs(SHOTS, exist_ok=True)
    page.screenshot(path=os.path.join(SHOTS, "error_engine.png"))
    err_shown = page.evaluate(
        "!document.getElementById('siteerr').hidden")
    ready = page.evaluate("window.IOT && window.IOT.ready === true")
    if err_shown:
        print("not_a_trace -> error UI:",
              page.text_content("#errmsg"))
    else:
        print("not_a_trace -> rendered (empty) report")
    assert err_shown or ready
    page.close()
    assert perr == [], f"page errors: {perr}"


def test_site_multi_file_chooser(browser, httpd):
    """(c3) two files -> chooser lists both."""
    page, perr = _fresh_page(browser, httpd)
    page.set_input_files("#filepick", [SAMPLE, NOTRACE])
    page.wait_for_selector("#chooser:not([hidden])", timeout=10_000)
    items = page.eval_on_selector_all(
        "#chlist .ch-item", "els => els.map(e => e.textContent)")
    assert len(items) == 2
    assert any(os.path.basename(SAMPLE) in t for t in items)
    assert any("not_a_trace.txt" in t for t in items)
    os.makedirs(SHOTS, exist_ok=True)
    page.screenshot(path=os.path.join(SHOTS, "chooser.png"))
    page.close()
    assert perr == []
