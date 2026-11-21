"""Single-file HTML builder (design 5.1 / 5.6 / 8).

web/index.html is the template; placeholders __TITLE__, __GENERATOR__,
/*__CSS__*/, /*__JS__*/, __PAYLOAD__, <!--__SITE__--> and <!--__MANUAL__-->
are replaced with the escaped trace name, the generator string
(blkscope <version>), the manifest-ordered CSS/JS inline contents, the
base64+gzip payload, the site landing markup (empty for CLI reports) and
the rendered user manual. The manual comes from the manifest's optional
"manual" entry (a Markdown file converted by mdlite) and is substituted
LAST so literal placeholder text inside the manual survives.
web/ lookup order: BLKSCOPE_WEB env > sys._MEIPASS (PyInstaller) > repo root.
"""

from __future__ import annotations

import html as _html
import json
import os
import sys

from . import __version__


def web_dir() -> str:
    """Locate the web/ asset directory."""
    env = os.environ.get("BLKSCOPE_WEB")
    if env and os.path.isdir(env):
        return env
    meipass = getattr(sys, "_MEIPASS", None)          # PyInstaller bundle
    if meipass and os.path.isdir(os.path.join(meipass, "web")):
        return os.path.join(meipass, "web")
    root = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))))                  # src/blkscope -> repo
    cand = os.path.join(root, "web")
    if not os.path.isdir(cand):
        raise FileNotFoundError(f"web/ assets not found at {cand} "
                                f"(set BLKSCOPE_WEB to override)")
    return cand


def load_manifest(wdir: str) -> dict:
    with open(os.path.join(wdir, "manifest.json"), encoding="utf-8") as f:
        return json.load(f)


def _read(wdir: str, rel: str) -> str:
    with open(os.path.join(wdir, rel), encoding="utf-8") as f:
        return f.read()


def _concat(wdir, rel_paths, escape):
    return "\n".join(escape(_read(wdir, rel)) for rel in rel_paths)


def _js_escape(s: str) -> str:
    return s.replace("</script", "<\\/script")


def _render(wdir, tpl, manifest, *, payload_b64, name, site_html="",
            extra_css=(), extra_js=()):
    """Shared inlining for the CLI report and the site page."""
    css = _concat(wdir, manifest.get("css", []) + list(extra_css),
                  lambda s: s)
    js = _concat(wdir, manifest.get("js", []) + list(extra_js), _js_escape)

    manual = ""
    mrel = manifest.get("manual")
    if mrel:
        from .mdlite import md_to_html
        manual = md_to_html(_read(wdir, mrel))

    # __MANUAL__ is replaced last: literal placeholder-looking text inside
    # the manual must survive verbatim (design 5.6). __SITE__ goes before it
    # for the same reason.
    return (tpl
            .replace("__TITLE__", _html.escape(name, quote=True))
            .replace("__GENERATOR__",
                     _html.escape(f"blkscope {__version__}", quote=True))
            .replace("/*__CSS__*/", css)
            .replace("/*__JS__*/", js)
            .replace("__PAYLOAD__", payload_b64)
            .replace("<!--__SITE__-->", site_html)
            .replace("<!--__MANUAL__-->", manual))


def render_html(payload_b64: str, name: str) -> str:
    """Inline web assets + payload -> standalone CLI report HTML."""
    wdir = web_dir()
    return _render(wdir, _read(wdir, "index.html"), load_manifest(wdir),
                   payload_b64=payload_b64, name=name)


def render_site(wdir: str = None) -> str:
    """Site index.html: empty payload -> landing screen; report assets plus
    the manifest "site" section (landing markup, extra css/js) inlined."""
    wdir = wdir or web_dir()
    manifest = load_manifest(wdir)
    site = manifest.get("site", {})
    landing = _read(wdir, site["html"]) if site.get("html") else ""
    return _render(wdir, _read(wdir, "index.html"), manifest,
                   payload_b64="", name="blkscope", site_html=landing,
                   extra_css=site.get("css", []),
                   extra_js=site.get("js", []))
