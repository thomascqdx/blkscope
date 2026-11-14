"""perfbox-tool.json 模板与 argparse 定义的契约测试。

清单里的每个 flag 和 args 中的子命令都必须存在于工具的 argparse 定义中；
命令行有改动时，模板必须在同一个提交里同步更新。
"""
import argparse
import json
from pathlib import Path

import blkscope.cli

TEMPLATE = Path(__file__).parents[1] / "perfbox-tool.json"


def _resolve(parser, args):
    """按 args 逐层下钻子命令并校验其中的选项 token，返回最终子解析器。"""
    p = parser
    for tok in args:
        if tok.startswith("-"):
            assert any(tok in a.option_strings for a in p._actions), \
                f"{p.prog} 没有选项 {tok}"
        elif tok.startswith("{"):
            continue
        else:
            choices = {n: sp for a in p._actions
                       if isinstance(a, argparse._SubParsersAction)
                       for n, sp in a.choices.items()}
            assert tok in choices, f"{p.prog} 没有子命令 {tok}"
            p = choices[tok]
    return p


def _actions(sub):
    opts, pos = {}, []
    for a in sub._actions:
        if isinstance(a, argparse._SubParsersAction):
            continue
        if a.option_strings:
            for s in a.option_strings:
                opts[s] = a
        elif a.dest != "help":
            pos.append(a)
    return opts, pos


def test_template_shape():
    d = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    assert d["schema"] == 1 and d["id"] == "blkscope"
    assert d["version"] == "" and d["tag"] == ""
    assert d["artifact"] == {"name": "", "kind": "zip",
                           "size": 0, "sha256": "",
                           "entry": ["blkscope.exe"]}
    assert d["commands"]


def test_commands_match_argparse():
    d = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    parser = blkscope.cli.build_parser()
    for cmd in d["commands"]:
        sub = _resolve(parser, cmd.get("args", []))
        opts, pos = _actions(sub)
        pos_params = []
        for p in cmd.get("params", []):
            flag = p.get("flag")
            if flag is None:
                pos_params.append(p)
                continue
            assert flag in opts, f"{cmd['id']} 的 {flag} 不在 argparse 中"
            a = opts[flag]
            if p.get("multiple"):
                assert a.nargs in ("+", "*"), f"{flag} nargs={a.nargs}"
            if "count" in p:
                assert a.nargs == p["count"], \
                    f"{flag} nargs={a.nargs}，应为 {p['count']}"
            if p["type"] == "boolean":
                assert a.nargs == 0, f"{flag} 需要带值，不是开关"
            if "choices" in p and a.choices is not None:
                assert set(p["choices"]) <= set(a.choices), \
                    f"{flag} 的 choices 超出 argparse 定义"
        assert [p["name"] for p in pos_params] == [a.dest for a in pos], \
            f"{cmd['id']} 位置参数与 argparse 不一致"
        of = cmd["output"]["flag"]
        assert of in opts, f"{cmd['id']} output.flag {of} 不在 argparse 中"
