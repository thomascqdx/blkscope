# blkscope 开发规则

需求与设计结论见 `docs/requirements.md`（修改需求先更新该文档）。

## 环境
- 平台 Windows，默认 shell 是 PowerShell（没有 Git Bash），命令用 PowerShell 语法。
- Python 依赖**只装在项目虚拟环境 `.venv`**，禁止安装到全局：`.\.venv\Scripts\python -m pip install ...`。
- trace_processor 二进制放在 `tools/`（被 gitignore），由 `scripts/fetch_tp.py` 获取；工具运行时必须可离线。
- 样例 Trace 放在 `samples/`，临时产物放在 `work/` / `out/`，都不入库。

## Git
- 每完成一个开发步骤就提交一次；提交信息说明「为什么」。
- 不提交大文件（trace、二进制、生成的 HTML）。
- 不修改 git config，不 force push。

## 架构约定
- `src/blkscope/`：Python 解析层（trace_processor → pandas → 模型 → JSON payload），产出单 HTML。
- `web/`：前端源码，原生 JS + Canvas，无外部依赖、无 CDN；由 Python 按清单内联成单文件 HTML。
- 每个输入 Trace 输出一个 HTML。
- 时间统一用相对 trace 起点的 ns（JS Number 精度足够）。
- 数据量大的数组用列式存储（payload 中按列存）。

## 领域规则（必须遵守）
- 传音定制事件必须适配：`tran_fs/tran_fs_pagecache_start`（文件名）、`tran_block_feature/block_rq_mq_make_request`（优先级 / UX / pid）、
  `block_rq_mq_complete_request`（req_tag / rq_log）、`block_rq_mq_requeue_request`（requeue_reason）。缺少这些事件时必须优雅降级。
- IO 归属取提交者（make_request.pid → insert 线程），不能用 complete 所在线程（中断上下文）。
- 文件关联是启发式推断，UI 中必须标注「推测」。
- block function 无法符号化时显示 `caller#<id>`，并给出数据质量提示。
- 框选统计按 issue→complete 与选区的重叠比例分摊字节数；速度 = 总量 / 选区时长。

## 验证
- 单元测试：`.\.venv\Scripts\python -m pytest -q`（合成事件单测 + `tests/test_cli_e2e.py` 用 tools/ 里的真实 trace_processor 跑端到端，二进制缺失时自动跳过）。
- 样例校验：`.\.venv\Scripts\python scripts/validate_sample.py`（加载样例约 1~2 分钟），检查配对率、总字节数、文件关联率等。
- 生成 HTML：`.\.venv\Scripts\blkscope <zip|trace> -o out`（支持多输入与 `--open` / `--json`）。
- 前端冒烟：`.\.venv\Scripts\python scripts/ui_smoke.py <html>` —— 无头 Edge 跑全量交互 + 截图到 `work/ui/` + 独立 Python 统计交叉校验；控制台报错即失败。空/降级 payload 用 `--load-only`（只加载并检查控制台无报错）。
- `research/` 是需求调研阶段的探查脚本，仅供参考。
