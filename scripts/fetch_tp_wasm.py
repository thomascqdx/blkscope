#!/usr/bin/env python3
"""Download the Perfetto web engine assets into tools/wasm/.

Fetches the official Perfetto UI engine bundle and trace_processor wasm
builds pinned to the same version as tools/trace_processor_shell
(see scripts/fetch_tp.py), plus the Perfetto Apache-2.0 LICENSE. Every file
is verified against a hardcoded sha256; existing files with a matching hash
are kept.

Usage:
    python scripts/fetch_tp_wasm.py [--proxy URL]

Proxy defaults to the HTTPS_PROXY/https_proxy environment variable.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import tempfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WASM_DIR = os.path.join(ROOT, "tools", "wasm")

VERSION = "v57.2-da1d152cf"
UI_BASE = f"https://ui.perfetto.dev/{VERSION}"

# sha256 of the official assets (matches the "sha256-..." digests in
# https://ui.perfetto.dev/<VERSION>/manifest.json, base64 -> hex).
FILES = [
    (
        f"{UI_BASE}/engine_bundle.js",
        "engine_bundle.js",
        "e5c75cbfaca0cd1c33c2239d8736c9286d6f4d80a63f9985edebbd394c8e76ff",
    ),
    (
        f"{UI_BASE}/trace_processor.wasm",
        "trace_processor.wasm",
        "5426a91adf47553b55dcd24444e0ec2271cef3896da4bea350d26e0dfbbaea72",
    ),
    (
        f"{UI_BASE}/trace_processor_memory64.wasm",
        "trace_processor_memory64.wasm",
        "7a29598ba557ce21747beabd582d1483e6fbface0baf0550b68ec6602a63bb63",
    ),
    (
        "https://raw.githubusercontent.com/google/perfetto/v57.2/LICENSE",
        "LICENSE",
        "9a682a56cffc9524dfa9b0b1c0dca9cb81a19e96d5bd0793aaf02c08a95ee7ca",
    ),
]


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _download(opener, url: str, dest: str, sha256: str) -> None:
    print(f"downloading {url}")
    fd, tmp = tempfile.mkstemp(dir=WASM_DIR, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as out, opener.open(url, timeout=300) as resp:
            shutil.copyfileobj(resp, out)
        digest = _sha256(tmp)
        if digest != sha256:
            sys.exit(f"checksum mismatch downloading {url}\n"
                     f"  expected {sha256}\n  got      {digest}")
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    print(f"installed {dest} (sha256 ok)")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--proxy", default=os.environ.get("HTTPS_PROXY")
                    or os.environ.get("https_proxy"))
    args = ap.parse_args()

    os.makedirs(WASM_DIR, exist_ok=True)

    handlers = []
    if args.proxy:
        handlers.append(urllib.request.ProxyHandler(
            {"http": args.proxy, "https": args.proxy}))
    opener = urllib.request.build_opener(*handlers)

    for url, name, sha256 in FILES:
        dest = os.path.join(WASM_DIR, name)
        if os.path.exists(dest) and _sha256(dest) == sha256:
            print(f"already up to date: {dest}")
            continue
        _download(opener, url, dest, sha256)

    version_file = os.path.join(WASM_DIR, "VERSION")
    with open(version_file, "w", encoding="utf-8") as f:
        f.write(VERSION + "\n")
    print(f"wrote {version_file}")


if __name__ == "__main__":
    main()
