"""Run the Node unit tests for web/engine JS modules (tests/js/*.js).

Skipped when node is not on PATH. On Node 24, `node --test tests/js`
treats the bare directory as a module path and `tests/js/**` also matches
the directory itself, so we pass an explicit `*.js` glob.
"""

import os
import shutil
import subprocess

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

pytestmark = pytest.mark.skipif(shutil.which("node") is None,
                                reason="node not on PATH")


def test_node_js_unit():
    r = subprocess.run(
        ["node", "--test", "tests/js/test_*.js"],
        cwd=ROOT, capture_output=True, timeout=120)
    out = (r.stdout or b"").decode("utf-8", "replace") + \
        (r.stderr or b"").decode("utf-8", "replace")
    assert r.returncode == 0, out
    # Guard against the glob matching nothing and trivially passing.
    assert "pass 0" not in out, out
