"""html.py: template rendering, escaping, payload round-trip."""

import base64
import gzip
import io
import json
import os

from iotrace.html import render_html
from iotrace.payload import encode_payload


def _make_web(tmp_path, manual=None):
    web = tmp_path / "web"
    (web / "css").mkdir(parents=True)
    (web / "js").mkdir()
    manifest = {"css": ["css/a.css", "css/b.css"],
                "js": ["js/a.js", "js/b.js"]}
    if manual is not None:
        manifest["manual"] = "manual.md"
        (web / "manual.md").write_text(manual, encoding="utf-8")
    (web / "manifest.json").write_text(json.dumps(manifest))
    (web / "index.html").write_text(
        "<html><title>__TITLE__</title><style>/*__CSS__*/</style>"
        "<script>/*__JS__*/</script>"
        "<script type='application/octet-stream' "
        "id='payload'>__PAYLOAD__</script>"
        "<article><!--__MANUAL__--></article></html>", encoding="utf-8")
    (web / "css" / "a.css").write_text(".a{color:red}", encoding="utf-8")
    (web / "css" / "b.css").write_text(".b{color:blue}", encoding="utf-8")
    (web / "js" / "a.js").write_text(
        "const s = '</script>'; var A = 1;", encoding="utf-8")
    (web / "js" / "b.js").write_text("var B = 2;", encoding="utf-8")
    return web


def test_render_replaces_placeholders_and_escapes(tmp_path, monkeypatch):
    web = _make_web(tmp_path)
    monkeypatch.setenv("IOTRACE_WEB", str(web))
    out = render_html("QUJD", 'x<y>"z"')
    assert "__TITLE__" not in out and "__PAYLOAD__" not in out
    assert "/*__CSS__*/" not in out and "/*__JS__*/" not in out
    assert "x&lt;y&gt;&quot;z&quot;" in out       # title html-escaped
    assert ".a{color:red}" in out and ".b{color:blue}" in out
    assert "var A = 1" in out and "var B = 2" in out
    # only the two real closing tags remain; the one inside JS was escaped
    assert out.count("</script>") == 2
    assert "<\\/script>" in out
    assert "QUJD" in out


def test_payload_roundtrip(tmp_path, monkeypatch):
    web = _make_web(tmp_path)
    monkeypatch.setenv("IOTRACE_WEB", str(web))
    payload = {"v": 1, "meta": {"name": "t"}, "strs": [], "req": {"dev": [1]}}
    b64 = encode_payload(payload)
    out = render_html(b64, "t")
    start = out.index("id='payload'>") + len("id='payload'>")
    end = out.index("</script>", start)
    raw = gzip.decompress(base64.b64decode(out[start:end]))
    assert json.loads(raw) == payload


def test_manual_rendered_when_manifest_has_key(tmp_path, monkeypatch):
    web = _make_web(tmp_path, manual="## 章节\n\n正文 **粗体** 与 `code`\n")
    monkeypatch.setenv("IOTRACE_WEB", str(web))
    out = render_html("QUJD", "t")
    assert "<!--__MANUAL__-->" not in out
    assert '<h2 id="m-1">章节</h2>' in out
    assert "<strong>粗体</strong>" in out and "<code>code</code>" in out


def test_manual_text_survives_literal_placeholders(tmp_path, monkeypatch):
    # __MANUAL__ is the last replacement: literal placeholder-looking text
    # inside the manual must not be substituted again
    web = _make_web(
        tmp_path,
        manual="占位符 __PAYLOAD__ 与 /*__JS__*/ 按原样显示\n")
    monkeypatch.setenv("IOTRACE_WEB", str(web))
    out = render_html("QUJD", "t")
    assert out.count("__PAYLOAD__") == 1      # only the manual's literal
    assert "/*__JS__*/" in out
    assert "<!--__MANUAL__-->" not in out


def test_manual_missing_key_leaves_empty(tmp_path, monkeypatch):
    web = _make_web(tmp_path)                  # manifest has no "manual"
    monkeypatch.setenv("IOTRACE_WEB", str(web))
    out = render_html("QUJD", "t")
    assert "<!--__MANUAL__-->" not in out
    assert "<article></article>" in out
