#!/usr/bin/env python3
"""One-command release build: PyInstaller onefile exe + smoke test + dist zip.

Steps: preflight -> clean-tree check -> fetch/verify trace_processor ->
unit tests -> PyInstaller onefile build (bundles trace_processor and web/)
-> smoke test the built exe (--version + fixture -> HTML) -> stage
dist/blkscope-<ver>-<plat>-<arch>/ (exe + README + LICENSE + manual) ->
zip + .sha256.

Usage:
    .\\.venv\\Scripts\\python scripts\\build_release.py [--skip-tests] [--allow-dirty] [--proxy URL]
"""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
BUILD_DIR = os.path.join(ROOT, "build", "release")
DIST_DIR = os.path.join(ROOT, "dist")


def step(msg: str) -> None:
    print(f"\n==> {msg}", flush=True)


def run(cmd, **kw) -> None:
    print("+ " + " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True, **kw)


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def preflight(args):
    step("preflight")
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        sys.exit("PyInstaller not installed; run: "
                 ".\\.venv\\Scripts\\python -m pip install -e .[release]")
    sys.path.insert(0, SRC)
    from blkscope import __version__ as ver
    plat = "windows" if sys.platform == "win32" else sys.platform
    machine = platform.machine().lower()
    arch = "x64" if machine in ("amd64", "x86_64") else machine
    rel = f"blkscope-{ver}-{plat}-{arch}"
    print(f"release: {rel}")
    return ver, rel


def git_state(args) -> str:
    step("checking git state")
    r = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT,
                       capture_output=True, text=True, check=True)
    dirty = r.stdout.strip()
    if dirty and not args.allow_dirty:
        sys.exit("working tree is dirty; commit first or pass --allow-dirty:\n"
                 + dirty)
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
                            capture_output=True, text=True,
                            check=True).stdout.strip()
    if dirty:
        commit += "+dirty"
    print(f"commit: {commit}")
    return commit


def fetch_tp(args) -> None:
    step("fetching trace_processor")
    cmd = [sys.executable, os.path.join(ROOT, "scripts", "fetch_tp.py")]
    if args.proxy:
        cmd += ["--proxy", args.proxy]
    run(cmd, cwd=ROOT)


def run_tests(args) -> None:
    if args.skip_tests:
        step("tests skipped (--skip-tests)")
        return
    step("running tests")
    run([sys.executable, "-m", "pytest", "-q"], cwd=ROOT)


def build_exe() -> str:
    step("building exe with PyInstaller")
    from blkscope.tp import TOOLS_DIR
    # bundle the sha-verified tools/ binary from fetch_tp, never BLKSCOPE_TP
    tp_binary = os.path.join(TOOLS_DIR, "trace_processor_shell.exe")
    if not os.path.isfile(tp_binary):
        sys.exit(f"trace_processor binary missing: {tp_binary}")

    if os.path.isdir(BUILD_DIR):
        shutil.rmtree(BUILD_DIR)
    os.makedirs(BUILD_DIR)
    entry = os.path.join(BUILD_DIR, "entry.py")
    with open(entry, "w", encoding="utf-8") as f:
        f.write("from blkscope.cli import main\nraise SystemExit(main())\n")

    run([
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--console", "--noupx",
        "--name", "blkscope",
        "--distpath", os.path.join(BUILD_DIR, "dist"),
        "--workpath", os.path.join(BUILD_DIR, "work"),
        "--specpath", BUILD_DIR,
        "--paths", SRC,
        "--add-data", f"{os.path.join(ROOT, 'web')}{os.pathsep}web",
        "--add-binary", f"{tp_binary}{os.pathsep}tools",
        "--collect-data", "perfetto",
        "--exclude-module", "pytest",
        "--exclude-module", "playwright",
        "--exclude-module", "tkinter",
        entry,
    ], cwd=ROOT)

    exe = os.path.join(BUILD_DIR, "dist", "blkscope.exe")
    if not os.path.isfile(exe):
        sys.exit(f"PyInstaller did not produce {exe}")
    return exe


def smoke(exe: str, ver: str) -> None:
    step("smoke testing exe")
    env = dict(os.environ)
    env.pop("BLKSCOPE_TP", None)
    env.pop("BLKSCOPE_WEB", None)
    env["PYTHONIOENCODING"] = "utf-8"

    def run_exe(argv, cwd):
        p = subprocess.run([exe, *argv], cwd=cwd, env=env,
                           capture_output=True, timeout=600)
        out = (p.stdout or b"").decode("utf-8", "replace")
        err = (p.stderr or b"").decode("utf-8", "replace")
        return p.returncode, out, err

    def fail(msg, rc, out, err):
        print(f"smoke failed: {msg}\nrc={rc}\n--- stdout ---\n{out}"
              f"\n--- stderr ---\n{err}", file=sys.stderr)
        sys.exit(1)

    with tempfile.TemporaryDirectory() as tmp:
        rc, out, err = run_exe(["--version"], tmp)
        if rc != 0 or out.strip() != f"blkscope {ver}":
            fail(f"--version != 'blkscope {ver}'", rc, out, err)
        print(f"exe --version: {out.strip()}")

        fixture = os.path.join(ROOT, "tests", "fixtures",
                               "systrace_sched.trace")
        outdir = os.path.join(tmp, "out")
        rc, out, err = run_exe([fixture, "-o", outdir], tmp)
        html = os.path.join(outdir, "systrace_sched.html")
        ok = rc == 0 and os.path.isfile(html)
        if ok:
            with open(html, encoding="utf-8") as f:
                ok = f'content="blkscope {ver}"' in f.read()
        if not ok:
            fail("fixture trace -> HTML", rc, out, err)
        print(f"exe generated {html} with blkscope {ver} marker")


def package(exe: str, rel: str) -> str:
    step("packaging dist/")
    staging = os.path.join(DIST_DIR, rel)
    zip_path = os.path.join(DIST_DIR, rel + ".zip")
    if os.path.isdir(staging):
        shutil.rmtree(staging)
    if os.path.isfile(zip_path):
        os.remove(zip_path)
    os.makedirs(staging, exist_ok=True)

    shutil.copy2(exe, os.path.join(staging, "blkscope.exe"))
    for name in ("README.md", "LICENSE"):
        shutil.copy2(os.path.join(ROOT, name), os.path.join(staging, name))
    shutil.copy2(os.path.join(ROOT, "web", "manual.md"),
                 os.path.join(staging, "manual.md"))

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, files in os.walk(staging):
            for fn in sorted(files):
                full = os.path.join(dirpath, fn)
                arc = os.path.join(rel, os.path.relpath(full, staging))
                z.write(full, arc)
    digest = sha256(zip_path)
    with open(zip_path + ".sha256", "w", encoding="ascii") as f:
        f.write(f"{digest}  {os.path.basename(zip_path)}\n")
    return zip_path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--skip-tests", action="store_true",
                    help="skip the pytest run before building")
    ap.add_argument("--allow-dirty", action="store_true",
                    help="build even with uncommitted changes")
    ap.add_argument("--proxy", default=None,
                    help="proxy URL passed to scripts/fetch_tp.py")
    args = ap.parse_args()

    ver, rel = preflight(args)
    commit = git_state(args)
    fetch_tp(args)
    run_tests(args)
    exe = build_exe()
    smoke(exe, ver)
    zip_path = package(exe, rel)

    step("summary")
    print(f"version : {ver}")
    print(f"commit  : {commit}")
    print(f"exe     : {exe} ({os.path.getsize(exe) / 1e6:.1f} MB)")
    print(f"zip     : {zip_path} ({os.path.getsize(zip_path) / 1e6:.1f} MB)")
    print(f"sha256  : {sha256(zip_path)}")


if __name__ == "__main__":
    main()
