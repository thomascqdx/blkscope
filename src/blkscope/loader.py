"""Resolve input files into a list of (trace_name, path) to hand to extract.

.zip inputs are unpacked to a temp dir; every member that sniffs as a trace
(protobuf / gzip / systrace text / html-systrace) is kept. Directory inputs
are scanned at the first level only: zip members and trace-sniffing files are
kept, the rest is skipped. Non-zip file inputs are passed through untouched.
Temp dirs live for the duration of the context manager returned by
`resolve_inputs`.
"""

from __future__ import annotations

import contextlib
import os
import re
import sys
import tempfile
import zipfile
from typing import Iterator, List, Tuple

_SNIFF_LEN = 8192

# Magic bytes of members that are definitely not traces (images, docs, ...).
_NON_TRACE_MAGIC = (
    b"\x89PNG", b"\xff\xd8\xff",  # png, jpeg
    b"%PDF", b"GIF8", b"\x7fELF", b"SQLite format 3",
    b"PK\x03\x04",  # nested zip
)

# A decodable text member is a trace only if it looks like systrace/atrace or
# an html wrapper around one.
_TEXT_TRACE_MARKERS = (
    re.compile(rb"^\s*<[^>]+>-\d+\s+\[?\d*\]?\s*[\d.]+:\s*\w+:", re.M),  # sched line
    re.compile(rb"TRACE:", re.I),
    re.compile(rb"^#\s*tracer", re.M),
    re.compile(rb"tracing_mark_write"),
    re.compile(rb"systrace", re.I),
    re.compile(rb"trace-viewer|trace2html|perfetto", re.I),
    re.compile(rb"\bB\|\d+\|"),  # atrace begin-slice lines
)


def looks_like_trace(head: bytes) -> bool:
    """Heuristic: does this blob plausibly contain trace data?"""
    if not head:
        return False
    if b'<meta name="generator" content="blkscope' in head:
        return False                    # blkscope's own generated HTML
    if head.startswith(b"\x1f\x8b"):  # gzip (compressed trace)
        return True
    if any(head.startswith(m) for m in _NON_TRACE_MAGIC):
        return False
    try:
        head.decode("utf-8")
    except UnicodeDecodeError:
        # Binary and not a known non-trace format: protobuf or other binary trace.
        return True
    return any(m.search(head) for m in _TEXT_TRACE_MARKERS)


def _extract_zip(path: str, outdir: str) -> List[Tuple[str, str]]:
    kept: List[Tuple[str, str]] = []
    zip_stem = os.path.splitext(os.path.basename(path))[0]
    base = os.path.normcase(os.path.realpath(outdir))
    with zipfile.ZipFile(path) as zf:
        members = [i for i in zf.infolist() if not i.is_dir()]
        for info in members:
            dest = os.path.normcase(os.path.realpath(
                os.path.join(outdir, info.filename.replace("/", os.sep))))
            if dest != base and not dest.startswith(base + os.sep):
                print(f"warning: skipping zip member outside extraction "
                      f"dir: {info.filename}", file=sys.stderr)
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with zf.open(info) as src, open(dest, "wb") as dst:
                while chunk := src.read(1 << 20):
                    dst.write(chunk)
            with open(dest, "rb") as f:
                head = f.read(_SNIFF_LEN)
            if looks_like_trace(head):
                kept.append(dest)
    if len(kept) == 1:
        return [(zip_stem, kept[0])]
    return [
        (f"{zip_stem}_{os.path.splitext(os.path.basename(p))[0]}", p)
        for p in sorted(kept)
    ]


def _scan_dir(path: str, stack: contextlib.ExitStack) -> List[Tuple[str, str]]:
    """First-level dir scan -> [(trace_name, path)]; prints a summary."""
    found: List[Tuple[str, str]] = []
    skipped = 0
    for name in sorted(os.listdir(path), key=str.lower):
        full = os.path.join(path, name)
        if not os.path.isfile(full):
            continue                                  # no recursion
        if name.endswith(".payload.json"):
            skipped += 1
            continue
        if zipfile.is_zipfile(full):
            tmp = stack.enter_context(
                tempfile.TemporaryDirectory(prefix="blkscope_"))
            found.extend(_extract_zip(full, tmp))
            continue
        with open(full, "rb") as f:
            head = f.read(_SNIFF_LEN)
        if looks_like_trace(head):
            found.append((os.path.splitext(name)[0], full))
        else:
            skipped += 1
    print(f"[{path}] 找到 {len(found)} 个 trace 输入，"
          f"跳过 {skipped} 个非 trace 文件")
    if not found:
        print(f"warning: 目录中没有 trace 文件: {path}", file=sys.stderr)
    return found


@contextlib.contextmanager
def resolve_inputs(paths: List[str]) -> Iterator[List[Tuple[str, str]]]:
    """Expand inputs -> [(trace_name, path)]; cleans up zip temp dirs on exit."""
    out: List[Tuple[str, str]] = []
    with contextlib.ExitStack() as stack:
        for path in paths:
            if os.path.isdir(path):
                out.extend(_scan_dir(path, stack))
                continue
            if not os.path.isfile(path):
                raise FileNotFoundError(f"input not found: {path}")
            if zipfile.is_zipfile(path):
                tmp = stack.enter_context(
                    tempfile.TemporaryDirectory(prefix="blkscope_"))
                out.extend(_extract_zip(path, tmp))
            else:
                out.append((os.path.splitext(os.path.basename(path))[0], path))
        yield out
