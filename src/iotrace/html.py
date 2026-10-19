"""Single-file HTML builder (design 5.1 / 5.6).

web/index.html is the template; placeholders __TITLE__, /*__CSS__*/,
/*__JS__*/, __PAYLOAD__ and <!--__MANUAL__--> are replaced with the escaped
trace name, the manifest-ordered CSS/JS inline contents, the base64+gzip
payload and the rendered user manual. The manual comes from the manifest's
optional "manual" entry (a Markdown file converted by mdlite) and is
substituted LAST so literal placeholder text inside the manual survives.
web/ lookup order: IOTRACE_WEB env > sys._MEIPASS (PyInstaller) > repo root.
"""

from __future__ import annotations

import html as _html
import json
import os
import sys


def web_dir() -> str:
    """Locate the web/ asset directory."""
    env = os.environ.get("IOTRACE_WEB")
    if env and os.path.isdir(env):
        return env
    meipass = getattr(sys, "_MEIPASS", None)          # PyInstaller bundle
    if meipass and os.path.isdir(os.path.join(meipass, "web")):
        return os.path.join(meipass, "web")
    root = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))))                  # src/iotrace -> repo
    cand = os.path.join(root, "web")
    if not os.path.isdir(cand):
        raise FileNotFoundError(f"web/ assets not found at {cand} "
                                f"(set IOTRACE_WEB to override)")
    return cand


def render_html(payload_b64: str, name: str) -> str:
    """Inline web assets + payload -> standalone HTML text."""
    wdir = web_dir()
    with open(os.path.join(wdir, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    with open(os.path.join(wdir, "index.html"), encoding="utf-8") as f:
        tpl = f.read()

    def concat(rel_paths, escape):
        parts = []
        for rel in rel_paths:
            with open(os.path.join(wdir, rel), encoding="utf-8") as f:
                parts.append(escape(f.read()))
        return "\n".join(parts)

    css = concat(manifest.get("css", []), lambda s: s)
    js = concat(manifest.get("js", []),
                lambda s: s.replace("</script", "<\\/script"))

    manual = ""
    mrel = manifest.get("manual")
    if mrel:
        from .mdlite import md_to_html
        with open(os.path.join(wdir, mrel), encoding="utf-8") as f:
            manual = md_to_html(f.read())

    # __MANUAL__ is replaced last: literal placeholder-looking text inside
    # the manual must survive verbatim (design 5.6)
    return (tpl
            .replace("__TITLE__", _html.escape(name, quote=True))
            .replace("/*__CSS__*/", css)
            .replace("/*__JS__*/", js)
            .replace("__PAYLOAD__", payload_b64)
            .replace("<!--__MANUAL__-->", manual))
