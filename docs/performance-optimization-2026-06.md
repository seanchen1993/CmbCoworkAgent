# 性能优化记录（2026-06，分支 codex/optimize-memory-lag）

针对"长会话卡顿、内存飙升、CPU 暴涨"的一轮性能优化。本文记录问题定位、改动清单、借鉴来源、验证情况与已知限制。

## 1. 背景与症状

- 长会话滚动 / 流式输出时界面卡顿，CPU 持续偏高。
- 打开多个带工作区的会话后内存逐步增长。
- 拖拽分隔条、缩放平移图片时掉帧。

排查后归纳为三类根因：渲染层重复计算与重渲染、文件监听的事件风暴与累积、IPC/磁盘扫描的重复与串行。

## 2. 改动清单

### 2.1 渲染层（聊天卡顿主因）

| 项 | 文件 | 改动 |
|---|---|---|
| O(n²)→O(n) | `src/renderer/src/components/chat/ChatContainer.tsx` | 渲染循环原本对每条消息 `slice().find/some`（每帧 O(n²)，且每个 token 触发一帧）。改为渲染前一次性反向遍历预计算 `showAssistantMeta` / `hasUserAfterHead`（`perMessageFlags`）。 |
| content-visibility | `src/renderer/src/components/chat/ChatContainer.tsx` | 每条非流式消息外层加 `content-visibility:auto` + `contain-intrinsic-size:auto 240px`，浏览器跳过屏幕外消息的 layout/paint（近似窗口化，但不改滚动逻辑）。`auto` 关键字启用 Chromium 的 last-remembered-size，元素渲染过一次后用真实高度，保证滚动定位准确。流式中的最后一条不加，保证实时渲染。 |
| MessageBubble memo | `src/renderer/src/components/chat/MessageBubble.tsx` | `React.memo` 包裹。容器传入的 props（`displayMessages` / `toolResults` / `toolCallStates` 均 `useMemo`，handler 均 `useCallback`）稳定，空闲滚动历史时整列气泡不再重渲。 |
| Markdown 配置稳定化 | `src/renderer/src/components/chat/StreamingMarkdown.tsx` | 将 `remarkPlugins` / `rehypePlugins` / `components` 提到模块级常量，避免每次渲染重建、减少 react-markdown 重复工作与 GC。 |
| 拖拽 rAF 节流 | `App.tsx`、`panels/RightPanel.tsx`、`ui/resizable.tsx` | mousemove 只缓存最新 delta，`requestAnimationFrame` 内 flush；mouseup 取消 pending frame 并补最终值。 |
| 图片平移优化 | `tabs/ImageViewer.tsx` | `panStart` 改 ref（消除按下重渲染）、rAF 节流、平移时关闭 CSS transition、卸载时 cancelAnimationFrame。 |
| 文件树 memo | `panels/FilesystemPanel.tsx` | `buildTree(workspaceFiles)` 用 `useMemo` 包裹。 |
| 滚动导航测量节流 | `chat/ChatScrollNavigator.tsx` | scroll 监听原本每个事件都遍历用户消息做 `getBoundingClientRect`（长会话靠底时近 O(n)/事件）。改为 rAF 合并到每帧一次，并将 viewport rect 每帧只读一次（原每条消息读一次）。避免 content-visibility 的收益被滚动测量抵消。 |

### 2.2 文件监听（CPU/内存累积）

| 项 | 文件 | 改动 |
|---|---|---|
| 同路径去重 | `src/main/services/workspace-watcher.ts` | `startWatching` 对同一线程相同路径直接返回，避免反复 close/recreate `fs.watch`（记录 workspacePath，win32 大小写归一）。 |
| watcher 数量封顶 | `src/main/services/workspace-watcher.ts` | 新增 `MAX_ACTIVE_WATCHERS=6` + `evictStaleWatchers()`，超出按插入顺序淘汰最旧的递归 watcher（当前线程始终保留）。根治"开多会话→N 个递归 watcher 常驻→构建/npm 时事件风暴"。 |
| watcher 重新挂载 | `src/main/ipc/models.ts`、`preload/index.ts`、`preload/index.d.ts`、`panels/RightPanel.tsx` | 新增 `workspace:ensureWatching` IPC。配合文件树缓存（切回会话不重扫）时，确保被 LRU 淘汰的 watcher 在会话激活时重新挂载（`startWatching` 幂等）。 |
| **前台线程不被淘汰** | `src/main/services/workspace-watcher.ts`、`models.ts`、`preload/*`、`lib/thread-context.tsx` | 新增 `workspace:setActiveThread` IPC + `setActiveWatchedThread()`。渲染层在 `currentThreadId` 变化时（与文件面板是否打开无关）告知主进程前台线程；LRU 永不淘汰前台线程，并在切换时重新挂载其 watcher。`startWatching` 同路径早返回时刷新 LRU 顺序（touch）。**修复评审高风险：后台 `loadFromDisk` 启动新 watcher 时按旧插入顺序把当前可见线程挤掉，导致文件变更/Git diff/文件树刷新静默失效。** |
| 切换工作区保留前台保护 | `src/main/services/workspace-watcher.ts` | `startWatching` 换路径会先 `stopWatching`（清 `activeThreadId`）；现在先记录 `wasActive`，重挂后恢复，避免当前线程切换工作区后短暂失去“不可淘汰”保护。 |

### 2.3 IPC / 磁盘扫描

| 项 | 文件 | 改动 |
|---|---|---|
| 跳过重目录（.gitignore 驱动） | `src/main/ipc/models.ts`、`workspace-watcher.ts` | `loadFromDisk` 硬编码仅跳过 `node_modules/coverage/tmp/temp` + 顶层 `resources/bin` + 隐藏项；**并复用 watcher 的 .gitignore 引擎（导出 `buildGitignoreMatcher`），按工作区自身 `.gitignore` 跳过大目录（dist/out/build/.next/target… 视用户配置而定），仅作用于目录**，单个被忽略文件仍可见。既拿到性能收益又不硬编码隐藏用户文件。 |
| 并发 stat（有界） | `src/main/ipc/models.ts` | 同目录文件 `fs.stat` 由串行改为分批并发（`FILE_STAT_CONCURRENCY=48`），子目录递归仍串行以控制总并发、规避 EMFILE。 |
| 元数据少解析 | `src/main/ipc/models.ts` | `workspace:set` 原本同份 `metadata` 解析 3 次，改为复用一份。 |
| 文件加载去重/懒加载 | `chat/WorkspacePicker.tsx`、`panels/RightPanel.tsx`、`lib/workspace-file-load.ts`、`lib/thread-context.tsx` | 删除 WorkspacePicker 挂载时的 `loadFromDisk`；文件树已缓存时跳过重扫；新增 in-flight 去重 `loadWorkspaceFilesDeduped`，后台初始化加载与文件面板加载共享同一次扫描。**去重 key 为 `threadId + workspacePath`，且 RightPanel 写回前校验 `result.workspacePath === path`**，避免工作区切换中途把旧目录文件树写进新工作区。 |
| 精品技能缓存/单次安装 | `chat/ChatContainer.tsx` | `loadMarketSkillsSnapshot`（10min TTL + 并发请求合并）与 `installFeaturedSkillsOnce`（进程级单次守卫），把"每次进会话拉市场+重装精品技能"降为进程一次。 |

### 2.4 构建期（仅 dev/lint）

- `electron.vite.config.ts`：renderer `cacheDir` + `server.watch.ignored`（dist/out/build/tmp/resources/bin 等）。
- `eslint.config.mjs`：ignore `**/.vite`。

## 3. 借鉴来源（C:\ai 下同类工程）

- **hermes-agent**：`@tanstack/react-virtual` 变高虚拟化（`measureElement`）；`markdown-text.tsx` 的 memo/LRU/超长文本 `content-visibility` 分块；`electron/main.cjs` 的非递归单目录 watch + 关闭登记表。
- **openclaw**：`canvas-host/server.ts` 的 chokidar `ignored`（源头排除 dotfiles/node_modules）+ `awaitWriteFinish`（合并写）。
- **CoPaw**：`react-window` 列表虚拟化（轻量备选）。

本轮在**不引入新依赖**前提下落地：用 `content-visibility` 拿到虚拟化的大部分收益；用 watcher 封顶+重挂载替代 chokidar 切换。

## 4. 验证

- `npm run typecheck`（node + web）均通过。
- 改动文件 `eslint` 0 error（仓库存量 CRLF/prettier 警告与本改动无关）。
- 未做运行时验证（需手动 `npm run dev`）。建议回归：
  - 长会话滚动是否顺、**跳转到用户提问**是否定位准确；
  - 流式输出是否正常、工具调用气泡是否实时更新；
  - 切换多个带工作区的会话后，文件树是否仍随磁盘变化刷新、内存/CPU 是否平稳；
  - 大目录工作区首次加载是否正常、无报错。

## 5. 评审与修复

针对本轮改动做了一次代码评审，发现并修复了以下风险（详见 §2 表格中标注"评审…修复"的行）：

第一轮评审：
- **[高] watcher LRU 淘汰当前线程**：前台线程保护 + LRU touch + `setActiveThread`（切换即重挂）。
- **[中] 重复扫盘未真正收敛**：`loadWorkspaceFilesDeduped` in-flight 去重。
- **[中] 硬编码跳过目录隐藏真实文件**：收窄为仅 node_modules/coverage/tmp/temp。
- **[中低] content-visibility 收益被滚动测量抵消**：滚动导航 rAF 节流 + viewport rect 单次读取。
- **[此前自查] EMFILE**：`fs.stat` 有界并发。

第二轮评审（P1–P3）：
- **[P1] 切换工作区后前台保护丢失**：`startWatching` 记录并恢复 `wasActive`。
- **[P2] 去重按 threadId 可能复用旧工作区结果**：key 改为 `threadId + workspacePath`，RightPanel 写回前校验 `result.workspacePath`。
- **[P3] dist/out/build 大目录仍全量扫描**：复用 watcher 的 .gitignore 引擎，按用户 `.gitignore` 跳过大目录（仅目录级）。

## 6. 已知限制 / 后续

- **未上完整 react-virtual 窗口化**：需新增依赖 + 重写渲染主循环，回归面大。`content-visibility` 已覆盖大部分收益；若仍需真窗口化，单开一轮专测滚动与跳转。
- **未切换 chokidar**：递归 `fs.watch` 无法在源头 ignore（仍事后过滤），但封顶+前台保护+重挂载已控住资源累积与静默失效。
- **流式期间 memo 部分失效**：`toolResults`/`toolCallStates` 为全列共享 Map，新工具结果到达时身份变化会触发整列重渲；此时主要靠 `content-visibility` 省下屏幕外的 layout/paint。彻底解决需把工具数据按消息切分下发（改动较大，未做）。
- **content-visibility 首次定位**：跳转到从未渲染过的远端消息时，因使用 240px 估高可能略有偏差；元素渲染过一次后由 last-remembered-size 校正。
- **.gitignore 仅根级、仅目录**：`buildGitignoreMatcher` 只读工作区根 `.gitignore`，不处理嵌套 `.gitignore`；且仅对目录生效（单个被忽略文件仍显示）。未被 gitignore 的超大 `dist/out` 仍会被完整扫描——如需进一步可做用户可配置 allowlist。
