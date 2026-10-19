# iotrace 设计（v1）

## 1. 目录结构

```
pyproject.toml            # 包 iotrace，入口 `iotrace = iotrace.cli:main`；依赖 perfetto、pandas、numpy
src/iotrace/
  cli.py                  # 参数解析；每个输入 Trace → 一个 HTML
  tp.py                   # 定位 trace_processor 二进制（IOTRACE_TP 环境变量 > tools/ > 报错并提示 scripts/fetch_tp.py）
  loader.py               # 输入格式处理：zip 解包、格式嗅探；产出 [(trace_name, path)]
  extract.py              # SQL 查询 → 原始事件 DataFrame（只做取数，不做逻辑）
  model.py                # 纯函数：配对、归属、优先级、文件关联、槽位、D 状态因果、数据质量
  payload.py              # 模型 → 列式 JSON payload（字符串池化），gzip + base64
  html.py                 # 按 web/manifest.json 内联 CSS/JS + payload → 单 HTML
web/
  manifest.json           # 内联顺序
  index.html, css/*.css, js/*.js
scripts/fetch_tp.py       # 下载 trace_processor_shell 到 tools/（支持 --proxy）
scripts/validate_sample.py# 用 samples/ 中的样例跑全流程并打印校验指标
tests/                    # pytest；model.py 用合成 DataFrame 测试
```

`model.py` 只接收 extract.py 产出的 DataFrame，**不直接访问 trace_processor**，以便用合成数据测试。

## 2. 取数（extract.py）

trace_processor 以 `ingest_ftrace_in_raw=True` 加载。用 `extract_arg(arg_set_id, '<key>')` 取字段；
列名是 SQL 关键字时要加引号（如 `"index"`）。所有 ts 都是绝对 ns（int64）。缺失的事件返回空 DataFrame（列齐全）。

| DataFrame | 来源 | 列 |
|---|---|---|
| `bio_make` | `block_rq_mq_make_request` | ts, utid, pid, dev?(无), sector, rwbs, class, priority, is_ux_task, is_ux_loop, FG_META, bi_ioprio |
| `rq_insert` | `block_rq_insert` | ts, utid, dev, sector, nr_sector, bytes, rwbs |
| `rq_issue` | `block_rq_issue` | ts, utid, dev, sector, nr_sector, bytes, rwbs |
| `rq_complete` | `block_rq_complete` | ts, dev, sector, nr_sector, rwbs, error |
| `mq_complete` | `block_rq_mq_complete_request` | ts, dev, sector, req_tag, rq_log |
| `mq_requeue` | `block_rq_mq_requeue_request` | ts, dev, sector, req_tag, rq_log |
| `pc_start` | `tran_fs_pagecache_start` | ts, utid, major_dev, minor_dev, ino, offset, bytes, filebuf |
| `fm_add` | `mm_filemap_add_to_page_cache` | ts, utid, s_dev, i_ino, index |
| `blocked` | `sched_blocked_reason` | ts, pid, caller, io_wait |
| `dstate` | `thread_state where state in ('D','DK')` | utid, ts, dur, blocked_function |
| `threads` | `thread` ⟕ `process` | utid, tid, thread_name, upid, pid, process_name |
| `meta` | `metadata`、`stats`、`trace_bounds` | 设备信息、时间范围、`interned_data_tokenizer_errors`、`traced_buf_write_wrap_count` 等 |

有效时间窗：`[min(ftrace_event.ts), max(ftrace_event.ts)]`（RING_BUFFER 回绕后早期只有非 ftrace 数据，不能用 trace_bounds）。

## 3. 模型算法（model.py）

### 3.1 请求配对（核心）

键 `(dev, sector)`。对每个键按 ts 排序合并 insert / issue / complete 事件，跑状态机：

- `insert`：开一个新请求 `{t_insert}`。若该键已有**未 issue** 的请求，则旧请求视为被合并或丢失（计入 `quality.dropped_insert`），用新的替换。
- `issue`：如果有未 issue 的开放请求，就把它置为 issued（`t_issue_first = t_issue = ts`）；
  如果有已 issue 未完成的请求，视为 **requeue 后再次下发**：`issue_count += 1`，`t_issue = ts`（保留 `t_issue_first`）；
  两者都没有时（绕过调度器直接下发），直接开一个请求，`t_insert = NaN`。
  `bytes / nr_sector / rwbs` 以**最后一次 issue** 为准（merge 之后的最终大小）。
- `complete`：关闭该键上已 issue 的请求，`t_complete = ts`，`error`。找不到开放请求时计入 `quality.orphan_complete`。
- 到 trace 结束仍未完成：`t_complete = NaN`、`incomplete = True`（前端画到窗口末尾，计入 quality）。

衍生字段：`q_ns = t_issue_first - t_insert`（排队），`svc_ns = t_complete - t_issue`（最后一次下发的设备服务时间），
`total_ns = t_complete - (t_make or t_insert or t_issue_first)`。

`requeue_count` = `issue_count - 1`；若有 `mq_requeue`，再按 (dev, sector) 统计 `[t_issue_first, t_complete]` 内的条数，取二者的最大值，
并把最后一次的 `requeue_reason`（从 rq_log 用正则 `requeue_reason: (\d+)` 取出）挂到请求上。

`req_tag`：用 `mq_complete` 按 (dev, sector) 匹配，取 ts 与 `t_complete` 最接近且相差 ≤1ms 的那条。

### 3.2 提交者与优先级

`bio_make` 按 `sector`（无 dev）+ 时间向后匹配：取 `ts ≤ (t_insert or t_issue_first)` 且相差 ≤50ms 的最近一条，并要求 rwbs 的操作字母（R/W/D/F）一致。
匹配上的：`t_make`、`pid`（即 tid）、class、priority、is_ux_task、is_ux_loop、FG_META。

提交线程 utid：优先用 make_request 的 pid 在 `threads` 中按 tid 找（同 tid 多个 utid 时取时间范围包含 t_make 的；不行就取最新的）；
找不到再用 insert 事件的 utid，最后才用 issue 的 utid。

### 3.3 IO 类别（rwbs）

rwbs 首段字母：`F` 前缀 = preflush，`R` 读，`W` 写，`D` discard，`N` 无数据；后续标志：`F` FUA，`A` 预读，`S` 同步，`M` 元数据，`E` secure。

`cat` 枚举：`0 sync_read`（R 且无 A/M）、`1 readahead`（R+A）、`2 meta`（含 M，读写均算）、`3 write`、`4 flush`（F 前缀、FUA，或 N 带 flush）、`5 discard`、`6 other`。
判定顺序：discard → flush（仅 F 前缀或 N）→ meta → readahead → sync_read → write → other。FUA 写记为 write，但 `fua=1`。

优先级标志位 `prio_flags`（位掩码，前端画角标）：`1 RT`（class==1）、`2 IDLE`（class==3）、`4 UX`（is_ux_task 或 is_ux_loop）、`8 FG_META`、`16 SYNC`（S）、`32 META`（M）、`64 FUA`。

### 3.4 设备号与文件关联

- 文件系统设备号编码（Linux `new_encode_dev`）：`(minor & 0xff) | (major << 8) | ((minor & ~0xff) << 12)`。
  `pc_start` 的 (major_dev, minor_dev) 用它编码后与 `fm_add.s_dev` 比较。样例：254:131 → 65155。
- 文件表 `files`：键 `(s_dev, ino)`，名字取该键所有 `pc_start.filebuf` 的众数。没有名字的：ino ∈ {1, 2, 3}（f2fs node/meta/root 等内部 inode）标为 `FS元数据`，
  其他标为 `ino:<ino>`。`is_meta` 字段表示前者。
- **读批次**：`pc_start` 事件是一个批次的开始；同一线程之后的 `fm_add` 归入最近一个 `pc_start` 批次，条件是 ino 和 s_dev 都相同，且距上一条 fm_add 不超过 5ms。
  不满足的 fm_add 归入「无起点批次」（同线程、同 (s_dev, ino)、距离 ≤5ms 的连续 fm_add 合并为一个批次，`has_start=0`）。
  批次字段：`utid, ts(批次起点), t_last_add, file_id, page_first, page_count`。
- **请求 → 文件**：对读请求 R（提交线程 T，提交时间 `t_sub = t_make or t_insert or t_issue_first`），
  取线程 T 在 `(T 上一个读请求的 t_sub, t_sub]` 区间内的 fm_add，按 (s_dev, ino) 计数取众数作为文件，并记下对应批次 `batch_id`；
  `file_off = 这些页中最小 index × 4096`，`file_len = 页数 × 4096`，`file_src = 1`。
  若区间内没有 fm_add，则退回到 T 在 `t_sub` 之前 20ms 内最近的 `pc_start`：文件 = 该事件对应文件，offset = 事件 offset，`file_src = 2`。
  仍然没有就 `file_id = -1`、`file_src = 0`。写请求不做关联。
- **文件读取轨道**（线程上「正在读哪个文件」）：每个批次画成一个切片，`start = 批次 ts`，
  `end = max(批次 t_last_add, 关联到该批次的请求的 t_complete)`，标签是文件名和 offset 范围。

### 3.5 槽位分配（队列泳道）

按 dev 分组。每个请求的区间是 `[t_issue_first, t_complete]`（未完成的用窗口末尾）。按开始时间排序后贪心分配**编号最小的空闲槽位**，
空闲的条件是该槽位上一个请求的结束时间 ≤ 当前开始时间。泳道数 = 用到的最大槽位编号 + 1。

设备槽位上限 `slot_limit`：取所有 `rq_log` 里 `use_tag: (\d+)` 的最大值；没有则为 null。

### 3.6 D 状态与 block function

只保留**有 IO 的线程**（提交过请求，或有读批次）的 D 段。

- block function：先用 `thread_state.blocked_function`；为空时用 `blocked` 事件（tid 等于 pid），条件是 ts 落在 `[D.ts, D.ts + D.dur + 1ms]` 内，取最靠近 D 结束时刻的一条。
  caller 是整数时显示为 `caller#<n>`，`fn_resolved = 0`；同时取 `io_wait`（取不到为 -1）。
- 等待的请求（因果）：
  - 首选：同线程提交、且 `t_complete ∈ [D.ts, D.end + 50µs]` 的请求，`wait_src = 1`；
  - 若没有且 io_wait == 1：任意线程中 `t_complete ∈ [D.end - 100µs, D.end]`、离 D.end 最近的那个请求，`wait_src = 2`（推测，来自其他线程）；
  - 结果用 CSR 格式存储：`wait_off`（长度 = D 段数 + 1）+ `wait_req`。

### 3.7 数据质量（quality 列表）

每条 `{level: 'warn'|'info', code, msg}`，msg 用中文。检查项：RING_BUFFER 回绕（`traced_buf_write_wrap_count > 0`）及有效时间窗；
缺少 IO 事件（无 block_rq_*）；缺少传音事件（文件关联 / 优先级不可用）；block function 未符号化（caller 是整数且 `blocked_function` 全空），并附抓取建议（用更大 buffer 或 DISCARD 模式，确保 kernel symbols 被保留）；
orphan complete、未完成请求、被丢弃的 insert 的数量；`ftrace_cpu_overrun_end - ftrace_cpu_overrun_begin > 0`（录制期间有事件丢失）。

## 4. Payload（payload.py）

顶层 JSON，按列存储，字符串池化（`strs` 数组 + 列中存下标）；时间相对于 `t0 = 有效时间窗起点`，单位 ns，缺失值用 -1。

```jsonc
{
  "v": 1,
  "meta": {"name", "source", "t0_abs", "dur", "device": {...}, "generated", "tool_version"},
  "quality": [{"level","code","msg"}],
  "strs": ["..."],
  "procs":   {"upid":[], "pid":[], "name":[/*str idx*/]},
  "threads": {"utid":[], "tid":[], "name":[], "upid":[]},
  "devs":    [{"dev": 2080, "name": "8:32", "lanes": 38, "slot_limit": 28}],
  "req": {   // 按 t_issue_first 排序；数组下标即请求 id
    "dev":[], "sector":[], "bytes":[], "rwbs":[/*str*/], "cat":[], "prio":[/*prio_flags*/],
    "cls":[], "lvl":[], "t_make":[], "t_ins":[], "t_iss0":[], "t_iss":[], "t_cmp":[],
    "utid":[], "slot":[], "tag":[], "rq_n":[], "rq_reason":[], "err":[],
    "file":[], "foff":[], "flen":[], "fsrc":[], "batch":[]
  },
  "files":   {"name":[/*str*/], "dev":[], "ino":[], "meta":[]},
  "batches": {"utid":[], "ts":[], "end":[], "file":[], "page0":[], "pages":[], "start":[/*has_start*/]},
  "dst":     {"utid":[], "ts":[], "dur":[], "fn":[/*str*/], "fn_ok":[], "iow":[], "wait_off":[], "wait_req":[], "wait_src":[]},
  "requeues":{"ts":[], "req":[], "reason":[]}
}
```

JSON → gzip → base64，放进 `<script type="application/octet-stream" id="payload">`；前端用 `DecompressionStream('gzip')` 解压。

## 5. 前端（v1 范围）

见 requirements.md 第 6 节。轨道顺序：数据质量横幅 → 概览计数器（读 MB/s、写 MB/s、IOPS、在途深度、排队深度 + requeue 标记）→
设备队列（每个 dev 一组：槽位泳道 + 上限线）→ 进程组（按 IO 总字节倒序；组内线程同样排序；每个线程三行：D 状态 / IO 请求 / 文件读取）。
底部面板 Tab：当前选择、区域统计（进程 / 线程 / 文件 / 阻塞函数）、延迟分布、慢 IO、关键线程阻塞。
