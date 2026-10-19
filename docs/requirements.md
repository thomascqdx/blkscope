# IO Trace 可视化工具 — 需求与调研记录（讨论稿）

> 状态：需求确认中，未开始实现。标注 **[待确认]** 的条目需要用户拍板。

## 1. 目标

输入一个或多个 Android Trace 文件，离线生成**单个自包含 HTML**（不依赖 CDN / 网络），
在浏览器中以 Perfetto UI 的交互方式分析块设备 IO。

## 2. 样例 Trace 调研结论（StartUp_com.opera.mini.native_..._7.zip）

- zip 内为单个 Perfetto protobuf trace（209 MB），设备 Infinix X1202 / MT6878 / kernel 6.1 / Android SDK 37，Perfetto v54。
- RING_BUFFER 模式且已回绕：ftrace 有效数据仅约 **53200.43s ~ 53227.51s（≈27s）**。
- 抓取配置中的 IO 相关 ftrace 事件（数量）：

| 事件 | 数量 | 关键字段 | 用途 |
|---|---|---|---|
| `block/block_rq_insert` | 61,420 | dev, sector, nr_sector, bytes, rwbs, comm | 请求进入调度队列（提交者线程上下文） |
| `block/block_rq_issue` | 68,495 | 同上 | 下发到设备（driver） |
| `block/block_rq_complete` | 62,571 | dev, sector, nr_sector, rwbs, error | 完成（中断上下文，线程无意义） |
| `tran_block_feature/block_rq_mq_make_request`（传音定制） | 61,415 | pid, comm, rwbs, sector, bi_ioprio, class, data, priority, type, is_ux_task, is_ux_loop, FG_META, req_nr, transsion_cmd_flags | **IO 优先级 / UX 标记** |
| `tran_block_feature/block_rq_mq_complete_request`（传音定制） | 61,328 | dev, sector, __data_len, rwbs, req_tag, rq_flags, rq_log | 完成时的 **硬件 tag**（122 个不同值，max 191） |
| `tran_block_feature/block_rq_mq_requeue_request`（传音定制） | 11,631 | 同上 + rq_log 中 requeue_reason | 重新排队 |
| `tran_fs/tran_fs_pagecache_start`（传音定制） | 71,272 | major_dev, minor_dev, ino, offset, bytes, **filebuf（文件名）** | **当前 IO 读的是哪个文件** |
| `filemap/mm_filemap_add_to_page_cache` | 944,249 | pfn, i_ino, index, s_dev | 页缓存填充，可用 ino 关联文件名 |
| `filemap/mm_filemap_delete_from_page_cache` | 1,006,677 | 同上 | 页缓存回收 |
| `sched/sched_blocked_reason` | 73,320 | pid, caller, io_wait | **D 状态阻塞函数（block function）** |
| thread_state 中 `D` 状态 | 34,253 段 | — | 不可中断睡眠（多为 IO 等待） |

- 注意事项：
  - `tran_fs_pagecache_start.filebuf` 只有**文件基名**（如 `base.apk`、`base.odex`、`base.art`），没有完整路径；可用 (dev, ino) 区分同名文件。
  - `sched_blocked_reason.caller` 在本样例中是 **interned id（1~39）**，trace_processor 未能还原成函数名（`thread_state.blocked_function` 全为空）；
    stats 中 `interned_data_tokenizer_errors = 146547`，推测是环形缓冲区回绕导致携带 kernel symbol 字典的包被覆盖。
    → 工具需要：能解析时显示函数名，不能解析时降级显示（如 `caller#13`）并提示原因。
  - block 事件的 rwbs 标志：R/W/D(discard)/F(flush/FUA)/S(sync)/M(meta)/A(readahead) 等。
  - issue 次数 > insert/complete 次数，原因是 requeue 后会重复 issue；请求匹配需按 (dev, sector, nr_sector) + 时序做配对。
  - `block_rq_complete` 发生在中断上下文，所属线程不能作为 IO 归属；IO 归属应取 insert / make_request 的提交者（pid → 线程/进程）。
  - 写 IO 常由 kworker / f2fs 回写线程提交，不一定能归属到真实发起写入的 App。

## 2.1 文件关联：基于 `tran_fs_pagecache_start`（已用样例验证）

用户指定以传音定制事件 `tran_fs_pagecache_start` 作为文件关联依据。样例验证结果：

- `tran_fs_pagecache_start` 每次 `bytes=4096`（单页），之后 **100%** 紧跟同线程的 `mm_filemap_add_to_page_cache`
  （中位间隔 0.3µs），且 `ino` 相同、`index == offset/4096`。
  → 它是一次 page cache miss 读批次的起点；随后同线程的连续 `filemap_add` 是这批要从磁盘读的页（预读窗口）。
- 设备号对应：`filemap_add.s_dev = (major_dev << 8) | minor_dev`（例：65155 = 254<<8 | 131，dm 设备）。
  block 事件的 `dev`（例 2080 = 8:32，UFS LUN）是底层物理设备，与文件系统 dev 不同，**不能用扇区反查文件**。
- `filebuf` 只有基名；同一 (dev, ino) 的文件名可从任意一次 `tran_fs_pagecache_start` 建立全局映射 `(dev, ino) → filebuf`。
- 读请求（`block_rq_insert`, 60,235 个）回溯同线程：
  - 20ms 内存在 `tran_fs_pagecache_start`：90.8%（RAS 预读 96%，RS 61%，RSM 72%）；
  - 5ms 内存在 `filemap_add`：95.8%。
- 未关联上的主要是 `RS/RSM`（同步/元数据读），其前序 `filemap_add` 常为 `ino=1`（f2fs node/meta inode），属于文件系统元数据，本就没有文件名。
- 写请求仅 1,185 个，多由回写线程提交，无文件信息。
- `block_rq_mq_make_request.pid` 即提交线程 tid（100% 相等）。

**关联规则（拟定）**：读请求 R（线程 T、时间 t）→ 取 T 在 t 之前、且在 T 上一个 block 请求之后的 `filemap_add` 页集合，
按 (s_dev, ino) 聚合取主文件，再经 `(dev, ino) → filebuf` 得到文件名与 offset 范围；
若无 filemap_add 则回退到 T 最近一次 `tran_fs_pagecache_start`（容差 20ms）。
ino 为文件系统元数据 inode 时标为「FS 元数据」。所有关联结果在 UI 中标注为「推测」。

## 3. 需求理解（逐条）

1. **Block function**：在线程 D 状态段上显示阻塞函数（来自 `sched_blocked_reason` / `thread_state.blocked_function`），并支持按阻塞函数聚合。
2. **当前 IO 读的文件**：基于传音定制 `tran_fs_pagecache_start`（文件名、ino、offset、bytes），在线程上显示"正在读哪个文件"；
   并尝试把 block request 关联到文件（同线程、时间相邻的启发式关联）。
3. **框选时间段统计**：类似 Perfetto 的拖拽选区，动态计算选区内按 进程 / 线程 / 全局 的 IO 总量、IO 速度，按总量倒序展示。
4. **IO 队列泳道**：仿照 Perfetto CPU 核调度轨道，把 IO request 画成泳道，区分普通 IO 与高优先级 IO。
5. **点击 IO request 看详情**：IO 类型、IO 量，以及扇区、设备、提交者、优先级、各阶段耗时等。
6. **输入/输出**：支持 .zip/.trace/.ptrace/.pftrace/.perfetto-trace/.systrace/.atrace 及无后缀的文本 systrace / Perfetto 文件 → 输出单 HTML。
7. **交互**：快捷键与流畅度对齐 Perfetto UI（W/S 缩放、A/D 平移、鼠标拖拽框选、Ctrl+滚轮缩放、M 标记、F 聚焦选区、Esc 取消、? 帮助等）。

## 4. 技术方案初步设想（待需求确认后细化）

- 离线解析：Python（项目内 `.venv` 虚拟环境，不污染全局）+ Perfetto 官方 `trace_processor` 统一解析所有格式，提取 IO 相关数据。
- 输出：数据压缩后内嵌到 HTML，前端用原生 JS + Canvas 渲染（保证 10 万级矩形流畅），不依赖外部资源。
- 不嵌入全部 trace（HTML 体积会过大），只嵌入 IO 分析所需的数据。

## 5. 待确认 / 待补充

- 文本 systrace / atrace 样例：用户稍后提供到 `samples/`；届时验证 trace_processor 能否解析传音定制事件，不能则自写文本解析器。
- Perfetto 快捷键清单与交互细节：实现前按 Perfetto UI 实际行为逐项对齐（见 3.7）。

## 5.1 样例量化数据（支撑下面的建议，research/probe7.py）

| 指标 | 数值 | 含义 |
|---|---|---|
| 启动窗口 | `launchingActivity#1720` 2478ms（与文件名 2477ms 吻合），`reportFullyDrawn` 在其后 | 可自动识别启动窗口与目标包名 |
| 设备服务时间 issue→complete | p50 0.68ms / p99 5.3ms / max 68.8ms | 有明显长尾 |
| 排队时间 insert→issue | p50 4µs / p99 3.8ms / max 49.8ms | 排队偶发严重 |
| 请求大小 | 4KB 占 47%（29,020/62,340），512KB 预读 2,254 个 | 小块随机读为主 |
| 在途深度 | 最大 40；61.6% 时间为 0；深度 28 处有尖峰 | requeue 日志 `use_tag:28 lrb_use:0x0fffffff` → 设备 28 个槽位被占满 |
| 传音 `req_tag` | 122 个不同值，范围 53~191 | 是 blk-mq tag，**不是硬件槽位**，直接当泳道会稀疏且无意义 |
| requeue | 11,631 次；reason 2 占 9,911 | 主要是设备槽位满 |
| 优先级字段 | class RT=2,481 / BE=58,934；`is_ux_task` 全 0；`FG_META=1` 3,360 | 本场景 UX 标记没有生效 |
| page cache 重复缺页（refault） | 944,249 次 add 中 460,341 次是 trace 内先被删、后又被加回的页（48.8%，约 1.8GB） | 内存压力大，**同样内容反复从磁盘读** |
| 后台干扰 | `com.transsion.smartpanel` 636MB > 目标 App 528MB | 启动期间后台 IO 抢占 |
| 目标 App 主线程 D 状态 | 1,272 段，共 1,262ms，最长 32.6ms | 关键线程被 IO 阻塞 |

## 5.2 专业建议（待用户选择）

**对已定方案的修正建议**
- 队列泳道：`req_tag` 不是硬件槽位 → 建议**按时间贪心分配槽位**（泳道数 = 最大并发），画出设备槽位上限线（28），真实 tag 放在详情里展示。
- 颜色：`is_ux_task` 在本样例全为 0，只用优先级上色时几乎全是一个颜色 → 建议**主色按 IO 类别（同步读/预读/元数据/写/flush）**，
  优先级用边框/角标表示，并支持快捷键切换配色模式（类别 / 优先级 / 进程 / 延迟）。

**P0（建议首版就做）**
1. 顶部概览计数器轨道：读/写吞吐 MB/s、IOPS、在途深度、排队深度，并标出 requeue 点。
2. D 状态 → IO 因果：点击线程的 D 段时，高亮它等待的请求（该线程在途、并在其唤醒前完成的请求），用 Perfetto 式 flow 箭头连到队列泳道。
   另给出「关键线程（主线程/RenderThread）IO 阻塞排行」。
3. 启动场景自动识别：从文件名 / `launching:` 切片识别目标包名和启动窗口，**目标进程置顶**，并一键把启动窗口设为选区。
4. 延迟拆解与慢 IO：区分排队时间和设备时间，选区内给出延迟直方图与分位数，慢 IO 高亮（阈值可调）+ Top N 列表。
5. 数据质量提示：环形缓冲回绕、有效时间窗、事件丢失、未配对请求、符号缺失。

**P1**
6. Page cache refault 分析：按文件统计重复读取量（样例 48.8%）。
7. 队列饱和与 requeue 分析：按 reason 分类，标出槽位满（28）的时间段。
8. 优先级反转检测：高优先级请求在排队，而低优先级请求占着设备时打标记。
9. 访问模式：请求大小分布、顺序/随机比例、文件内 offset 访问热图。
10. 搜索/过滤（进程、文件、rwbs、优先级、延迟 > N）与表格导出 CSV。

**P2**
11. 诊断首页：自动给出结论（如「启动期间后台 smartpanel 读 636MB」「主线程 IO 阻塞 1.26s」）。
12. 多 Trace 对比（A/B）：导出摘要 JSON，再生成对比页。

## 6. 讨论结论

- 传音定制事件 `tran_fs_pagecache_start` 记录读取文件名，工具必须适配（用户确认）。
- Python 依赖必须装在项目虚拟环境 `.venv` 中，不污染全局（用户要求）。
- 文件关联以 `tran_fs_pagecache_start` 为依据（用户指定），规则见 2.1，启发式关联结果标注「推测」。
- 队列泳道：按**硬件 tag/槽位**划分（有传音 `req_tag` 用真实 tag，否则按时间贪心分配槽位），矩形 = issue→complete。
- 高优先级判定：综合 **ioprio class（RT/BE/IDLE）+ 传音 UX 标记（is_ux_task/is_ux_loop/FG_META）+ rwbs 标志（S/M/F/A）**，用颜色/标记区分。
- 多个输入 Trace：**每个 Trace 输出一个 HTML**。
- 轨道范围：**只要 IO 轨道** = 设备队列泳道 + 有 IO 的线程各一组轨道（该线程提交的 request、读取的文件、D 状态+block function），按进程分组可折叠；不含 CPU 调度和普通 atrace 切片。
- 框选统计：IO 速度 = **总量 / 选区时长**；列包含读/写/discard/flush 分开、请求数、平均/最大排队时间与服务时间、线程 D 状态时长；另有**按文件聚合** Tab。
- 跨选区边界的 request：按 issue→complete 与选区的**重叠比例分摊**字节数。
- 交付形式：**先 Python CLI（.venv，trace_processor 二进制随项目放置，可离线），稳定后再 PyInstaller 打包 exe**。
- block function 符号缺失时：**显示 `caller#<id>` 并可按 id 聚合，页面顶部提示内核符号缺失原因及抓取建议**。
- 队列泳道修正为：**按时间贪心分配槽位（泳道数 = 最大并发）+ 设备槽位上限线**，真实 `req_tag` 只在详情中展示（取代前面"有 req_tag 就用真实 tag"的方案）。
- 配色：主色按 IO 类别（同步读/预读/元数据/写/flush），优先级用边框/角标，支持切换配色模式；数据质量提示默认做。
- 采纳的建议功能：
  - 首版：概览计数器轨道、D 状态 → IO 因果（含关键线程 IO 阻塞排行）、延迟拆解与慢 IO。
  - 第二版：Page cache refault 分析、队列饱和 / requeue 分析。
  - 其他：搜索过滤 + 导出 CSV、诊断首页。
- 暂不做（backlog）：启动场景自动识别与目标进程置顶、优先级反转检测、访问模式分析、多 Trace A/B 对比。
