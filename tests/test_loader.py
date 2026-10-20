"""loader.py tests: zip member sniffing, naming, and zip-slip protection."""

import os
import zipfile

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
