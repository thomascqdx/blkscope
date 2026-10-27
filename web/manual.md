# blkscope 使用手册

面向组内 Android 性能 / 内核 IO 工程师。本手册内嵌在每个生成的 HTML 中（标题栏「手册」按钮），仓库中的 `web/manual.md` 是唯一来源。

## 1. 简介

blkscope 把一条 Android / Perfetto trace 离线转换成**单个自包含 HTML**：双击即可在浏览器里以 Perfetto 式交互分析块设备 IO，无需服务器、无网络依赖。

它能回答的问题：

- 每个进程 / 线程读写了多少、速度多少、打到了哪个文件（IO 归属取**提交者**线程，不是中断上下文）
- 每个请求的排队（insert→issue）、服务（issue→complete）、总耗时（提交→complete）
- 设备槽位占用、在途深度、排队深度、带宽 / IOPS 曲线、requeue 时刻
- 线程 D 状态阻塞与导致阻塞的具体请求（含跨线程推测等待）
- 慢 IO 列表、延迟分布、关键线程（主线程 / RenderThread）阻塞汇总

## 2. 生成 HTML

### 命令

```powershell
.\.venv\Scripts\blkscope <输入...> [-o 输出目录] [--open] [--json]
```

- 一个输入：`blkscope samples\xxx.zip -o out` → `out\<trace名>.html`
- 目录输入：`blkscope samples -o out` 只扫描第一层；非 trace 文件自动跳过（blkscope 自己生成的 HTML 与 `.payload.json` 会被忽略）
- 多个输入：每条 trace 各产出一个 HTML，单个失败不中断，结尾打印汇总；有失败时进程 exit code 为 1
- `.zip` 内可有多个 trace 成员，每个成员一个 HTML；非 trace 成员（图片、文档等）自动跳过
- 输出名冲突时自动追加 `_2`、`_3` 后缀
- `--open` 生成后用默认浏览器打开；`--json` 只输出 `<name>.payload.json`（数据，不生成 HTML）
- `-V` / `--version` 打印版本号；版本也显示在生成 HTML 的标题栏

### 支持的输入格式

- Perfetto protobuf trace（`.trace` / `.pftrace` 等），直接给文件或打包成 `.zip`
- 文本 systrace / ftrace dump / atrace（含 HTML 包裹的 systrace）
- gzip 压缩的 trace

加载一条约 200 MB 的 trace 大约 10~20 秒（按阶段打印进度）。

### 抓取要求

工具查询以下 ftrace 事件（缺失即按对应功能降级）：

| 事件 | 关键字段 | 用途 |
|---|---|---|
| `block/block_rq_insert` | dev, sector, nr_sector, bytes, rwbs | 请求进入调度队列 |
| `block/block_rq_issue` | 同上 | 下发到设备 |
| `block/block_rq_complete` | dev, sector, nr_sector, rwbs, error | 完成（中断上下文） |
| `tran_block_feature/block_rq_mq_make_request`（传音定制） | pid, sector, rwbs, class, priority, is_ux_task/loop, FG_META, bi_ioprio | IO 优先级 / UX 标记 / 提交 pid |
| `tran_block_feature/block_rq_mq_complete_request`（传音定制） | req_tag, rq_log | 真实 tag、槽位上限 `use_tag` |
| `tran_block_feature/block_rq_mq_requeue_request`（传音定制） | rq_log 中 requeue_reason | requeue 原因与次数 |
| `tran_fs/tran_fs_pagecache_start`（传音定制） | major_dev, minor_dev, ino, offset, bytes, filebuf | 文件关联 |
| `filemap/mm_filemap_add_to_page_cache` | s_dev, i_ino, index | 文件关联（页缓存填充） |
| `sched/sched_blocked_reason` | pid, caller, io_wait | D 状态阻塞函数、io_wait |
| `sched/sched_switch`、`sched/sched_waking`（trace_processor 据此生成 `thread_state` 的 `D`/`DK` 段） | utid, ts, dur, blocked_function | D 状态轨道 |

传音定制事件缺失时的降级：

| 事件 | 提供 | 缺失时 |
|---|---|---|
| `tran_fs_pagecache_start` | 文件名 | 文件关联不可用 |
| `block_rq_mq_make_request` | 优先级 / UX / 提交 pid | 按 insert 线程归属，无优先级 |
| `block_rq_mq_complete_request` | req_tag、槽位上限 | 无槽位上限提示 |
| `block_rq_mq_requeue_request` | requeue 原因 | 无 requeue 标注 |

**buffer 建议**：抓取时 ring buffer 要足够大（或使用 DISCARD 模式）并保留 kernel symbols。回绕后早期数据被覆盖（有效窗口只剩末尾），且携带符号表的数据包可能丢失 → block function 只剩 `caller#<id>` 内部编号。

## 3. 界面总览

从上到下：

- **标题栏**：trace 名 · 设备信息（厂商 / SoC / fingerprint · 时长）｜「含 loop 设备」开关｜「慢 IO ≥ N ms」阈值输入框｜「配色: …」当前配色（点击打开图例）｜「时间: …」时间基准（点击循环切换 Perfetto / 原始 ns / 窗口相对，见 §6「与 Perfetto 时间对齐」）｜生命周期分段说明｜搜索框（**目前仅占位，未实现搜索**）｜「定位」「手册」「图例」「?」按钮
- **数据质量横幅**：warn / info 级提示，点击标题行折叠 / 展开
- **顶部缩略图**：全 trace 读（蓝）/ 写（橙）速率曲线；蓝色刷选框 = 当前可视窗口，可整体拖动、拖两端调整、空白处拖出新窗口
- **刻度尺**：时间刻度（默认与 Perfetto UI 对齐，可用标题栏「时间: …」切换基准）；显示选区范围与时长、标记旗标与名称、悬停时刻
- **轨道区**：左侧轨道名（组可折叠），右侧 Canvas；滚轮纵向滚动
- **分隔条**：拖动调整底部面板高度
- **底部面板**：Tab 页（当前选择 / 区域统计 / 延迟分布 / 慢 IO / 关键线程阻塞），可用 Q 收起

## 4. 颜色与图例

默认「类别」配色：同步读 蓝、预读 青、元数据 紫、写 橙、flush 棕、discard/other 灰。读系偏冷色（蓝/青/紫）、写是橙色；注意「元数据」紫色读写都算（rwbs 含 M 即归入），统计里的读 / 写仍按 rwbs 操作字母区分；顶部缩略图与概览计数器同样是蓝 = 读、橙 = 写。优先级用角标（顶部红条 / 三角）区分，不占主色。

按 `C` 在 类别 → 优先级 → 进程 → 延迟 间循环切换；按 `L`、点标题栏「图例」按钮或点击「配色: …」文字，打开带色块的完整图例浮层（当前模式有「当前」标记）。

## 5. 轨道详解

### 概览计数器（默认展开）

读 MB/s、写 MB/s、IOPS、在途深度、排队深度五行。速率按 issue→complete 的重叠比例分摊；在途深度（issue→complete）和排队深度（insert→issue）是精确阶梯函数，每像素取 max。在途深度上的红色虚线 = 设备槽位上限；排队深度底部的品红刻度 = requeue 时刻。

### 设备队列

每个磁盘设备一组（按请求数倒序），组名形如 `8:32 (disk) · 33 槽位 · 上限 32`：

- **槽位行**：矩形 = `[最后一次 issue, complete]`。槽位是**按时间贪心分配的最小编号空闲槽**，不是硬件 tag（真实 `req_tag` 在请求详情里看）。编号 ≥ 上限的行底色加深，上限处有橙色虚线「设备上限 N」（N = 该设备 rq_log 中 `use_tag` 最大值）。
- **调度队列**子组（`调度队列 · 峰值 N`，默认折叠）：每行是排队区间 `[insert|首次issue, 最后issue]` 的贪心打包；折叠时标题行显示排队深度热力条。
- 组折叠时标题行显示该设备的**在途深度热力条**（越亮越深）。

### loop / 其他设备组

major 7 = loop、major 0 = other，合并为一组默认折叠，每个设备是独立子组。loop 的 IO 会再落到底层物理设备，全局统计默认**只算 disk**（标题栏可勾选「含 loop 设备」）。

### 进程 / 线程组

默认折叠；折叠时标题行显示该进程**请求字节密度**热力条。展开后每个有 IO 的线程一个子组：

- **线程标题行**（可点击 → 全 trace 排队 / 服务 / D 时长汇总）
- **D 状态**：D 段，标签是 block function；io_wait=1 用更深的红色
- **IO 请求**：`[提交, 完成]` 的分段矩形；并发请求贪心打包成最多 4 个子行，溢出共用最后一行
- **文件读取**：读批次切片，标签 `文件名 · 进程提示 +offset (N 页)`

### 排序规则

进程按 IO 总字节（默认仅 disk 设备）倒序；进程内线程同规则；只展示有 IO（提交过请求或有读批次）的线程。

## 6. 交互与快捷键

| 键 / 操作 | 作用 |
|---|---|
| W / S（按住连续） | 以鼠标位置为中心放大 / 缩小 |
| A / D（按住连续） | 向左 / 右平移 |
| Ctrl + 滚轮 | 以鼠标为中心缩放 |
| 滚轮 | 纵向滚动；Shift+滚轮 / 触控板横滑 = 横向平移 |
| 单击 | 选中条目（空白处清除选择） |
| 拖动 | 区域选择（时间 × 轨道），统计只计入覆盖的轨道；刻度尺上拖动 = 全部轨道 |
| Shift + 拖动 | 平移 |
| F | 缩放到当前选中条目或区域 |
| Esc | 关闭浮层 / 取消选择 |
| Ctrl + A | 选中整个 trace；鼠标按下在面板内 = 全选面板文字；手册打开时 = 全选手册正文 |
| R | 把选中条目转成区域选择 |
| M / Shift+M | 临时标记（只保留一个）/ 持久标记（可多个）当前时间范围 |
| G | 打开「定位」对话框：按时间设选区 / 居中 / 添加命名标记（同标题栏「定位」按钮） |
| [ / ] | 跳到同一行上一条 / 下一条目，视图跟随 |
| / | 聚焦搜索框 |
| C | 切换配色：类别 / 优先级 / 进程 / 延迟 |
| L | 颜色图例 |
| ? | 显示 / 隐藏快捷键帮助 |
| Q | 收起 / 展开底部面板 |
| 点击组标题 | 展开 / 折叠该组（设备组内「调度队列」子组单独开关） |
| 点击线程标题行 | 「当前选择」显示该线程全 trace 排队 / 服务汇总 |

浮层（帮助 / 图例 / 手册 / 定位）互斥：打开一个自动关闭其他；浮层打开时只有 Esc、`?`、`L` 三个键响应（图例打开时 `C` 也可用，方便边切换配色边对照）。面板与手册正文可选中、Ctrl+C 复制。

### 与 Perfetto 时间对齐

Perfetto UI 的时间轴原点是整条 trace 的最早数据（`trace_bounds.start_ts`），而 blkscope 内部 t=0 是 ftrace 事件有效窗口的起点（`min(ftrace_event.ts)`）。RING_BUFFER 回绕后两者可能相差很大（样例差 88.354s），且每条 trace 不同——这正是「在 Perfetto 里看到的时间在 HTML 里找不到」的原因。

标题栏「时间: …」点击循环切换三种显示基准（只改显示，数据不变）：

| 基准 | 原点 | 显示格式 |
|---|---|---|
| **Perfetto**（默认） | `trace_bounds.start_ts` | 与 Perfetto UI 默认 Timecode 一致：`HH:MM:SS.mmm uuu nnn`（>1 天带 `Nd` 前缀） |
| **原始 ns** | 0 | 绝对时间戳整数，对应 Perfetto 的 Raw 格式 |
| **窗口相对** | ftrace 有效窗口起点 | 旧行为（`x.xxx s` 等自适应单位） |

「定位」对话框（`G` 或标题栏「定位」按钮）接受三种输入：

- **Perfetto 时间码**：如 `00:01:29.652 554 159`，空格可任意（含细空格），可带 `Nd` 天数前缀——**始终**按 Perfetto 原点解析，与当前显示基准无关
- **绝对 ns 整数**：如 `53201629736246` 或 `53,201,629,736,246`——**始终**按绝对时间戳解析
- **带单位数值**：`1.5s` / `200ms` / `3us` / `100ns`（带小数无单位按秒）——按**当前**时间基准解析

填起点 + 终点 → 设为选区（全部轨道）并缩放过去；再填名称则同时落一个持久命名标记。只填起点 → 视图居中到该点并放临时标记。「添加标记」直接生成持久标记（可命名、可为区间），对话框下方列出所有持久标记，可一键设为选区或删除。超出 ftrace 有效窗口的范围会被截断并提示，完全在窗口外则报错。「当前选择」的选区摘要里额外有一行**原始 ns** 起止，方便回贴到 Perfetto。

> 如果 Perfetto 里抄过来的时间码仍对不齐（例如 Perfetto 自己切换过时间显示格式），把 Perfetto 的 timestamp format 设成 **Raw**，直接粘贴整数 ns——它按绝对时间戳解析，与原点无关、永远精确。

### 轨道复选框（选区过滤）

有框选时，左侧轨道名前出现复选框；底部面板的所有统计（区域统计 / 延迟分布 / 慢 IO / 关键线程阻塞 / 选区摘要）**只计入勾选的轨道**。「当前选择」页顶部显示「轨道：已选 N / M 条」并可 全选 / 反选 / 清空；全选（= 不过滤）时复选框全亮。

- 框选时拖过的轨道即初始勾选集；拖过**已展开**组头的区域以其可见子行为准，拖过折叠组头 = 选中整组。
- 线程标题行和组头是**三态**复选框（全选 / 部分 / 未选），点击切换整组 / 整线程；`IO 请求` 多个子行共享一个勾选（点第一个子行的框即可）。
- 勾选粒度：槽位泳道 = 该槽位上的请求；调度队列行 = 排过该队列的请求；`IO 请求` = 该线程全部请求；`文件读取` = 该线程关联到文件的读请求；`D 状态` = 该线程的 D 段（决定 D 时长 / 阻塞函数 / 关键线程阻塞统计）。
- 概览计数器行（读 / 写 / IOPS / 深度）**不参与过滤**，勾选它们只控制选区摘要里「计数器（选区内）」表显示哪些行——计数器始终是全局口径（仅 disk / 含 loop）。
- 一条 IO 轨道都没勾时，请求与 D 状态统计为空（面板有提示），只剩计数器表。

## 7. 底部面板

统计窗口 W：有框选时取选区**时间 × 轨道**（只计入勾选的轨道，见上节「轨道复选框」）；未框选时取全 trace（面板上注明）。设备过滤默认仅 disk，「含 loop 设备」勾选后算全部。

### 当前选择

- 条目详情：请求（扇区、大小、rwbs、类别、优先级标志、各阶段时间戳与排队/服务/总耗时、槽位、req_tag、requeue、关联文件「推测」、等待它的 D 段可点击跳转）；D 段（阻塞函数、io_wait、等待的请求可点击）；批次；计数器点。
- 有框选时改为选区摘要：顶部是「轨道：已选 N / M 条」+ 全选 / 反选 / 清空按钮；表内为范围 / 时长 / 轨道 / 请求数 / 总量 / 读 / 写 / 其他 / 读速度 / 写速度 / 总速度 / D 状态时长，下方是「读速度 Top N」「写速度 Top N」榜单（进程 / 线程 × Top 5/10/20，点击行定位到轨道）；勾选了计数器轨道（默认全选 = 全部 5 行）时末尾有「计数器（选区内）」表：平均 / 峰值（100µs 桶）。

### 区域统计

四个子视图：进程 / 线程 / 文件 / 阻塞函数；表头点击排序，第一行是「全部」合计。

- 进程 / 线程列：名称、总量、读、写、其他、读速度、写速度、总速度、占比%、请求数、平均/最大排队、平均/最大服务、D 状态时长
- 文件列：文件（`名字 · 提示`，全部标「推测」）、读量、请求数、进程数、平均服务；另有「未关联」「FS元数据」两行
- 阻塞函数列：block function、D 段数、D 总时长、io_wait=1 段数、平均/最大时长、线程数

### 延迟分布

取 `t_cmp ∈ W` 的已完成请求，画排队 / 服务 / 总耗时三条对数分箱直方图（1µs~100ms）+ p50 / p90 / p99 / max；可按类别筛选。注意它的取样口径与其他 Tab 不同（按完成时刻落点，不按重叠）。

### 慢 IO

W 内（重叠 f > 0）`总耗时 ≥ 标题栏阈值` 的请求，按总耗时倒序取前 500。点击行选中并居中该请求。

### 关键线程阻塞

范围 = 有 IO 的非内核进程中主线程（tid == pid）与 RenderThread。列：进程、线程、D 时长、io_wait 时长、有等待请求的 D 段数、所等请求总耗时之和、最长 D 段（点击跳转）。

## 8. 统计口径

- 请求计量区间 `[s, e] = [t_iss, t_cmp]`；未完成的 `e = min(窗口末尾, t_iss + 200ms)`；没有 issue 的请求不计入
- 重叠比例 `f = |[s,e] ∩ W| / (e − s)`；`e == s`（cmp_lost 零长度请求）时 `s ∈ W` 则 f=1 否则 0
- 计入字节 = `bytes × f`；请求数 = f > 0 的个数
- 读 / 写 / 其他按 rwbs 操作字母：R→读（含 meta / 预读）、W→写、D/F/N 等→其他
- 速度 = 计入字节 / (w1 − w0)；显示为 MB/s，**1 MB = 1048576 B**
- 排队 q = `t_iss0 − t_ins`（有 insert 才算）；服务 svc = `t_cmp − t_iss`（已完成才算）；总耗时 = `t_cmp − (t_make | t_ins | t_iss0)`；平均 / 最大都是 f>0 请求的未加权值
- D 状态时长 = D 段与 W 的交集之和（只算有 IO 的线程）
- 概览计数器同样按 issue→complete 重叠比例分摊到 100µs 分箱；深度类计数器是精确阶梯函数

## 9. 典型分析流程

### 启动慢：查主线程 IO 阻塞

1. 打开「关键线程阻塞」Tab，按 D 时长倒序找目标进程主线程
2. 点「最长 D 段」跳到该段，D 段高亮 + 黄色箭头连到它等待的请求
3. 看该请求的排队 vs 服务占比：排队长 = 被别的 IO 挤，服务长 = 设备慢
4. 点等待的请求看详情里的关联文件（推测），确认在读什么

### 谁在抢 IO

1. 在启动窗口上框选（刻度尺上拖动 = 全部轨道）
2. 看「当前选择」的读 / 写速度 Top N，或「区域统计 → 进程」按总量排序
3. 点进程行展开并滚动到其轨道组

### 设备是否打满

1. 概览「在途深度」曲线对照红色虚线（槽位上限）；持续贴线 = 设备打满
2. 展开设备组的「调度队列」看排队峰值；「排队深度」行底部品红刻度 = requeue 时刻
3. 点开 requeue 过的请求看详情里的 `requeue` 次数与 reason

### 慢 IO 排查

1. 「慢 IO」Tab 按总耗时倒序，点开看排队 / 服务拆解与 rwbs / 优先级
2. 同时段看在途深度是否顶着上限、排队深度是否尖峰

### 哪些文件读得最多

「区域统计 → 文件」按读量排序；点击文件行滚动到读它最多的线程。全部标注「推测」——文件关联是启发式推断。

## 10. 数据质量提示

| code | 级别 | 含义 | 处理建议 |
|---|---|---|---|
| `ring_wrap` | warn | RING_BUFFER 已回绕，有效窗口只有末尾一段 | 增大 buffer 或改 DISCARD 模式重抓 |
| `no_block_events` | warn | 没有 block_rq_* 事件 | 抓取配置需包含 block ftrace 事件 |
| `no_make_request` | warn | 缺 `block_rq_mq_make_request` | 优先级 / UX 不可用，已降级按 insert 线程归属 |
| `no_pagecache` | warn | 缺 `tran_fs_pagecache_start` / `mm_filemap_add_to_page_cache` | 文件关联不可用 |
| `block_fn_unresolved` | warn | caller 只有内部 id，显示 `caller#<id>` | 回绕导致符号表丢失；增大 buffer / DISCARD 重抓并保留 kernel symbols |
| `ftrace_overrun` | warn | 录制期间丢失 N 个 ftrace 事件 | 降低负载或增大 per-cpu buffer |
| `orphan_complete` | info | N 个 complete 找不到配对 | 请求在有效窗口外开始或事件丢失，属正常 |
| `incomplete` | info | N 个请求到 trace 结束未完成 | 画到窗口末尾（截断 +200ms） |
| `cmp_lost` | info | N 个请求没有 complete（多为 flush） | 仅标注下发时刻，按零长度处理 |
| `dropped_insert` | info | N 个 insert 下发前被合并 / 丢失 | 正常 IO merge |

## 11. 推测性结论与已知限制

- **文件关联是启发式**：读请求按提交线程回溯——先看 (上一个读请求提交时刻, 本请求提交时刻] 内的 `mm_filemap_add_to_page_cache` 页众数（fsrc=1），否则退到 20ms 内最近的 `tran_fs_pagecache_start`（fsrc=2）。`filebuf` 只有文件基名；同一基名的不同文件用 (dev, ino) 区分，提示列给出关联读量最大的进程名。UI 中一律标「推测」。写请求不做关联。
- **wait_src=2 是推测**：D 段 io_wait=1 但本线程没有在其结束附近完成的请求时，取**任意线程**在该 D 结束前 100µs 内最近完成的请求，虚线箭头 + 「推测」标注。
- **写 IO 归属**：写多由 kworker / f2fs 回写线程提交，归属到回写线程而非发起写入的 App。
- **loop 设备重复计数**：loop 的 IO 会再落到底层物理设备，默认统计只算 disk 避免重复。
- **`caller#<id>`**：sched_blocked_reason.caller 是 interned id、符号表未解析时的降级显示。
- **req_tag 不是硬件槽位**：blk-mq tag 复用率高，泳道槽位是按时序贪心分配的；真实 req_tag 只在详情展示。
- **issue 次数 > insert**：requeue 后同一请求会重复 issue；请求配对按 (dev, sector) + 时序状态机完成。

## 12. FAQ

- **看不到文件名 / 优先级？** 抓取缺少传音定制事件，看顶部数据质量横幅（`no_pagecache` / `no_make_request`）。
- **写 IO 为什么都归到 kworker / f2fs 线程？** 回写路径本身就在内核线程提交，不是工具归错；要看谁触发的回写需要上层事件，本工具不做。
- **`caller#13` 是什么？** block function 符号表缺失，只剩 interned id；增大 ring buffer 或 DISCARD 模式重抓可改善。
- **时间轴 0 点是什么？** 默认按 Perfetto UI 的口径显示——原点 = `trace_bounds.start_ts`；「窗口相对」模式下 0 点是 ftrace 事件有效窗口的起点（不是开机时间 / trace 开始录制时间），RING_BUFFER 回绕后该起点是缓冲区里最早的 ftrace 事件，会比 Perfetto 的 0 点晚。
- **怎么在 HTML 里定位 Perfetto 中看到的时刻？** 按 `G`（或标题栏「定位」）粘贴 Perfetto 时间码即可，它始终按 Perfetto 原点解析；如果格式对不上，把 Perfetto 的 timestamp format 切成 Raw，粘贴整数 ns 最稳妥。详见 §6「与 Perfetto 时间对齐」。
- **选区统计的字节为什么和直觉不一致？** 跨边界的请求按 `[issue, complete]` 与选区的**重叠比例**分摊，且默认只算 disk 设备（勾选「含 loop 设备」才计入 loop/other）。
- **延迟分布的数量为什么比区域统计少？** 它只取 `t_cmp` 落在窗口内的已完成请求，口径不同于按重叠分摊的其他 Tab。
- **面板里的表格能复制吗？** 能，直接鼠标选中后 Ctrl+C；在面板内 Ctrl+A 全选面板文字，手册打开时 Ctrl+A 全选手册正文。
- **搜索框怎么没用？** 目前仅占位（`/` 可以聚焦），搜索功能尚未实现。
