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
    trace_start: int = 0  # trace_bounds.start_ts (Perfetto UI time origin)
    notes: list = field(default_factory=list)  # (level, code, msg) extras
    script: dict | None = None                 # text-log script replay


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


def _fill_process_names(threads: pd.DataFrame) -> pd.DataFrame:
    """Fill missing process names with the main/first thread name.

    Text systrace has thread names but rarely process names; without this
    every process group and the report's process view would be nameless.
    """
    th = threads.copy()
    missing = th["process_name"].isna() | \
        (th["process_name"].astype(str).str.len() == 0)
    if not missing.any():
        return th
    names = {}
    for upid, g in th.groupby("upid"):
        main = g[(g["tid"] == g["pid"]) & g["thread_name"].notna()]
        pick = main if len(main) else g[g["thread_name"].notna()]
        if len(pick):
            names[upid] = pick.iloc[0]["thread_name"]
    th["process_name"] = th["process_name"].astype("object")
    th.loc[missing, "process_name"] = th.loc[missing, "upid"].map(names)
    return th


def extract_all(tp, path: str | None = None) -> Extracted:
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
        "p.pid, p.name as process_name, pp.pid as parent_pid "
        "from thread t left join process p using(upid) "
        "left join process pp on pp.upid = p.parent_upid")
    if out.threads.empty:
        out.threads = _empty(["utid", "tid", "thread_name", "upid",
                              "pid", "process_name", "parent_pid"])
    else:
        out.threads = _fill_process_names(out.threads)

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

    tb = _query(tp, "select start_ts from trace_bounds")
    if not tb.empty and not pd.isna(tb.start_ts.iloc[0]):
        out.trace_start = int(tb.start_ts.iloc[0])

    # text systrace fallback (design 3.9): the systrace parser keeps only
    # scheduling events, so block_rq_* are read from the text log itself.
    # The script replay is always built for text logs (it is the script's
    # original number set); merging only happens when TP produced no block
    # request, to avoid double counting.
    if path:
        from . import textlog
        if textlog.looks_like_text(path):
            ev = textlog.parse_block_events(path)
            if ev.has_block:
                out.script = textlog.build_script_report(ev.rows)
                if not (len(out.rq_insert) or len(out.rq_issue)):
                    att = textlog.attach_utids(ev, out.threads,
                                               out.thread_ranges)
                    out.rq_insert = att.insert
                    out.rq_issue = att.issue
                    out.rq_complete = att.complete
                    if att.synth_rows:
                        synth = pd.DataFrame(att.synth_rows,
                                             columns=out.threads.columns)
                        out.threads = pd.concat(
                            [out.threads, synth], ignore_index=True)
                    if out.t_max > out.t_min:
                        out.t_min = min(out.t_min, ev.t_min)
                        out.t_max = max(out.t_max, ev.t_max)
                    else:
                        out.t_min, out.t_max = ev.t_min, ev.t_max
                    msg = (f"trace_processor 未解析 block_rq_* 文本事件；"
                           f"已从文本日志补 {len(att.insert)} 条 insert / "
                           f"{len(att.issue)} 条 issue / "
                           f"{len(att.complete)} 条 complete")
                    if att.n_synth:
                        msg += f"（{att.n_synth} 个线程为合成）"
                    if att.n_tid_missing:
                        msg += (f"；{att.n_tid_missing} 条事件没有 atrace "
                                f"前缀，按 comm 合成线程")
                    out.notes.append(("info", "text_block", msg))
                    if ev.bad:
                        out.notes.append((
                            "warn", "text_block_bad",
                            f"文本日志中有 {ev.bad} 行 block_rq_* 无法解析，"
                            f"已跳过"))
                else:
                    out.notes.append((
                        "info", "text_block_skipped",
                        "文本日志中的 block_rq_* 已由 trace_processor 解析，"
                        "未启用文本回退；脚本原值仅用于报告对照"))
    return out
