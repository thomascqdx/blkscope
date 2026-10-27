"""payload.py unit tests: meta fields, trace_start_abs fallback rule."""

import pandas as pd

from blkscope import payload as pl
from blkscope.model import Model

_REQ_COLS = ["dev", "sector", "bytes", "rwbs", "cat", "prio", "cls", "lvl",
             "t_make", "t_ins", "t_iss0", "t_iss", "t_cmp", "utid", "slot",
             "tag", "rq_n", "rq_reason", "err", "file", "foff", "flen",
             "fsrc", "batch", "cmp_lost", "req_id"]


def _model(t_min, t_max, trace_start) -> Model:
    m = Model()
    m.t_min, m.t_max, m.trace_start = t_min, t_max, trace_start
    m.req = pd.DataFrame({c: pd.Series(dtype="int64") for c in _REQ_COLS})
    return m


def test_trace_start_abs_fallback():
    # rule: trace_start if 0 < trace_start <= t0 else t0
    assert pl._trace_start_abs(0, 100) == 100        # missing -> t0
    assert pl._trace_start_abs(None, 100) == 100
    assert pl._trace_start_abs(-5, 100) == 100       # non-positive -> t0
    assert pl._trace_start_abs(50, 100) == 50        # normal earlier origin
    assert pl._trace_start_abs(100, 100) == 100      # equal is fine
    assert pl._trace_start_abs(150, 100) == 100      # after t0 -> t0


def test_build_payload_meta_trace_start():
    p = pl.build_payload(_model(1000, 2000, 500), "n", "src")
    assert p["meta"]["t0_abs"] == 1000
    assert p["meta"]["trace_start_abs"] == 500
    # missing / out-of-window trace_start falls back to t0_abs
    m = _model(1000, 2000, 0)
    assert pl.build_payload(m, "n", "s")["meta"]["trace_start_abs"] == 1000
    m = _model(1000, 2000, 3000)
    assert pl.build_payload(m, "n", "s")["meta"]["trace_start_abs"] == 1000
