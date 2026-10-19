"""End-to-end CLI tests using the real trace_processor binary in tools/.

Skipped automatically when the binary is absent (run scripts/fetch_tp.py).
"""

import base64
import gzip
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TP = ROOT / "tools" / ("trace_processor_shell.exe" if sys.platform == "win32"
                       else "trace_processor_shell")
FIX = Path(__file__).parent / "fixtures"

pytestmark = pytest.mark.skipif(not TP.is_file(),
                                reason="trace_processor binary missing")


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "iotrace", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=ROOT, timeout=600)


def payload_of(html_path: Path) -> dict:
    t = html_path.read_text(encoding="utf-8")
    m = re.search(r'id="payload">([^<]+)</script>', t)
    assert m, "payload element missing in generated HTML"
    return json.loads(gzip.decompress(base64.b64decode(m.group(1))))


def test_systrace_sched_only_degrades(tmp_path):
    """A trace with sched events but no block IO produces a valid HTML
    with 0 requests and the no_block_events quality warning."""
    r = run_cli(str(FIX / "systrace_sched.trace"), "-o", str(tmp_path))
    assert r.returncode == 0, f"stdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    html = tmp_path / "systrace_sched.html"
    assert html.is_file()
    p = payload_of(html)
    assert len(p["req"]["dev"]) == 0
    assert any(q["code"] == "no_block_events" for q in p["quality"])


def test_not_a_trace_fails_cleanly(tmp_path):
    r = run_cli(str(FIX / "not_a_trace.txt"), "-o", str(tmp_path))
    assert r.returncode == 1
    combined = r.stdout + r.stderr
    assert "FAIL" in combined
    assert "Traceback (most recent call last)" not in r.stderr
    assert not list(tmp_path.glob("*.html"))


def test_zip_skips_nontrace_members(tmp_path):
    zp = tmp_path / "mixed.zip"
    with zipfile.ZipFile(zp, "w") as z:
        z.write(FIX / "systrace_sched.trace", "sched.trace")
        z.writestr("README.txt", "not a trace, just a note\n")
    r = run_cli(str(zp), "-o", str(tmp_path))
    assert r.returncode == 0, f"stdout:\n{r.stdout}\nstderr:\n{r.stderr}"
    htmls = list(tmp_path.glob("*.html"))
    assert len(htmls) == 1


def test_multi_input_continues_and_reports(tmp_path):
    """A failing input does not stop later ones; summary + exit code."""
    r = run_cli(str(FIX / "not_a_trace.txt"), str(FIX / "systrace_sched.trace"),
                "-o", str(tmp_path))
    assert r.returncode == 1
    assert "1 succeeded, 1 failed" in r.stdout
    assert (tmp_path / "systrace_sched.html").is_file()
