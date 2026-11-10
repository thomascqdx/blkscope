#!/usr/bin/env python3
"""Build a single-file startup_firstframe_io.exe with PyInstaller.

Bundles scripts/startup_firstframe_io.py together with pandas / openpyxl /
perfetto and tools/trace_processor_shell.exe (must already exist; run
scripts/fetch_tp.py first if missing). Recipients only need the exe.

Usage:
    .\\.venv\\Scripts\\python scripts\\build_firstframe_io.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD_DIR = os.path.join(ROOT, "build", "firstframe_io")
DIST_DIR = os.path.join(ROOT, "dist")
ENTRY = os.path.join(ROOT, "scripts", "startup_firstframe_io.py")
TP_BINARY = os.path.join(ROOT, "tools", "trace_processor_shell.exe")
EXE_NAME = "startup_firstframe_io"


def step(msg: str) -> None:
    print(f"\n==> {msg}", flush=True)


def run(cmd, **kw) -> None:
    print("+ " + " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True, **kw)


def main() -> None:
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        sys.exit("PyInstaller not installed; run: "
                 ".\\.venv\\Scripts\\python -m pip install pyinstaller")

    if not os.path.isfile(TP_BINARY):
        sys.exit(f"trace_processor binary missing: {TP_BINARY}\n"
                 "Run first: .\\.venv\\Scripts\\python scripts\\fetch_tp.py")

    if os.path.isdir(BUILD_DIR):
        shutil.rmtree(BUILD_DIR)
    os.makedirs(BUILD_DIR)

    step("building exe with PyInstaller")
    run([
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--console", "--noupx",
        "--name", EXE_NAME,
        "--distpath", os.path.join(BUILD_DIR, "dist"),
        "--workpath", os.path.join(BUILD_DIR, "work"),
        "--specpath", BUILD_DIR,
        "--add-binary", f"{TP_BINARY}{os.pathsep}tools",
        "--collect-data", "perfetto",
        "--exclude-module", "pytest",
        "--exclude-module", "playwright",
        "--exclude-module", "tkinter",
        ENTRY,
    ], cwd=ROOT)

    exe = os.path.join(BUILD_DIR, "dist", EXE_NAME + ".exe")
    if not os.path.isfile(exe):
        sys.exit(f"PyInstaller did not produce {exe}")

    step("copying to dist/")
    os.makedirs(DIST_DIR, exist_ok=True)
    dst = os.path.join(DIST_DIR, EXE_NAME + ".exe")
    shutil.copy2(exe, dst)
    print(f"\nexe: {dst} ({os.path.getsize(dst) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
