#!/usr/bin/env python3
"""Run loader -> extract -> model -> payload on the sample trace and print
validation metrics. Writes the same report to work/validate_sample.txt.

Usage: .\\.venv\\Scripts\\python scripts\\validate_sample.py [trace_or_zip]
"""

from __future__ import annotations

import base64
import gzip
import io
import json
import os
import sys
import time

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

SAMPLE = os.path.join(
    ROOT, "samples",
    "StartUp_com.opera.mini.native_20261010011312_2477ms_sn1824615693000400_7.zip")


def main() -> None:
    from iotrace.loader import resolve_inputs
    from iotrace.tp import open_trace
    from iotrace.extract import extract_all
    from iotrace.model import build_model
    from iotrace.payload import build_payload, encode_payload

    path = sys.argv[1] if len(sys.argv) > 1 else SAMPLE
    out = io.StringIO()

    def p(*a):
        print(*a)
        print(*a, file=out)

    timings = {}
    t0 = time.time()
    with resolve_inputs([path]) as traces:
        p(f"loader: {len(traces)} trace(s) from {os.path.basename(path)}")
        for name, tp_path in traces:
            p(f"  -> {name}: {tp_path} "
              f"({os.path.getsize(tp_path) / 1e6:.0f} MB)")
        timings["loader"] = time.time() - t0

        for name, tp_path in traces:
            p(f"\n===== {name} =====")
            t = time.time()
            tp = open_trace(tp_path)
            timings["open+load"] = time.time() - t
            t = time.time()
            try:
                ex = extract_all(tp)
            finally:
                tp.close()
            timings["extract"] = time.time() - t
            t = time.time()
            m = build_model(ex)
            timings["model"] = time.time() - t
            t = time.time()
            payload = build_payload(m, name=name,
                                    source=os.path.basename(tp_path))
            raw = json.dumps(payload, ensure_ascii=False,
                             separators=(",", ":")).encode()
            enc = encode_payload(payload)
            timings["payload"] = time.time() - t

            # ---- event counts
            p("\n-- events --")
            for attr in ("bio_make", "rq_insert", "rq_issue", "rq_complete",
                         "mq_complete", "mq_requeue", "pc_start", "fm_add",
                         "blocked", "dstate", "threads"):
                p(f"  {attr:12s} {len(getattr(ex, attr)):>9,}")
            p(f"  valid window: {(m.t_max - m.t_min) / 1e9:.2f}s "
              f"({m.t_min / 1e9:.2f} ~ {m.t_max / 1e9:.2f})")

            # ---- pairing
            req = m.req
            n_cmp_ev = len(ex.rq_complete)
            paired = req["t_cmp"].notna().sum()
            p("\n-- requests --")
            p(f"  requests: {len(req):,}")
            p(f"  paired (t_cmp): {paired:,} "
              f"({paired / max(n_cmp_ev, 1):.1%} of rq_complete events)")
            p(f"  with insert: {req['t_ins'].notna().sum():,}  "
              f"direct-issue only: {(req['t_ins'].isna()).sum():,}")
            ins_req = req["t_ins"].notna()
            p(f"  make_request match: {req['t_make'].notna().sum():,} "
              f"({req.loc[ins_req, 't_make'].notna().mean():.1%} of inserted)")
            c = m.counters
            p(f"  orphan_complete: {c['orphan_complete']:,}  "
              f"incomplete: {c['incomplete']:,}  "
              f"dropped_insert: {c['dropped_insert']:,}")
            p(f"  requeue events mapped: {len(m.requeues):,}  "
              f"requests with rq_n>0: {(req['rq_n'] > 0).sum():,}")
            p(f"  req_tag matched: {req['tag'].notna().sum():,}")

            # ---- file association
            reads = req[req["op"] == "R"]
            p("\n-- file association (reads) --")
            fs = reads["fsrc"].value_counts().sort_index()
            p(f"  reads: {len(reads):,}  associated: "
              f"{(reads['fsrc'] > 0).sum():,} "
              f"({(reads['fsrc'] > 0).mean():.1%})")
            for k, label in ((1, "fm_add mode"), (2, "pc_start 20ms"),
                             (0, "unassociated")):
                p(f"    fsrc={k} {label:14s}: {fs.get(k, 0):,}")
            by = reads.groupby("rwbs")["fsrc"].agg(
                assoc=lambda s: f"{(s > 0).mean():.1%}", n="size")
            p("  by rwbs:\n" + by.to_string())

            # ---- files
            p("\n-- files --")
            p(f"  files: {len(m.files):,}  "
              f"(FS元数据: {m.files['is_meta'].sum()})")
            rf = req.dropna(subset=["file"])
            fb = rf.groupby(rf["file"].astype("int64"))["bytes"] \
                .agg(["sum", "count"])
            fb = fb.join(m.files[["name", "hint"]]) \
                .sort_values("sum", ascending=False)
            p("  top 15 by associated request bytes:")
            for _, r in fb.head(15).iterrows():
                hint = f" · {r['hint']}" if r.get("hint") else ""
                p(f"    {r['sum'] / 1e6:>9.1f} MB  n={int(r['count']):>6}  "
                  f"{r['name']}{hint}")

            # ---- bytes by category
            cat_names = {0: "sync_read", 1: "readahead", 2: "meta",
                         3: "write", 4: "flush", 5: "discard", 6: "other"}
            p("\n-- bytes by cat --")
            bc = req.groupby(req["cat"].astype("int64"))["bytes"].agg(
                ["sum", "count"])
            for ci, r in bc.iterrows():
                p(f"  {cat_names.get(ci, ci):>10s}: {r['sum'] / 1e6:>10.1f} MB"
                  f"  n={int(r['count']):,}")

            # ---- latency
            p("\n-- latency (ms) --")
            for col in ("q_ns", "svc_ns"):
                s = req[col].dropna() / 1e6
                p(f"  {col:6s} p50={s.quantile(.5):.3f} "
                  f"p99={s.quantile(.99):.3f} max={s.max():.3f}")

            # ---- devices
            p("\n-- devices --")
            infl = req.dropna(subset=["t_iss"])
            iend = infl["t_cmp"].where(
                infl["t_cmp"].notna(),
                np.minimum(m.t_max, infl["t_iss"] + 200_000_000))
            ev = pd.concat([
                infl[["dev", "t_iss"]].rename(columns={"t_iss": "ts"})
                .assign(d=1),
                pd.DataFrame({"dev": infl["dev"], "ts": iend}).assign(d=-1)])
            ev = ev.sort_values(["ts", "d"])
            cur = {}
            peak = {}
            for dname, t, d in ev.itertuples(index=False):
                cur[dname] = cur.get(dname, 0) + d
                if cur[dname] > peak.get(dname, 0):
                    peak[dname] = cur[dname]
            for r in m.devs.itertuples():
                n = int((req["dev"] == r.dev).sum())
                lim = None if pd.isna(r.slot_limit) else int(r.slot_limit)
                p(f"  dev {r.dev:>8} ({r.name:>8} {r.kind:>4}): "
                  f"lanes={r.lanes} slot_limit={lim} "
                  f"requests={n:,} peak_in_flight={peak.get(r.dev, 0)}")

            # ---- D-state
            p("\n-- D state --")
            n_d = len(m.dst)
            waits = np.diff(m.wait_off) > 0
            p(f"  segments kept: {n_d:,} "
              f"(of {len(ex.dstate):,} total)")
            p(f"  with block fn: {(m.dst['fn'].astype(str).str.len() > 0).mean():.1%}"
              f"  resolved (fn_ok): {m.dst['fn_ok'].mean():.1%}")
            p(f"  with waited reqs: {waits.mean():.1%}  "
              f"src1: {(m.wait_src == 1).sum():,}  "
              f"src2: {(m.wait_src == 2).sum():,}")

            # ---- payload
            p("\n-- payload --")
            p(f"  json raw: {len(raw) / 1e6:.2f} MB  "
              f"gzip+b64: {len(enc) / 1e6:.2f} MB  strs: {len(payload['strs']):,}")

            # ---- quality
            p("\n-- quality --")
            for q in m.quality:
                p(f"  [{q['level']}] {q['code']}: {q['msg']}")

    p("\n-- timings --")
    for k, v in timings.items():
        p(f"  {k:10s} {v:6.1f}s")

    txt = out.getvalue()
    os.makedirs(os.path.join(ROOT, "work"), exist_ok=True)
    rep = os.path.join(ROOT, "work", "validate_sample.txt")
    with open(rep, "w", encoding="utf-8") as f:
        f.write(txt)
    print(f"\nreport written to {rep}")


if __name__ == "__main__":
    main()
