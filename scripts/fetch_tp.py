#!/usr/bin/env python3
"""Download trace_processor_shell for the current platform into tools/.

Reuses the URL/sha256 pinned by the installed perfetto Python package
(perfetto.prebuilts.manifests.trace_processor_shell), so the binary version
always matches the parser the package expects.

Usage:
    python scripts/fetch_tp.py [--proxy http://127.0.0.1:7890]

Proxy defaults to the HTTPS_PROXY/https_proxy environment variable.
If the perfetto package has already downloaded the same binary into its own
cache (~/.local/share/perfetto/prebuilts), it is copied instead of re-downloaded.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import stat
import sys
import tempfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS_DIR = os.path.join(ROOT, "tools")


def _manifest_entry():
    """Return the manifest dict for the current platform, or None."""
    try:
        from perfetto.prebuilts.manifests.trace_processor_shell import (
            TRACE_PROCESSOR_SHELL_MANIFEST,
        )
    except ImportError:
        sys.exit("perfetto package not installed; run: pip install perfetto")
    plat = sys.platform.lower()
    machine = platform.machine().lower()
    for entry in TRACE_PROCESSOR_SHELL_MANIFEST:
        if entry.get("platform") == plat and machine in entry.get("machine", []):
            return entry
    sys.exit(f"no trace_processor_shell prebuilt for {plat}-{machine}")


def _perfetto_cache_path(entry) -> str:
    """Path the perfetto package would cache this binary at."""
    root, ext = os.path.splitext(entry["file_name"])
    return os.path.join(
        os.path.expanduser("~"), ".local", "share", "perfetto", "prebuilts",
        f"{root}-{entry['sha256'][:16]}{ext}",
    )


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--proxy", default=os.environ.get("HTTPS_PROXY")
                    or os.environ.get("https_proxy"))
    args = ap.parse_args()

    entry = _manifest_entry()
    os.makedirs(TOOLS_DIR, exist_ok=True)
    dest = os.path.join(TOOLS_DIR, entry["file_name"])

    if os.path.exists(dest) and _sha256(dest) == entry["sha256"]:
        print(f"already up to date: {dest}")
        return

    cached = _perfetto_cache_path(entry)
    if os.path.exists(cached):
        shutil.copyfile(cached, dest)
        if _sha256(dest) == entry["sha256"]:
            print(f"copied cached binary: {cached} -> {dest}")
            return
        os.remove(dest)

    print(f"downloading {entry['url']}")
    handlers = []
    if args.proxy:
        handlers.append(urllib.request.ProxyHandler(
            {"http": args.proxy, "https": args.proxy}))
    opener = urllib.request.build_opener(*handlers)
    fd, tmp = tempfile.mkstemp(dir=TOOLS_DIR, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as out, opener.open(entry["url"], timeout=120) as resp:
            shutil.copyfileobj(resp, out)
        if _sha256(tmp) != entry["sha256"]:
            sys.exit(f"checksum mismatch downloading {entry['url']}")
        os.chmod(tmp, os.stat(tmp).st_mode | stat.S_IEXEC)
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    print(f"installed {dest} ({entry['file_size']} bytes, sha256 ok)")


if __name__ == "__main__":
    main()
