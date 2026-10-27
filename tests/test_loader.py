"""loader.py tests: zip member sniffing, naming, and zip-slip protection."""

import os
import zipfile

import pytest

from blkscope.loader import looks_like_trace, resolve_inputs


def _trace_bytes():
    # non-UTF8 binary -> sniffs as protobuf-style trace
    return b"\x00\x01\xff\xfetrace-body" * 16


def test_single_trace_zip_named_by_zip(tmp_path):
    zp = tmp_path / "sample.zip"
    with zipfile.ZipFile(zp, "w") as zf:
        zf.writestr("inner.trace", _trace_bytes())
        zf.writestr("notes.txt", b"just some plain text, no markers")
    with resolve_inputs([str(zp)]) as traces:
        assert len(traces) == 1
        name, path = traces[0]
        assert name == "sample"
        assert os.path.isfile(path)
    # temp dir cleaned up after the context exits
    assert not os.path.exists(os.path.dirname(path))


def test_multi_trace_zip_names_members(tmp_path):
    zp = tmp_path / "multi.zip"
    with zipfile.ZipFile(zp, "w") as zf:
        zf.writestr("a.trace", _trace_bytes())
        zf.writestr("b.trace", _trace_bytes())
    with resolve_inputs([str(zp)]) as traces:
        assert len(traces) == 2
        assert {n for n, _ in traces} == {"multi_a", "multi_b"}


def test_zip_slip_member_skipped(tmp_path, capsys):
    zp = tmp_path / "evil.zip"
    with zipfile.ZipFile(zp, "w") as zf:
        zf.writestr("../evil.trace", _trace_bytes())
        zf.writestr("good.trace", _trace_bytes())
    with resolve_inputs([str(zp)]) as traces:
        assert len(traces) == 1
        name, path = traces[0]
        assert name == "evil"      # zip stem
        assert "good" in path
        assert os.path.isfile(path)
    assert "../evil.trace" in capsys.readouterr().err


def test_looks_like_trace():
    assert looks_like_trace(b"\x1f\x8b\x08\x00")          # gzip
    assert looks_like_trace(b"\x00\xff\x00\xff" * 32)     # binary (protobuf)
    assert not looks_like_trace(b"\x89PNG\r\n\x1a\n" + b"x" * 64)
    assert not looks_like_trace(b"plain text notes\n" * 8)


def test_non_zip_passthrough(tmp_path):
    p = tmp_path / "raw.trace"
    p.write_bytes(_trace_bytes())
    with resolve_inputs([str(p)]) as traces:
        assert traces == [("raw", str(p))]


_GENERATED_HTML_HEAD = (
    b'<!DOCTYPE html><html><head><meta charset="utf-8">'
    b'<meta name="generator" content="blkscope 0.1.0">'
    b'perfetto systrace')


def test_directory_input(tmp_path, capsys):
    d = tmp_path / "in"
    d.mkdir()
    (d / "b.trace").write_bytes(_trace_bytes())
    with zipfile.ZipFile(d / "a.zip", "w") as zf:
        zf.writestr("inner.trace", _trace_bytes())
    (d / "notes.txt").write_text("just some plain text, no markers")
    (d / "x.payload.json").write_text("{}")
    (d / "old.html").write_bytes(_GENERATED_HTML_HEAD)
    sub = d / "sub"
    sub.mkdir()
    (sub / "c.trace").write_bytes(_trace_bytes())     # first level only
    with resolve_inputs([str(d)]) as traces:
        assert [n for n, _ in traces] == ["a", "b"]
    assert ("找到 2 个 trace 输入，跳过 3 个非 trace 文件"
            in capsys.readouterr().out)


def test_empty_dir_mixed_with_file(tmp_path, capsys):
    d = tmp_path / "emptydir"
    d.mkdir()
    (d / "notes.txt").write_text("just some plain text, no markers")
    p = tmp_path / "raw.trace"
    p.write_bytes(_trace_bytes())
    with resolve_inputs([str(d), str(p)]) as traces:
        assert traces == [("raw", str(p))]
    assert "目录中没有 trace 文件" in capsys.readouterr().err


def test_missing_input_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        with resolve_inputs([str(tmp_path / "nope")]):
            pass


def test_looks_like_trace_generated_html():
    assert not looks_like_trace(_GENERATED_HTML_HEAD)
