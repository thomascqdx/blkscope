"""Unit tests for blkscope.tp.find_tp_binary lookup order."""

import sys

import pytest

from blkscope import tp

NAME = ("trace_processor_shell.exe" if sys.platform == "win32"
        else "trace_processor_shell")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("BLKSCOPE_TP", raising=False)


def _bundle(tmp_path, with_bin=True):
    """Fake PyInstaller _MEIPASS dir with tools/<name> inside."""
    d = tmp_path / "bundle"
    (d / "tools").mkdir(parents=True)
    if with_bin:
        (d / "tools" / NAME).write_bytes(b"x")
    return d


def _tools(tmp_path, with_bin=True):
    """Fake repo TOOLS_DIR."""
    d = tmp_path / "toolsdir"
    d.mkdir()
    if with_bin:
        (d / NAME).write_bytes(b"x")
    return d


def test_env_wins_over_meipass(monkeypatch, tmp_path):
    env_bin = tmp_path / "env_tp"
    env_bin.write_bytes(b"x")
    monkeypatch.setenv("BLKSCOPE_TP", str(env_bin))
    monkeypatch.setattr(sys, "_MEIPASS", str(_bundle(tmp_path)), raising=False)
    monkeypatch.setattr(tp, "TOOLS_DIR", str(_tools(tmp_path)))
    assert tp.find_tp_binary() == str(env_bin)


def test_env_missing_raises(monkeypatch, tmp_path):
    monkeypatch.setenv("BLKSCOPE_TP", str(tmp_path / "nope"))
    monkeypatch.setattr(sys, "_MEIPASS", str(_bundle(tmp_path)), raising=False)
    with pytest.raises(FileNotFoundError):
        tp.find_tp_binary()


def test_meipass_preferred_over_tools_dir(monkeypatch, tmp_path):
    bundle = _bundle(tmp_path)
    monkeypatch.setattr(sys, "_MEIPASS", str(bundle), raising=False)
    monkeypatch.setattr(tp, "TOOLS_DIR", str(_tools(tmp_path)))
    assert tp.find_tp_binary() == str(bundle / "tools" / NAME)


def test_meipass_without_binary_falls_back(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "_MEIPASS",
                        str(_bundle(tmp_path, with_bin=False)), raising=False)
    tools = _tools(tmp_path)
    monkeypatch.setattr(tp, "TOOLS_DIR", str(tools))
    assert tp.find_tp_binary() == str(tools / NAME)


def test_nothing_anywhere_raises(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "_MEIPASS",
                        str(_bundle(tmp_path, with_bin=False)), raising=False)
    monkeypatch.setattr(tp, "TOOLS_DIR", str(_tools(tmp_path, with_bin=False)))
    with pytest.raises(FileNotFoundError):
        tp.find_tp_binary()
