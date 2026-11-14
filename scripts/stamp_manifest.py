#!/usr/bin/env python3
"""把清单模板填写成发布用的 perfbox-tool.json。

只依赖标准库；本文件从 perfbox 仓库 tools/ 拷贝到各工具仓库使用。
规范见 perfbox/docs/tool-manifest.md 第 8 节。
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

_VERSION_FROM_RE = re.compile(
    r"(?:__version__|VERSION)\s*=\s*[\"']([^\"']+)[\"']")
_VERSION_RE = re.compile(r"\d+\.\d+\.\d+\Z")


def fail(msg):
    print(f"stamp_manifest: 错误：{msg}", file=sys.stderr)
    sys.exit(1)


def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        if not s.isatty():
            s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(
        prog="stamp_manifest.py",
        description="填写清单模板中的版本号与产物信息，写出发布清单")
    ap.add_argument("--template", default="perfbox-tool.json",
                    help="清单模板路径（默认 perfbox-tool.json）")
    ap.add_argument("--out", default="dist/perfbox-tool.json",
                    help="输出路径（默认 dist/perfbox-tool.json）")
    ap.add_argument("--artifact", required=True, help="产物文件路径")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--version", help="版本号 X.Y.Z")
    g.add_argument("--version-from",
                   help="从文件里取 __version__ = \"...\" 或 VERSION = \"...\"")
    ns = ap.parse_args(argv)

    if ns.version is not None:
        version = ns.version
    else:
        try:
            text = Path(ns.version_from).read_text(encoding="utf-8")
        except OSError as e:
            fail(f"无法读取版本文件 {ns.version_from}：{e}")
        m = _VERSION_FROM_RE.search(text)
        if not m:
            fail(f"{ns.version_from} 中找不到 __version__ 或 VERSION 定义")
        version = m.group(1)
    if not _VERSION_RE.fullmatch(version):
        fail(f"版本号 {version!r} 不是 X.Y.Z 格式")

    art = Path(ns.artifact)
    if not art.is_file():
        fail(f"产物不存在：{art}")

    try:
        data = json.loads(Path(ns.template).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        fail(f"无法读取清单模板 {ns.template}：{e}")
    if not isinstance(data, dict):
        fail(f"{ns.template} 不是 JSON 对象")
    if not isinstance(data.get("artifact"), dict):
        fail(f"{ns.template} 缺少 artifact 对象")

    h = hashlib.sha256()
    with open(art, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    sha = h.hexdigest()

    data["version"] = version
    data["tag"] = f"v{version}"
    data["artifact"]["name"] = art.name
    data["artifact"]["size"] = art.stat().st_size
    data["artifact"]["sha256"] = sha

    out = Path(ns.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    print(f"{out}")
    print(f"sha256: {sha}")


if __name__ == "__main__":
    main()
