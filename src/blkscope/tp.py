"""Locate the trace_processor_shell binary and open a TraceProcessor."""

from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TOOLS_DIR = os.path.join(ROOT, "tools")


def find_tp_binary() -> str:
    """Resolve trace_processor_shell: env BLKSCOPE_TP > tools/ > error."""
    env = os.environ.get("BLKSCOPE_TP")
    if env:
        if os.path.isfile(env):
            return env
        raise FileNotFoundError(f"BLKSCOPE_TP points to a missing file: {env}")
    name = "trace_processor_shell.exe" if sys.platform == "win32" else "trace_processor_shell"
    candidate = os.path.join(TOOLS_DIR, name)
    if os.path.isfile(candidate):
        return candidate
    raise FileNotFoundError(
        f"trace_processor_shell not found at {candidate}.\n"
        "Run: .\\.venv\\Scripts\\python scripts\\fetch_tp.py "
        "(or set the BLKSCOPE_TP environment variable to the binary path)")


def open_trace(path: str, load_timeout: int = 600):
    """Open a TraceProcessor on `path` with the project binary and raw ftrace."""
    from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig

    return TraceProcessor(
        trace=path,
        config=TraceProcessorConfig(
            bin_path=find_tp_binary(),
            ingest_ftrace_in_raw=True,
            load_timeout=load_timeout,
        ),
    )
