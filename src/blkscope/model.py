"""Model layer: pure functions over the DataFrames produced by extract.py.

Implements design.md section 3: request pairing (3.1), submitter & priority
(3.2), rwbs category (3.3), device numbers & file association (3.4), slot
assignment (3.5), D-state & block function (3.6), data quality (3.7).

No trace_processor access here; everything works on DataFrames so it can be
tested with synthetic data.
"""

from __future__ import annotations

import heapq
import re
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

MAKE_MATCH_TOL_NS = 50_000_000   # 50 ms: bio_make -> request
BATCH_GAP_NS = 5_000_000         # 5 ms between consecutive fm_add of a batch
PC_FALLBACK_TOL_NS = 20_000_000  # 20 ms: pc_start fallback
TAG_MATCH_TOL_NS = 1_000_000     # 1 ms: mq_complete -> t_complete
D_BLK_SLACK_NS = 1_000_000       # blocked event within [D.ts, D.end + 1ms]
D_END_SLACK_NS = 50_000          # 50 us after D end for own-request wait
D_END_BACK_NS = 100_000          # 100 us before D end for io_wait guess
SLOT_INCOMPLETE_NS = 200_000_000  # incomplete request slot end: t_iss + 200ms

CAT_SYNC_READ, CAT_READAHEAD, CAT_META, CAT_WRITE = 0, 1, 2, 3
CAT_FLUSH, CAT_DISCARD, CAT_OTHER = 4, 5, 6

PRIO_RT, PRIO_IDLE, PRIO_UX, PRIO_FG_META = 1, 2, 4, 8
PRIO_SYNC, PRIO_META, PRIO_FUA = 16, 32, 64

_REQUEUE_RE = re.compile(r"requeue_reason:\s*(\d+)")
_USETAG_RE = re.compile(r"use_tag:\s*(\d+)")

_FKEY_SHIFT = 40  # file key = s_dev << 40 | ino


@dataclass
class Model:
    req: pd.DataFrame = field(default_factory=pd.DataFrame)
    files: pd.DataFrame = field(default_factory=pd.DataFrame)
    batches: pd.DataFrame = field(default_factory=pd.DataFrame)
    dst: pd.DataFrame = field(default_factory=pd.DataFrame)
    wait_off: np.ndarray = field(default_factory=lambda: np.zeros(1, np.int64))
    wait_req: np.ndarray = field(default_factory=lambda: np.empty(0, np.int64))
    wait_src: np.ndarray = field(default_factory=lambda: np.empty(0, np.int64))
    devs: pd.DataFrame = field(default_factory=pd.DataFrame)
    requeues: pd.DataFrame = field(default_factory=pd.DataFrame)
    quality: list = field(default_factory=list)
    device: dict = field(default_factory=dict)
    stats: dict = field(default_factory=dict)
    counters: dict = field(default_factory=dict)
    threads: pd.DataFrame = field(default_factory=pd.DataFrame)
    t_min: int = 0
    t_max: int = 0
    trace_start: int = 0


# ---------------------------------------------------------------- 3.3 rwbs

def parse_rwbs(rwbs: pd.Series) -> pd.DataFrame:
    """Split rwbs strings into op letter + flags.

    Leading 'F' = preflush; the op letter follows; trailing letters are flags
    (F=FUA, A=readahead, S=sync, M=meta, E=secure). A bare 'F' means a
    dataless flush -> op 'F'.
    """
    s = rwbs.fillna("").astype(str).str.upper()
    preflush = s.str.startswith("F")
    rest = s.str.slice(1).where(preflush, s)
    op = rest.str.slice(0, 1)
    op = op.where(rest.str.len() > 0, "F")
    flags = rest.str.slice(1)
    return pd.DataFrame({
        "op": op.to_numpy(),
        "preflush": preflush.to_numpy(),
        "fua": flags.str.contains("F").to_numpy(),
        "rahead": flags.str.contains("A").to_numpy(),
        "sync": flags.str.contains("S").to_numpy(),
        "meta": flags.str.contains("M").to_numpy(),
        "secure": flags.str.contains("E").to_numpy(),
    }, index=rwbs.index)


def categorize(p: pd.DataFrame) -> pd.Series:
    """IO category per design 3.3 (order: discard > flush > meta > readahead
    > sync_read > write > other). FUA writes stay 'write' with the fua flag."""
    cat = np.select(
        [
            p["op"] == "D",
            p["preflush"] | (p["op"] == "N") | (p["op"] == "F"),
            p["meta"],
            (p["op"] == "R") & p["rahead"],
            p["op"] == "R",
            p["op"] == "W",
        ],
        [CAT_DISCARD, CAT_FLUSH, CAT_META, CAT_READAHEAD, CAT_SYNC_READ,
         CAT_WRITE],
        default=CAT_OTHER,
    )
    return pd.Series(cat, index=p.index, dtype="int64")


def prio_flags(p: pd.DataFrame, cls, ux, fg_meta) -> pd.Series:
    """Bitmask per design 3.3."""
    cls_v = pd.Series(cls).fillna(-1).to_numpy()
    flags = np.zeros(len(p), np.int64)
    flags += np.where(cls_v == 1, PRIO_RT, 0)
    flags += np.where(cls_v == 3, PRIO_IDLE, 0)
    flags += np.where(pd.Series(ux).fillna(0).to_numpy() != 0, PRIO_UX, 0)
    flags += np.where(pd.Series(fg_meta).fillna(0).to_numpy() != 0,
                      PRIO_FG_META, 0)
    flags += np.where(p["sync"].to_numpy(), PRIO_SYNC, 0)
    flags += np.where(p["meta"].to_numpy(), PRIO_META, 0)
    flags += np.where(p["fua"].to_numpy(), PRIO_FUA, 0)
    return pd.Series(flags, index=p.index)


# ------------------------------------------------------------- 3.1 pairing

# request record layout inside the state machine
(_R_DEV, _R_SEC, _R_TINS, _R_INSU, _R_TISS0, _R_TISS, _R_ISSU,
 _R_TCMP, _R_ERR, _R_BYTES, _R_NR, _R_RWBS, _R_ICNT, _R_LOST) = range(14)


def pair_requests(rq_insert, rq_issue, rq_complete):
    """(dev, sector) keyed insert/issue/complete state machine (design 3.1).

    Returns (requests DataFrame, counters dict). Requests still open at the
    end of the trace are emitted with t_cmp = NaN (incomplete)."""
    nan = np.nan
    parts = []
    for kind, df in ((0, rq_insert), (1, rq_issue)):
        if len(df):
            parts.append(df[["ts", "utid", "dev", "sector", "nr_sector",
                             "bytes", "rwbs"]].assign(kind=kind, error=nan))
    if len(rq_complete):
        parts.append(
            rq_complete[["ts", "dev", "sector", "nr_sector", "rwbs", "error"]]
            .assign(kind=2, utid=nan, bytes=nan))
    cols = ["dev", "sector", "t_ins", "ins_utid", "t_iss0", "t_iss",
            "iss_utid", "t_cmp", "err", "bytes", "nr_sector", "rwbs",
            "issue_count", "cmp_lost"]
    counters = {"orphan_complete": 0, "dropped_insert": 0, "incomplete": 0,
                "cmp_lost": 0}
    if not parts:
        return pd.DataFrame(columns=cols), counters

    evs = pd.concat(parts, ignore_index=True)
    evs = evs.sort_values(["dev", "sector", "ts", "kind"], kind="mergesort")

    reqs = []
    cur = None
    pend = None      # inserted, not yet issued
    infl = []        # issued, not yet completed

    def fin_key():
        # Requests left open when the key ends: cmp_lost if any LATER event
        # exists on the key (a following in-flight request or a pending
        # insert); the very last open request is genuinely incomplete.
        nonlocal pend, infl
        if pend is not None:
            for r in infl:
                r[_R_LOST] = 1
            reqs.append(pend)
        else:
            for r in infl[:-1]:
                r[_R_LOST] = 1
        reqs.extend(infl)
        pend, infl = None, []

    for dev, sec, ts, kind, utid, err, b, nr, rw in evs[
            ["dev", "sector", "ts", "kind", "utid", "error", "bytes",
             "nr_sector", "rwbs"]].itertuples(index=False, name=None):
        key = (dev, sec)
        if key != cur:
            # first event of a new key: finalize leftovers of previous key
            fin_key()
            cur = key
        if kind == 0:
            if pend is not None:
                counters["dropped_insert"] += 1   # merged or lost
            pend = [dev, sec, ts, utid, nan, nan, nan, nan, nan, b, nr, rw,
                    0, 0]
        elif kind == 1:
            if nr == 0:
                # dataless issue (e.g. FFS flush): never a requeue; each
                # issue opens a new request and supersedes any open
                # dataless request on the same key (design 3.8 补充)
                for r in infl:
                    if r[_R_NR] == 0:
                        r[_R_LOST] = 1
                if pend is not None:
                    r, pend = pend, None
                    r[_R_TISS0] = ts
                    r[_R_TISS] = ts
                    r[_R_ISSU] = utid
                    r[_R_BYTES], r[_R_NR], r[_R_RWBS] = b, nr, rw
                    r[_R_ICNT] = 1
                else:
                    r = [dev, sec, nan, nan, ts, ts, utid, nan, nan,
                         b, nr, rw, 1, 0]
                infl.append(r)
            elif pend is not None:
                r, pend = pend, None
                r[_R_TISS0] = ts
                r[_R_TISS] = ts
                r[_R_ISSU] = utid
                r[_R_BYTES], r[_R_NR], r[_R_RWBS] = b, nr, rw
                r[_R_ICNT] = 1
                infl.append(r)
            elif infl and infl[-1][_R_NR] > 0:
                r = infl[-1]                      # re-issue after requeue
                r[_R_TISS] = ts
                r[_R_ICNT] += 1
                r[_R_BYTES], r[_R_NR], r[_R_RWBS] = b, nr, rw
            else:                                 # direct issue, no insert
                infl.append([dev, sec, nan, nan, ts, ts, utid, nan, nan,
                             b, nr, rw, 1, 0])
        else:
            if infl:
                r = infl.pop(0)
                r[_R_TCMP] = ts
                r[_R_ERR] = err
                r[_R_LOST] = 0
                reqs.append(r)
            else:
                counters["orphan_complete"] += 1
    fin_key()

    req = pd.DataFrame(reqs, columns=cols)
    # join keys must be int64 for merge_asof `by=` matching
    req["dev"] = req["dev"].astype("int64")
    req["sector"] = req["sector"].astype("int64")
    req["incomplete"] = req["t_cmp"].isna() & (req["cmp_lost"] == 0)
    counters["incomplete"] = int(req["incomplete"].sum())
    counters["cmp_lost"] = int((req["cmp_lost"] > 0).sum())
    return req, counters


# ------------------------------------------------- 3.2 submitter/priority

def match_make_requests(req: pd.DataFrame, bio_make: pd.DataFrame,
                        threads: pd.DataFrame, thread_ranges: pd.DataFrame):
    """Attach t_make + submitter + priority fields from bio_make (design 3.2).

    Match key: sector only (bio_make has no dev); the candidate must share the
    rwbs op letter and lie within 50 ms before t_ins (or t_iss0).
    """
    req = req.copy()
    for c, d in (("t_make", np.nan), ("mk_pid", np.nan), ("mk_utid", np.nan),
                 ("cls", np.nan), ("lvl", np.nan), ("ux", np.nan),
                 ("fg_meta", np.nan)):
        req[c] = d

    if len(req) and len(bio_make):
        req["t_key"] = req["t_ins"].fillna(req["t_iss0"]).astype("float64")
        # the request's submit thread (insert runs in the submitter's context;
        # direct-issue requests fall back to the issuing thread)
        req["iutid"] = req["ins_utid"].fillna(req["iss_utid"])
        mk = bio_make.dropna(subset=["ts", "sector", "utid"]).copy()
        mk["op"] = parse_rwbs(mk["rwbs"])["op"]
        mk = mk.rename(columns={"ts": "mk_ts", "utid": "iutid"})
        mk["mk_ts"] = mk["mk_ts"].astype("float64")  # match t_key dtype
        mk["iutid"] = mk["iutid"].astype("int64")
        # NOTE: the match is additionally constrained to the submit thread
        # (iutid). Design 3.2 only required sector+op+time, but on real data
        # that collides for hot shared sectors (another thread's make_event
        # wins by being nearer) — ~94% of matched requests got the wrong
        # submitter and hence a wrong file/D association thread.
        cand = req.dropna(subset=["t_key", "iutid"]).copy()
        cand["iutid"] = cand["iutid"].astype("int64")
        # joint (iutid, sector) group codes, consistent across both frames
        both = pd.concat([cand[["iutid", "sector"]],
                          mk[["iutid", "sector"]]], ignore_index=True)
        g = both.groupby(["iutid", "sector"], sort=True).ngroup().to_numpy()
        cand["gkey"], mk["gkey"] = g[:len(cand)], g[len(cand):]
        for op, lsub in cand.groupby("op"):
            rsub = mk[mk["op"] == op]
            if rsub.empty:
                continue
            m = pd.merge_asof(
                lsub.assign(lid=lsub.index).sort_values("t_key"),
                rsub.sort_values("mk_ts"),
                left_on="t_key", right_on="mk_ts", by="gkey",
                direction="backward", tolerance=MAKE_MATCH_TOL_NS,
                suffixes=("", "_mk"))
            hit = m[m["mk_ts"].notna()]
            req.loc[hit["lid"], "t_make"] = hit["mk_ts"].to_numpy()
            req.loc[hit["lid"], "mk_pid"] = hit["pid"].to_numpy()
            req.loc[hit["lid"], "mk_utid"] = hit["iutid"].to_numpy()
            req.loc[hit["lid"], "cls"] = hit["class"].to_numpy()
            req.loc[hit["lid"], "lvl"] = hit["priority"].to_numpy()
            req.loc[hit["lid"], "ux"] = (
                hit["is_ux_task"].fillna(0).astype("int64") |
                hit["is_ux_loop"].fillna(0).astype("int64")).to_numpy()
            req.loc[hit["lid"], "fg_meta"] = hit["FG_META"].to_numpy()
        req = req.drop(columns=["t_key", "iutid"])

    # submitter utid: tid -> utid via threads (range disambiguation),
    # then the make event's own utid, insert utid, issue utid.
    req["utid"] = np.nan
    if len(req) and req["mk_pid"].notna().any() and len(threads):
        th = threads.dropna(subset=["tid"]).copy()
        if len(thread_ranges):
            th = th.merge(thread_ranges, on="utid", how="left")
        th["ts_min"] = th["ts_min"].fillna(-np.inf) \
            if "ts_min" in th else -np.inf
        th["ts_max"] = th["ts_max"].fillna(np.inf) \
            if "ts_max" in th else np.inf
        by_tid = {tid: list(zip(g["utid"], g["ts_min"], g["ts_max"]))
                  for tid, g in th.groupby("tid")}
        single = {t: c[0][0] for t, c in by_tid.items() if len(c) == 1}
        pids = req["mk_pid"]
        utid = pids.map(single)
        multi = (utid.isna() & pids.notna() & pids.isin(by_tid)).fillna(False)
        for i in req.index[multi]:
            t_mk = req.at[i, "t_make"]
            cands = by_tid[pids.at[i]]
            hit = [u for u, lo, hi in cands if lo <= t_mk <= hi]
            utid.at[i] = hit[0] if hit else max(cands, key=lambda c: c[1])[0]
        req["utid"] = utid
    req["utid"] = req["utid"].fillna(req["mk_utid"]) \
        .fillna(req["ins_utid"]).fillna(req["iss_utid"])
    return req


def enrich_requests(req: pd.DataFrame, mq_complete: pd.DataFrame,
                    mq_requeue: pd.DataFrame, t_max: int):
    """req_tag from mq_complete; requeue count/reason + requeue event list
    (design 3.1 tail). Returns (req, requeues_df)."""
    req = req.copy()
    req["req_id"] = np.arange(len(req))
    req["tag"] = np.nan
    req["rq_n"] = (req["issue_count"].fillna(0) - 1).clip(lower=0) \
        .astype("int64")
    req["rq_reason"] = np.nan
    requeues = pd.DataFrame(columns=["ts", "req", "reason"])

    have_cmp = req["t_cmp"].notna()
    if len(mq_complete) and have_cmp.any():
        l = req[have_cmp].copy()
        l["t_cmp"] = l["t_cmp"].astype("int64")
        l["lid"] = l.index
        m = pd.merge_asof(
            l.sort_values("t_cmp"), mq_complete.sort_values("ts"),
            left_on="t_cmp", right_on="ts", by=["dev", "sector"],
            direction="nearest", tolerance=TAG_MATCH_TOL_NS,
            suffixes=("", "_mq"))
        hit = m["ts"].notna()
        req.loc[m.loc[hit, "lid"], "tag"] = m.loc[hit, "req_tag"].to_numpy()

    if len(mq_requeue) and len(req):
        rq = mq_requeue.copy()
        rq["reason"] = pd.to_numeric(
            rq["rq_log"].astype(str).str.extract(_REQUEUE_RE, expand=False),
            errors="coerce")
        # anchor on t_ins-or-t_iss0: mq-level requeues can fire between the
        # insert and the first issue of the same request
        base = req[["req_id", "dev", "sector", "t_ins", "t_iss0", "t_cmp"]] \
            .copy()
        base["t_start"] = base["t_ins"].fillna(base["t_iss0"])
        base = base.dropna(subset=["t_start"])
        base["t_start"] = base["t_start"].astype("int64")
        m = pd.merge_asof(
            rq.sort_values("ts"), base.sort_values("t_start"),
            left_on="ts", right_on="t_start", by=["dev", "sector"],
            direction="backward")
        ok = m["req_id"].notna() & (m["ts"] <= m["t_cmp"].fillna(t_max))
        m = m[ok]
        if len(m):
            cnt = m.groupby("req_id").size()
            req["rq_n"] = np.maximum(
                req["rq_n"],
                req["req_id"].map(cnt).fillna(0).astype("int64"))
            last = m.sort_values("ts").groupby("req_id").tail(1)
            req["rq_reason"] = req["req_id"].map(
                last.set_index("req_id")["reason"])
            requeues = m[["ts", "req_id", "reason"]] \
                .rename(columns={"req_id": "req"}).reset_index(drop=True)
    return req, requeues


# --------------------------------------------------- 3.4 dev/files/batches

def new_encode_dev(major, minor):
    """Linux new_encode_dev: (minor & 0xff) | (major << 8) | ((minor & ~0xff) << 12)."""
    major = np.asarray(major, dtype=np.int64)
    minor = np.asarray(minor, dtype=np.int64)
    return (minor & 0xFF) | (major << 8) | ((minor & ~0xFF) << 12)


def new_decode_dev(dev) -> str:
    """Inverse of new_encode_dev -> 'major:minor' for block event dev values."""
    dev = int(dev)
    major = (dev >> 8) & 0xFFF
    minor = (dev & 0xFF) | ((dev >> 12) & ~0xFF)
    return f"{major}:{minor}"


def build_files(pc_start: pd.DataFrame, fm_add: pd.DataFrame):
    """files table keyed (s_dev, ino); name = mode of pc_start.filebuf.

    Returns (files_df, key_to_file_id dict)."""
    names = {}
    keys = set()
    if len(pc_start):
        pc = pc_start.copy()
        pc["s_dev"] = new_encode_dev(pc["major_dev"], pc["minor_dev"])
        for (sd, ino), g in pc.groupby(["s_dev", "ino"]):
            sd, ino = int(sd), int(ino)
            keys.add((sd, ino))
            vals = g["filebuf"].dropna()
            if len(vals):
                names[(sd, ino)] = vals.mode().iloc[0]
    if len(fm_add):
        for sd, ino in fm_add[["s_dev", "i_ino"]].drop_duplicates() \
                .itertuples(index=False, name=None):
            keys.add((int(sd), int(ino)))
    rows = []
    for sd, ino in sorted(keys):
        name = names.get((sd, ino))
        is_meta = 0
        if name is None:
            if ino in (1, 2, 3):
                name, is_meta = "FS元数据", 1
            else:
                name = f"ino:{ino}"
        rows.append((sd, ino, name, is_meta))
    files = pd.DataFrame(rows, columns=["s_dev", "ino", "name", "is_meta"])
    key2id = {(r.s_dev, r.ino): i for i, r in files.iterrows()}
    return files, key2id


def build_batches(pc_start: pd.DataFrame, fm_add: pd.DataFrame,
                  key2id: dict):
    """Read batches (design 3.4): pc_start-anchored batches plus no-start
    batches of consecutive same-file fm_add within 5 ms.

    Returns (batches_df with batch_id column, fa_df with batch_id column)."""
    bcols = ["batch_id", "utid", "ts", "t_last_add", "file_id", "page_first",
             "page_count", "has_start"]
    if not len(fm_add):
        return pd.DataFrame(columns=bcols), fm_add.assign(batch_id=np.nan)

    fa = fm_add.sort_values(["utid", "ts"]).reset_index(drop=True)
    fa["fkey"] = fa["s_dev"] * (1 << _FKEY_SHIFT) + fa["i_ino"]
    fa["prev_ts"] = fa.groupby("utid")["ts"].shift()
    fa["prev_key"] = fa.groupby("utid")["fkey"].shift()
    fa["batch_id"] = np.nan
    fa["matched"] = False

    starts = pd.DataFrame(columns=["batch_id", "utid", "ts", "t_last_add",
                                   "fkey", "page_first", "page_count",
                                   "has_start"])
    if len(pc_start):
        pc = pc_start.sort_values("ts").reset_index(drop=True)
        pc["s_dev"] = new_encode_dev(pc["major_dev"], pc["minor_dev"])
        fas = fa.sort_values("ts")   # merge_asof needs a sorted 'on' key
        fas["lid"] = fas.index       # merge_asof resets the index
        m = pd.merge_asof(
            fas,
            pc[["ts", "utid", "s_dev", "ino"]]
            .rename(columns={"ts": "pc_ts", "s_dev": "pc_sdev",
                             "ino": "pc_ino"})
            .assign(pc_idx=lambda d: d.index),
            left_on="ts", right_on="pc_ts", by="utid", direction="backward")
        fa[["pc_ts", "pc_sdev", "pc_ino", "pc_idx"]] = \
            m.set_index("lid")[["pc_ts", "pc_sdev", "pc_ino", "pc_idx"]] \
                .reindex(fa.index)
        fa["matched"] = fa["pc_idx"].notna() & \
            (fa["pc_ino"] == fa["i_ino"]) & (fa["pc_sdev"] == fa["s_dev"])

        hit = fa[fa["matched"]].copy()
        # chain anchor: the first fm_add of a batch measures its gap from the
        # pc_start event itself (it is the batch's leading page)
        head = ~hit.duplicated(subset=["utid", "pc_idx"])
        hit["anchor"] = hit["prev_ts"].fillna(hit["pc_ts"])
        hit.loc[head, "anchor"] = hit.loc[head, "pc_ts"]
        brk = (hit["ts"] - hit["anchor"]) > BATCH_GAP_NS
        hit["sub"] = brk.groupby([hit["utid"], hit["pc_idx"]]).cumsum()
        hit["batch_code"] = hit.groupby(
            ["utid", "pc_idx", "sub"], sort=True).ngroup()
        fa.loc[hit.index, "batch_id"] = hit["batch_code"].astype(float)
        gb = hit.groupby("batch_code", sort=True)
        starts = gb.agg(utid=("utid", "first"), ts=("ts", "min"),
                        pc_ts=("pc_ts", "min"), sub=("sub", "min"),
                        t_last_add=("ts", "max"), fkey=("fkey", "first"),
                        page_first=("index", "min"),
                        page_count=("ts", "size")) \
            .rename_axis("batch_id").reset_index()
        # sub>0 sub-batches begin at their own first fm_add and carry
        # has_start=0; only the leading sub-batch starts at pc_start
        starts["has_start"] = np.where(starts["sub"] == 0,
                                       np.int64(1), np.int64(0))
        starts["ts"] = np.where(starts["sub"] == 0, starts["pc_ts"],
                                starts["ts"])

    # no-start batches: consecutive unmatched rows, same fkey, gap <= 5ms,
    # never continuing across a matched row.
    un = fa[~fa["matched"]].copy()
    prev_matched = fa.groupby("utid")["matched"].shift().fillna(False) \
        .astype(bool)
    brk = ((un["fkey"] != un["prev_key"]) |
           (un["ts"] - un["prev_ts"] > BATCH_GAP_NS) |
           prev_matched.loc[un.index])
    un["seg"] = brk.groupby(un["utid"]).cumsum()
    n0 = len(starts)
    un["batch_code"] = n0 + un.groupby(["utid", "seg"], sort=True).ngroup()
    fa.loc[un.index, "batch_id"] = un["batch_code"].astype(float)
    nostarts = un.groupby("batch_code", sort=True).agg(
        utid=("utid", "first"), ts=("ts", "min"), t_last_add=("ts", "max"),
        fkey=("fkey", "first"), page_first=("index", "min"),
        page_count=("ts", "size")).rename_axis("batch_id").reset_index()
    nostarts["has_start"] = np.int64(0)

    cols = ["batch_id", "utid", "ts", "t_last_add", "fkey", "page_first",
            "page_count", "has_start"]
    batches = pd.concat([starts, nostarts])[cols] \
        .sort_values("batch_id").reset_index(drop=True)
    for c in ("batch_id", "utid", "ts", "t_last_add", "fkey", "page_first",
              "page_count", "has_start"):
        batches[c] = batches[c].astype("int64")
    fkey2id = {(sd * (1 << _FKEY_SHIFT) + ino): fid
               for (sd, ino), fid in key2id.items()}
    batches["file_id"] = batches["fkey"].map(fkey2id)
    return batches[bcols], fa


def associate_files(req: pd.DataFrame, fa: pd.DataFrame,
                    pc_start: pd.DataFrame, key2id: dict):
    """Request -> file heuristic for read requests (design 3.4).

    fsrc: 1 = fm_add mode in (prev read submit, this submit]; 2 = nearest
    pc_start within 20 ms; 0 = unassociated; -1 = not a read request."""
    req = req.copy()
    req[["file", "foff", "flen", "batch"]] = np.nan
    req["fsrc"] = np.where(req["op"] == "R", 0, -1)
    reads = req[req["fsrc"] == 0].copy()
    if not len(reads):
        return req
    reads["t_sub"] = reads["t_make"].fillna(reads["t_ins"]) \
        .fillna(reads["t_iss0"])
    reads = reads.dropna(subset=["t_sub", "utid"]).copy()
    reads["utid"] = reads["utid"].astype("int64")
    reads["prev_sub"] = reads.sort_values("t_sub") \
        .groupby("utid")["t_sub"].shift()
    rsub = reads.sort_values("t_sub")[
        ["t_sub", "utid", "prev_sub"]].assign(req_idx=lambda d: d.index)
    rsub["t_sub"] = rsub["t_sub"].astype("int64")

    fkey2id = {(sd * (1 << _FKEY_SHIFT) + ino): fid
               for (sd, ino), fid in key2id.items()}
    if len(fa) and len(rsub):
        m = pd.merge_asof(
            fa.sort_values("ts"), rsub,
            left_on="ts", right_on="t_sub", by="utid", direction="forward")
        ok = m["req_idx"].notna() & (m["ts"] > m["prev_sub"].fillna(-np.inf))
        asg = m[ok]
        if len(asg):
            cnt = asg.groupby(["req_idx", "s_dev", "i_ino"]).agg(
                n=("ts", "size"), pmin=("index", "min"))
            # associated batch = the batch holding most of the group's pages
            bm = asg.groupby(["req_idx", "s_dev", "i_ino", "batch_id"]) \
                .size().rename("bn").reset_index()
            bm = bm.sort_values("bn", ascending=False) \
                .drop_duplicates(["req_idx", "s_dev", "i_ino"])
            cnt = cnt.join(bm.set_index(["req_idx", "s_dev", "i_ino"])
                           [["batch_id"]].rename(columns={"batch_id": "bmode"}))
            win = cnt.sort_values(["n", "s_dev"], ascending=[False, True])
            win = win[~win.index.get_level_values(0).duplicated()] \
                .reset_index()
            win["fid"] = (win["s_dev"] * (1 << _FKEY_SHIFT)
                          + win["i_ino"]).map(fkey2id)
            win = win[win["fid"].notna()]
            req.loc[win["req_idx"], "file"] = win["fid"].to_numpy()
            req.loc[win["req_idx"], "foff"] = \
                (win["pmin"].astype("int64") * 4096).to_numpy()
            req.loc[win["req_idx"], "flen"] = \
                (win["n"].astype("int64") * 4096).to_numpy()
            req.loc[win["req_idx"], "batch"] = win["bmode"].to_numpy()
            req.loc[win["req_idx"], "fsrc"] = 1

    # fallback: nearest pc_start on same thread within 20 ms before t_sub
    miss = req.index[req["fsrc"] == 0]
    if len(miss) and len(pc_start):
        pc = pc_start.sort_values("ts").reset_index(drop=True)
        pc["s_dev"] = new_encode_dev(pc["major_dev"], pc["minor_dev"])
        r = req.loc[miss].copy()
        r["t_sub"] = r["t_make"].fillna(r["t_ins"]).fillna(r["t_iss0"])
        rr = r.dropna(subset=["t_sub", "utid"]).copy()
        rr["utid"] = rr["utid"].astype("int64")
        rr["t_sub"] = rr["t_sub"].astype("int64")
        m = pd.merge_asof(
            rr.assign(lid=rr.index).sort_values("t_sub"),
            pc[["ts", "utid", "s_dev", "ino", "offset", "bytes"]]
            .rename(columns={"bytes": "pc_bytes"}),
            left_on="t_sub", right_on="ts", by="utid", direction="backward",
            tolerance=PC_FALLBACK_TOL_NS)
        hit = m[m["ts"].notna()].copy()
        hit["fid"] = (hit["s_dev"] * (1 << _FKEY_SHIFT)
                      + hit["ino"]).map(fkey2id)
        hit = hit[hit["fid"].notna()]
        req.loc[hit["lid"], "file"] = hit["fid"].to_numpy()
        req.loc[hit["lid"], "foff"] = hit["offset"].to_numpy()
        req.loc[hit["lid"], "flen"] = hit["pc_bytes"].to_numpy()
        req.loc[hit["lid"], "fsrc"] = 2
    return req


def build_file_hints(req: pd.DataFrame, files: pd.DataFrame,
                     threads: pd.DataFrame) -> pd.Series:
    """files.hint: process name owning the most associated READ bytes of
    this file (design 3.8); '' when none. Same basename often maps to many
    files, so the hint disambiguates (frontend: 'base.apk · com.xxx')."""
    hint = pd.Series("", index=files.index, dtype=object)
    if not (len(files) and len(req) and len(threads)):
        return hint
    rf = req[req["op"] == "R"].dropna(subset=["file", "utid"])
    if not len(rf):
        return hint
    pname = threads.dropna(subset=["utid"]).drop_duplicates("utid") \
        .set_index("utid")["process_name"].fillna("")
    proc = rf["utid"].astype("int64").map(pname).fillna("")
    gb = rf.groupby([rf["file"].astype("int64"), proc])["bytes"].sum()
    top = gb.groupby(level=0).idxmax()          # file_id -> (file_id, proc)
    best = pd.Series({int(fid): str(p[1]) for fid, p in top.items()})
    hint.loc[best.index] = best
    return hint


# ------------------------------------------------------------- 3.5 slots

def assign_slots(req: pd.DataFrame, t_max: int):
    """Greedy lowest-free-slot per dev over [t_iss (last issue),
    t_cmp | min(t_max, t_iss + 200ms)] (design 3.5/3.8: only the time a
    request is actually in the device occupies a lane).  cmp_lost
    requests are zero-length: they get a slot for the 1px marker but
    occupy no lane time."""
    slot = pd.Series(np.nan, index=req.index)
    lanes = {}
    g_in = req.dropna(subset=["t_iss"])
    if "cmp_lost" not in g_in.columns:      # synthetic frames may omit it
        g_in = g_in.assign(cmp_lost=0)
    for dev, g in g_in.groupby("dev"):
        busy = []          # heap of (end, slot)
        free = []          # heap of reusable slot ids
        n_slots = 0
        for idx, start, end, lost in g.sort_values("t_iss")[
                ["t_iss", "t_cmp", "cmp_lost"]].itertuples(name=None):
            end = start if lost else (min(t_max, start + SLOT_INCOMPLETE_NS)
                                      if pd.isna(end) else end)
            while busy and busy[0][0] <= start:
                heapq.heappush(free, heapq.heappop(busy)[1])
            if free:
                s = heapq.heappop(free)
            else:
                s = n_slots
                n_slots += 1
            heapq.heappush(busy, (end, s))
            slot.at[idx] = s
        lanes[dev] = n_slots
    return slot, lanes


def parse_slot_limit(rq_log: pd.Series):
    """Max 'use_tag: N' over rq_log strings; None if absent."""
    if rq_log is None or not len(rq_log):
        return None
    v = rq_log.dropna().astype(str).str.extract(_USETAG_RE, expand=False)
    v = pd.to_numeric(v, errors="coerce").dropna()
    return int(v.max()) if len(v) else None


def slot_limits(mq_complete: pd.DataFrame, mq_requeue: pd.DataFrame) -> dict:
    """Per-dev slot_limit = max 'use_tag: N' of THAT dev's rq_log;
    devs with no mq events are simply absent (design 3.8: loop devices
    have no such logs -> null)."""
    frames = [df[["dev", "rq_log"]] for df in (mq_complete, mq_requeue)
              if len(df)]
    if not frames:
        return {}
    logs = pd.concat(frames, ignore_index=True).dropna(subset=["dev"])
    logs["use_tag"] = pd.to_numeric(
        logs["rq_log"].fillna("").astype(str)
        .str.extract(_USETAG_RE, expand=False), errors="coerce")
    lim = logs.groupby(logs["dev"].astype("int64"))["use_tag"].max()
    return {int(d): (int(l) if not pd.isna(l) else None)
            for d, l in lim.items()}


def dev_major(dev) -> int:
    """Major number of a new_encode_dev-encoded device."""
    return (int(dev) >> 8) & 0xFFF


def dev_kind(dev) -> str:
    """major 7 -> 'loop', major 0 -> 'other', else 'disk' (design 3.8)."""
    maj = dev_major(dev)
    if maj == 7:
        return "loop"
    if maj == 0:
        return "other"
    return "disk"


def proc_kernel_flag(threads: pd.DataFrame) -> dict:
    """upid -> 1 for kernel processes (pid 0/2 or parent pid 2, i.e.
    kthreadd and its children like kworkers); else 0."""
    out = {}
    if threads.empty or "upid" not in threads:
        return out
    up = threads.dropna(subset=["upid"]).drop_duplicates("upid")
    for _, r in up.iterrows():
        pid, ppid = r.get("pid"), r.get("parent_pid")
        kt = (pd.notna(pid) and int(pid) in (0, 2)) or \
             (pd.notna(ppid) and int(ppid) == 2)
        out[int(r["upid"])] = int(kt)
    return out


# ------------------------------------------------------ 3.6 dstate/blocked

def build_dstate(dstate: pd.DataFrame, blocked: pd.DataFrame,
                 req: pd.DataFrame, io_utids: set, threads: pd.DataFrame):
    """D-state segments of IO threads + block function + wait CSR
    (design 3.6). Returns (dst_df, wait_off, wait_req, wait_src)."""
    dcols = ["utid", "ts", "dur", "fn", "fn_ok", "iow"]
    empty = (pd.DataFrame(columns=dcols), np.zeros(1, np.int64),
             np.empty(0, np.int64), np.empty(0, np.int64))
    if not len(dstate) or not io_utids:
        return empty
    d = dstate[dstate["utid"].isin(io_utids)] \
        .sort_values(["utid", "ts"]).reset_index(drop=True)
    if not len(d):
        return empty
    d["end"] = d["ts"] + d["dur"]

    # block function: thread_state.blocked_function else sched_blocked_reason
    bf = d["blocked_function"].fillna("").astype(str)
    has_bf = bf.str.len() > 0
    d["fn"] = np.where(has_bf, bf, "")
    d["fn_ok"] = has_bf.astype("int64")
    d["iow"] = -1
    dd = d[~has_bf].copy()
    if len(dd) and len(blocked) and len(threads):
        tid_of = threads.dropna(subset=["tid"]).drop_duplicates("utid") \
            .set_index("utid")["tid"]
        dd["tid"] = dd["utid"].map(tid_of)
        dd["lid"] = dd.index
        blk = blocked.dropna(subset=["ts", "pid"]).sort_values("ts") \
            .rename(columns={"pid": "tid", "ts": "bts"})
        dd["q"] = dd["end"] + D_BLK_SLACK_NS
        dd["lid"] = dd.index
        m = pd.merge_asof(
            dd.dropna(subset=["tid"]).sort_values("q"),
            blk[["bts", "tid", "caller", "io_wait"]],
            left_on="q", right_on="bts", by="tid", direction="backward")
        hh = m[m["bts"].notna() & (m["bts"] >= m["ts"])]
        if len(hh):
            caller = hh["caller"]
            is_num = pd.to_numeric(caller, errors="coerce").notna()
            d.loc[hh["lid"], "fn"] = np.where(
                is_num, "caller#" + caller.astype(str), caller.astype(str))
            d.loc[hh["lid"], "fn_ok"] = np.where(is_num, 0, 1)
            d.loc[hh["lid"], "iow"] = \
                hh["io_wait"].fillna(-1).astype("int64").to_numpy()

    # wait CSR: src1 = own-thread requests completing in [D.ts, D.end+50us]
    pairs = {}
    rq = req.dropna(subset=["t_cmp", "utid"]).copy()
    rq["utid"] = rq["utid"].astype("int64")
    rq["t_cmp"] = rq["t_cmp"].astype("int64")
    if len(rq):
        dr = d[["ts", "utid", "end"]].assign(d_idx=np.arange(len(d))) \
            .sort_values("ts")
        m = pd.merge_asof(
            rq.sort_values("t_cmp"), dr,
            left_on="t_cmp", right_on="ts", by="utid", direction="backward")
        ok = m["d_idx"].notna() & (m["t_cmp"] <= m["end"] + D_END_SLACK_NS)
        for di, ri in m.loc[ok, ["d_idx", "req_id"]].itertuples(index=False):
            pairs.setdefault(int(di), []).append((int(ri), 1))
    # src2 = io_wait==1 segs w/o src1: nearest request completing <= D.end
    d2 = d[(d["iow"] == 1) & ~d.index.isin(pairs)].copy()
    d2["d_idx"] = d2.index
    rq_any = req.dropna(subset=["t_cmp"]).copy()
    rq_any["t_cmp"] = rq_any["t_cmp"].astype("int64")
    if len(d2) and len(rq_any):
        m = pd.merge_asof(
            d2.sort_values("end"),
            rq_any[["t_cmp", "req_id"]].sort_values("t_cmp"),
            left_on="end", right_on="t_cmp", direction="backward",
            tolerance=D_END_BACK_NS)
        ok = m["req_id"].notna()
        for di, ri in m.loc[ok, ["d_idx", "req_id"]].itertuples(index=False):
            pairs.setdefault(int(di), []).append((int(ri), 2))

    wait_req, wait_src, offs = [], [], [0]
    for di in range(len(d)):
        for ri, s in sorted(pairs.get(di, [])):
            wait_req.append(ri)
            wait_src.append(s)
        offs.append(len(wait_req))
    dst = d[["utid", "ts", "dur", "fn", "fn_ok", "iow"]].copy()
    return (dst, np.asarray(offs, np.int64),
            np.asarray(wait_req, np.int64), np.asarray(wait_src, np.int64))


# --------------------------------------------------------- 3.7 quality

def build_quality(ex, counters: dict, t_min: int, t_max: int) -> list:
    q = []

    def warn(code, msg):
        q.append({"level": "warn", "code": code, "msg": msg})

    def info(code, msg):
        q.append({"level": "info", "code": code, "msg": msg})

    stats = ex.stats
    if stats.get("traced_buf_write_wrap_count", 0) > 0:
        warn("ring_wrap",
             f"RING_BUFFER 已回绕，早期数据被覆盖；有效时间窗约 "
             f"{t_min / 1e9:.2f}s ~ {t_max / 1e9:.2f}s"
             f"（{(t_max - t_min) / 1e9:.1f}s）")
    if not (len(ex.rq_insert) or len(ex.rq_issue) or len(ex.rq_complete)):
        warn("no_block_events",
             "未解析到块设备 IO 事件（block_rq_*），请确认抓取配置包含 "
             "block ftrace 事件")
    if not len(ex.bio_make):
        warn("no_make_request",
             "缺少传音定制事件 block_rq_mq_make_request：IO 优先级与提交者"
             "信息不可用（已按 insert 线程降级归属）")
    if not len(ex.pc_start) or not len(ex.fm_add):
        warn("no_pagecache",
             "缺少传音定制事件 tran_fs_pagecache_start / "
             "mm_filemap_add_to_page_cache：文件关联不可用")
    bf_ok = len(ex.dstate) and bool(
        ex.dstate["blocked_function"].fillna("").astype(str).str.len()
        .gt(0).any())
    caller_num = len(ex.blocked) and bool(
        pd.to_numeric(ex.blocked["caller"], errors="coerce").notna().all())
    if len(ex.dstate) and not bf_ok and caller_num:
        warn("block_fn_unresolved",
             "block function 未能符号化（sched_blocked_reason.caller 为内部 "
             "id，显示为 caller#<id>）：可能是环形缓冲回绕导致内核符号表"
             "丢失；建议增大 buffer 或使用 DISCARD 模式重抓，并确保保留 "
             "kernel symbols")
    if counters.get("orphan_complete"):
        info("orphan_complete",
             f"{counters['orphan_complete']} 个 complete 事件找不到配对的 "
             f"issue/insert（请求在有效窗口外开始或事件丢失）")
    if counters.get("incomplete"):
        info("incomplete",
             f"{counters['incomplete']} 个请求到 trace 结束未完成，"
             f"将绘制到窗口末尾")
    if counters.get("cmp_lost"):
        info("cmp_lost",
             f"{counters['cmp_lost']} 个请求没有 complete 事件"
             f"（多为 flush，内核未上报 block_rq_complete），"
             f"仅标注下发时刻")
    if counters.get("dropped_insert"):
        info("dropped_insert",
             f"{counters['dropped_insert']} 个 insert 请求在下发前"
             f"被合并或丢失")
    ov = stats.get("ftrace_cpu_overrun_end", 0) - \
        stats.get("ftrace_cpu_overrun_begin", 0)
    if ov > 0:
        warn("ftrace_overrun",
             f"录制期间丢失 {ov} 个 ftrace 事件（CPU overrun），"
             f"部分 IO 事件可能缺失")
    return q


# ----------------------------------------------------------- orchestrator

def build_model(ex) -> Model:
    """extract.Extracted -> Model (design.md section 3)."""
    m = Model()
    m.device, m.stats = ex.device, ex.stats
    m.threads = ex.threads
    m.t_min, m.t_max = ex.t_min, ex.t_max
    m.trace_start = getattr(ex, "trace_start", 0)

    req, counters = pair_requests(ex.rq_insert, ex.rq_issue, ex.rq_complete)
    m.counters = counters
    if len(req):
        parsed = parse_rwbs(req["rwbs"])
        req["op"] = parsed["op"]
        req["cat"] = categorize(parsed)
        req = match_make_requests(req, ex.bio_make, ex.threads,
                                  ex.thread_ranges)
        req["prio"] = prio_flags(parsed.reindex(req.index), req["cls"],
                                 req["ux"], req["fg_meta"])
        req["q_ns"] = req["t_iss0"] - req["t_ins"]
        req["svc_ns"] = req["t_cmp"] - req["t_iss"]
        t0 = req["t_make"].fillna(req["t_ins"]).fillna(req["t_iss0"])
        req["total_ns"] = req["t_cmp"] - t0
        req, m.requeues = enrich_requests(req, ex.mq_complete,
                                          ex.mq_requeue, ex.t_max)
        slot, lanes = assign_slots(req, ex.t_max)
        req["slot"] = slot
        req["lanes"] = req["dev"].map(lanes).fillna(0).astype("int64")
    else:
        req = req.assign(cat=pd.Series(dtype="int64"),
                         prio=pd.Series(dtype="int64"),
                         req_id=pd.Series(dtype="int64"),
                         op=pd.Series(dtype="object"))

    m.files, key2id = build_files(ex.pc_start, ex.fm_add)
    m.batches, fa = build_batches(ex.pc_start, ex.fm_add, key2id)
    if len(req):
        req = associate_files(req, fa, ex.pc_start, key2id)
    m.files["hint"] = build_file_hints(req, m.files, ex.threads)
    # a batch's slice extends to the t_cmp of associated requests
    if len(m.batches) and len(req) and req["batch"].notna().any():
        rb = req.dropna(subset=["batch", "t_cmp"])
        bend = rb.groupby(rb["batch"].astype("int64"))["t_cmp"].max()
        m.batches["t_last_add"] = np.maximum(
            m.batches["t_last_add"],
            m.batches["batch_id"].map(bend).fillna(-np.inf))

    io_utids = set(req["utid"].dropna().astype("int64")) if len(req) else set()
    if len(m.batches):
        io_utids |= set(m.batches["utid"].dropna().astype("int64"))
    (m.dst, m.wait_off, m.wait_req, m.wait_src) = build_dstate(
        ex.dstate, ex.blocked, req, io_utids, ex.threads)

    # per-dev summary: lanes + kind + per-dev slot_limit (design 3.8)
    lim_by_dev = slot_limits(ex.mq_complete, ex.mq_requeue)
    rows = [{"dev": int(dev), "name": new_decode_dev(dev),
             "kind": dev_kind(dev),
             "lanes": int(req.loc[req["dev"] == dev, "lanes"].max())
             if "lanes" in req else 0,
             "slot_limit": lim_by_dev.get(int(dev))}
            for dev in sorted(req["dev"].dropna().unique())] if len(req) \
        else []
    m.devs = pd.DataFrame(
        rows, columns=["dev", "name", "kind", "lanes", "slot_limit"])

    m.quality = build_quality(ex, counters, ex.t_min, ex.t_max)
    for c in ("t_make", "mk_pid", "cls", "lvl", "ux", "fg_meta", "utid",
              "prio", "q_ns", "svc_ns", "total_ns", "tag", "rq_n",
              "rq_reason", "slot", "lanes", "op", "cat", "file", "foff",
              "flen", "fsrc", "batch", "req_id", "incomplete"):
        if c not in req:
            req[c] = np.nan
    m.req = req
    return m
