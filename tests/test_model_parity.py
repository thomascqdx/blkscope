"""JS model parity (P4a): BLK.model.buildReqs vs Python build_model
intermediates (dump_extracted.dump_model -> m.req / m.requeues /
m.counters).

Synthetic cases reuse the event frames of tests/test_model.py scenarios
(pairing edge cases, same-thread make matching, requeue windows, slots
incl. cmp_lost + incomplete). The sample case runs the native shell on
the sample trace, caches dumps under work/, and compares every listed
req column row-for-row via tests/js/model_parity.js (Node).

Skipped when node is missing; the sample case additionally needs the
sample trace and tools/trace_processor_shell.exe.
"""

import json
import os
import shutil
import subprocess
import sys
import time

import numpy as np
import pandas as pd
import pytest

from _web_helpers import ROOT, SAMPLE, TP_EXE, WORK

sys.path.insert(0, os.path.join(ROOT, "scripts"))
import dump_extracted  # noqa: E402

NODE = shutil.which("node")
PARITY_JS = os.path.join(ROOT, "tests", "js", "model_parity.js")

pytestmark = pytest.mark.skipif(NODE is None, reason="node not on PATH")


# ------------------------------------------------------------- helpers

def rq_ins(rows):
    cols = ["ts", "utid", "dev", "sector", "nr_sector", "bytes", "rwbs"]
    return pd.DataFrame(rows, columns=cols)


rq_iss = rq_ins


def rq_cmp(rows):
    cols = ["ts", "dev", "sector", "nr_sector", "rwbs", "error"]
    return pd.DataFrame(rows, columns=cols)


def bio_make(rows):
    cols = ["ts", "utid", "pid", "sector", "rwbs", "class", "priority",
            "is_ux_task", "is_ux_loop", "FG_META", "bi_ioprio"]
    return pd.DataFrame(rows, columns=cols)


def threads(rows):
    cols = ["utid", "tid", "thread_name", "upid", "pid",
            "process_name", "parent_pid"]
    return pd.DataFrame(rows, columns=cols)


def run_parity(ex, name, tmp_path):
    """dump(ex) + dump_model(ex) -> JSON -> node model_parity.js."""
    ex_path = os.path.join(tmp_path, name + ".extracted.json")
    model_path = os.path.join(tmp_path, name + ".model_req.json")
    with open(ex_path, "w", encoding="utf-8") as f:
        json.dump(dump_extracted.dump(ex), f)
    t0 = time.time()
    with open(model_path, "w", encoding="utf-8") as f:
        json.dump(dump_extracted.dump_model(ex), f)
    py_ms = (time.time() - t0) * 1000
    r = subprocess.run(
        [NODE, PARITY_JS, ex_path, model_path],
        cwd=ROOT, capture_output=True, timeout=300)
    out = (r.stdout or b"").decode("utf-8", "replace") + \
        (r.stderr or b"").decode("utf-8", "replace")
    assert r.returncode == 0, f"{name} parity failed:\n{out}"
    return out, py_ms


# ------------------------------------------------- synthetic scenarios

def ex_pair_edges():
    """All pairing edge cases on several (dev, sector) keys."""
    ins = rq_ins([
        (100, 7, 2080, 8, 8, 4096, "R"),      # normal pair
        (100, 7, 2080, 16, 8, 4096, "R"),     # requeue
        (100, 7, 2080, 24, 8, 4096, "R"),     # dropped insert (1st)
        (120, 7, 2080, 24, 8, 4096, "R"),     #  ... replaces it
        (100, 7, 2080, 32, 8, 4096, "R"),     # pend superseded by insert
        (400, 7, 2080, 32, 8, 4096, "R"),     # pending insert at end
        (100, 7, 1976, 24, 8, 4096, "R"),     # incomplete (iss, no cmp)
    ])
    iss = rq_iss([
        (150, 7, 2080, 8, 8, 4096, "R"),
        (150, 7, 2080, 16, 8, 4096, "R"),
        (180, 7, 2080, 16, 16, 8192, "R"),    # re-issue -> issue_count 2
        (150, 7, 2080, 24, 8, 4096, "R"),
        (150, 7, 2080, 32, 8, 4096, "R"),
        (150, 7, 2080, 0, 0, 0, "FFS"),       # dataless: 3 new requests,
        (300, 7, 2080, 0, 0, 0, "FFS"),       #  first two cmp_lost
        (450, 7, 2080, 0, 0, 0, "FFS"),
        (150, 7, 1976, 8, 8, 4096, "W"),      # direct issue, no insert
        (150, 7, 1976, 24, 8, 4096, "R"),     # incomplete
        (500, 7, 2080, 0, 8, 4096, "R"),      # data issue after dataless
    ])
    cmp_ = rq_cmp([
        (200, 2080, 8, 8, "R", 0),
        (200, 2080, 16, 16, "R", 0),
        (200, 2080, 24, 8, "R", 0),
        (200, 1976, 8, 8, "W", 0),
        (250, 1976, 16, 8, "R", 0),           # orphan complete
        (600, 2080, 0, 8, "R", 0),
    ])
    from blkscope.extract import Extracted
    return Extracted(rq_insert=ins, rq_issue=iss, rq_complete=cmp_,
                     t_min=0, t_max=10_000)


def ex_make_match():
    """Same-thread make matching + tid->utid disambiguation."""
    ins = rq_ins([
        (1000, 5, 2080, 8, 8, 4096, "R"),     # mk on same thread 5
        (2000, 9, 2080, 16, 8, 4096, "R"),    # multi-cand, range hit
        (3000, 7, 2080, 24, 8, 4096, "R"),    # single tid -> utid
        (4000, 9, 2080, 32, 8, 4096, "R"),    # multi, no range hit -> max
        (5000, 5, 2080, 40, 8, 4096, "R"),    # op mismatch -> no match
    ])
    iss = rq_iss([
        (1100, 5, 2080, 8, 8, 4096, "R"),
        (2100, 9, 2080, 16, 8, 4096, "R"),
        (3100, 7, 2080, 24, 8, 4096, "R"),
        (4100, 9, 2080, 32, 8, 4096, "R"),
        (5100, 5, 2080, 40, 8, 4096, "R"),
        (900, 9, 2080, 48, 8, 4096, "W"),     # direct issue, iutid=iss
    ])
    cmp_ = rq_cmp([
        (1200, 2080, 8, 8, "R", 0),
        (2200, 2080, 16, 8, "R", 0),
        (3200, 2080, 24, 8, "R", 0),
        (4200, 2080, 32, 8, "R", 0),
        (5200, 2080, 40, 8, "R", 0),
        (1000, 2080, 48, 8, "W", 0),
    ])
    mk = bio_make([
        (900, 5, 55, 8, "R", 2, 110, 1, 0, 0, 100),
        (1900, 9, 55, 16, "R", 1, 111, 0, 0, 1, 200),
        (2900, 7, 77, 24, "R", 2, 105, 0, 1, 0, 300),
        (3900, 9, 55, 32, "R", 2, 105, 0, 0, 0, 300),
        (3990, 5, 88, 32, "R", 2, 105, 0, 0, 0, 300),  # nearer, wrong tid
        (4900, 5, 55, 40, "W", 2, 105, 0, 0, 0, 300),  # op mismatch
        (800, 9, 55, 48, "W", 3, 99, 0, 0, 1, 300),    # direct-issue mk
    ])
    th = threads([
        (5, 55, "a", 1, 55, "p", 0),
        (9, 55, "b", 1, 55, "p", 0),          # same tid as utid 5!
        (7, 77, "c", 2, 77, "q", 0),
    ])
    tr = pd.DataFrame(
        [(5, 0, 1000), (9, 1000, 2000)],
        columns=["utid", "ts_min", "ts_max"])
    from blkscope.extract import Extracted
    return Extracted(rq_insert=ins, rq_issue=iss, rq_complete=cmp_,
                     bio_make=mk, threads=th, thread_ranges=tr,
                     t_min=0, t_max=10_000)


def ex_requeue_window():
    """mq tag matching + requeue window/reason bookkeeping."""
    ins = rq_ins([
        (100, 5, 2080, 8, 8, 8192, "R"),
        (100, 5, 2080, 16, 8, 4096, "R"),
    ])
    iss = rq_iss([
        (150, 5, 2080, 8, 8, 8192, "R"),
        (180, 5, 2080, 8, 16, 8192, "R"),     # requeue -> issue_count 2
        (150, 5, 2080, 16, 8, 4096, "R"),
    ])
    cmp_ = rq_cmp([
        (300, 2080, 8, 16, "R", 0),
        (300, 2080, 16, 8, "R", 0),
    ])
    mq_c = pd.DataFrame(
        [(299, 2080, 8, 42, "use_tag: 10"),
         (301, 2080, 16, 43, "use_tag: 11")],
        columns=["ts", "dev", "sector", "req_tag", "rq_log"])
    mq_r = pd.DataFrame(
        [(160, 2080, 8, 42, "requeue_reason: 2 use_tag: 28"),
         (170, 2080, 8, 42, "requeue_reason: 5 use_tag: 28"),
         (175, 2080, 8, 42, "no reason here"),          # reason -> null
         (400, 2080, 8, 42, "requeue_reason: 9"),       # after t_cmp: out
         (160, 2080, 16, 43, "requeue_reason: 3")],
        columns=["ts", "dev", "sector", "req_tag", "rq_log"])
    from blkscope.extract import Extracted
    return Extracted(rq_insert=ins, rq_issue=iss, rq_complete=cmp_,
                     mq_complete=mq_c, mq_requeue=mq_r,
                     t_min=0, t_max=10_000)


def ex_slots():
    """cmp_lost zero-length slots + incomplete clip at t_max."""
    gap = 200_000_000
    iss = rq_iss([
        (150, 7, 2080, 0, 0, 0, "FFS"),         # cmp_lost flush
        (160, 7, 2080, 0, 0, 0, "FFS"),         # second dataless
        (200, 7, 2080, 8, 8, 4096, "R"),
        (100, 7, 1976, 1, 8, 4096, "R"),        # incomplete, clipped
        (100 + 2 * gap, 7, 1976, 2, 8, 4096, "R"),
        (100 + gap // 2, 7, 1976, 3, 8, 4096, "R"),
    ])
    cmp_ = rq_cmp([
        (250, 2080, 8, 8, "R", 0),
        (100 + 3 * gap, 1976, 2, 8, "R", 0),
        (100 + gap // 2 + 10, 1976, 3, 8, "R", 0),
    ])
    from blkscope.extract import Extracted
    return Extracted(rq_issue=iss, rq_complete=cmp_,
                     t_min=0, t_max=100 + 10 * gap)


def test_fill_process_names_edge_literals():
    """Python-side literals for the same frame asserted in
    tests/js/test_extract_shape.js (pandas-verified expectations)."""
    from blkscope.extract import _fill_process_names
    th = pd.DataFrame({
        "utid": [1, 2, 3, 4, 5, 6, 7, 8],
        "tid": [100, 101, 102, 200, 300, 301, 400, 401],
        "thread_name": ["main-t", "worker", None, None, None, "named-x",
                        "t-x", None],
        "upid": [10, 10, 10, 20, 30, 30, np.nan, 40],
        "pid": [100, 100, 100, 200, 300, 300, 400, 999],
        "process_name": [None, "keepme", None, None, None, None, "", ""],
        "parent_pid": [0, 0, 0, 0, 0, 0, 0, 0],
    })
    out = _fill_process_names(th)
    names = [n if pd.notna(n) else None for n in out["process_name"]]
    assert names == ["main-t", "keepme", "main-t", None,
                     "named-x", "named-x", None, None]


def test_model_parity_synthetic(tmp_path):
    from blkscope.extract import Extracted
    cases = {
        "pair_edges": ex_pair_edges(),
        "make_match": ex_make_match(),
        "requeue_window": ex_requeue_window(),
        "slots": ex_slots(),
        "empty": Extracted(t_min=0, t_max=1000),
    }
    for name, ex in cases.items():
        run_parity(ex, name, str(tmp_path))


# ------------------------------------------------------- sample parity

def _sample_stamp():
    import blkscope
    return {"size": os.path.getsize(SAMPLE),
            "mtime": os.path.getmtime(SAMPLE),
            "version": blkscope.__version__}


def _sample_dumps():
    """Cache work/<stem>.extracted.json + .model_req.json keyed by
    sample mtime/size + blkscope version. Returns (paths, py_ms)."""
    stem = os.path.splitext(os.path.basename(SAMPLE))[0]
    ex_path = os.path.join(WORK, stem + ".extracted.json")
    model_path = os.path.join(WORK, stem + ".model_req.json")
    stamp_path = os.path.join(WORK, stem + ".model_parity.stamp.json")
    stamp = _sample_stamp()
    if (os.path.exists(ex_path) and os.path.exists(model_path)
            and os.path.exists(stamp_path)):
        try:
            old = json.load(open(stamp_path))
        except (OSError, ValueError):
            old = None
        if old == stamp:
            return ex_path, model_path, None
    from blkscope import tp as blktp
    from blkscope import extract
    from blkscope.model import (
        assign_slots, categorize, enrich_requests, match_make_requests,
        pair_requests, parse_rwbs, prio_flags)
    proc = blktp.open_trace(SAMPLE)
    try:
        ex = extract.extract_all(proc)
    finally:
        proc.close()
    os.makedirs(WORK, exist_ok=True)
    with open(ex_path, "w", encoding="utf-8") as f:
        json.dump(dump_extracted.dump(ex), f)
    t0 = time.time()
    # P4a portion of build_model, timed separately for the JS-vs-Python
    # comparison (full build_model additionally does files/batches/
    # associate/dstate/quality which the JS side doesn't have yet).
    req, counters = pair_requests(ex.rq_insert, ex.rq_issue,
                                  ex.rq_complete)
    parsed = parse_rwbs(req["rwbs"])
    req["op"] = parsed["op"]
    req["cat"] = categorize(parsed)
    req = match_make_requests(req, ex.bio_make, ex.threads,
                              ex.thread_ranges)
    req["prio"] = prio_flags(parsed.reindex(req.index), req["cls"],
                             req["ux"], req["fg_meta"])
    req["q_ns"] = req["t_iss0"] - req["t_ins"]
    req["svc_ns"] = req["t_cmp"] - req["t_iss"]
    t0v = req["t_make"].fillna(req["t_ins"]).fillna(req["t_iss0"])
    req["total_ns"] = req["t_cmp"] - t0v
    req, _ = enrich_requests(req, ex.mq_complete, ex.mq_requeue,
                             ex.t_max)
    assign_slots(req, ex.t_max)
    p4a_ms = (time.time() - t0) * 1000

    t0 = time.time()
    with open(model_path, "w", encoding="utf-8") as f:
        json.dump(dump_extracted.dump_model(ex), f)
    py_ms = (time.time() - t0) * 1000
    with open(stamp_path, "w", encoding="utf-8") as f:
        json.dump({**stamp, "p4a_ms": p4a_ms, "build_model_ms": py_ms}, f)
    return ex_path, model_path, {"p4a_ms": p4a_ms,
                                 "build_model_ms": py_ms}


@pytest.mark.skipif(not os.path.exists(SAMPLE) or
                    not os.path.exists(TP_EXE),
                    reason="sample trace or trace_processor_shell missing")
def test_model_parity_sample():
    ex_path, model_path, py_ms = _sample_dumps()
    t0 = time.time()
    r = subprocess.run(
        [NODE, PARITY_JS, ex_path, model_path],
        cwd=ROOT, capture_output=True, timeout=600)
    wall_ms = (time.time() - t0) * 1000
    out = (r.stdout or b"").decode("utf-8", "replace") + \
        (r.stderr or b"").decode("utf-8", "replace")
    print(out)
    report = {"js_wall_ms": wall_ms, "out_tail": out.strip()[-400:]}
    if py_ms:
        report.update(py_ms)
    try:
        with open(os.path.join(WORK, "model_parity.json"), "w") as f:
            json.dump(report, f, indent=2)
    except OSError:
        pass
    assert r.returncode == 0, f"sample model parity failed:\n{out}"
