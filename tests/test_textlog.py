"""textlog.py: atrace block_rq parsing, thread resolution, script replay."""

import numpy as np
import pandas as pd

from blkscope import textlog
from blkscope.model import new_decode_dev

FIX = __import__("pathlib").Path(__file__).parent / "fixtures"


def test_parse_block_events_positional_and_kv():
    ev = textlog.parse_block_events(str(FIX / "block_rq_systrace.atrace"))
    assert ev.has_block
    assert ev.bad == 0 and ev.lines == 12 and len(ev.rows) == 12
    assert ev.t_min == 3_000_000_000 and ev.t_max == 3_007_500_000

    devs = {r.dev for r in ev.rows}
    assert devs == {2080, 1050416}
    assert new_decode_dev(2080) == "8:32"
    assert new_decode_dev(1050416) == "7:304"     # loop major with minor > 255

    first = ev.rows[0]
    assert (first.ts, first.kind, first.sector, first.nr, first.rwbs) == \
        (3_000_000_000, textlog.INSERT, 10000, 8, "R")
    assert first.comm == "app.main" and first.tid == 100 and first.tgid == 100

    kv = [r for r in ev.rows if r.sector == 30000]
    assert len(kv) == 3
    assert all(r.dev == 2080 and r.nr == 8 for r in kv)
    assert kv[0].comm == "app.main" and kv[0].rwbs == "R"


def test_script_replay_matches_original_algorithm():
    ev = textlog.parse_block_events(str(FIX / "block_rq_systrace.atrace"))
    rep = textlog.build_script_report(ev.rows)
    # A and KV read complete; B's complete is swallowed by the key overwrite
    assert rep["read_n"] == 2
    assert abs(rep["read_mb"] - 0.015625) < 1e-12
    ins = rep["ins_iss"]
    assert ins["n"] == 2
    assert abs(ins["avg_ms"] - 1.55) < 1e-9
    assert abs(ins["max_ms"] - 3.0) < 1e-9
    assert abs(ins["lt1"] - 50.0) < 1e-9
    iss = rep["iss_cmp"]
    assert iss["n"] == 2 and iss["ge25"] == 0
    assert [t["name"] for t in rep["top"]] == ["app.write", "app.main"]
    assert rep["top"][0]["total_kb"] == 24.0
    assert rep["top"][1]["total_kb"] == 16.0


def _threads(rows):
    return pd.DataFrame(rows, columns=[
        "utid", "tid", "thread_name", "upid", "pid", "process_name",
        "parent_pid"])


def test_attach_resolves_known_threads_and_synthesizes_missing():
    ev = textlog.parse_block_events(str(FIX / "block_rq_systrace.atrace"))
    threads = _threads([(1, 100, "app.main", 1, 100, "app.main", -1)])
    ranges = pd.DataFrame([(1, 1_000_000_000, 4_000_000_000)],
                          columns=["utid", "ts_min", "ts_max"])
    att = textlog.attach_utids(ev, threads, ranges)
    assert len(att.insert) == 4 and len(att.issue) == 4
    assert len(att.complete) == 4
    # tid 100 resolved to utid 1; tid 101 synthesized
    assert set(att.insert["utid"]) == {1, 2}
    assert att.n_synth == 1
    synth = att.synth_rows[0]
    assert synth["tid"] == 101 and synth["process_name"] == "app.write"

    # no TP threads at all: every block thread is synthesized
    empty = _threads([])
    att2 = textlog.attach_utids(ev, empty, pd.DataFrame())
    assert att2.n_synth == 2
    assert set(att2.insert["utid"]) == {0, 1}


def test_looks_like_text_rejects_plain_and_binary(tmp_path):
    plain = tmp_path / "plain.txt"
    plain.write_text("not a trace, just a note\n", encoding="utf-8")
    assert not textlog.looks_like_text(str(plain))
    assert textlog.looks_like_text(str(FIX / "block_rq_systrace.atrace"))
