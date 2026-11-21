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
PAYLOAD_JS = os.path.join(ROOT, "tests", "js", "payload_parity.js")

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


def run_payload_parity(ex, name, tmp_path, m=None, py_ms=None):
    """dump(ex) + dump_payload(ex) -> JSON -> node payload_parity.js.
    m = optional prebuilt Python model (build_model result); py_ms is
    the caller's build_model+build_payload time when it built m itself.
    Returns (node stdout, py build_model+payload ms)."""
    ex_path = os.path.join(tmp_path, name + ".extracted.json")
    payload_path = os.path.join(tmp_path, name + ".payload.json")
    with open(ex_path, "w", encoding="utf-8") as f:
        json.dump(dump_extracted.dump(ex), f, ensure_ascii=False)
    if m is None:
        t0 = time.time()
        pl = dump_extracted.dump_payload(ex, name=name, source=name)
        py_ms = (time.time() - t0) * 1000
    else:
        pl = dump_extracted.dump_payload(ex, name=name, source=name, m=m)
    with open(payload_path, "w", encoding="utf-8") as f:
        json.dump(pl, f, ensure_ascii=False)
    r = subprocess.run(
        [NODE, PAYLOAD_JS, ex_path, payload_path],
        cwd=ROOT, capture_output=True, timeout=300)
    out = (r.stdout or b"").decode("utf-8", "replace") + \
        (r.stderr or b"").decode("utf-8", "replace")
    assert r.returncode == 0, f"{name} payload parity failed:\n{out}"
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


# ------------------------------------------------------ P4b scenarios

def pc_start(rows):
    cols = ["ts", "utid", "major_dev", "minor_dev", "ino", "offset",
            "bytes", "filebuf"]
    return pd.DataFrame(rows, columns=cols)


def fm_add(rows):
    return pd.DataFrame(rows, columns=["ts", "utid", "s_dev", "i_ino",
                                       "index"])


def dstate(rows):
    return pd.DataFrame(rows, columns=["ts", "utid", "dur",
                                       "blocked_function"])


def blocked(rows):
    return pd.DataFrame(rows, columns=["ts", "pid", "caller", "io_wait"])


def mq(rows):
    return pd.DataFrame(rows, columns=["ts", "dev", "sector", "req_tag",
                                       "rq_log"])


def ex_p4b_full():
    """Files/batches/associate/hints/dstate/waits/slot_limits/devs/
    quality in one trace (see inline comments for what each row
    exercises)."""
    th = threads([
        (5, 55, "io-t", 1, 55, "app", 0),
        (9, 66, "kworker", 2, 66, "kwork", 2),      # kernel proc (ppid 2)
        (7, 77, "t7", np.nan, 77, "noproc", 0),     # no upid
        (3, 0, "swapper", 4, 0, "idle", 0),         # pid 0 -> kernel
    ])
    pc = pc_start([
        (400, 5, 8, 32, 100, 0, 4096, "file_a.so"),
        (500, 5, 8, 32, 100, 8192, 4096, "file_a.so"),
        (800, 5, 8, 32, 300, 0, 4096, "file_c.so"),
        (59_000_000, 9, 8, 32, 2, 4096, 4096, None),
        (60_000_000, 5, 8, 32, 150, 0, 4096, "bb.so"),
        (60_100_000, 5, 8, 32, 150, 0, 4096, "aa.so"),  # mode tie -> aa.so
    ])
    fa = fm_add([
        (600, 5, 2080, 100, 0),            # matched pc_idx1 -> start batch
        (700, 5, 2080, 100, 1),
        (7_000_000, 5, 2080, 400, 0),      # unmatched -> no-start seg
        (8_000_000, 5, 2080, 300, 0),      # matched pc_idx2
        (9_000_000, 5, 2080, 400, 0),      # unmatched after matched -> seg
        (20_000_000, 5, 2080, 300, 1),     # matched pc_idx2, gap -> sub 1
        (30_000_000, 5, 2080, 555, 0),     # no-start seg (pages 30,31)
        (31_000_000, 5, 2080, 555, 1),
        (40_000_000, 5, 2080, 555, 0),     # >5ms gap -> new seg
        (50_000_000, 5, 2080, 555, 0),     # >5ms gap -> new seg
        (60_500_000, 5, 2080, 150, 0),     # matched pc_idx5
        (60_000_000, 9, 2080, 1, 0),       # FS元数据 ino1
        (61_000_000, 9, 2080, 2, 0),       # matched pc ino2 (FS元数据)
        (62_000_000, 9, 2080, 3, 0),       # FS元数据 ino3
        (63_000_000, 9, 2080, 42, 0),      # "ino:42"
    ])
    ins = rq_ins([
        (1000, 5, 2080, 8, 8, 4096, "R"),        # R0: assoc ino100 batchA
        (25_000_000, 5, 2080, 16, 8, 4096, "R"), # R1: n-tie -> ino300
        (45_000_000, 5, 2080, 24, 8, 8192, "R"), # R2: ino555 (30,31 batch)
        (55_000_000, 5, 2080, 32, 8, 4096, "R"), # R3: ino555 (50e6 batch)
        (2000, 5, 2080, 40, 8, 4096, "W"),       # R4: write -> fsrc -1
        (59_500_000, 9, 2080, 48, 8, 4096, "R"), # R5: pc fallback ino2
        (100, 7, 1234, 56, 8, 4096, "R"),        # R6: dev 1234, src2 wait
    ])
    iss = rq_iss([
        (1100, 5, 2080, 8, 8, 4096, "R"),
        (25_100_000, 5, 2080, 16, 8, 4096, "R"),
        (45_100_000, 5, 2080, 24, 8, 8192, "R"),
        (55_100_000, 5, 2080, 32, 8, 4096, "R"),
        (2100, 5, 2080, 40, 8, 4096, "W"),
        (59_550_000, 9, 2080, 48, 8, 4096, "R"),
        (150, 7, 1234, 56, 8, 4096, "R"),
    ])
    cmp_ = rq_cmp([
        (1500, 2080, 8, 8, "R", 0),              # R0 cmp: wait src1 seg0
        (25_500_000, 2080, 16, 8, "R", 0),
        (45_500_000, 2080, 24, 8, "R", 0),
        (55_500_000, 2080, 32, 8, "R", 0),
        (2100, 2080, 40, 8, "W", 0),             # R4 cmp: src1 seg0 + seg1
        (59_600_000, 2080, 48, 8, "R", 0),
        (9450, 1234, 56, 8, "R", 0),             # R6: src2 for utid9 seg
    ])
    mk = bio_make([
        (900, 5, 55, 8, "R", 2, 110, 1, 0, 0, 100),  # make-match R0
    ])
    mq_c = mq([
        (1400, 2080, 8, 42, "use_tag: 10"),      # tag 42 for R0
        (9400, 1234, 56, 43, "use_tag: 28"),     # tag 43, dev limit 28
    ])
    mq_r = mq([
        (1200, 2080, 8, 42, "requeue_reason: 3 use_tag: 10"),
    ])
    dst = dstate([
        (1300, 5, 4000, ""),            # no bf -> caller#13.0, iow 1
        (1600, 5, 1000, "io_schedule"),  # explicit bf -> fn_ok 1
        (9000, 9, 500, ""),             # caller#21.0, iow 1 -> src2 wait
        (5000, 7, 300, ""),             # no blocked on tid77 -> unmatched
                                        #   left row -> float caller col
    ])
    blk = blocked([
        (1400, 55, 13, 1),
        (9100, 66, 21, 1),
    ])
    from blkscope.extract import Extracted
    return Extracted(
        rq_insert=ins, rq_issue=iss, rq_complete=cmp_, bio_make=mk,
        mq_complete=mq_c, mq_requeue=mq_r, pc_start=pc, fm_add=fa,
        dstate=dst, blocked=blk, threads=th,
        device={"android_sdk_version": 34, "system_ram_gb": 8.0,
                "name": "dev0"},
        stats={"traced_buf_write_wrap_count": 1,
               "ftrace_cpu_overrun_begin": 2,
               "ftrace_cpu_overrun_end": 5},
        t_min=100, t_max=70_000_000, trace_start=50,
        notes=[("warn", "x_warn", "自定义警告"), ("info", "x_info", "提示B")])


def ex_p4b_callers():
    """Symbolic + mixed-dtype callers; wait src1 and src2."""
    th = threads([
        (5, 55, "io-t", 1, 55, "app", 0),
        (7, 77, "t7", 2, 77, "p2", 0),
    ])
    ins = rq_ins([
        (900, 5, 2080, 8, 8, 4096, "R"),     # cmp inside seg0 -> src1
        (999_000, 7, 2080, 16, 8, 4096, "R"),  # cmp 1000450 -> src2 seg2
    ])
    iss = rq_iss([
        (950, 5, 2080, 8, 8, 4096, "R"),
        (999_050, 7, 2080, 16, 8, 4096, "R"),
    ])
    cmp_ = rq_cmp([
        (1149, 2080, 8, 8, "R", 0),          # in [1000, 1150] -> src1
        (1_000_450, 2080, 16, 8, "R", 0),
    ])
    # caller window [ts, end+1ms]; src2 window [end-100us, end]:
    # seg1 sits >100us after req0's completion so it gets no wait pair
    dst = dstate([
        (1000, 5, 100, ""),       # symbolic caller -> fn as-is, iow 1
        (100_650, 7, 500, ""),    # numeric caller on pid77 -> caller#7
        (1_000_000, 5, 500, ""),  # symbolic, iow 1, no own completion
                                 #   -> src2: nearest <= end (1000450)
    ])
    blk = blocked([
        (1050, 55, "bio_schedule", 1),
        (100_700, 77, 7, 1),
        (1_002_000, 55, "wakeup", 1),
    ])
    from blkscope.extract import Extracted
    return Extracted(rq_insert=ins, rq_issue=iss, rq_complete=cmp_,
                     dstate=dst, blocked=blk, threads=th,
                     t_min=0, t_max=2_000_000)


def ex_p4b_clean():
    """All-numeric callers, every lookup matched -> clean caller#N and
    the block_fn_unresolved quality warning."""
    th = threads([(5, 55, "io-t", 1, 55, "app", 0)])
    ins = rq_ins([(900, 5, 2080, 8, 8, 4096, "R")])
    iss = rq_iss([(950, 5, 2080, 8, 8, 4096, "R")])
    cmp_ = rq_cmp([(1500, 2080, 8, 8, "R", 0)])
    dst = dstate([
        (1000, 5, 1000, ""),
        (2000, 5, 500, ""),
    ])
    blk = blocked([
        (1050, 55, 7, 1),
        # +1ms slack: must sit outside seg0's [ts, end+1ms] window to be
        # a distinct lookup result
        (1_002_050, 55, 9, 0),
    ])
    from blkscope.extract import Extracted
    return Extracted(rq_insert=ins, rq_issue=iss, rq_complete=cmp_,
                     dstate=dst, blocked=blk, threads=th,
                     t_min=0, t_max=10_000)


def ex_p4b_bigdev():
    """Composite fkeys and dev encode/decode beyond 2**31."""
    th = threads([(5, 55, "io-t", 1, 55, "app", 0)])
    big_sdev = 4294967301            # 2**32 + 5
    pc = pc_start([
        (400, 5, 16777216, 5, 99, 0, 4096, "big.so"),  # s_dev = 2**32+5
    ])
    fa = fm_add([
        (600, 5, big_sdev, 99, 0),
        (700, 5, big_sdev, 99, 1),
    ])
    ins = rq_ins([(1000, 5, 4294967296, 8, 8, 4096, "R")])
    iss = rq_iss([(1100, 5, 4294967296, 8, 8, 4096, "R")])
    cmp_ = rq_cmp([(1500, 4294967296, 8, 8, "R", 0)])
    from blkscope.extract import Extracted
    return Extracted(rq_insert=ins, rq_issue=iss, rq_complete=cmp_,
                     pc_start=pc, fm_add=fa, threads=th,
                     t_min=0, t_max=10_000)



# ------------------------------------------------- P4c: exact file keys

def ex_p4c_split_ino():
    """Same thread, same s_dev, consecutive fm_add ino 1 then 2 within
    the batch gap -> two batches on two files (old float64 fkey
    comparison merged them into one)."""
    th = threads([(5, 55, "io-t", 1, 55, "app", 0)])
    fa = fm_add([
        (100, 5, 65155, 1, 0),
        (101, 5, 65155, 2, 1),
    ])
    ins = rq_ins([
        (100, 5, 2080, 8, 8, 4096, "R"),
        (101, 5, 2080, 16, 8, 4096, "R"),
    ])
    iss = rq_iss([
        (150, 5, 2080, 8, 8, 4096, "R"),
        (151, 5, 2080, 16, 8, 4096, "R"),
    ])
    cmp_ = rq_cmp([
        (200, 2080, 8, 8, "R", 0),
        (201, 2080, 16, 8, "R", 0),
    ])
    from blkscope.extract import Extracted
    return Extracted(rq_insert=ins, rq_issue=iss, rq_complete=cmp_,
                     fm_add=fa, threads=th, t_min=0, t_max=10_000)


def ex_p4c_pc_collision():
    """pc fallback with nearby large inos that collide in float64:
    the request must get the file of the pc row it actually matched.
    A second request outside the 20 ms window exercises the NaN path
    that made the old column float64."""
    th = threads([(5, 55, "io-t", 1, 55, "app", 0)])
    pc = pc_start([
        # out of ts order so the matched file is not the later dict key
        (500, 5, 254, 131, 12624502, 0, 4096, "a.ttf"),
        (400, 5, 254, 131, 12624505, 0, 4096, "b.ttf"),
    ])
    ins = rq_ins([
        (1000, 5, 2080, 8, 8, 4096, "R"),
        (50_000_000, 5, 2080, 16, 8, 4096, "R"),
    ])
    iss = rq_iss([
        (1100, 5, 2080, 8, 8, 4096, "R"),
        (50_000_100, 5, 2080, 16, 8, 4096, "R"),
    ])
    cmp_ = rq_cmp([
        (1200, 2080, 8, 8, "R", 0),
        (50_000_200, 2080, 16, 8, "R", 0),
    ])
    from blkscope.extract import Extracted
    return Extracted(rq_insert=ins, rq_issue=iss, rq_complete=cmp_,
                     pc_start=pc, threads=th, t_min=0,
                     t_max=60_000_000)


def ex_p4c_bigdev_wrap():
    """s_dev large enough that s_dev*2**40+ino overflows int64
    (new_encode_dev(254, 2**19) = 2147548672): fm_add association and
    pc fallback must still work."""
    from blkscope.model import new_encode_dev
    th = threads([(5, 55, "io-t", 1, 55, "app", 0)])
    sd = int(new_encode_dev(254, 2 ** 19))       # 2147548672
    pc = pc_start([
        (400, 5, 254, 2 ** 19, 9, 0, 4096, "big.so"),
    ])
    fa = fm_add([
        (900, 5, sd, 9, 10),
        (901, 5, sd, 9, 11),
    ])
    ins = rq_ins([
        (1000, 5, 2080, 8, 8, 4096, "R"),        # fm_add assoc
        (3000, 5, 2080, 16, 8, 4096, "R"),       # pc fallback
    ])
    iss = rq_iss([
        (1100, 5, 2080, 8, 8, 4096, "R"),
        (3100, 5, 2080, 16, 8, 4096, "R"),
    ])
    cmp_ = rq_cmp([
        (1200, 2080, 8, 8, "R", 0),
        (3200, 2080, 16, 8, "R", 0),
    ])
    from blkscope.extract import Extracted
    return Extracted(rq_insert=ins, rq_issue=iss, rq_complete=cmp_,
                     pc_start=pc, fm_add=fa, threads=th,
                     t_min=0, t_max=10_000)


def ex_p4c_caller_int():
    """Blocked-caller column that pandas promotes to float64 (matched
    int caller + an unmatched segment) must still render caller#<int>."""
    th = threads([
        (5, 55, "io-t", 1, 55, "app", 0),
        (6, 66, "t6", 1, 66, "app", 0),
    ])
    dst = dstate([
        (1000, 5, 500, ""),      # caller 13 matched -> caller#13
        (2000, 6, 400, ""),      # no blocked row on tid66 -> NaN caller
                                 #   -> old merged column was float64
    ])
    blk = blocked([
        (1400, 55, 13, 0),
    ])
    from blkscope.extract import Extracted
    return Extracted(dstate=dst, blocked=blk, threads=th,
                     t_min=0, t_max=10_000)


def test_payload_parity_synthetic(tmp_path):
    """Full-payload parity on synthetic Extracted objects covering every
    P4b function (files meta naming, start/no-start/sub-batches, fm_add
    mode + pc fallback association, hints, dstate callers + wait src1/2,
    slot limits, kernel flags, quality, big keys, empty)."""
    from blkscope.extract import Extracted
    cases = {
        "p4b_full": ex_p4b_full(),
        "p4b_callers": ex_p4b_callers(),
        "p4b_clean": ex_p4b_clean(),
        "p4b_bigdev": ex_p4b_bigdev(),
        "p4c_split_ino": ex_p4c_split_ino(),
        "p4c_pc_collision": ex_p4c_pc_collision(),
        "p4c_bigdev_wrap": ex_p4c_bigdev_wrap(),
        "p4c_caller_int": ex_p4c_caller_int(),
        "pair_edges": ex_pair_edges(),
        "requeue_window": ex_requeue_window(),
        "empty": Extracted(t_min=0, t_max=1000),
    }
    for name, ex in cases.items():
        run_payload_parity(ex, name, str(tmp_path))


# ------------------------------------------------------- sample parity

def _sample_stamp():
    import blkscope
    return {"size": os.path.getsize(SAMPLE),
            "mtime": os.path.getmtime(SAMPLE),
            "version": blkscope.__version__}


def _sample_dumps():
    """Cache work/<stem>.extracted.json + .model_req.json + .payload.json
    keyed by sample mtime/size + blkscope version.
    Returns (ex_path, model_path, payload_path, py_timings|None)."""
    stem = os.path.splitext(os.path.basename(SAMPLE))[0]
    ex_path = os.path.join(WORK, stem + ".extracted.json")
    model_path = os.path.join(WORK, stem + ".model_req.json")
    payload_path = os.path.join(WORK, stem + ".payload.json")
    stamp_path = os.path.join(WORK, stem + ".model_parity.stamp.json")
    stamp = _sample_stamp()
    if (os.path.exists(ex_path) and os.path.exists(model_path)
            and os.path.exists(payload_path)
            and os.path.exists(stamp_path)):
        try:
            old = json.load(open(stamp_path))
        except (OSError, ValueError):
            old = None
        if old == stamp:
            return ex_path, model_path, payload_path, None
    from blkscope import tp as blktp
    from blkscope import extract
    from blkscope.model import (
        assign_slots, categorize, enrich_requests, match_make_requests,
        pair_requests, parse_rwbs, prio_flags, build_model)
    from blkscope.payload import build_payload
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
    # comparison.
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
    m = build_model(ex)
    payload = build_payload(m, name=stem,
                            source=os.path.basename(SAMPLE))
    py_ms = (time.time() - t0) * 1000
    with open(model_path, "w", encoding="utf-8") as f:
        json.dump(dump_extracted.dump_model(ex, m=m), f)
    with open(payload_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    with open(stamp_path, "w", encoding="utf-8") as f:
        json.dump({**stamp, "p4a_ms": p4a_ms,
                   "build_model_payload_ms": py_ms}, f)
    return ex_path, model_path, payload_path, {
        "p4a_ms": p4a_ms, "build_model_payload_ms": py_ms}


@pytest.mark.skipif(not os.path.exists(SAMPLE) or
                    not os.path.exists(TP_EXE),
                    reason="sample trace or trace_processor_shell missing")
def test_model_parity_sample():
    ex_path, model_path, _, py_ms = _sample_dumps()
    t0 = time.time()
    r = subprocess.run(
        [NODE, PARITY_JS, ex_path, model_path],
        cwd=ROOT, capture_output=True, timeout=600)
    wall_ms = (time.time() - t0) * 1000
    out = (r.stdout or b"").decode("utf-8", "replace") + \
        (r.stderr or b"").decode("utf-8", "replace")
    print(out)
    report = {"js_model_wall_ms": wall_ms, "model_out_tail": out.strip()[-400:]}
    if py_ms:
        report.update(py_ms)
    try:
        with open(os.path.join(WORK, "model_parity.json"), "w") as f:
            json.dump(report, f, indent=2)
    except OSError:
        pass
    assert r.returncode == 0, f"sample model parity failed:\n{out}"


@pytest.mark.skipif(not os.path.exists(SAMPLE) or
                    not os.path.exists(TP_EXE),
                    reason="sample trace or trace_processor_shell missing")
def test_payload_parity_sample():
    """Full-payload byte-for-byte parity on the sample trace (with the
    Python payload's generated/tool_version passed through)."""
    ex_path, _, payload_path, py_ms = _sample_dumps()
    t0 = time.time()
    r = subprocess.run(
        [NODE, PAYLOAD_JS, ex_path, payload_path],
        cwd=ROOT, capture_output=True, timeout=600)
    wall_ms = (time.time() - t0) * 1000
    out = (r.stdout or b"").decode("utf-8", "replace") + \
        (r.stderr or b"").decode("utf-8", "replace")
    print(out)
    # fold JS analyze + python build_model/payload timings into
    # work/model_parity.json
    report = {}
    rp = os.path.join(WORK, "model_parity.json")
    try:
        report = json.load(open(rp))
    except (OSError, ValueError):
        pass
    report["js_analyze_wall_ms"] = wall_ms
    report["payload_out_tail"] = out.strip()[-400:]
    for line in out.splitlines():
        if line.startswith("js analyze:"):
            report["js_analyze_ms"] = float(
                line.split(":")[1].strip().split()[0])
    if py_ms:
        report.update(py_ms)
    try:
        with open(rp, "w") as f:
            json.dump(report, f, indent=2)
    except OSError:
        pass
    assert r.returncode == 0, f"sample payload parity failed:\n{out}"
