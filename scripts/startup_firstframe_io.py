"""批量统计启动 trace 首帧 DrawFrames 窗口内 RenderThread 的 IO 等待与读入文件。

对每个 trace：定位应用 RenderThread 上第一个 `DrawFrames <id>` slice 作为窗口
（仅 RenderThread 线程，其它线程与窗口外一律不计），统计窗口内：
- D/DK 且 io_wait=1 的 IO 等待时长（以及全部 D/DK 时长）；
- mm_filemap_add_to_page_cache 读入 page cache 的文件与字节数（每事件 1 页
  = 4096 字节，文件名用整条 trace 的 tran_fs_pagecache_start 事件解析）。

用法：
    .\\.venv\\Scripts\\python scripts\\startup_firstframe_io.py <目录>
        [-o out.xlsx] [--tp <trace_processor_shell 路径>] [-j N]
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import tempfile
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from pathlib import Path

import pandas as pd

PAGE_BYTES = 4096
TRACE_EXTS = {".trace", ".pftrace", ".perfetto-trace", ".pb"}
REPO_TOOLS = Path(__file__).resolve().parents[1] / "tools"

NAME_RE = re.compile(
    r"^StartUp_(?P<pkg>.+)_(?P<ts>\d{14})_(?P<cost>\d+)ms_"
    r"(?P<sn>[^_]+)_(?P<type>\w+)$"
)

SUM_COLS = [
    "trace文件", "包名", "时间戳", "启动耗时ms(文件名)", "序列号", "启动类型码(文件名)",
    "启动类型(trace识别)", "启动耗时ms(trace识别)", "pid", "RenderThread tid",
    "首帧slice", "首帧开始(相对启动开始ms)", "DrawFrames耗时ms", "IO等待ms",
    "D态总ms", "IO占比%", "读入文件数", "读入页数", "读入MiB", "未命名文件MiB", "备注",
]
FILE_COLS = [
    "trace文件", "包名", "文件名", "dev(major:minor)", "ino", "页数", "字节", "MiB",
    "占本次读入%", "首次读入(相对首帧开始ms)",
]
TOP_COLS = [
    "文件名", "总字节", "总MiB", "出现trace数", "出现占比%", "平均MiB", "最大MiB",
    "最大所在trace", "涉及包名",
]


def find_tp_binary(cli_arg: str | None) -> str:
    """--tp > BLKSCOPE_TP > 仓库 tools/。"""
    if cli_arg:
        if os.path.isfile(cli_arg):
            return cli_arg
        raise FileNotFoundError(f"--tp 指向的文件不存在: {cli_arg}")
    env = os.environ.get("BLKSCOPE_TP")
    if env:
        if os.path.isfile(env):
            return env
        raise FileNotFoundError(f"BLKSCOPE_TP 指向的文件不存在: {env}")
    name = "trace_processor_shell.exe" if sys.platform == "win32" else "trace_processor_shell"
    cand = REPO_TOOLS / name
    if cand.is_file():
        return str(cand)
    raise FileNotFoundError(f"trace_processor_shell 未找到: {cand}（可用 --tp 或 BLKSCOPE_TP 指定）")


def scan_inputs(d: Path) -> list[Path]:
    """只扫目录第一层；接受 .zip、常见 trace 后缀与无后缀文件。"""
    out = []
    for p in sorted(d.iterdir()):
        if not p.is_file():
            continue
        suf = p.suffix.lower()
        if suf == ".zip" or suf in TRACE_EXTS or suf == "":
            out.append(p)
        else:
            print(f"跳过(不支持的后缀): {p.name}", file=sys.stderr)
    return out


def parse_name(stem: str) -> dict | None:
    m = NAME_RE.match(stem)
    if not m:
        return None
    return {
        "pkg": m["pkg"], "ts14": m["ts"], "cost_ms": int(m["cost"]),
        "sn": m["sn"], "type_code": m["type"],
    }


@contextmanager
def trace_source(path: Path):
    """yield (trace_path | None, [候选 stem,...])。zip 取最大成员解压到临时目录。"""
    if path.suffix.lower() == ".zip":
        tmp = tempfile.mkdtemp(prefix="ffio_")
        try:
            with zipfile.ZipFile(path) as zf:
                members = [i for i in zf.infolist() if not i.is_dir()]
                if not members:
                    yield None, [path.stem]
                    return
                biggest = max(members, key=lambda i: i.file_size)
                dest = Path(tmp) / Path(biggest.filename).name
                with zf.open(biggest) as src, open(dest, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                yield str(dest), [Path(biggest.filename).stem, path.stem]
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    else:
        yield str(path), [path.stem]


def sdev_encode(major: int, minor: int) -> int:
    return (minor & 0xFF) | (major << 8) | ((minor & ~0xFF) << 12)


def sdev_decode(s_dev: int) -> tuple[int, int]:
    return (s_dev >> 8) & 0xFFF, (s_dev & 0xFF) | ((s_dev >> 12) & ~0xFF)


def analyze(tp_bin: str, trace_path: str, meta: dict) -> dict:
    """返回 {"summary": {...}, "files": [...]}。异常由调用方捕获。"""
    from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig

    pkg = meta["pkg"]
    pkg_sql = pkg.replace("'", "''")
    notes: list[str] = []
    summary = {
        "启动类型(trace识别)": None, "启动耗时ms(trace识别)": None,
        "pid": None, "RenderThread tid": None, "首帧slice": None,
        "首帧开始(相对启动开始ms)": None, "DrawFrames耗时ms": None,
        "IO等待ms": None, "D态总ms": None, "IO占比%": None,
        "读入文件数": None, "读入页数": None, "读入MiB": None, "未命名文件MiB": None,
    }
    files: list[dict] = []

    tp = TraceProcessor(
        trace=trace_path,
        config=TraceProcessorConfig(
            bin_path=tp_bin, ingest_ftrace_in_raw=True, load_timeout=600),
    )
    try:
        q = lambda sql: tp.query(sql).as_pandas_dataframe()  # noqa: E731

        # 1) 启动与进程
        startup = None
        try:
            tp.query("INCLUDE PERFETTO MODULE android.startup.startups")
            su = q(
                "select startup_id, ts, ts_end, dur, package, startup_type "
                f"from android_startups where package='{pkg_sql}' order by ts")
            if not su.empty:
                startup = su.iloc[0]
        except Exception as e:  # 模块缺失等 -> 走回退
            notes.append(f"android_startups 查询失败: {e}")

        upid_rows = pd.DataFrame()
        if startup is not None:
            summary["启动类型(trace识别)"] = startup["startup_type"]
            if pd.notna(startup["dur"]):
                summary["启动耗时ms(trace识别)"] = round(startup["dur"] / 1e6, 1)
            try:
                upid_rows = q(
                    "select upid, pid from android_startup_processes "
                    f"where startup_id={int(startup['startup_id'])}")
            except Exception as e:
                notes.append(f"android_startup_processes 查询失败: {e}")
                upid_rows = pd.DataFrame()

        frame = None  # (utid, tid, slice_name, ts, dur, pid)
        if startup is not None and not upid_rows.empty:
            cond = f"and s.ts >= {int(startup['ts'])}"
            for _, pr in upid_rows.iterrows():
                if pd.isna(pr["upid"]):
                    continue
                f = q(
                    "select t.utid, t.tid, s.name as slice_name, s.ts, s.dur "
                    "from slice s "
                    "join thread_track tt on s.track_id = tt.id "
                    "join thread t on t.utid = tt.utid "
                    f"where t.upid={int(pr['upid'])} and t.name='RenderThread' "
                    f"and s.name glob 'DrawFrames *' {cond} "
                    "order by s.ts limit 1")
                if not f.empty:
                    r = f.iloc[0]
                    frame = (int(r["utid"]), int(r["tid"]), r["slice_name"],
                             int(r["ts"]), int(r["dur"]),
                             int(pr["pid"]) if pd.notna(pr["pid"]) else None)
                    break
        else:
            # 回退：按进程名找拥有 RenderThread + DrawFrames 的进程，取首帧最早的
            if startup is None:
                notes.append("未识别到 android_startups，按进程名回退")
            else:
                notes.append("startup 无关联进程记录，按进程名回退")
            cond = f"and s.ts >= {int(startup['ts'])}" if startup is not None else ""
            f = q(
                "select t.utid, t.tid, p.pid, s.name as slice_name, s.ts, s.dur "
                "from slice s "
                "join thread_track tt on s.track_id = tt.id "
                "join thread t on t.utid = tt.utid "
                "join process p on p.upid = t.upid "
                f"where p.name='{pkg_sql}' and t.name='RenderThread' "
                f"and s.name glob 'DrawFrames *' {cond} "
                "order by s.ts limit 1")
            if not f.empty:
                r = f.iloc[0]
                frame = (int(r["utid"]), int(r["tid"]), r["slice_name"],
                         int(r["ts"]), int(r["dur"]),
                         int(r["pid"]) if pd.notna(r["pid"]) else None)

        if frame is None:
            notes.append("RenderThread 上找不到 DrawFrames slice，跳过后续统计")
            summary["备注"] = "；".join(notes)
            return {"summary": summary, "files": files}

        utid, rt_tid, slice_name, w0, dur, pid = frame
        w1 = w0 + dur
        summary["pid"] = pid
        summary["RenderThread tid"] = rt_tid
        summary["首帧slice"] = slice_name
        if startup is not None:
            summary["首帧开始(相对启动开始ms)"] = round((w0 - int(startup["ts"])) / 1e6, 1)
        summary["DrawFrames耗时ms"] = round(dur / 1e6, 1)

        # 2) IO 等待（窗口内裁剪重叠）
        st = q(
            "select ts, dur, state, io_wait from thread_state "
            f"where utid={utid} and state in ('D','DK') "
            f"and ts + dur > {w0} and ts < {w1} and dur > 0")
        d_ns = io_ns = 0
        for r in st.itertuples(index=False):
            ov = min(r.ts + r.dur, w1) - max(r.ts, w0)
            if ov <= 0:
                continue
            d_ns += ov
            if r.io_wait == 1:
                io_ns += ov
        if not st.empty and st["io_wait"].isna().all():
            notes.append("io_wait 缺失（无 sched_blocked_reason），IO等待列不可信")
        summary["IO等待ms"] = round(io_ns / 1e6, 1)
        summary["D态总ms"] = round(d_ns / 1e6, 1)
        summary["IO占比%"] = round(io_ns / dur * 100, 1) if dur > 0 else None

        # 3) 窗口内 RenderThread 读入 page cache 的文件
        total_fm = q("select count(*) as n from ftrace_event "
                     "where name='mm_filemap_add_to_page_cache'")
        if total_fm.empty or int(total_fm["n"].iloc[0]) == 0:
            notes.append("缺少 mm_filemap_add_to_page_cache，无法统计读入文件")
            ev = pd.DataFrame(columns=["ts", "s_dev", "i_ino"])
        else:
            ev = q(
                "select ts, "
                "extract_arg(arg_set_id,'s_dev') as s_dev, "
                "extract_arg(arg_set_id,'i_ino') as i_ino "
                "from ftrace_event "
                "where name='mm_filemap_add_to_page_cache' "
                f"and utid={utid} and ts >= {w0} and ts < {w1}")

        # 文件名映射：整条 trace 的 tran_fs_pagecache_start
        name_map: dict[tuple[int, int], str] = {}
        pc = q(
            "select extract_arg(arg_set_id,'major_dev') as major_dev, "
            "extract_arg(arg_set_id,'minor_dev') as minor_dev, "
            "extract_arg(arg_set_id,'ino') as ino, "
            "extract_arg(arg_set_id,'filebuf') as filebuf "
            "from ftrace_event where name='tran_fs_pagecache_start'")
        if pc.empty:
            notes.append("缺少 tran_fs_pagecache_start，文件名不可用")
        else:
            votes: dict[tuple[int, int], Counter] = {}
            for r in pc.itertuples(index=False):
                if pd.isna(r.major_dev) or pd.isna(r.minor_dev) or pd.isna(r.ino):
                    continue
                key = (sdev_encode(int(r.major_dev), int(r.minor_dev)), int(r.ino))
                votes.setdefault(key, Counter())[str(r.filebuf)] += 1
            name_map = {k: c.most_common(1)[0][0] for k, c in votes.items()}

        total_bytes = 0
        unk_bytes = 0
        if not ev.empty:
            ev = ev.dropna(subset=["s_dev", "i_ino"])
            ev["s_dev"] = ev["s_dev"].astype("int64")
            ev["i_ino"] = ev["i_ino"].astype("int64")
            grp = ev.groupby(["s_dev", "i_ino"]).agg(
                pages=("ts", "size"), first_ts=("ts", "min")).reset_index()
            for r in grp.itertuples(index=False):
                nbytes = int(r.pages) * PAGE_BYTES
                fname = name_map.get((r.s_dev, r.i_ino))
                if fname is None:
                    ma, mi = sdev_decode(r.s_dev)
                    fname = f"<unknown dev={ma}:{mi} ino={r.i_ino}>"
                    unk_bytes += nbytes
                total_bytes += nbytes
                files.append({
                    "文件名": fname,
                    "dev(major:minor)": f"{sdev_decode(r.s_dev)[0]}:{sdev_decode(r.s_dev)[1]}",
                    "ino": int(r.i_ino),
                    "页数": int(r.pages),
                    "字节": nbytes,
                    "首次读入ns": int(r.first_ts) - w0,
                })
            for f in files:
                f["MiB"] = round(f["字节"] / (1 << 20), 2)
                f["占本次读入%"] = round(f["字节"] / total_bytes * 100, 1) if total_bytes else 0.0
                f["首次读入(相对首帧开始ms)"] = round(f.pop("首次读入ns") / 1e6, 1)
        summary["读入文件数"] = len(files)
        summary["读入页数"] = int(sum(f["页数"] for f in files))
        summary["读入MiB"] = round(total_bytes / (1 << 20), 2)
        summary["未命名文件MiB"] = round(unk_bytes / (1 << 20), 2)

        summary["备注"] = "；".join(notes)
        return {"summary": summary, "files": files}
    finally:
        tp.close()


def process_one(tp_bin: str, path: Path, idx: int, total: int) -> dict:
    print(f"[{idx}/{total}] 开始 {path.name}", file=sys.stderr, flush=True)
    row = {"trace文件": path.name, "包名": None, "时间戳": None,
           "启动耗时ms(文件名)": None, "序列号": None, "启动类型码(文件名)": None}
    files: list[dict] = []
    try:
        with trace_source(path) as (tp_path, stems):
            meta = None
            for s in stems:
                meta = parse_name(s)
                if meta:
                    break
            if meta is None:
                row["备注"] = f"文件名不匹配 StartUp_ 命名规则（{' / '.join(stems)}），跳过分析"
            elif tp_path is None:
                row["备注"] = "zip 内无文件成员，跳过分析"
            else:
                row.update({
                    "包名": meta["pkg"], "时间戳": meta["ts14"],
                    "启动耗时ms(文件名)": meta["cost_ms"], "序列号": meta["sn"],
                    "启动类型码(文件名)": meta["type_code"],
                })
                res = analyze(tp_bin, tp_path, meta)
                row.update(res["summary"])
                for f in res["files"]:
                    f["trace文件"] = path.name
                    f["包名"] = meta["pkg"]
                files = res["files"]
    except Exception as e:
        row["备注"] = f"分析异常: {type(e).__name__}: {e}"
    print(f"[{idx}/{total}] 完成 {path.name}: {row.get('备注') or 'ok'}",
          file=sys.stderr, flush=True)
    return {"row": row, "files": files, "name": path.name}


def _disp_width(s: str) -> int:
    return sum(2 if ord(c) > 0x2E7F else 1 for c in s)


def format_xlsx(path: Path) -> None:
    from openpyxl import load_workbook
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter

    wb = load_workbook(path)
    for ws in wb.worksheets:
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for col in ws.columns:
            letter = get_column_letter(col[0].column)
            w = max((_disp_width(str(c.value)) for c in col if c.value is not None),
                    default=0)
            ws.column_dimensions[letter].width = min(max(w + 2, 8), 60)
    wb.save(path)


def write_xlsx(results: list[dict], out_path: Path) -> None:
    rows = []
    for r in results:
        row = {c: r["row"].get(c) for c in SUM_COLS}
        rows.append(row)
    sum_df = pd.DataFrame(rows, columns=SUM_COLS)
    sum_df["_io"] = pd.to_numeric(sum_df["IO等待ms"], errors="coerce")
    sum_df = sum_df.sort_values("_io", ascending=False, na_position="last").drop(columns="_io")

    n_ok = int(sum_df["首帧slice"].notna().sum())

    file_rows = []
    for r in results:
        file_rows.extend(r["files"])
    files_df = pd.DataFrame(file_rows, columns=FILE_COLS)
    if not files_df.empty:
        rank = {n: i for i, n in enumerate(sum_df["trace文件"])}
        files_df["_r"] = files_df["trace文件"].map(rank).fillna(1 << 30)
        files_df = files_df.sort_values(["_r", "MiB"], ascending=[True, False])
        files_df = files_df.drop(columns="_r")

    top_rows = []
    if not files_df.empty:
        for fname, g in files_df.groupby("文件名", sort=False):
            b = g["字节"].astype("int64")
            mx = g.loc[b.idxmax()]
            top_rows.append({
                "文件名": fname,
                "总字节": int(b.sum()),
                "总MiB": round(b.sum() / (1 << 20), 2),
                "出现trace数": int(g["trace文件"].nunique()),
                "出现占比%": round(g["trace文件"].nunique() / n_ok * 100, 1) if n_ok else 0.0,
                "平均MiB": round(b.sum() / g["trace文件"].nunique() / (1 << 20), 2),
                "最大MiB": round(b.max() / (1 << 20), 2),
                "最大所在trace": mx["trace文件"],
                "涉及包名": ",".join(sorted({str(x) for x in g["包名"] if pd.notna(x)})),
            })
    top_df = pd.DataFrame(top_rows, columns=TOP_COLS)
    if not top_df.empty:
        top_df = top_df.sort_values("总字节", ascending=False)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(out_path, engine="openpyxl") as xw:
        sum_df.to_excel(xw, sheet_name="汇总", index=False)
        files_df.to_excel(xw, sheet_name="文件明细", index=False)
        top_df.to_excel(xw, sheet_name="TOP文件", index=False)
    format_xlsx(out_path)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="批量统计启动 trace 首帧 DrawFrames 窗口内 RenderThread 的 "
                    "IO 等待与 page cache 读入文件，输出 xlsx")
    ap.add_argument("dir", help="trace 所在目录（只扫第一层）")
    ap.add_argument("-o", "--out", default=None,
                    help="输出 xlsx 路径（默认 <dir>\\startup_firstframe_io.xlsx）")
    ap.add_argument("--tp", default=None, help="trace_processor_shell 路径")
    ap.add_argument("-j", type=int, default=1, help="并行 trace 数（默认 1）")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    d = Path(args.dir)
    if not d.is_dir():
        print(f"目录不存在: {d}", file=sys.stderr)
        return 2
    tp_bin = find_tp_binary(args.tp)
    out_path = Path(args.out) if args.out else d / "startup_firstframe_io.xlsx"

    inputs = scan_inputs(d)
    if not inputs:
        print("目录中没有可处理的 trace 文件", file=sys.stderr)
        return 1
    print(f"共 {len(inputs)} 个候选文件, tp={tp_bin}", file=sys.stderr)

    results: list[dict] = [None] * len(inputs)  # type: ignore
    if args.j > 1:
        with ThreadPoolExecutor(max_workers=args.j) as ex:
            futs = {ex.submit(process_one, tp_bin, p, i + 1, len(inputs)): i
                    for i, p in enumerate(inputs)}
            for fut in as_completed(futs):
                results[futs[fut]] = fut.result()
    else:
        for i, p in enumerate(inputs):
            results[i] = process_one(tp_bin, p, i + 1, len(inputs))

    write_xlsx(results, out_path)
    print(f"已写出: {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
