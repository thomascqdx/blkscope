"""Model -> columnar JSON payload (design.md section 4).

Times are relative to t0 (valid window start) in ns; missing values are -1.
Strings are pooled in "strs" with columns holding indices. Output dict is
json.dumps-able; encode_payload returns gzip+base64 text for HTML embedding.
"""

from __future__ import annotations

import base64
import datetime
import gzip
import json

import numpy as np
import pandas as pd

from . import __version__, model as mod


class _Strings:
    def __init__(self):
        self.pool = []
        self.idx = {}

    def intern(self, s) -> int:
        s = "" if s is None or (isinstance(s, float) and np.isnan(s)) else str(s)
        i = self.idx.get(s)
        if i is None:
            i = len(self.pool)
            self.idx[s] = i
            self.pool.append(s)
        return i

    def col(self, series) -> list:
        return [self.intern(v) for v in series]


def _ints(series, t0: int = 0, missing=-1) -> list:
    """int64 column with -1 sentinel; optionally subtract t0 (ns times)."""
    s = pd.to_numeric(series, errors="coerce")
    out = np.where(s.isna(), missing, s.fillna(0).astype("int64") - t0)
    return out.astype("int64").tolist()


def build_payload(m, name: str, source: str) -> dict:
    st = _Strings()
    req = m.req
    t0 = m.t_min

    # requests sorted by t_issue_first (design 4); remap dependent ids
    order = np.argsort(
        req["t_iss0"].fillna(req["t_ins"]).fillna(np.float64(np.inf))
        .to_numpy(), kind="stable") if len(req) else np.empty(0, np.int64)
    req = req.iloc[order].reset_index(drop=True)
    remap = np.zeros(len(req), np.int64)
    if len(req):
        remap[req["req_id"].astype("int64").to_numpy()] = np.arange(len(req))

    # threads / procs
    th = getattr(m, "threads", pd.DataFrame())
    procs = {"upid": [], "pid": [], "name": [], "kt": []}
    threads = {"utid": [], "tid": [], "name": [], "upid": []}
    if len(th):
        up = th.dropna(subset=["upid"]).drop_duplicates("upid")
        kt = mod.proc_kernel_flag(th)
        procs = {"upid": _ints(up["upid"]), "pid": _ints(up["pid"]),
                 "name": st.col(up["process_name"]),
                 "kt": _ints(up["upid"].map(lambda u: kt.get(int(u), 0)))}
        threads = {"utid": _ints(th["utid"]), "tid": _ints(th["tid"]),
                   "name": st.col(th["thread_name"]),
                   "upid": _ints(th["upid"])}

    files = {"name": [], "dev": [], "ino": [], "meta": [], "hint": []}
    if len(m.files):
        files = {"name": st.col(m.files["name"]),
                 "dev": _ints(m.files["s_dev"]),
                 "ino": _ints(m.files["ino"]),
                 "meta": _ints(m.files["is_meta"]),
                 "hint": st.col(m.files["hint"])}

    batches = {"utid": [], "ts": [], "end": [], "file": [], "page0": [],
               "pages": [], "start": []}
    if len(m.batches):
        b = m.batches
        batches = {"utid": _ints(b["utid"]), "ts": _ints(b["ts"], t0),
                   "end": _ints(b["t_last_add"], t0),
                   "file": _ints(b["file_id"]),
                   "page0": _ints(b["page_first"]),
                   "pages": _ints(b["page_count"]),
                   "start": _ints(b["has_start"])}

    dst = {"utid": [], "ts": [], "dur": [], "fn": [], "fn_ok": [], "iow": [],
           "wait_off": [], "wait_req": [], "wait_src": []}
    if len(m.dst):
        dst = {"utid": _ints(m.dst["utid"]), "ts": _ints(m.dst["ts"], t0),
               "dur": _ints(m.dst["dur"]), "fn": st.col(m.dst["fn"]),
               "fn_ok": _ints(m.dst["fn_ok"]), "iow": _ints(m.dst["iow"]),
               "wait_off": m.wait_off.astype("int64").tolist(),
               "wait_req": remap[m.wait_req].tolist()
               if len(m.wait_req) else [],
               "wait_src": m.wait_src.astype("int64").tolist()}

    requeues = {"ts": [], "req": [], "reason": []}
    if len(m.requeues):
        rids = m.requeues["req"].astype("int64").to_numpy()
        requeues = {"ts": _ints(m.requeues["ts"], t0),
                    "req": remap[rids].tolist(),
                    "reason": _ints(m.requeues["reason"])}

    devs = []
    if len(m.devs):
        devs = [{"dev": int(r.dev), "name": r.name, "kind": r.kind,
                 "lanes": int(r.lanes),
                 "slot_limit": (int(r.slot_limit)
                                if not pd.isna(r.slot_limit) else None)}
                for r in m.devs.itertuples()]

    req_cols = {
        "dev": _ints(req["dev"]), "sector": _ints(req["sector"]),
        "bytes": _ints(req["bytes"]), "rwbs": st.col(req["rwbs"]),
        "cat": _ints(req["cat"]), "prio": _ints(req["prio"]),
        "cls": _ints(req["cls"]), "lvl": _ints(req["lvl"]),
        "t_make": _ints(req["t_make"], t0), "t_ins": _ints(req["t_ins"], t0),
        "t_iss0": _ints(req["t_iss0"], t0), "t_iss": _ints(req["t_iss"], t0),
        "t_cmp": _ints(req["t_cmp"], t0), "utid": _ints(req["utid"]),
        "slot": _ints(req["slot"]), "tag": _ints(req["tag"]),
        "rq_n": _ints(req["rq_n"]), "rq_reason": _ints(req["rq_reason"]),
        "err": _ints(req["err"]), "file": _ints(req["file"]),
        "foff": _ints(req["foff"]), "flen": _ints(req["flen"]),
        "fsrc": _ints(req["fsrc"]), "batch": _ints(req["batch"]),
    }

    return {
        "v": 1,
        "meta": {
            "name": name,
            "source": source,
            "t0_abs": int(t0),
            "dur": int(m.t_max - t0),
            "device": {k: (int(v) if isinstance(v, (int, np.integer)) or
                           (isinstance(v, float) and float(v).is_integer())
                           else v)
                       for k, v in m.device.items()},
            "generated": datetime.datetime.now(
                datetime.timezone.utc).isoformat(timespec="seconds"),
            "tool_version": __version__,
        },
        "quality": m.quality,
        "strs": st.pool,
        "procs": procs,
        "threads": threads,
        "devs": devs,
        "req": req_cols,
        "files": files,
        "batches": batches,
        "dst": dst,
        "requeues": requeues,
    }


def encode_payload(payload: dict) -> str:
    """payload dict -> gzip -> base64 ascii string."""
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) \
        .encode("utf-8")
    return base64.b64encode(gzip.compress(raw, compresslevel=6)) \
        .decode("ascii")
