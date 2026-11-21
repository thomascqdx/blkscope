# blkscope（块设备 IO Trace 可视化工具）— 需求与调研记录（讨论稿）

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
- 队列泳道修正为：**按时间贪心分配槽位（泳道数 = 最大并发）+ 设备槽位上限线**（上限取该设备 rq_log 中 `use_tag` 的最大值；实现时发现样例中是 32，不是 28），真实 `req_tag` 只在详情中展示（取代前面"有 req_tag 就用真实 tag"的方案）。
- 配色：主色按 IO 类别（同步读/预读/元数据/写/flush），优先级用边框/角标，支持切换配色模式；数据质量提示默认做。
- 采纳的建议功能：
  - 首版：概览计数器轨道、D 状态 → IO 因果（含关键线程 IO 阻塞排行）、延迟拆解与慢 IO。
  - 第二版：Page cache refault 分析、队列饱和 / requeue 分析。
  - 其他：搜索过滤 + 导出 CSV、诊断首页。
- 暂不做（backlog）：启动场景自动识别与目标进程置顶、优先级反转检测、访问模式分析、多 Trace A/B 对比。
- 框选摘要：「当前选择」Tab 在框选后显示系统整体读速度 / 写速度 / 总速度，以及进程或线程的「读速度 Top N」「写速度 Top N」两个倒序榜单（N 可选 5/10/20，默认 10）；字节按重叠比例分摊，速度 = 字节 / 选区时长（与区域统计同一口径）。
- 区域统计的进程 / 线程表把速度拆成「读速度 / 写速度 / 总速度」三列。
- 底部面板支持快捷键 Q 收起 / 展开（抽屉式，收起后保留 Tab 栏）；面板内文字可以鼠标选中并 Ctrl+C 复制。
- 排队时间（insert→issue）已在线程「IO 请求」行分段显示；图例注明「调度排队 ≈ Runnable，设备服务 ≈ Running」；单击线程标题行显示该线程的排队 / 服务汇总。
- 颜色图例：标题栏加「图例」按钮（也可按 `L` 或点击「配色: …」文字），弹出完整图例浮层：当前配色模式下哪种颜色是读、哪种是写，以及计数器、生命周期分段、角标、D 状态、热力条、标记等所有颜色/记号的含义。不常驻占用纵向空间（用户选择）。
- 使用手册：面向组内工程师，**内嵌进每个 HTML**（标题栏「手册」按钮打开全屏浮层，带目录），同时在仓库保留 Markdown 版本 `web/manual.md`（唯一来源，生成 HTML 时转换内嵌）。
- 目录输入：命令行输入可以是目录（可与文件混用），**只扫描第一层**、不递归子目录（用户选择）；目录内文件按名称排序，`.zip` 照常解包，其他文件按内容嗅探，非 trace 文件跳过并在终端提示跳过数量；blkscope 自己生成的 HTML（`<meta name="generator" content="blkscope …">`）和 `*.payload.json` 不当作 trace。目录中没有 trace 时给出警告，其余输入照常处理。显式给出的单个文件不做嗅探（保持原行为，解析失败时报错）。
- 选区轨道过滤（Perfetto 式 area selection）：框选的状态是 `tracks = Set<leaf key> | null`，**null = 全部轨道 = 不过滤**（与旧行为一致）。leaf key：`ctr:<metric>`、`lane:<di>:<slot>`（设备槽位泳道）、`qlane:<di>:<slot>`（调度队列）、`treq:<utid>`（一个 key 覆盖该线程所有 IO 请求子行）、`dstate:<utid>`、`files:<utid>`。画布拖动覆盖的轨道决定初始集合（**已展开**组头的轨道由其可见子行决定，折叠组头贡献全部 leaf）；刻度尺拖动 / Ctrl+A = 全部（null）；`R` = 条目所在行的 leaf。有选区时轨道名前有复选框（组头三态），「当前选择」里可全选 / 反选 / 清空。过滤语义：`lane`/`qlane` 选中该道的请求、`treq` 选中该线程全部请求、`files` 只算该线程关联到文件的读请求、`dstate` 决定该线程的 D 段是否计入（D 时长 / 阻塞函数 / 关键线程阻塞都以它为准）；`ctr:*` **不参与过滤**，只控制选区摘要里的「计数器（选区内）」表（全局口径 仅 disk / 含 loop，平均按 buildCounters 同款区间规则精确重算，峰值取 100µs 桶最大值）。只勾选 ctr 轨道时请求 / D 统计为空并给出提示。统计实现仍在 `IOT.stats` 一处。
- 区域统计「文件」页只显示文件名，**不再拼接全局 `· hint`**（用户反馈：只勾选单个线程时，`libaudioclient.so · screencap` 这类全局主读者标签让人误以为混入了其他线程读的文件）。该页只展示勾选轨道在框选范围内的数据，不掺入选区以外的信息；其他位置（请求 / 批次详情、文件读取轨道标签、悬停、慢 IO 表）保持不变。
- 版本号：语义化版本 `MAJOR.MINOR.PATCH`，唯一来源 `src/blkscope/__init__.py` 的 `__version__`（pyproject 动态读取）；`blkscope --version` 查看；版本号同时写入生成的 HTML（payload `meta.tool_version` + 标题栏可见 + generator meta 标签）。升级规则写在 `AGENTS.md`。
- 与 Perfetto UI 时间对齐（用户反馈：无法在 HTML 中准确标出 Perfetto 里分析的场景阶段）：根因是零点不同——Perfetto UI 的时间轴原点是 `trace_bounds.start_ts`（整个 trace 最早的数据），blkscope 内部 t=0 是 `min(ftrace_event.ts)`（ftrace 有效窗口起点）；RING_BUFFER 回绕时两者相差很大（样例 88.354s），且每个 trace 不同。方案（用户选择方案 1+2）：
  - **统一时间基准（只改显示）**：payload `meta.trace_start_abs` = `trace_bounds.start_ts`（缺失或晚于 `t0_abs` 时取 `t0_abs`；旧 payload 无此字段同样回退）。payload 内部时间列仍相对 `t0_abs`，格式不变。前端所有「时刻」（刻度尺、悬停、选区范围、请求 / D 段 / 读批次详情、计数器时间、慢 IO 时间列）按当前时间基准显示，「时长」不变。三种基准，标题栏「时间: …」点击循环切换，默认 Perfetto：
    - `Perfetto`：相对 trace 起点，格式与 Perfetto UI 默认 Timecode 一致 `[Dd]HH:MM:SS.mmm uuu nnn`；
    - `原始 ns`：绝对时间戳整数（对应 Perfetto 的 Raw 格式）；
    - `窗口相对`：相对 ftrace 有效窗口起点（旧行为）。
  - **定位输入（快捷键 G / 标题栏「定位」）**：输入起点、可选终点、可选名称。解析规则：Timecode（`HH:MM:SS.xxx…`，可带 `Nd` 天数前缀，任意空白 / 细空格忽略）一律按 Perfetto 起点；纯整数（可带千分位逗号 / 空白）一律按绝对 ns；带单位（s/ms/us/µs/ns）或带小数无单位（按秒）的数值按**当前时间基准**。超出 ftrace 有效窗口的部分截断并提示，完全在窗口外报错。有终点 → 设为选区（全部轨道）并缩放到该范围；只有起点 → 居中并放临时标记；「添加标记」→ 持久标记（可带名称，有终点时画成区间）。对话框列出已有持久标记，可一键设为选区或删除。「当前选择」的选区摘要额外显示原始 ns 起止，便于回贴到 Perfetto。
- Release 构建：双击仓库根目录 `build_release.bat` 即可（用户要求；bat 负责检查 .venv、缺 PyInstaller 时自动装进 .venv、透传参数、双击运行时结束后暂停，构建逻辑在 `scripts/build_release.py`）一键产出 Windows 发布包——检查工作区干净 → 获取/校验 trace_processor → 跑单测 → PyInstaller 打成**单文件 exe**（内置 trace_processor 与 web/ 资源，完全离线，无需 Python）→ 用 exe 冒烟（`--version` + 跑测试 fixture 生成 HTML）→ 打包 `dist/blkscope-<版本>-windows-x64.zip`（exe + README + LICENSE + 使用手册）并输出 sha256。exe 内 trace_processor 查找顺序：`BLKSCOPE_TP` > 包内 `tools/` > 仓库 `tools/`。

## 7. Block RQ 报告（v0.6.0，已确认）

背景：用户已有 `block_rq_pars_enhanced.py`（纯文本日志统计 block_rq_*），希望把结果整合进 HTML 展示页，且不影响现有界面。
实测：`trace_processor_shell` v57.2 解析 systrace 文本时只产出调度事件，对 `short_trace.atrace`（400 MB）生成 0 个请求；
脚本对同一文件能算出 72,450 个完成读请求 / 1,945 MB。因此必须补一层文本解析，否则报告页在该输入上是空的。

**数据层**
- 新增文本回退解析：当输入是可解码文本且 `trace_processor` 未解析出 `block_rq_*` 时，流式解析
  `block_rq_insert / issue / complete`（兼容 atrace 位置格式与 Perfetto `key=value` 格式），合并进现有 `Extracted` → 现有模型。
- 线程归属：用 trace_processor 的 `thread` + `thread_ranges` 按 `tid + 时间范围 + comm` 解析 `utid`；解析不到的线程/进程合成一条（进程名用 comm 兜底）。
- 时间窗按文本事件扩展 `t_min/t_max`；数据质量新增 info 说明事件来源。
- 文本日志在构建时按**原脚本算法**复算原值（按 `(dev,sector)` 覆盖配对、insert 与 issue 双计、每次 issue 累加），写入 payload `script`，供报告页对照。

**展示层**
- 底部面板新增第 6 个 Tab「Block RQ 报告」，追加在现有 5 个 Tab 之后；不改现有 Tab / 轨道 / 计数器 / 标题栏。
- 报告跟随选区、勾选的轨道（v0.4 的轨道过滤）与「含 loop 设备」过滤；
  当前 Tab 是报告时，拖动框选 / Ctrl+A / R 不自动切到「区域统计」，只刷新报告。
- 指标：窗口、读请求数、读/写总量、读/写速度、≥25 ms 慢读数；
  阶段耗时拆成 `insert→首次 issue`（排队）、`首次→末次 issue`（requeue 等待）、`末次 issue→完成`（服务），
  并给出脚本定义 `insert→末次 issue` 参考值；分桶为 `<1 / <3 / <5 / ≥10 / ≥25 ms`（累计占比，和脚本一致）。
- 延迟分布：1 ms 分桶直方图，默认 0–40 ms，可切 0–200 ms；超过上限的值单独放「≥上限」溢出柱。
- Top N 进程/线程（默认线程，即脚本的 comm 口径），可选 5/10/20，点击行定位到对应轨道。
- 「复制报告」输出脚本风格的纯文本（窗口、设备/轨道、概览、阶段表、Top N、口径脚注）。
- 若 payload 带 `script`（文本日志），报告页显示可折叠的「脚本原值」对照块：脚本原值 / 工具口径 / 差异原因 / 脚本 Top 5。
- 口径说明必须写清：
  - 脚本按 `(dev,sector)` 覆盖配对，同一扇区并发请求会让 `insert_time` 被后一个请求的 issue 覆盖，
    `insert→issue` 会偏大（实测样例 5.45 ms / 最大 15.87 s，工具 FIFO 为 0.46 ms / 53 ms）。
  - 脚本的 Top N 在 insert 和 issue 两处都累加，**约为实际值的 2 倍**；工具按请求去重。
  - 脚本的读总量只累加 issue（单计），与 Top N 的双计口径不同；工具按完成请求的 bytes 统计。
  - 脚本没有设备 / 轨道过滤（含 loop）；报告主表按当前过滤，对照块用「含 loop + 全轨道」对齐脚本原值。
  - 报告页以工具模型为准，脚本原值仅作对照。

## 8. 网页版（拖入即分析，讨论结论，第一期）

背景：单 exe 工具越来越多，分发、更新和「选文件 → 跑命令 → 打开 HTML」的流程负担重。目标是像 Perfetto UI 一样：打开网页，把 trace 拖进去，直接在浏览器里分析；免安装，始终是最新版；**trace 只在浏览器本地处理，不上传**。

**引擎**
- 原样复用 Perfetto 官方构建的 `engine_bundle.js` + `trace_processor.wasm` + `trace_processor_memory64.wasm`（ui.perfetto.dev 的 `v57.2-da1d152cf/` 目录，与 `tools/` 中原生 trace_processor_shell 同版本），由 `scripts/fetch_tp_wasm.py` 固定版本下载并校验 sha256，放到 `tools/wasm/`（不入库），附 Perfetto 的 Apache-2.0 LICENSE。不自行编译。
- `engine_bundle.js` 是自成一体的 Web Worker：主线程编译 wasm 得到 `WebAssembly.Module`，把 `{port, wasmModule}` 发给它；它按浏览器是否支持 memory64 自动选 32/64 位构建；之后在 MessagePort 上收发 protobuf 编码的 TraceProcessor RPC（与 Python `perfetto` 库走 HTTP 的协议相同）。我们只写一个最小的 JS RPC 客户端（追加数据 / 结束追加 / 重置 / 流式查询 + CellsBatch 解码）。该初始化方式不是公开 API，因此版本锁定、由测试守护；以后原生与 WASM 一起升级。
- 重置会话的参数必须与原生 `tp.open_trace` 的配置对齐（如 `ingest_ftrace_in_raw`），保证 `ftrace_event` 与时间窗一致。

**建模**
- `extract.py` + `model.py` + `payload.py` 的逻辑改写为 JS（`web/model/`），是不依赖 DOM 的纯模块，浏览器 Worker 与 Node 都能运行；用 TypedArray / 排序双指针实现 `merge_asof` 等语义。payload 格式与 CLI 完全相同。
- 正确性用两层对照守护（都纳入 pytest，缺 Node / 样例 / 二进制时自动跳过）：
  1. Python 导出 `extract_all` 的原始表（JSON），Node 里用 JS 建模层算 payload，与 Python `build_payload` 逐字段比对（字符串 id 还原成字符串后比较，浮点允许微小误差）；合成用例 + 样例各一套。
  2. 无头 Edge 端到端：站点里加载样例 trace，网页算出的 payload 与 CLI payload 比对，并跑全量交互冒烟。

**输入**
- 与 Perfetto UI 一致：任何文件原样交给 trace_processor（protobuf、gzip、zip 等由它处理；多 trace 的 zip 由它合并成一个会话），不做格式白名单。已验证原生 v57.2 直接加载样例 zip 能解析出全部 block_rq / tran_ 事件。
- 加载成功但没有块设备事件时优雅降级，给出说明。
- 文本 systrace：trace_processor 的文本解析器会丢掉 block_rq_*（实测 780 MB 样例只剩 sched_switch），第一期**不移植 textlog**，检测到文本输入且没有块设备请求时明确提示「文本格式的块设备事件请暂用 CLI 版」。第二期再用 JS 移植 textlog（流式逐行解析 + 自写 zip 读取器）。
- 一次拖入多个文件时列出来让用户选一个；一次只分析一个 trace。
- 大 trace：第一期不做本机 `trace_processor_shell --httpd` 加速通道；自动选用 memory64 构建，按文件大小给提示，失败时引导使用 CLI。

**输出**
- 「导出报告 HTML」：生成与 CLI 产物格式完全相同的单文件报告（内嵌 payload，不含 wasm），用于分享 / 存档。

**前端组织**
- 一套 `web/` 源码，`manifest.json` 区分「报告」和「站点」两份清单；页面里有内嵌 payload 时直接渲染（CLI 报告行为不变），没有时显示拖放页。

**部署与发布**
- 服务器：静态目录（`index.html` + js/css + `engine_bundle.js` + 两个 wasm），解压到 web 根目录即可；不需要后端，不需要 COOP/COEP 响应头。
- 离线兜底：同一份源码再打一个 `blkscope-offline-<版本>.html`（两个 wasm 以 base64 内联，engine 用 blob Worker 启动），可放共享盘双击使用。
- 版本号唯一来源不变（`__version__`），页面与导出报告都显示；网页版上线升 MINOR。Release 在原 exe zip 之外增加 `blkscope-web-<版本>.zip`、离线 html 和一页部署说明。

**过渡与退役**
- 过渡期 CLI / exe / perfbox 条目照常发布，Python 实现作为对照基准；`startup_firstframe_io` 不在范围内。
- 退役 Python 的条件（同时满足）：两层对照在样例上全部通过；textlog 文本补全已移植；网页版内网试用一段时间无遗留问题。退役时升 MAJOR。

**实现记录（v0.7.x，第一期已完成）**
- 结构：`web/engine/`（RPC 客户端 + 引擎启动）、`web/model/`（extract / model / payload 的 JS 实现）、`web/site/`（拖放页 + 分析 Worker）；`scripts/build_web.py` 产出 `dist/web/` 与 `dist/blkscope-offline-<版本>.html`，`scripts/build_release.py` 一并产出 web zip、离线 html 和各自的 sha256。
- 引擎：重置会话只设 `ingest_ftrace_in_raw_table=true`（与原生 shell 默认一致）；样例上 5 条基准查询与原生逐行一致，12 张原始表摘要一致。
- 正确性：样例 payload 与 Python 版**逐字节一致**；合成用例覆盖配对、提交者匹配、requeue、槽位、批次、文件关联、D 状态、质量提示。移植中发现并修复了 Python 版的确定性与精度问题（同时改 Python 与 JS）：
  - pandas 单列排序默认不稳定，并列时槽位 / 批次 / 匹配结果随 numpy 排序实现变化 → 相关排序改为 `kind="stable"`；
  - 文件键 `s_dev<<40|ino` 超出 float64 精度（部分路径还会溢出 int64）：相邻 ino 被并成一个批次、pc_start 回退可能关联到相邻文件 → 改用 `(s_dev, ino)` 二元组（v0.7.1；样例上 1,177 个读请求改到正确文件，1,943 个误并批次拆开，关联率不变）；
  - 数值型 caller 统一显示为 `caller#<整数>`。
- 性能（样例 63 MB zip，Edge）：解析约 9.5 s、提取约 3 s、建模约 1.8 s、渲染约 0.4 s，从选文件到出图约 15 s；离线单文件约 37 MB，同样约 15 s。
- 缓存：站点里 worker / 引擎 / wasm 的 URL 带 `?v=<版本>`，`index.html` 需 `no-cache`（见 `docs/deploy_web.md`）。
- 第二期待办：textlog 文本补全的 JS 移植（含 zip 读取器），之后按退役条件评估下线 Python CLI。