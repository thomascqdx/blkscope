# blkscope 网页版部署说明

`blkscope-web-<版本>.zip` 是 blkscope 块设备 IO 分析器的纯静态网页版：
打开页面、把 Perfetto trace 拖进去即可分析。**trace 只在本机浏览器内
处理，不会上传到任何服务器。**

## 包里有什么

| 文件 | 说明 |
|---|---|
| `index.html` | 站点页面（拖放入口 + 报告渲染，全部内联） |
| `analysis_worker.js` | 分析 Worker（trace_processor 客户端 + 建模） |
| `engine_bundle.js` | Perfetto 官方 trace_processor WASM 引擎（worker） |
| `trace_processor.wasm` | WASM 引擎 32 位构建 |
| `trace_processor_memory64.wasm` | WASM 引擎 memory64 构建 |
| `report_template.html` | 「导出报告」用的报告模板 |
| `LICENSE` | Perfetto Apache-2.0 许可 |
| `DEPLOY.md` | 本文档 |

## 部署

解压到任意静态 Web 根目录即可 —— **不需要后端，不需要 COOP/COEP
响应头**。

- nginx：`server { root /path/to/web; }`
- IIS：新建站点指向解压目录
- Apache：放进 `DocumentRoot` 或配置 `Alias`
- 本机快速验证：`python -m http.server 8000 -d <解压目录>`，浏览器打开
  `http://localhost:8000/`

### 可选优化

- **MIME**：`.wasm` 不需要 `application/wasm` —— 代码用
  `WebAssembly.compile(字节)` 从字节数组实例化，不依赖服务器 MIME
  （不配置也能正常工作）。
- **压缩**：可对 `.wasm` / `.js` / `.html` 开 gzip/brotli 静态压缩，
  wasm 约可省 40% 传输量。
- **缓存**：`index.html` 应 `Cache-Control: no-cache`（否则升级后用户
  可能长时间看到旧页面）。其余静态资源（`analysis_worker.js` /
  `engine_bundle.js` / `*.wasm`）可以放心长缓存：页面以
  `?v=<版本>` 引用它们，升级后 URL 自动变化，不会混用新旧文件。
  例：nginx `location = /index.html { add_header Cache-Control no-cache; }`

## 验证

打开站点 URL，应看到拖放页，标题下方显示版本号（与发行版一致）。
浏览器要求：当前版本 64 位 Edge / Chrome；支持 memory64 时自动使用
64 位 WASM 构建，否则回落到 32 位构建（小 trace 不受影响）。

## 没有服务器时

发行版还附带 `blkscope-offline-<版本>.html`：与站点完全相同的单文件
（引擎、WASM、Worker、报告模板全部内嵌 base64），双击即可在
Edge/Chrome 中离线使用，可放共享盘分发。

## 不支持 / 限制

- 文本格式 systrace（.atrace 文本）的块设备事件暂不支持网页版，
  页面会提示改用 CLI 版 blkscope。
- 超大 trace（> 1 GB）可能较慢或内存不足，页面会给出提示；
  不支持 memory64 的浏览器对 > 1.5 GB 的文件建议直接用 CLI 版。
