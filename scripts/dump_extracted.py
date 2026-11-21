#!/usr/bin/env python3
"""Dump extract_all() results (and the CLI payload) for a trace to JSON.

    python scripts/dump_extracted.py <trace> [-o work/<stem>]

Writes <out>.extracted.json — the raw extraction tables in the same columnar
shape the web extract layer (web/model/extract.js) produces —
<out>.model_req.json — build_model(ex) intermediates (m.req, m.requeues,
m.counters) for JS-model parity — and <out>.payload.json —
build_payload(build_model(ex)), the payload parity baseline.

The `script` field of Extracted (text-systrace fallback) is NOT dumped:
the web version does not port textlog in v1 (requirements.md §8).

dump(ex) is importable so tests can dump synthetic Extracted objects
without loading a trace.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

TABLE_ATTRS = [
    "bio_make", "rq_insert", "rq_issue", "rq_complete",
    "mq_complete", "mq_requeue", "pc_start", "fm_add",
    "blocked", "dstate", "threads", "thread_ranges",
]


def _norm(v):
    """JSON-normalize a cell: NaN/NA -> None, numpy -> Python scalars,
    integral floats -> int."""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.bool_):
        return bool(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return int(f) if f.is_integer() else f
    return v


def _dump_frame(df) -> dict:
    cols = list(df.columns)
    return {"columns": cols,
            "data": {c: [_norm(v) for v in df[c]] for c in cols}}


def dump(ex) -> dict:
    """Extracted -> the JSON shape shared with web/model/extract.js."""
    tables = {}
    for attr in TABLE_ATTRS:
        df = getattr(ex, attr, None)
        tables[attr] = _dump_frame(df) if df is not None \
            else {"columns": [], "data": {}}
    return {
        "tables": tables,
        "device": {k: _norm(v) for k, v in ex.device.items()},
        "stats": {k: _norm(v) for k, v in ex.stats.items()},
        "t_min": _norm(ex.t_min),
        "t_max": _norm(ex.t_max),
        "trace_start": _norm(ex.trace_start),
        "notes": [list(n) for n in ex.notes],
    }


def dump_model(ex) -> dict:
    """build_model(ex) intermediate values for JS-model parity:
    m.req in pairing order, m.requeues in event order, m.counters."""
    from blkscope.model import build_model
    m = build_model(ex)
    return {
        "req": _dump_frame(m.req),
        "requeues": _dump_frame(m.requeues),
        "counters": {k: _norm(v) for k, v in m.counters.items()},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("trace")
    ap.add_argument("-o", "--out", default=None,
                    help="output path prefix (default: work/<stem>)")
    args = ap.parse_args()

    from blkscope.tp import open_trace
    from blkscope.extract import extract_all
    from blkscope.model import build_model
    from blkscope.payload import build_payload

    stem = os.path.splitext(os.path.basename(args.trace))[0]
    out = args.out or os.path.join(ROOT, "work", stem)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    tp = open_trace(args.trace)
    try:
        ex = extract_all(tp, args.trace)
    finally:
        tp.close()

    extracted_path = out + ".extracted.json"
    with open(extracted_path, "w", encoding="utf-8") as f:
        json.dump(dump(ex), f, ensure_ascii=False)
    print(f"wrote {extracted_path}")

    model_path = out + ".model_req.json"
    with open(model_path, "w", encoding="utf-8") as f:
        json.dump(dump_model(ex), f, ensure_ascii=False)
    print(f"wrote {model_path}")

    payload = build_payload(build_model(ex), name=stem,
                            source=os.path.basename(args.trace))
    payload_path = out + ".payload.json"
    with open(payload_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"wrote {payload_path}")


if __name__ == "__main__":
    main()
