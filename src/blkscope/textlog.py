"""Text systrace/atrace fallback for block_rq_* events (design 3.9).

trace_processor's systrace text parser emits only scheduling events, so a
text log loses all block IO even though the lines are present.  This module
streams the log, extracts block_rq_insert/issue/complete (atrace positional
and Perfetto key=value formats), resolves thread ids against the
trace_processor thread table (synthesizing missing threads), and replays
``block_rq_pars_enhanced.py``'s original algorithm so the HTML can show the
script's own numbers next to the corrected model numbers.

Only text inputs trigger this module; binary traces are untouched.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
import pandas as pd

INSERT, ISSUE, COMPLETE = 0, 1, 2
_SNIFF = 8192

_INSERT_RE = re.compile(r"^block_rq_insert\b")
_ISSUE_RE = re.compile(r"^block_rq_issue\b")
_COMPLETE_RE = re.compile(r"^block_rq_complete\b")

# atrace/systrace line prefix: "  task-123    (  123) [003] d.h1.  1.234567: ..."
# tgid may be dashes for <idle>/irq context; the timestamp may have no space
# before the event colon.
_PREFIX_RE = re.compile(
    r"^(?P<task>.*?)-(?P<tid>\d+)\s+\(\s*(?P<tgid>-+|\d*)\s*\)\s+"
    r"\[(?P<cpu>\d+)\]\s+\S+\s+(?P<ts>\d+(?:\.\d+)?):\s+"
    r"(?P<ev>block_rq_\w+):")

_KV_DEV_RE = re.compile(r"\bdev=([0-9]+(?:[:,][0-9]+)?)")
_KV_SECTOR_RE = re.compile(r"\bsector=(-?[0-9]+)")
_KV_NR_RE = re.compile(r"\bnr_sector=([0-9]+)")
_KV_RWBS_RE = re.compile(r"\brwbs=([A-Za-z]+)")
_KV_COMM_RE = re.compile(r'\bcomm=(?:"([^"]*)"|(\S+))')

_TEXT_MARKERS = ("TRACE:", "# tracer", "tracing_mark_write", "block_rq_")


@dataclass
class BlockRow:
    """One block_rq_* line, in file order."""
    ts: int                 # ns
    kind: int               # INSERT / ISSUE / COMPLETE
    dev: int                # (major << 8) | minor
    sector: int
    nr: int                 # sectors
    rwbs: str
    comm: str               # script's comm key (raw, may have padding)
    tid: int                # -1 when the line has no atrace prefix
    tgid: int               # -1 when unknown
    task: str = ""          # atrace task prefix, model fallback name


@dataclass
class TextBlockEvents:
    rows: List[BlockRow] = field(default_factory=list)
    t_min: int = 0
    t_max: int = 0
    lines: int = 0          # lines containing ": block_rq_"
    bad: int = 0            # candidate lines that could not be parsed

    @property
    def has_block(self) -> bool:
        return bool(self.rows)


@dataclass
class Attached:
    insert: pd.DataFrame
    issue: pd.DataFrame
    complete: pd.DataFrame
    synth_rows: List[dict] = field(default_factory=list)
    n_synth: int = 0
    n_tid_missing: int = 0


def looks_like_text(path: str) -> bool:
    """Cheap sniff: decodable text without NUL bytes and with trace markers."""
    try:
        with open(path, "rb") as f:
            head = f.read(_SNIFF)
    except OSError:
        return False
    if not head or head.startswith(b"\x1f\x8b") or b"\x00" in head:
        return False
    text = head.decode("utf-8", "ignore")
    return any(m in text for m in _TEXT_MARKERS)


def _dev_int(raw: str) -> int:
    """major,minor text -> Linux new_encode_dev (matches trace_processor).

    Minor numbers above 255 (many loop devices are 7,304 etc.) must use the
    split encoding; a plain (major << 8) | minor would collide with other
    devices and mis-classify the major.
    """
    s = raw.strip().strip('"').rstrip(",")
    if not s:
        raise ValueError("empty dev")
    if "," in s:
        a, b = s.split(",", 1)
        major, minor = int(a), int(b)
    elif ":" in s:
        a, b = s.split(":", 1)
        major, minor = int(a), int(b)
    else:
        return int(s)
    return (minor & 0xFF) | (major << 8) | ((minor & ~0xFF) << 12)


def _timestamp(line: str, cut: int) -> Optional[int]:
    """Timestamp (ns) of the token immediately before ``: block_rq_``."""
    k = line.rfind(" ", 0, cut)
    tok = line[k + 1:cut].strip()
    if tok:
        try:
            return int(round(float(tok) * 1e9))
        except ValueError:
            pass
    m = re.search(r"(\d+(?:\.\d+)?)\s*$", line[:cut])
    if not m:
        return None
    return int(round(float(m.group(1)) * 1e9))


def _prefix(line: str) -> Tuple[int, int, str]:
    m = _PREFIX_RE.match(line)
    if not m:
        return -1, -1, ""
    task = m.group("task").strip()
    tid = int(m.group("tid"))
    g = m.group("tgid")
    tgid = int(g) if g and g.isdigit() else -1
    return tid, tgid, task


def _comm_from_line(line: str) -> str:
    lb = line.rfind("[")
    rb = line.rfind("]")
    if lb >= 0 and rb > lb:
        return line[lb + 1:rb]
    return ""


def _parse_kv(rest: str) -> Optional[dict]:
    mdev = _KV_DEV_RE.search(rest)
    if not mdev:
        return None
    msec = _KV_SECTOR_RE.search(rest)
    if not msec:
        return None
    mnr = _KV_NR_RE.search(rest)
    mrw = _KV_RWBS_RE.search(rest)
    mcom = _KV_COMM_RE.search(rest)
    return {
        "dev": _dev_int(mdev.group(1)),
        "sector": int(msec.group(1)),
        "nr": int(mnr.group(1)) if mnr else 0,
        "rwbs": mrw.group(1) if mrw else "",
        "comm": (mcom.group(1) or mcom.group(2) or "") if mcom else "",
    }


def _parse_positional(rest: str) -> Optional[dict]:
    parts = rest.split()
    if len(parts) < 4:
        return None
    try:
        pi = parts.index("+")
    except ValueError:
        return None
    if pi < 1 or pi + 1 >= len(parts):
        return None
    try:
        return {
            "dev": _dev_int(parts[0]),
            "rwbs": parts[1],
            "sector": int(parts[pi - 1].rstrip(",")),
            "nr": int(parts[pi + 1].rstrip(",")),
            "comm": "",
        }
    except ValueError:
        return None


def parse_block_events(path: str) -> TextBlockEvents:
    """Stream the text log and collect block_rq_* rows in file order."""
    ev = TextBlockEvents()
    with open(path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            i = line.find(": block_rq_")
            if i < 0:
                continue
            j = line.find(":", i + 2)
            if j < 0:
                continue
            ev.lines += 1
            name = line[i + 2:j].strip()
            if _INSERT_RE.match(name):
                kind = INSERT
            elif _ISSUE_RE.match(name):
                kind = ISSUE
            elif _COMPLETE_RE.match(name):
                kind = COMPLETE
            else:
                ev.bad += 1
                continue
            ts = _timestamp(line, i)
            if ts is None:
                ev.bad += 1
                continue
            rest = line[j + 1:]
            fields = _parse_kv(rest) if (
                "dev=" in rest or "sector=" in rest) else _parse_positional(rest)
            if fields is None:
                ev.bad += 1
                continue
            tid, tgid, task = _prefix(line)
            comm = fields["comm"] or _comm_from_line(line) or "unknown"
            ev.rows.append(BlockRow(
                ts=ts, kind=kind, dev=fields["dev"], sector=fields["sector"],
                nr=fields["nr"], rwbs=fields["rwbs"], comm=comm,
                tid=tid, tgid=tgid, task=task))
            if not ev.t_min or ts < ev.t_min:
                ev.t_min = ts
            if ts > ev.t_max:
                ev.t_max = ts
    return ev


# --------------------------------------------------------------- attach

def _thread_candidates(threads: pd.DataFrame,
                       thread_ranges: pd.DataFrame) -> Dict[int, list]:
    """tid -> [(utid, ts_min, ts_max, name)] from the TP thread table."""
    if not len(threads):
        return {}
    th = threads.copy()
    if len(thread_ranges):
        th = th.merge(thread_ranges, on="utid", how="left")
    else:
        th["ts_min"] = -np.inf
        th["ts_max"] = np.inf
    th["ts_min"] = th["ts_min"].fillna(-np.inf)
    th["ts_max"] = th["ts_max"].fillna(np.inf)
    out: Dict[int, list] = {}
    for r in th.dropna(subset=["tid"]).itertuples(index=False):
        name = r.thread_name
        if name is None or (isinstance(name, float) and np.isnan(name)):
            name = ""
        out.setdefault(int(r.tid), []).append(
            (int(r.utid), float(r.ts_min), float(r.ts_max), str(name)))
    return out


def _pick(cands: list, ts: int, comm: str) -> int:
    inside = [c for c in cands if c[1] <= ts <= c[2]]
    pool = inside or cands
    name_hits = [c for c in pool
                 if c[3] and (c[3] == comm or c[3].startswith(comm)
                              or comm.startswith(c[3]))]
    if name_hits:
        return name_hits[0][0]
    return max(pool, key=lambda c: c[1])[0]


def attach_utids(ev: TextBlockEvents, threads: pd.DataFrame,
                 thread_ranges: pd.DataFrame) -> Attached:
    """Resolve utids (synthesizing missing threads) and build the 3 frames."""
    cands = _thread_candidates(threads, thread_ranges)

    # process identity of known threads, for reusing an existing upid
    pid_upid: Dict[int, Tuple[int, str]] = {}
    if len(threads):
        for r in threads.itertuples(index=False):
            if pd.isna(r.pid) or pd.isna(r.upid):
                continue
            pname = r.process_name
            if pname is None or (isinstance(pname, float) and np.isnan(pname)):
                pname = ""
            pid_upid.setdefault(int(r.pid), (int(r.upid), str(pname)))

    max_utid = int(threads["utid"].dropna().max()) if len(threads) else -1
    upids = threads["upid"].dropna() if len(threads) else pd.Series(dtype=float)
    max_upid = int(upids.max()) if len(upids) else -1
    next_utid = max_utid + 1
    next_upid = max_upid + 1
    synth_rows: List[dict] = []
    synth_by_key: Dict[object, int] = {}
    synth_proc: Dict[int, Tuple[int, str]] = {}   # tgid -> (upid, name)
    n_synth = 0
    n_tid_missing = 0

    def synth_utid(tid: int, tgid: int, comm: str) -> int:
        nonlocal next_utid, next_upid, n_synth
        key = tid if tid >= 0 else ("comm", comm)
        u = synth_by_key.get(key)
        if u is not None:
            return u
        u = next_utid
        next_utid += 1
        n_synth += 1
        if tgid >= 0 and tgid in pid_upid:
            upid, pname = pid_upid[tgid]
        elif tgid >= 0 and tgid in synth_proc:
            upid, pname = synth_proc[tgid]
        else:
            upid = next_upid
            next_upid += 1
            pname = comm or "unknown"
            if tgid >= 0:
                synth_proc[tgid] = (upid, pname)
        synth_by_key[key] = u
        synth_rows.append({
            "utid": u, "tid": tid if tid >= 0 else -1,
            "thread_name": comm or "unknown",
            "upid": upid,
            "pid": tgid if tgid >= 0 else (tid if tid >= 0 else -1),
            "process_name": pname, "parent_pid": -1,
        })
        return u

    def resolve(r: BlockRow) -> int:
        nonlocal n_tid_missing
        name = (r.comm if r.comm != "unknown" else r.task).strip()
        if r.tid >= 0 and r.tid in cands:
            return _pick(cands[r.tid], r.ts, name)
        if r.tid < 0:
            n_tid_missing += 1
        return synth_utid(r.tid, r.tgid, name)

    ins, iss, cmp_ = [], [], []
    ins_cols = ["ts", "utid", "dev", "sector", "nr_sector", "bytes", "rwbs"]
    cmp_cols = ["ts", "dev", "sector", "nr_sector", "rwbs", "error"]
    for r in ev.rows:
        if r.kind == COMPLETE:
            cmp_.append((r.ts, r.dev, r.sector, r.nr, r.rwbs, 0))
        elif r.kind == INSERT:
            ins.append((r.ts, resolve(r), r.dev, r.sector, r.nr,
                        r.nr * 512, r.rwbs))
        else:
            iss.append((r.ts, resolve(r), r.dev, r.sector, r.nr,
                        r.nr * 512, r.rwbs))
    insert = pd.DataFrame(ins, columns=ins_cols)
    issue = pd.DataFrame(iss, columns=ins_cols)
    complete = pd.DataFrame(cmp_, columns=cmp_cols)
    return Attached(insert=insert, issue=issue, complete=complete,
                    synth_rows=synth_rows, n_synth=n_synth,
                    n_tid_missing=n_tid_missing)


# ---------------------------------------------------------- script replay

def _stage(vals: List[float]) -> Optional[dict]:
    if not vals:
        return None
    n = len(vals)
    return {
        "n": n,
        "avg_ms": sum(vals) / n,
        "min_ms": min(vals),
        "max_ms": max(vals),
        "lt1": 100.0 * sum(1 for v in vals if v < 1) / n,
        "lt3": 100.0 * sum(1 for v in vals if v < 3) / n,
        "lt5": 100.0 * sum(1 for v in vals if v < 5) / n,
        "ge10": 100.0 * sum(1 for v in vals if v >= 10) / n,
        "ge25": sum(1 for v in vals if v >= 25),
    }


def build_script_report(rows: Sequence[BlockRow]) -> Optional[dict]:
    """Replay block_rq_pars_enhanced.py's exact algorithm on text events.

    Mirrors the script's key handling: (dev, sector) dict overwrite, insert
    and issue both add process bytes, the *last* issue before a complete is
    used for both phase diffs.  Values are the script's original ones; they
    are not the tool model's (FIFO) numbers.
    """
    if not rows:
        return None
    issue_events: Dict[Tuple[int, int], dict] = {}
    process_names: Dict[Tuple[int, int], str] = {}
    process_io: Dict[str, List[int]] = {}
    insert_to_issue: List[float] = []     # last issue - insert (ms)
    issue_to_complete: List[float] = []   # complete - last issue (ms)
    blocksum = 0
    time_start = None
    time_end = None

    for r in rows:
        if r.kind == COMPLETE:
            if "R" not in r.rwbs:
                continue
            key = (r.dev, r.sector)
            ev = issue_events.pop(key, None)
            if ev is None:
                continue
            issue_time = ev.get("issue_time")
            if issue_time is None:
                continue
            issue_to_complete.append((r.ts - issue_time) / 1e6)
            time_end = r.ts
            insert_time = ev.get("insert_time")
            if insert_time is not None:
                insert_to_issue.append((issue_time - insert_time) / 1e6)
        elif r.kind == INSERT:
            key = (r.dev, r.sector)
            if key not in issue_events:
                issue_events[key] = {"insert_time": r.ts, "issue_time": None}
            process_names[key] = r.comm
            op = (r.rwbs or "")[:1]
            io = process_io.setdefault(r.comm, [0, 0])
            if op == "R":
                io[0] += r.nr
            elif op == "W":
                io[1] += r.nr
        else:  # ISSUE
            key = (r.dev, r.sector)
            ev = issue_events.get(key)
            if ev is None:
                ev = {"insert_time": None, "issue_time": None}
                issue_events[key] = ev
            ev["issue_time"] = r.ts
            name = process_names.get(key)
            if not name or name == "unknown":
                name = r.comm
                process_names[key] = name
            op = (r.rwbs or "")[:1]
            io = process_io.setdefault(name, [0, 0])
            if op == "R":
                io[0] += r.nr
                blocksum += r.nr
            elif op == "W":
                io[1] += r.nr
            if time_start is None:
                time_start = r.ts

    span = ((time_end - time_start) / 1e9
            if time_start is not None and time_end is not None else 0.0)
    top = sorted(process_io.items(),
                 key=lambda kv: kv[1][0] + kv[1][1], reverse=True)[:5]
    return {
        "span_s": span,
        "read_n": len(issue_to_complete),
        "read_mb": blocksum / 2 / 1024,
        "ins_iss": _stage(insert_to_issue),
        "iss_cmp": _stage(issue_to_complete),
        "top": [{
            "name": name,
            "read_kb": r / 2,
            "write_kb": w / 2,
            "total_kb": (r + w) / 2,
        } for name, (r, w) in top],
    }
