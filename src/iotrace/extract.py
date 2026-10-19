"""SQL extraction layer: trace_processor -> raw event DataFrames.

Only fetches data; all logic lives in model.py. All timestamps are absolute
ns (int64). Events absent from the trace yield empty DataFrames with the
correct columns.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

_STR_COLS = {"rwbs", "comm", "filebuf", "rq_log", "caller", "blocked_function",
             "error", "type", "name"}

# Fixed output schema per event table (design.md section 2).
_EVENT_QUERIES = {
    "bio_make": (
        "block_rq_mq_make_request",
        ["pid", "sector", "rwbs", "class", "priority", "is_ux_task",
         "is_ux_loop", "FG_META", "bi_ioprio"],
        ["ts", "utid"],
    ),
    "rq_insert": (
        "block_rq_insert",
        ["dev", "sector", "nr_sector", "bytes", "rwbs"],
        ["ts", "utid"],
    ),
    "rq_issue": (
        "block_rq_issue",
        ["dev", "sector", "nr_sector", "bytes", "rwbs"],
        ["ts", "utid"],
    ),
    "rq_complete": (
        "block_rq_complete",
        ["dev", "sector", "nr_sector", "rwbs", "error"],
        ["ts"],
    ),
    "mq_complete": (
        "block_rq_mq_complete_request",
        ["dev", "sector", "req_tag", "rq_log"],
        ["ts"],
    ),
    "mq_requeue": (
        "block_rq_mq_requeue_request",
        ["dev", "sector", "req_tag", "rq_log"],
        ["ts"],
    ),
    "pc_start": (
        "tran_fs_pagecache_start",
        ["major_dev", "minor_dev", "ino", "offset", "bytes", "filebuf"],
        ["ts", "utid"],
    ),
    "fm_add": (
        "mm_filemap_add_to_page_cache",
        ["s_dev", "i_ino", "index"],
        ["ts", "utid"],
    ),
    "blocked": (
        "sched_blocked_reason",
        ["pid", "caller", "io_wait"],
        ["ts"],
    ),
}

_META_KEYS = [
    "android_build_fingerprint", "android_device_manufacturer",
    "android_soc_model", "system_release", "android_sdk_version",
    "system_ram_gb",
]

_STATS_KEYS = [
    "traced_buf_write_wrap_count", "interned_data_tokenizer_errors",
    "ftrace_cpu_overrun_begin", "ftrace_cpu_overrun_end",
]


@dataclass
class Extracted:
    """Raw extraction result consumed by model.build_model."""
    bio_make: pd.DataFrame = field(default_factory=pd.DataFrame)
    rq_insert: pd.DataFrame = field(default_factory=pd.DataFrame)
    rq_issue: pd.DataFrame = field(default_factory=pd.DataFrame)
    rq_complete: pd.DataFrame = field(default_factory=pd.DataFrame)
    mq_complete: pd.DataFrame = field(default_factory=pd.DataFrame)
    mq_requeue: pd.DataFrame = field(default_factory=pd.DataFrame)
    pc_start: pd.DataFrame = field(default_factory=pd.DataFrame)
    fm_add: pd.DataFrame = field(default_factory=pd.DataFrame)
    blocked: pd.DataFrame = field(default_factory=pd.DataFrame)
    dstate: pd.DataFrame = field(default_factory=pd.DataFrame)
    threads: pd.DataFrame = field(default_factory=pd.DataFrame)
    thread_ranges: pd.DataFrame = field(default_factory=pd.DataFrame)
    device: dict = field(default_factory=dict)
    stats: dict = field(default_factory=dict)
    t_min: int = 0  # valid window: [t_min, t_max] absolute ns
    t_max: int = 0


def _query(tp, sql: str) -> pd.DataFrame:
    df = tp.query(sql).as_pandas_dataframe()
    for col in df.columns:
        if col in _STR_COLS:
            continue
        try:
            df[col] = pd.to_numeric(df[col])
        except (ValueError, TypeError):
            pass
    return df


def _empty(cols) -> pd.DataFrame:
    return pd.DataFrame({c: pd.Series(dtype="int64" if c not in _STR_COLS
                                    else "object") for c in cols})


def _events(tp, name: str, arg_keys, base_cols) -> pd.DataFrame:
    select = ", ".join(
        f"extract_arg(arg_set_id,'{k}') as \"{k}\"" for k in arg_keys)
    cols = list(base_cols) + list(arg_keys)
    df = _query(
        tp,
        f"select {', '.join(base_cols)}, {select} "
        f"from ftrace_event where name='{name}' order by ts")
    if df.empty:
        return _empty(cols)
    return df[cols]


def extract_all(tp) -> Extracted:
    out = Extracted()
    for attr, (event, arg_keys, base_cols) in _EVENT_QUERIES.items():
        setattr(out, attr, _events(tp, event, arg_keys, base_cols))

    out.dstate = _query(
        tp,
        "select utid, ts, dur, blocked_function from thread_state "
        "where state in ('D','DK') order by ts")
    if out.dstate.empty:
        out.dstate = _empty(["utid", "ts", "dur", "blocked_function"])

    out.threads = _query(
        tp,
        "select t.utid, t.tid, t.name as thread_name, t.upid, "
        "p.pid, p.name as process_name "
        "from thread t left join process p using(upid)")
    if out.threads.empty:
        out.threads = _empty(["utid", "tid", "thread_name", "upid",
                              "pid", "process_name"])

    # ts range per utid, used to disambiguate reused tids (design 3.2).
    out.thread_ranges = _query(
        tp,
        "select utid, min(ts) as ts_min, max(ts + dur) as ts_max "
        "from thread_state group by utid")
    if out.thread_ranges.empty:
        out.thread_ranges = _empty(["utid", "ts_min", "ts_max"])

    meta = _query(
        tp,
        "select name, str_value, int_value from metadata "
        f"where name in ({', '.join(repr(k) for k in _META_KEYS)})")
    for _, row in meta.iterrows():
        val = row["str_value"]
        if val is None or (isinstance(val, float) and np.isnan(val)):
            val = row["int_value"]
        if val is not None and not (isinstance(val, float) and np.isnan(val)):
            out.device[row["name"]] = val

    stats = _query(
        tp,
        "select name, sum(value) as value from stats "
        f"where name in ({', '.join(repr(k) for k in _STATS_KEYS)}) "
        "group by name")
    out.stats = {r["name"]: int(r["value"]) for _, r in stats.iterrows()
                 if not pd.isna(r["value"])}

    bounds = _query(tp, "select min(ts) as mn, max(ts) as mx from ftrace_event")
    if not bounds.empty and not pd.isna(bounds.mn.iloc[0]):
        out.t_min = int(bounds.mn.iloc[0])
        out.t_max = int(bounds.mx.iloc[0])
    return out
