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

## 3.8 实现修订（基于样例数据，取代上文对应条目）

- 3.2：make_request 匹配**额外限定为提交线程**（insert 的 utid，直接下发的用 issue 的 utid）+ sector + 操作字母 + 50ms。
  原因：只按 sector 匹配时，热点共享文件的扇区会匹配到其他线程的 make 事件。
- 3.1：requeue 事件的匹配窗口从 `t_insert`（没有则 `t_issue_first`）开始，因为传音的 mq requeue 多发生在 insert 和首次 issue 之间。
- 3.5：槽位区间改为 **`[t_issue（最后一次下发）, t_complete]`**，即真正占用设备的时间段；
  之前被 requeue 的那几次下发不占槽位（在详情中展示）。未完成请求的区间终点取 `min(t_max, t_issue + 200ms)`。
  这样泳道数应该接近实际的最大在途数（样例约 33）。
- 3.5：`slot_limit` **按 dev 分别统计**，只解析该 dev 的 mq 事件的 rq_log；没有就是 null。样例中 8:32 为 32。
- 设备类型 `kind`：major 7 是 `loop`（loop 设备的 IO 会再落到底层物理设备，算全局总量时会重复计入）；major 0 是 `other`；其余是 `disk`。
  前端的全局 / 进程统计**默认只算 `disk`**，可以切换为包含 loop。
- 文件提示 `hint`：同一个基名（如 `base.apk`）会对应很多不同文件。每个文件取关联读字节数最多的进程名作为 hint，前端显示成 `base.apk · com.xxx`。
- 读批次被 5ms 间隔切开后，后面子批次的起点是该子批次第一个 fm_add 的时间，`has_start` 为 0（只有第一个子批次的起点是 pc_start）。
- 3.1 补充（样例发现）：**无数据请求**（issue 的 nr_sector == 0，如 `FFS` flush）不适用 requeue 解释。
  同一个键上的每次 issue 都开一个新请求；如果之前在途的同键无数据请求一直没有 complete，就把它关闭为「complete 丢失」（`cmp_lost = 1`，t_cmp 仍为 NaN）。
  样例中 8:32 sector 0 的 137 次 FFS issue 都没有 complete 事件，原逻辑会把它们拼成一个 24.5s 的 requeue。
- 所有 `cmp_lost = 1` 的请求（包括 trace 结束时仍在途、但同键之后还有事件的情况）都按**零长度**处理：区间终点 = t_iss，不使用 +200ms，
  不进入在途深度和槽位占用的计算，在泳道上画成 1px 的标记。只有 trace 结束时真正还在途的请求，才使用 `min(t_max, t_iss + 200ms)`。
  payload 的 req 增加列 `lost`（0/1）。数据质量增加一条 info：「N 个请求没有 complete 事件（多为 flush，内核未上报 block_rq_complete），仅标注下发时刻」。
- zip 解包要防止路径穿越（成员路径必须落在临时目录内）；每个 trace 处理完要关闭 trace_processor 进程。

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
  "devs":    [{"dev": 2080, "name": "8:32", "kind": "disk", "lanes": 33, "slot_limit": 32}],
  "req": {   // 按 t_issue_first 排序；数组下标即请求 id
    "dev":[], "sector":[], "bytes":[], "rwbs":[/*str*/], "cat":[], "prio":[/*prio_flags*/],
    "cls":[], "lvl":[], "t_make":[], "t_ins":[], "t_iss0":[], "t_iss":[], "t_cmp":[],
    "utid":[], "slot":[], "tag":[], "rq_n":[], "rq_reason":[], "err":[],
    "file":[], "foff":[], "flen":[], "fsrc":[], "batch":[]
  },
  "files":   {"name":[/*str*/], "dev":[], "ino":[], "meta":[], "hint":[/*str，进程名或空*/]},
  "batches": {"utid":[], "ts":[], "end":[], "file":[], "page0":[], "pages":[], "start":[/*has_start*/]},
  "dst":     {"utid":[], "ts":[], "dur":[], "fn":[/*str*/], "fn_ok":[], "iow":[], "wait_off":[], "wait_req":[], "wait_src":[]},
  "requeues":{"ts":[], "req":[], "reason":[]}
}
```

JSON → gzip → base64，放进 `<script type="application/octet-stream" id="payload">`；前端用 `DecompressionStream('gzip')` 解压。

## 5. 前端（v1 范围）

### 5.1 构建方式
- `web/index.html` 是模板，占位符为 `__TITLE__`、`/*__CSS__*/`、`/*__JS__*/`、`__PAYLOAD__`。
  `html.py` 按 `web/manifest.json`（`{"css": [...], "js": [...]}`）的顺序内联文件；JS 中的 `</script` 要转义成 `<\/script`。
- 原生 JS，不用构建工具和第三方库。每个文件都是 classic script + `'use strict'`，通过全局命名空间 `IOT` 共享。
- payload 放在 `<script type="application/octet-stream" id="payload">`，解码流程是 base64 → `DecompressionStream('gzip')` → JSON → 转成 TypedArray。

### 5.2 数据准备（data.js）
- 列转换为 TypedArray：时间用 `Float64Array`（-1 表示缺失），其余用 `Int32Array`。
- 建立的索引：每个 dev 每个槽位的请求 id 列表（按 t_iss 排序）；每个线程的请求行（按 `[t_sub, t_cmp]` 贪心打包成多个子行，`t_sub = t_make|t_ins|t_iss0`）；
  每个线程的批次和 D 段（按 ts 排序）。
- 排序：进程按 IO 总字节（默认只算 `kind=disk` 的设备）倒序，进程内的线程也一样。只展示有 IO 的线程（有请求或读批次）。
- 计数器：基础分箱 100µs，读字节、写字节、IOPS 按 issue→complete 的重叠比例分摊到各箱；在每 10 倍粒度上建一层 mipmap，渲染时按缩放级别选层，每像素取 max 或 avg。
  在途深度（issue→complete）和排队深度（insert→issue）用精确的阶梯函数（±1 事件排序后求前缀和），每像素取 max。

### 5.3 布局（参考 Perfetto）
- 顶部：标题栏（trace 名、设备信息、`?` 帮助按钮）→ 数据质量横幅（warn 级别，可折叠）→ 全局概览条
  （全 trace 吞吐缩略图 + 当前可视窗口的刷选框，可拖动）→ 时间刻度尺（相对 t0；标记、选区范围显示在尺上）。
- 中部：左侧轨道名列（宽约 260px，组可以折叠/展开，显示 ▸/▾），右侧 Canvas（适配 devicePixelRatio，可纵向滚动）。
- 底部：可拖动高度的详情面板，带 Tab（Stage 2 先做「当前选择」，其余 Tab 在 Stage 3 实现）。
- 轨道树：
  1. **概览**组（默认展开）：读 MB/s、写 MB/s、IOPS、在途深度（叠加 slot_limit 虚线）、排队深度（叠加 requeue 刻度标记）。
  2. **设备队列**：每个 dev 一组，组名形如 `8:32 (disk) · 33 槽位 · 上限 32`。展开后每个槽位一行，矩形是请求的 `[t_iss, t_cmp]`。
     编号 ≥ slot_limit 的行底色加深，并在 slot_limit 处画分隔线，标注「设备上限」。组折叠时显示一行在途深度热力条。
     loop / other 类型的设备默认折叠。
  3. **进程组**（默认折叠）：折叠时显示该进程所有请求的密度汇总行。展开后每个线程一个子组，包含 3 行：
     `D 状态`（D 段，标签为 block function；io_wait=1 用深色）、`IO 请求`（`[t_sub, t_cmp]`，可能有多个子行）、
     `文件读取`（批次切片，标签为 `文件名 · hint +offset (N 页)`）。没有数据的行不显示。
- 矩形绘制：二分查找可视范围；宽度不足 1px 的矩形按像素合并（同一行同一像素只画一次，最小宽度 1px）；宽度 >30px 时在矩形内画截断标签。
- 颜色（默认「类别」配色）：sync_read 蓝 `#4e79a7`、readahead 青 `#59a5a8`、meta 紫 `#9c6ade`、write 橙 `#f28e2b`、flush 棕 `#9c755f`、discard / other 灰 `#9e9e9e`；
  优先级角标：RT 在顶部画 2px 红条、UX 在左上角画品红三角、FG_META 在右上角画黄三角；未完成的请求用斜线填充；
  慢 IO（total ≥ 阈值，默认 10ms）加红色描边。D 状态用 `#e8763a`，io_wait=1 时用 `#c0392b`。文件切片按文件名哈希取色相。
- 悬停：画竖向十字线，刻度尺上显示时间；tooltip 显示条目摘要（类型、大小、耗时、进程/线程、文件）。

### 5.3.1 请求生命周期分段展示（v1.1）

一个请求的阶段（某个时间点不存在、或该段长度 ≤ 0 时，就不画这一段）：

| 阶段 | 区间 | 线程「IO 请求」行的画法 | 调度队列行的画法 |
|---|---|---|---|
| bio 提交 | `[t_make, t_ins]` | 类别色 30% 不透明度，高度为行高的 40%，垂直居中 | 不画 |
| 调度排队 | `[t_ins, t_iss0]` | 类别色 55% 不透明度，高度为行高的 60%，垂直居中 | 同左 |
| requeue 等待 | `[t_iss0, t_iss]`（只有 requeue 过的请求才有） | 类别色 55% 不透明度，高度 60%，叠加斜线 | 同左 |
| 设备服务 | `[t_iss, svcEnd]` | 实色、满高度（和泳道一致；未完成的请求仍用斜线） | 不画（在设备槽位行里） |

- 整个请求宽度 < 3px 时不分段，用实色画 1px。角标、慢 IO 红框都按**整个请求**的外框来画。标签画在设备服务段上；服务段 <30px 而整体 ≥30px 时，标签画在整体上。
- 悬停 tooltip 第一行显示鼠标所在的阶段和该阶段的耗时，例如「调度排队 2.31 ms」，然后是原来的摘要。
- 详情面板的阶段耗时增加一项「首次 issue→最后 issue（requeue 等待）」。
- **调度队列行**：每个设备组里、槽位行**上方**加一个子组「调度队列 · 峰值 N」，默认折叠；折叠时在标题行显示该设备的排队深度热力条。
  展开后，把每个请求的排队区间 `[t_ins | t_iss0, t_iss]` 按开始时间贪心分配到最小编号的空闲行（和槽位分配算法相同）；
  行数 N = 该设备的最大同时排队数，排队区间为空的请求不进入。
- flow：选中请求时，如果调度队列行里的矩形可见，就从它的末尾（最后一次 issue）画箭头到槽位行矩形的开头，并描边高亮队列行里的矩形。
- 图例：配色图例旁注明「实色=设备服务(≈Running) · 浅色细条=调度排队(≈Runnable) · 斜线=requeue 等待」；帮助浮层里也加上这句说明。
- 单击线程标题行（`thead` 行）在「当前选择」里显示该线程的汇总：请求数、读/写字节、排队（≈Runnable）累计/平均/最大、
  服务（≈Running）累计/平均/最大、D 状态时长（统计全 trace）；选中时左侧轨道名高亮。

### 5.4 交互（与 Perfetto 一致；依据 Perfetto 源码 help_modal.ts 和 CoreCommands）
| 操作 | 行为 |
|---|---|
| `W` / `S` | 以鼠标所在位置为中心放大 / 缩小，按住时连续、平滑（rAF 动画，松开即停） |
| `A` / `D` | 向左 / 右平移，按住时连续 |
| `Ctrl` + 滚轮 | 以鼠标位置为中心缩放 |
| 滚轮 | 纵向滚动轨道；`Shift` + 滚轮或触控板横向滑动 = 横向平移 |
| 单击 | 选中条目（请求 / D 段 / 批次 / 计数器点），点在空白处则清除选中 |
| 单击 + 拖动 | 区域选择（时间范围 + 拖过的轨道）；在刻度尺上拖动 = 选择时间范围（覆盖全部轨道） |
| `Shift` + 单击 + 拖动 | 平移 |
| `F` | 把视图缩放到当前选中条目或区域 |
| `Esc` | 取消选择 |
| `Ctrl` + `A` | 选中整个 trace 作为区域；最近一次鼠标按下在底部面板内时改为全选面板文字 |
| `R` | 把选中的条目转成区域选择（时间范围取该条目的范围） |
| `M` / `Shift` + `M` | 标记当前选中的时间范围：M 是临时标记（只保留一个），Shift+M 是持久标记（可以多个）；以竖向半透明带 + 刻度尺旗标显示 |
| `[` / `]` | 在当前选中条目所在行，跳到上一个 / 下一个条目，视图跟随 |
| `/` | 聚焦搜索框（Stage 2 只做框，搜索逻辑在 v2） |
| `?` | 显示 / 隐藏快捷键帮助 |
| `Q` | 收起 / 展开底部面板（抽屉式，收起后保留 Tab 栏；点击任意 Tab 或拖动分隔条也会展开；选择变化不自动展开） |
| 点击组标题 | 展开 / 折叠该组 |

焦点在输入框时不响应单键快捷键。底部面板内文字可用鼠标选中、Ctrl+C 复制（表格行改为 `click` 触发，拖动选中文字时不跳转）。

### 5.5 底部面板（Stage 3）

**统计窗口 W = [w0, w1]**：有区域选择时取选区的时间范围（**不按拖过的轨道过滤**，统计窗口内的全部数据）；没有选区时取整个 trace，面板上注明「未框选，统计全 trace」。
设备过滤：默认只算 `kind=disk`；勾选标题栏的「含 loop 设备」后算全部设备。

**请求的计量口径（唯一实现在 `IOT.stats`，所有 Tab 共用）**：
- 请求区间 `[s, e] = [t_iss, t_cmp]`；未完成的请求 `e = min(dur, t_iss + 200ms)`（与槽位一致）；没有 t_iss 的请求不计入。
- 重叠比例 `f = |[s,e] ∩ W| / (e - s)`；当 `e == s` 时，s ∈ W 则 f = 1，否则 f = 0。
- 计入字节 = `bytes × f`；「请求数」= f > 0 的请求个数（整数）。
- 读 / 写 / 其他按 rwbs 的操作字母分：R → 读（含 meta / 预读），W → 写，D / F / N 等 → 其他。
- 速度 = 计入字节 / (w1 - w0)，单位 MB/s（1 MB = 1048576 B）。
- 排队 q = `t_iss0 - t_ins`（有 insert 才算），服务 svc = `t_cmp - t_iss`（已完成才算），总耗时 total = `t_cmp - (t_make | t_ins | t_iss0)`；平均值和最大值都取 f > 0 的请求。
- D 状态时长 = `|[ts, ts+dur] ∩ W|` 求和（只算有 IO 的线程的 D 段）。

**Tab**
1. 当前选择：条目详情（已有）。有框选时改为选区摘要 —— 选区范围 / 时长 / 覆盖轨道、请求数、总量 / 读 / 写 / 其他、
   读速度 / 写速度 / 总速度（与区域统计同一口径：`IOT.stats`），并注明分摊口径与设备过滤；
   下方是「进程 / 线程」和「Top 5 / 10 / 20」（默认进程、10）两组切换，以及「读速度 Top N」「写速度 Top N」
   两个并排榜单（列：排名、名称、速度、字节、占比；该操作字节为 0 的实体不进入；点击行定位到对应轨道）。
   榜单逻辑是 `IOT.statsMod.topN(S, kind, op, n)`。
2. 区域统计：子视图有「进程 / 线程 / 文件 / 阻塞函数」。表头点击排序，默认按总量倒序；第一行是「全部」合计。
   - 进程 / 线程的列：名称、总量、读、写、其他、读速度、写速度、总速度、占比%、请求数、平均/最大排队、平均/最大服务、D 状态时长。线程行显示「线程名 (tid) · 进程名」。
   - 文件的列：文件（`name · hint`，统一标「推测」）、读量、请求数、进程数、平均服务。另有「未关联」和「FS元数据」两行。
   - 阻塞函数的列：block function、D 段数、D 总时长（窗口内重叠）、io_wait=1 的段数、平均/最大时长、线程数。
   - 点击某行：进程 / 线程行展开并滚动到对应轨道；文件行高亮该文件的读取切片（Stage 3 先做到滚动到读量最大的那个线程）。
3. 延迟分布：取 `t_cmp ∈ W` 的请求，画排队、服务、总耗时三个对数分箱直方图（边界 1µs, 10µs, 50µs, 100µs, 200µs, 500µs, 1ms, 2ms, 5ms, 10ms, 20ms, 50ms, 100ms, ∞）
   和 p50 / p90 / p99 / max；可按类别筛选（全部 / 同步读 / 预读 / 元数据 / 写）。
4. 慢 IO：W 内（f > 0）`total ≥ 阈值`的请求，按 total 倒序取前 500。列：开始时间、总耗时、排队、服务、大小、rwbs、优先级标志、进程/线程、文件。点击行选中该请求并把视图居中到它。
5. 关键线程阻塞：线程范围是有 IO 的进程中的主线程（tid == pid）和名为 `RenderThread` 的线程。
   列：进程、线程、D 时长（W 内）、io_wait=1 的时长、有等待请求的 D 段数、所等待请求的总耗时之和、最长 D 段（点击跳转）。按 D 时长倒序。

**其他**
- 慢 IO 阈值：标题栏有输入框（ms，默认 10），同时影响红色描边和「慢 IO」Tab。
- flow 箭头：选中 D 段时，从 D 段末尾（唤醒点）画箭头到它等待的每个请求。请求在线程的「IO 请求」行可见就画到那里，所在设备槽位行可见也画到那里；wait_src=2 用虚线。
  选中请求时，从线程行的请求矩形画箭头到它的槽位矩形，并高亮等待过它的 D 段（建反向索引）。
- `C` 键循环切换配色：类别 → 优先级 → 进程 → 延迟。标题栏显示当前配色和图例。
  - 优先级配色：RT 红、UX 品红、FG_META 黄、SYNC 蓝、其余异步灰、IDLE 深灰，按这个顺序取第一个命中的。
  - 进程配色：按 upid 哈希取色相。
  - 延迟配色：按 total 在对数刻度 0.1ms → 20ms 上从绿到黄再到红渐变。

### 5.6 图例与内嵌使用手册（v1.2）

**图例浮层**（`web/js/legend.js`，`IOT.legend.toggle(force)`）
- 打开方式：标题栏「图例」按钮、`L` 键、点击「配色: …」文字；`Esc` / 点击背景关闭。图例、帮助、手册三个浮层互斥（打开一个会关闭其他）。
- 色块**直接取 render.js 导出的颜色常量**（`IOT.render.PAL`：类别色、优先级色、计数器色、D 状态色、延迟色函数），不在图例里另写一份颜色值。
- 每次打开都重新生成内容（慢 IO 阈值等取当前值）；浮层打开时按 `C` 切换配色，「当前」标记要跟着更新。
- 内容分节：① 请求颜色——四种配色模式都列出，当前模式标「当前」；类别模式按「读：同步读 / 预读 / 元数据（读写都算）」「写」「其他：flush / discard / other」分组；
  ② 计数器与顶部缩略图（读蓝 / 写橙 / IOPS / 在途深度 / 排队深度、上限虚线、requeue 刻度）；③ 生命周期分段；④ 角标与描边（RT / UX / FG_META / FUA / 未完成斜线 / 慢 IO 红框（显示当前阈值）/ 选中蓝框）；
  ⑤ 线程轨道（D 状态、io_wait、文件读取按文件名取色并标「推测」）；⑥ 热力条与设备上限；⑦ 叠加标记（flow 箭头实线 / 虚线 = 推测、区域选择、临时 / 持久标记）。

**内嵌手册**
- 唯一来源 `web/manual.md`（随 web/ 一起打包）；`web/manifest.json` 增加 `"manual": "manual.md"`。
- `src/iotrace/mdlite.py` 在生成时把 Markdown 子集转成 HTML（标题 `#`~`###`、段落、有序 / 无序列表（可按缩进嵌套）、GFM 表格、围栏代码块、引用、行内代码 / 粗体 / 链接），所有文本先做 HTML 转义；标题按顺序生成 id `m-<n>`。
- `html.py` 把结果替换到模板占位符 `<!--__MANUAL__-->`，**最后一个**替换（避免手册正文里的占位符字样被二次替换）；manifest 没有 manual 时替换为空。
- 前端：标题栏「手册」按钮打开全屏浮层，左侧目录（h2 / h3，点击滚动到对应位置），右侧正文可选中复制；帮助浮层里也有「打开完整使用手册」链接。
- 浮层打开时，除 `Esc` / `?` / `L` 外的单键快捷键不响应；手册打开时 `Ctrl+A` 只全选手册正文。
