"""model.py unit tests with synthetic event DataFrames (no trace needed)."""

import numpy as np
import pandas as pd
import pytest

from iotrace.model import (
    BATCH_GAP_NS, CAT_DISCARD, CAT_FLUSH, CAT_META, CAT_READAHEAD,
    CAT_SYNC_READ, CAT_WRITE, PRIO_FG_META, PRIO_FUA, PRIO_IDLE, PRIO_META,
    PRIO_RT, PRIO_SYNC, PRIO_UX, assign_slots, associate_files,
    build_batches, build_dstate, build_file_hints, build_files,
    categorize, dev_kind, enrich_requests, match_make_requests,
    new_encode_dev, pair_requests, parse_rwbs, parse_slot_limit,
    prio_flags, slot_limits,
)


def rq_ins(rows):
    cols = ["ts", "utid", "dev", "sector", "nr_sector", "bytes", "rwbs"]
    return pd.DataFrame(rows, columns=cols)


def rq_iss(rows):
    return rq_ins(rows)


def rq_cmp(rows):
    cols = ["ts", "dev", "sector", "nr_sector", "rwbs", "error"]
    return pd.DataFrame(rows, columns=cols)


# ------------------------------------------------- make_request matching

def test_match_make_same_thread_only():
    # sector 8 is made by BOTH threads; the request on thread 5 must bind the
    # thread-5 make even though thread 9's make is nearer in time
    ins = rq_ins([(1000, 5, 2080, 8, 8, 4096, "R")])
    iss = rq_iss([(1100, 5, 2080, 8, 8, 4096, "R")])
    cmp_ = rq_cmp([(1200, 2080, 8, 8, "R", 0)])
    req, _ = pair_requests(ins, iss, cmp_)
    req["op"] = parse_rwbs(req["rwbs"])["op"]
    mk = pd.DataFrame(
        [(900, 5, 55, 8, "R", 2, 110, 1, 0, 0, 100),
         (995, 9, 99, 8, "R", 1, 111, 0, 0, 1, 200)],
        columns=["ts", "utid", "pid", "sector", "rwbs", "class", "priority",
                 "is_ux_task", "is_ux_loop", "FG_META", "bi_ioprio"])
    threads = pd.DataFrame(
        [(5, 55, "a", 1, 55, "p"), (9, 99, "b", 1, 99, "p")],
        columns=["utid", "tid", "thread_name", "upid", "pid",
                 "process_name"])
    req = match_make_requests(req, mk, threads, pd.DataFrame())
    r = req.iloc[0]
    assert r.mk_pid == 55 and r.cls == 2 and r.utid == 5


# ------------------------------------------------------------- rwbs / prio


# ---------------------------------------------------------------- pairing

def test_pair_normal():
    ins = rq_ins([(100, 7, 2080, 8, 8, 4096, "R")])
    iss = rq_iss([(150, 7, 2080, 8, 8, 4096, "R")])
    cmp_ = rq_cmp([(200, 2080, 8, 8, "R", 0)])
    req, cnt = pair_requests(ins, iss, cmp_)
    assert len(req) == 1
    r = req.iloc[0]
    assert r.t_ins == 100 and r.t_iss0 == 150 and r.t_iss == 150
    assert r.t_cmp == 200 and r.issue_count == 1 and not r.incomplete
    assert cnt["orphan_complete"] == 0


def test_pair_requeue_keeps_first_issue_and_last_bytes():
    ins = rq_ins([(100, 7, 2080, 8, 8, 4096, "R")])
    iss = rq_iss([(150, 7, 2080, 8, 8, 4096, "R"),
                  (180, 7, 2080, 8, 16, 8192, "R")])
    cmp_ = rq_cmp([(200, 2080, 8, 16, "R", 0)])
    req, cnt = pair_requests(ins, iss, cmp_)
    r = req.iloc[0]
    assert r.issue_count == 2
    assert r.t_iss0 == 150          # first issue kept
    assert r.t_iss == 180           # last issue
    assert r.bytes == 8192          # bytes of last issue
    assert r.nr_sector == 16
    assert r.t_cmp == 200


def test_pair_direct_issue_no_insert():
    iss = rq_iss([(150, 7, 2080, 8, 8, 4096, "W")])
    cmp_ = rq_cmp([(200, 2080, 8, 8, "W", 0)])
    req, _ = pair_requests(pd.DataFrame(), iss, cmp_)
    r = req.iloc[0]
    assert pd.isna(r.t_ins) and r.t_iss0 == 150 and r.t_cmp == 200


def test_pair_orphan_complete():
    cmp_ = rq_cmp([(200, 2080, 8, 8, "R", 0)])
    req, cnt = pair_requests(pd.DataFrame(), pd.DataFrame(), cmp_)
    assert len(req) == 0 and cnt["orphan_complete"] == 1


def test_pair_incomplete_at_end():
    ins = rq_ins([(100, 7, 2080, 8, 8, 4096, "R")])
    iss = rq_iss([(150, 7, 2080, 8, 8, 4096, "R")])
    req, cnt = pair_requests(ins, iss, rq_cmp([]))
    r = req.iloc[0]
    assert pd.isna(r.t_cmp) and r.incomplete and cnt["incomplete"] == 1


def test_pair_two_concurrent_different_sectors():
    ins = rq_ins([(100, 7, 2080, 8, 8, 4096, "R"),
                  (110, 7, 2080, 16, 8, 4096, "R")])
    iss = rq_iss([(150, 7, 2080, 8, 8, 4096, "R"),
                  (160, 7, 2080, 16, 8, 4096, "R")])
    cmp_ = rq_cmp([(250, 2080, 8, 8, "R", 0), (260, 2080, 16, 8, "R", 0)])
    req, _ = pair_requests(ins, iss, cmp_)
    assert len(req) == 2 and req.t_cmp.notna().all()
    assert set(req.sector) == {8, 16}


def test_pair_dropped_insert():
    ins = rq_ins([(100, 7, 2080, 8, 8, 4096, "R"),
                  (120, 7, 2080, 8, 8, 4096, "R")])  # second replaces first
    iss = rq_iss([(150, 7, 2080, 8, 8, 4096, "R")])
    cmp_ = rq_cmp([(200, 2080, 8, 8, "R", 0)])
    req, cnt = pair_requests(ins, iss, cmp_)
    assert cnt["dropped_insert"] == 1
    assert req.iloc[0].t_ins == 120


# ------------------------------------------------------------- rwbs / prio

@pytest.mark.parametrize("rwbs,cat", [
    ("RAS", CAT_READAHEAD), ("RA", CAT_READAHEAD),
    ("RS", CAT_SYNC_READ), ("R", CAT_SYNC_READ),
    ("RSM", CAT_META), ("WSM", CAT_META), ("RM", CAT_META),
    ("W", CAT_WRITE), ("WS", CAT_WRITE), ("WFS", CAT_WRITE),
    ("FWS", CAT_FLUSH), ("F", CAT_FLUSH), ("N", CAT_FLUSH),
    ("D", CAT_DISCARD),
])
def test_rwbs_category(rwbs, cat):
    p = parse_rwbs(pd.Series([rwbs]))
    assert categorize(p).iloc[0] == cat


def test_prio_flags():
    p = parse_rwbs(pd.Series(["WFS"]))
    flags = prio_flags(p, cls=[3], ux=[0], fg_meta=[0])
    assert flags.iloc[0] == PRIO_IDLE | PRIO_SYNC | PRIO_FUA
    p2 = parse_rwbs(pd.Series(["RSM"]))
    flags2 = prio_flags(p2, cls=[1], ux=[1], fg_meta=[1])
    assert flags2.iloc[0] == (PRIO_RT | PRIO_UX | PRIO_FG_META
                              | PRIO_SYNC | PRIO_META)


# ------------------------------------------------------------ dev / files

def test_new_encode_dev():
    assert new_encode_dev(254, 131) == 65155
    assert new_encode_dev(7, 264) == (8 | (7 << 8) | (256 << 12)) == 1050376


def _pc(rows):
    cols = ["ts", "utid", "major_dev", "minor_dev", "ino", "offset",
            "bytes", "filebuf"]
    return pd.DataFrame(rows, columns=cols)


def _fa(rows):
    return pd.DataFrame(rows, columns=["ts", "utid", "s_dev", "i_ino",
                                       "index"])


def test_batches_with_and_without_start():
    # thread 1: pc_start at t=100 (ino 5, page 10) then adds 10,11,12
    #            (gap 8ms) then add 13 -> sub-batch break
    #           unmatched ino 9 adds at 200,201 -> one no-start batch
    pc = _pc([(100, 1, 254, 131, 5, 10 * 4096, 4096, "a.so")])
    fa = _fa([(100, 1, 65155, 5, 10), (101, 1, 65155, 5, 11),
              (102, 1, 65155, 5, 12),
              (200, 1, 65155, 9, 1), (201, 1, 65155, 9, 2),
              (102 + 2 * BATCH_GAP_NS, 1, 65155, 5, 13)])
    files, key2id = build_files(pc, fa)
    batches, fad = build_batches(pc, fa, key2id)
    assert len(batches) == 3
    b = batches.set_index("batch_id")
    started = b[b.has_start == 1]
    # only the leading sub-batch anchors at pc_start
    assert len(started) == 1
    assert started.iloc[0].page_count == 3 and started.iloc[0].ts == 100
    # the 5ms-split continuation starts at its own first fm_add
    cont = b[(b.has_start == 0) & (b.page_first == 13)].iloc[0]
    assert cont.page_count == 1 and cont.ts == 102 + 2 * BATCH_GAP_NS
    nostart = b[b.has_start == 0]
    assert (nostart.page_count == 2).any()
    assert fad.batch_id.notna().all()


def test_build_files_meta_naming():
    pc = _pc([(100, 1, 254, 131, 7, 0, 4096, "x.dex")])
    fa = _fa([(100, 1, 65155, 7, 0), (101, 1, 65155, 1, 3),
              (102, 1, 65155, 99, 0)])
    files, key2id = build_files(pc, fa)
    f = files.set_index(["s_dev", "ino"])
    assert f.loc[(65155, 7), "name"] == "x.dex"
    assert f.loc[(65155, 1), "name"] == "FS元数据" \
        and f.loc[(65155, 1), "is_meta"] == 1
    assert f.loc[(65155, 99), "name"] == "ino:99"


def _req_frame(rows):
    cols = ["dev", "sector", "t_ins", "ins_utid", "t_iss0", "t_iss",
            "iss_utid", "t_cmp", "err", "bytes", "nr_sector", "rwbs",
            "issue_count"]
    req = pd.DataFrame(rows, columns=cols)
    req["dev"] = req["dev"].astype("int64")
    req["sector"] = req["sector"].astype("int64")
    req["op"] = parse_rwbs(req["rwbs"])["op"]
    req["cat"] = categorize(parse_rwbs(req["rwbs"]))
    req["t_make"] = np.nan
    req["utid"] = req["ins_utid"].fillna(req["iss_utid"])
    req["req_id"] = np.arange(len(req))
    return req


def test_associate_files_via_fm_add_and_pc_fallback():
    # thread 5 reads: r1 gets fm_adds (file 5), r2 has no fm_add but a pc_start
    pc = _pc([(1000, 5, 254, 131, 5, 100 * 4096, 4096, "a.so"),
              (2000, 5, 254, 131, 7, 0, 4096, "b.so")])
    fa = _fa([(900, 5, 65155, 5, 100), (901, 5, 65155, 5, 101)])
    files, key2id = build_files(pc, fa)
    _, fad = build_batches(pc, fa, key2id)
    req = _req_frame([
        [2080, 8, 1000, 5, 1100, 1100, 5, 1200, 0, 4096, 8, "R", 1],
        [2080, 16, 3000, 5, 3100, 3100, 5, 3200, 0, 4096, 8, "R", 1],
        [2080, 24, 4000, 5, 4100, 4100, 5, 4200, 0, 4096, 8, "W", 1],
        [2080, 32, np.nan, np.nan, 5000, 5000, 7, 5200, 0, 4096, 8, "R", 1],
    ])
    req = associate_files(req, fad, pc, key2id)
    fid5 = key2id[(65155, 5)]
    fid7 = key2id[(65155, 7)]
    assert req.loc[0, "fsrc"] == 1 and req.loc[0, "file"] == fid5
    assert req.loc[0, "foff"] == 100 * 4096 and req.loc[0, "flen"] == 8192
    # r2: pc_start at 2000 within 20ms of t_sub=3000
    assert req.loc[1, "fsrc"] == 2 and req.loc[1, "file"] == fid7
    # write request: no association
    assert req.loc[2, "fsrc"] == -1
    # read on thread 7 with nothing -> unassociated
    assert req.loc[3, "fsrc"] == 0 and pd.isna(req.loc[3, "file"])


# ------------------------------------------------------------------ slots

def test_assign_slots_reuses_lowest_free():
    req = _req_frame([
        [2080, 1, np.nan, np.nan, 100, 100, 1, 300, 0, 1, 1, "R", 1],
        [2080, 2, np.nan, np.nan, 110, 110, 1, 200, 0, 1, 1, "R", 1],
        [2080, 3, np.nan, np.nan, 210, 210, 1, 250, 0, 1, 1, "R", 1],
        [2080, 4, np.nan, np.nan, 400, 400, 1, 500, 0, 1, 1, "R", 1],
    ])
    slot, lanes = assign_slots(req, t_max=1000)
    assert slot.tolist() == [0, 1, 1, 0]
    assert lanes[2080] == 2


def test_slot_interval_uses_last_issue():
    # A requeued: issues at 100 and 200, completes 300 -> occupies
    # [200,300]; B [110,120] overlaps A's first issue only -> same lane
    req = _req_frame([
        [2080, 1, 90, 1, 100, 200, 1, 300, 0, 1, 1, "R", 2],
        [2080, 2, np.nan, np.nan, 110, 110, 1, 120, 0, 1, 1, "R", 1],
    ])
    slot, lanes = assign_slots(req, t_max=10 ** 12)
    assert slot.tolist() == [0, 0]
    assert lanes[2080] == 1


def test_slot_incomplete_end_clipped():
    # A incomplete at 100 -> ends t_iss + 200ms; C inside that window gets
    # lane 1, B after the clip reuses lane 0
    gap = 200_000_000
    req = _req_frame([
        [2080, 1, np.nan, np.nan, 100, 100, 1, np.nan, 0, 1, 1, "R", 1],
        [2080, 2, np.nan, np.nan, 100 + 2 * gap, 100 + 2 * gap, 1,
         100 + 3 * gap, 0, 1, 1, "R", 1],
        [2080, 3, np.nan, np.nan, 100 + gap // 2, 100 + gap // 2, 1,
         100 + gap // 2 + 10, 0, 1, 1, "R", 1],
    ])
    slot, lanes = assign_slots(req, t_max=100 + 10 * gap)
    assert slot.tolist() == [0, 0, 1]
    assert lanes[2080] == 2


def test_parse_slot_limit():
    logs = pd.Series(["use_tag: 28 lrb_use: 0x0fffffff", "use_tag: 12",
                      "no tag here"])
    assert parse_slot_limit(logs) == 28
    assert parse_slot_limit(pd.Series(["nothing"])) is None
    assert parse_slot_limit(pd.Series(dtype=object)) is None


def test_slot_limits_per_dev():
    mq_c = pd.DataFrame(
        {"ts": [1, 2], "dev": [2080, 2080], "sector": [1, 2],
         "req_tag": [1, 2],
         "rq_log": ["use_tag: 32 lrb_use: x", "use_tag: 16"]})
    mq_r = pd.DataFrame(
        {"ts": [3], "dev": [1976], "sector": [3], "req_tag": [1],
         "rq_log": ["requeue_reason: 2 use_tag: 5"]})
    lim = slot_limits(mq_c, mq_r)
    assert lim[2080] == 32 and lim[1976] == 5
    # a dev with no mq events has no limit (e.g. loop devices)
    assert lim.get(1808) is None
    assert slot_limits(pd.DataFrame(), pd.DataFrame()) == {}


def test_dev_kind():
    assert dev_kind(new_encode_dev(8, 32)) == "disk"
    assert dev_kind(new_encode_dev(7, 16)) == "loop"
    assert dev_kind(new_encode_dev(7, 264)) == "loop"  # minor >= 256
    assert dev_kind(0) == "other"


def test_build_file_hints():
    files = pd.DataFrame(
        {"s_dev": [1, 1, 1], "ino": [5, 6, 7],
         "name": ["a.apk", "b.so", "c.dat"], "is_meta": [0, 0, 0]})
    threads = pd.DataFrame(
        {"utid": [7, 8], "tid": [7, 8], "thread_name": ["t1", "t2"],
         "upid": [1, 2], "pid": [1, 2],
         "process_name": ["app", "sys"]})
    req = pd.DataFrame(
        {"op": ["R", "R", "R", "W"],
         "file": [0.0, 0.0, 1.0, np.nan],
         "utid": [7, 8, 8, 8],
         "bytes": [100, 10, 60, 999]})
    hint = build_file_hints(req, files, threads)
    assert hint.tolist() == ["app", "sys", ""]


# --------------------------------------------------------------- requeues

def test_enrich_requests_requeue_window():
    req = _req_frame([
        [2080, 8, 100, 5, 150, 180, 5, 300, 0, 8192, 16, "R", 2],
    ])
    mq_c = pd.DataFrame(
        [(299, 2080, 8, 42, "use_tag: 10")],
        columns=["ts", "dev", "sector", "req_tag", "rq_log"])
    mq_r = pd.DataFrame(
        [(160, 2080, 8, 42, "requeue_reason: 2 use_tag: 28"),
         (170, 2080, 8, 42, "requeue_reason: 5 use_tag: 28")],
        columns=["ts", "dev", "sector", "req_tag", "rq_log"])
    req, rqs = enrich_requests(req, mq_c, mq_r, t_max=1000)
    r = req.iloc[0]
    assert r.tag == 42
    assert r.rq_n == 2                    # max(issue_count-1, observed)
    assert r.rq_reason == 5               # last reason
    assert len(rqs) == 2 and set(rqs.req) == {0}


# --------------------------------------------------------------- d-state

def test_dstate_blockfn_caller_int_and_wait_src():
    threads = pd.DataFrame([(5, 55, "t5", 1, 55, "app"),
                            (6, 66, "t6", 1, 66, "app")],
                           columns=["utid", "tid", "thread_name", "upid",
                                    "pid", "process_name"])
    dstate = pd.DataFrame(
        [(5, 1000, 500, None),   # D on thread 5 covering [1000,1500]
         (6, 2000, 400, None)],  # D on thread 6, io_wait=1 -> src2 guess
        columns=["utid", "ts", "dur", "blocked_function"])
    blocked = pd.DataFrame(
        [(1400, 55, 13, 0),      # caller int -> caller#13
         (2400, 66, 21, 1)],     # io_wait=1 for thread 6
        columns=["ts", "pid", "caller", "io_wait"])
    req = _req_frame([
        [2080, 8, 900, 5, 950, 950, 5, 1450, 0, 4096, 8, "R", 1],
        [2080, 16, 1900, 9, 1950, 1950, 9, 2350, 0, 4096, 8, "R", 1],
    ])
    dst, off, wreq, wsrc = build_dstate(dstate, blocked, req, {5, 6}, threads)
    assert dst.loc[0, "fn"] == "caller#13" and dst.loc[0, "fn_ok"] == 0
    assert dst.loc[0, "iow"] == 0
    # seg 0 (thread 5): own request 0 completes at 1450 in [1000,1500+50us]
    seg0 = wreq[off[0]:off[1]]
    assert list(seg0) == [0] and wsrc[0] == 1
    # seg 1 (thread 6, iow=1): nearest request completing <= 2000+400
    seg1 = wreq[off[1]:off[2]]
    assert list(seg1) == [1] and wsrc[1] == 2
