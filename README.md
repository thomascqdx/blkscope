# blkscope

Android / Perfetto **块设备 IO trace 离线分析工具**：把一条 trace 转成**单个自包含的 HTML 文件**，双击即可在浏览器中分析，无需服务器、无网络依赖。

可以回答的问题：

- 每个进程/线程读写多少、打到哪个文件、速度多少（进程 = IO 提交者，而非中断上下文）
- 每个请求的排队（insert→issue）、服务（issue→complete）、总耗时（make→complete）
- 设备槽位占用、在途深度、排队深度、带宽/IOPS 曲线
- 线程 D 状态阻塞与导致阻塞的具体请求（含推测的跨线程等待）
- 慢 IO 列表、延迟分布、关键线程（主线程/RenderThread）阻塞汇总

## 支持的输入

- Perfetto protobuf trace（`.trace` / `.pftrace`，直接给文件或打成 `.zip`）
- 文本 systrace / ftrace dump（`sched_switch` 等文本行）
- `.zip` 内可混放多个成员；非 trace 成员（README、图片等）自动跳过

## 安装

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -e .[dev]
.\.venv\Scripts\python scripts\fetch_tp.py          # 下载 trace_processor 到 tools/
```

`fetch_tp.py` 复用 perfetto Python 包的二进制清单与版本，需要时可用
`--proxy <url>`（或环境变量 `HTTPS_PROXY`）指定代理。也可以直接把
`trace_processor_shell.exe` 放进 `tools/`，或设环境变量 `BLKSCOPE_TP` 指向它。

## 用法

```powershell
# 一个输入 -> out\<name>.html
.\.venv\Scripts\blkscope samples\<xxx>.zip -o out

# 多个输入：每条 trace 一个 HTML，失败不中断，结尾打印汇总；exit code 非零表示有失败
.\.venv\Scripts\blkscope a.zip b.trace -o out

# 生成后直接打开浏览器
.\.venv\Scripts\blkscope a.zip -o out --open

# 只要数据（不生成 HTML）
.\.venv\Scripts\blkscope a.zip -o out --json
```

输出名冲突时自动追加数字后缀（`name_2.html`）。加载一条 200MB 的 trace
大约需要 10~20 秒（期间按阶段打印进度）。

## 界面快捷键

| 键 / 操作 | 作用 |
|---|---|
| W / S（按住连续） | 以鼠标位置为中心放大 / 缩小 |
| A / D（按住连续） | 向左 / 右平移 |
| Ctrl + 滚轮 | 以鼠标为中心缩放 |
| 滚轮 | 纵向滚动；Shift+滚轮 / 触控板横滑 = 横向平移 |
| 单击 | 选中条目（空白处清除选择） |
| 拖动 | 区域选择（时间 × 轨道）；刻度尺上拖动 = 全部轨道 |
| Shift + 拖动 | 平移 |
| F | 缩放到当前选中条目或区域 |
| Esc | 关闭帮助 / 取消选择 |
| Ctrl + A | 选中整个 trace |
| R | 把选中条目转成区域选择 |
| M / Shift+M | 临时标记 / 持久标记当前时间范围 |
| [ / ] | 跳到同一行上一条 / 下一条目 |
| / | 聚焦搜索框 |
| C | 切换配色：类别 / 优先级 / 进程 / 延迟 |
| L | 颜色图例（色块含义） |
| ? | 显示 / 隐藏帮助 |

标题栏还有：「含 loop 设备」开关、「慢 IO ≥ N ms」阈值（同时驱动红色描边和慢 IO 表）、配色模式指示（点击打开图例）、「图例」（或按 `L`，弹出全部颜色 / 记号含义）、「手册」（内嵌完整使用手册，全屏带目录）、「?」快捷键帮助。

完整使用手册内嵌在每个 HTML 中（标题栏「手册」按钮）；Markdown 源文件在 `web/manual.md`。

## 面板说明

- **当前选择**：选中请求 / D 段 / 批次的全部字段；等待链上的请求与 D 段可点击跳转
- **区域统计**：框选范围内的进程 / 线程 / 文件 / 阻塞函数 汇总；未框选时统计全 trace
- **延迟分布**：排队 / 服务 / 总耗时的对数直方图 + p50/p90/p99/max
- **慢 IO**：超过阈值（默认 10ms）的请求，按总耗时倒序
- **关键线程阻塞**：主线程（tid==pid）与 RenderThread 的 D 阻塞汇总（内核线程已排除）

统计口径：请求按 `[t_iss, t_cmp]` 与统计窗口的**重叠比例**分摊字节数；速度 = 分摊字节 / 窗口时长；未完成请求按 `t_iss + 200ms` 截断。

## 依赖的传音定制事件与降级

工具为 Transsion 内核定制事件设计，缺失时按以下方式降级并在顶部质量条提示：

| 事件 | 提供 | 缺失时 |
|---|---|---|
| `tran_fs` / `tran_fs_pagecache_start` | 文件名 | 文件关联不可用 |
| `tran_block_feature/block_rq_mq_make_request` | IO 优先级 / UX / 提交 pid | 按 insert 线程归属，无优先级 |
| `block_rq_mq_complete_request`（req_tag / rq_log） | req_tag、槽位上限 | 无槽位上限提示 |
| `block_rq_mq_requeue_request` | requeue 原因 | 无 requeue 标注 |

文件关联是**启发式推断**，UI 中以「推测」标注；`wait_src=2` 的等待链同样标「推测」。

## 已知限制

- block function 符号化取决于抓取配置：若 `sched_blocked_reason.caller` 只有内部 id，显示 `caller#<id>` 并提示（增大 ring buffer / DISCARD 模式重抓可改善）
- 文件关联只有 `tran_fs_pagecache_start` + `mm_filemap_add_to_page_cache` 两条启发式路径；非读请求及窗口外请求无法关联
- 文本 systrace 抓取的传音定制事件尚未在真实数据上验证（合成样例可跑通）

## 目录

```
src/blkscope/   Python 解析层（trace_processor -> pandas -> 模型 -> JSON payload）
web/           前端（原生 JS + Canvas，无外部依赖，内联进 HTML）
tools/         trace_processor_shell（fetch_tp.py 下载，不入库）
samples/       样例 trace     out/ work/   产物与临时文件（不入库）
tests/         pytest（合成事件单测 + 基于真实 trace_processor 的 e2e）
```
