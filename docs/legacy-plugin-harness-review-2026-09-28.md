# 存量 Plugin / 项目模式 / Harness 独立回检

日期：2026-09-28。开发目录：`C:\ai\CmbCoworkAgent-mods-v2`。本报告为独立复核记录，不代替主报告的全仓测试统计。

## 结论与范围

传统 Plugin 的安装、技能与 Hook 目录、启停、Harness adapter 项目创建、特性创建、详情解析、产物授权、重启持久化和卸载保留用户项目，已通过真实生产 Electron 回归。覆盖 Mods 默认关闭、全局开启但没有任何项目授权这两种状态。不能据此声称业务模型运行、企业平台或所有旧功能已经全部验证。

本轮另发现并由主任务修复一个实际兼容缺陷：当全局和项目 Mods 开启、但没有有效 Mods 链时，传统 Stop Hook 的 `additionalContext` 被误当作 Mods 新反馈，可能多执行一轮模型。此修复已完成独立二审，见下文。

初轮审查仅修改测试；后续在主任务授权、另一 agent 二审后，修复了下述模型流回调缺失消息对象的问题。新增真实 Electron 测试并修正三处陈旧测试断言；安装/MCP/Harness 产品代码未因这些测试调整而改变。

## 比较基准：避免把 UAT 后续演进误报为本分支删除

`git merge-base UAT HEAD` 为 `d8da18d3cc1c3bb55e4303980978591c9963c825`。审查时 HEAD 为 `e81a634a`，本地 UAT 为 `ca95c6bf`。本地 UAT 与开发分支并行演进，不能仅凭 `git diff UAT` 中的减号推断本分支删除了功能。

以下路径从 merge-base 到工作树没有改动；相关提交只存在于 `HEAD..UAT`：

| UAT 差异 | 提交 | 实际影响与归因 |
| --- | --- | --- |
| Markdown 文件链接正规化修复 | `875f7dc5` | 开发分支尚未合入；`c:/repo/src/index.ts` 配 `C:/repo` 实测解析为 null，UNC/file URL 支持也落后。不是 Mods 引入的新回归。 |
| 右栏展开时清理旧资源抽屉状态 | `a5d2cbe3` | 开发分支尚未合入；旧 `open` 状态在右栏展开后仍保留，再折叠可能重开抽屉。不是本分支主动删除。 |
| Bash First 工具偏好 | `9b1080cb` | UAT 后续新增能力；本分支没有该配置，不应在本轮擅自移植，也不能宣称与最新 UAT 功能集合完全相同。 |
| 独立“外观”设置页 | `af7dfb1b` | UAT 后续拆页；开发分支外观仍在通用设置中，不是主题能力被删除。 |

复核依据：`src/renderer/src/lib/markdown-file-preview-links.ts:22` 的大小写敏感比较、`:50` 的正规化；`src/renderer/src/components/panels/ResourcePanelOverlay.tsx:31` 的本地 open 状态与 `:80` 的返回条件。文件链接纯函数实测只用于确认行为，不代替完整 UI 预览 E2E。

未来同步 UAT 时，应一并带入相应产品修复及其测试；本次未修改这几个产品路径。

## Plugin、技能、MCP 与 Mods 的独立边界

- `src/main/ipc/plugins.ts:294` 的普通安装默认 `requireMods=false`；只有明确从 Mods 安装入口传入 true 才要求 Mods 清单。普通包仍可仅含 skill、MCP 或传统 Hook。
- `src/main/ipc/plugins.ts:841` 的启停更新插件启用状态，同时失效技能缓存、MCP capability 缓存和 Hook 订阅，并通知 Mods 重新发现；没有要求用户先打开 Mods 或授予项目 Mods 权限。
- `src/main/storage.ts:3303` 的技能来源和 `:3328` 的插件 MCP 配置以插件自身启用状态筛选；`:4286` 的传统 Hook 同样基于 enabled plugin，而不是 Mods 项目 grant。
- `src/main/mods/manager.ts:1194` 的 Mods 生效条件是全局开关与项目开关共同满足；Function 插件仍需相应加载与授权检查。全局开关缓存的变化不把旧 Plugin 变成 Mods。
- `src/preload/index.ts:3185` 保留独立 `plugins` API；`harnessBoard` API 位于 `:4431`。旧插件页面不是受 chat Mods scope gate 控制的组件。
- `src/main/ipc/plugins.ts`、`src/main/ipc/skills.ts`、`src/main/ipc/harness-board.ts`、`src/main/harness-board/`、`src/main/mcp/`、旧 `PluginsPanel`、App 与 Sidebar 对 merge-base 的产品 diff 为空。仍需审查共享 runtime / Hooks 的间接影响，不能仅据此下“无影响”结论。

传统插件执行程序及 MCP 自有权限语义继续沿用旧入口；桌面 E2E 本身没有证明真实 MCP 工具调用。下文补充的独立集成测试已覆盖本地 stdio MCP 调用及禁用、换代、移除清理，仍不代表外部进程在所有场景下的资源撤销或模型激活技能的完整生命周期。

## 真实生产 Electron 验证

测试：`tests/legacy-plugin-project-e2e.spec.ts`。使用已有普通 `out/main/index.js`；未使用 Mods E2E 后门或替换业务 IPC handler。测试自己的临时目录位于系统 temp，隔离 `HOME/USERPROFILE/APPDATA/LOCALAPPDATA/CMB_COWORK_AGENT_HOME/TEMP/TMP`，没有读取或修改用户真实插件目录。

本地最小普通 Plugin ZIP 含 `plugin.json`、`skills/legacy-review/SKILL.md`、传统 `hooks/hooks.json`、MCP 配置、`board_core/board_config.json` 和 Node adapter，没有 Mods 清单。MCP fixture 只用于解析/目录验证，不提供真实工具服务器。Adapter 是明确的本地业务数据 fixture，通过生产 argv 子进程启动、生产 Harness worker 解析，非伪造 IPC 返回值。

已通过 7 组：

1. Mods 默认关闭时安装 ZIP，检查 Skill / Hook / MCP 元数据以及 Harness adapter 可发现。
2. 实际点击“自定义→插件”，显示新安装的传统插件；保存截图。
3. Hook 单独停启、整个插件停启后技能与 Hook 目录随之变化。
4. 真实 adapter 创建项目目录与特性文件，检查绑定的 adapter ID、project/run worker 结果；主进程签发产物 grant，真实读取发布的 markdown，拒绝同项目未发布的 `feature.txt`。
5. 关闭并重启 Electron，确认插件、项目绑定、特性与产物仍可读。
6. 开启全局 Mods，不创建项目 grant；传统 Skill/Hook/project/run 读取仍正常。首次运行时使用当时的管理口令入口，后续产品已取消此口令，保留兼容查询，未取消项目授权。
7. 卸载插件后插件消失，项目记录及用户产物仍在，项目详情返回缺失 adapter 的可恢复诊断。

运行命令：Node 22 执行 `node_modules/tsx/dist/cli.mjs tests/legacy-plugin-project-e2e.spec.ts`。进程退出码 0，页面错误记录为空。

证据：

- `output/legacy-plugin-project-e2e/result.json`：7 组检查、隔离目录、覆盖边界。
- `output/legacy-plugin-project-e2e-run.log`：全部 PASS。
- `output/legacy-plugin-project-e2e/legacy-plugin.png`：真实旧插件页。
- `output/legacy-plugin-project-e2e/restart-global-mods-on.png`：重启/全局开启后的桌面截图。

明确未覆盖：真实模型请求、Skill 实际激活及 Hook 进程执行、live MCP 工具调用、企业 feature gate 开启后的项目 UI 操作、业务平台网络。项目创建与详情通过真实 renderer preload API 调用，不冒称全部通过用户点击完成；feature-session 对话绑定也没有在这个测试中验证。

## 两项 Harness 失败的核实与最小测试修复

### 产物隔离断言

`harness-plugin-run-artifacts-isolation.test.ts` 原断言要求源码包含 `if (externalPreviewGrant)`。实际 `RightPanel.tsx:3097` 按 `!resolved.inWorkspace` 进入外部授权路径，支持已有 grant 或异步续签；缺失 grant 立即 return，再调用 `harnessBoard.revealRunArtifact`，只有工作区内部路径走通用 show-item-in-folder。此语义比旧字符串条件更完整。

测试更新为校验实际的外部路径分支、无 grant 退出、续签在专用 reveal 前、专用 reveal 在通用 reveal 前。未删除安全断言。新真实 E2E 同时证实产物 grant 只能读已发布产物；并不声称操作系统文件管理器窗口也已自动化验证。

### 设置懒加载/限额断言

`harness-settings-lazy.test.ts` 原断言要求 `service.ts` 内原地声明 `MAX_ENTRIES=512`。常量实际已移至 `src/main/harness-board/context-integrity.ts:2` 并导入。`service.ts:2012` 仍使用 2 MiB bounded read，`:2219` 检查条目上限，`:2224` 使用 bounded atomic write。`async-json-store.ts:60` 和 `:73` 在读取前后检查字节限额与文件稳定性。

测试现在导入并验证真实共享常量为 512，同时验证 service 确实从对应文件导入、读写条目限额调用存在；原懒加载、2 MiB 读写、读取前后字节检查全部保留。此次真实 E2E 没有制造 2 MiB 恶意设置文件，不能将源码约束检查冒充大文件运行验证。

## 子 Agent 增量持久化断言

`tests/subagent-transcript-tail-performance.spec.ts:318` 原期望无 reasoning 的 content-only bootstrap 自动生成空 reasoning。`subagent-transcripts.ts:1881` 明确缺失 pending 字段不代表清空另一个字段，该产品与测试在本轮之前已经不一致，且产品对 merge-base 无改动。

修复仅调整陈旧期望，并增加两字段交叉的 4 个向量：content-only / reasoning-only 更新时保留另一字段；显式另一字段 pending 空串时真正清空。完整独立 performance suite 已执行完毕，包含后续 2,000 次增量、10,000 bucket 等原有复杂度检查。另运行真实 DB snapshots 测试，避免仅检查 serializer 表面输出。

定向证据 `output/legacy-focused-review-tests.log`：两 Harness 文件 10 项与 DB snapshots 6 项，共 16/16 通过。独立尾部性能 suite 的修复后完整重跑日志为 `output/legacy-subagent-tail-fixed.log`，退出码 0；原 `legacy-extra-tests` 汇总失败未被覆盖。不是重跑全仓后的全绿结论。

## 传统 MCP 的真实调用与连接清理补验

新增 `src/main/mcp/legacy-plugin-lifecycle.test.ts` 与 `tests/support/legacy-plugin-mcp-server.mjs`。运行真实 `ManagedMcpCapabilityService`、生产 stdio 配置转换、`MultiServerMCPClient` 和 MCP SDK 的 `StdioServerTransport` 子进程。仅隔离应用存储和 Mods manager 启动依赖；Mods manager 为 null，调用链走真实 legacy 直接分支，没有替换 capability service、SDK transport 或工具返回值。

1. 从普通 Plugin `.mcp.json` 发现工具，经真实 JSON-RPC 调用返回第一版结果；服务端日志记录实际进程 PID 与入参。
2. 禁用 Plugin 后工具消失，旧 capability 调用被拒；实际检查旧进程已退场，服务端没有收到被拒调用。
3. 重新启用后新建连接，generation 与 PID 改变；再次实际调用成功。
4. 修改服务器 argv revision 后通过真实配置 fingerprint 换代；旧 PID 退场，新调用返回第二版结果。
5. 从插件存储列表移除后工具消失、连接退出；删除后调用被拒。日志仅有三次允许执行。

测试已执行通过，并经另一 agent 独立二审。证据为 `output/legacy-mcp-lifecycle.log`，单个完整生命周期测试约 1.24 秒。`afterEach` 先关闭真实 service，再移除隔离临时目录。

此测试直接控制隔离存储中的 enable/remove 状态，不冒称经过 Electron 插件按钮和卸载 IPC；真实安装/启停/卸载 IPC 由上文 7 组桌面 E2E 另行覆盖。也不冒称完成全局 Mods on/未授权下的 MCP 调用矩阵、企业远端 OAuth/SSE 服务或外部网络验证。

## Stop 反馈归因修复二审

审查 `src/main/mods/v2/classic-result.ts`、`session.ts:1100` / `:1478`、`src/main/hooks/runner.ts:1616`：宿主深拷贝 core wire；仅比较 `additionalContext` 的实际文本贡献；在内容保护发布前记录来源、在发布后用宿主 WeakMap 关联结果。Guest 不能伪造此标记。wire 完全相同则保留原 native HookResult，包括旧私有元数据。仅策略脱敏导致文本变化不应被当作 guest 新反馈；实际 guest 追加或短路反馈仍可要求续轮。

原有 signal、authority/current 检查及 lower 只执行一次约束均保留。实现与方案二审通过，无阻断。主任务/quality 已提供 49 项定向通过的证据，含真实 manager + VM 的 no-source、未授权、no-match、next 透传、append、短路、policy 和 native block/halt；最终构建与更广泛回归由主任务统一记录。

## 后续验收建议

### Mods 开启时模型流消息身份修复

原 `stream-harness-e2e.spec.ts` 在 Mods 开启、无任何 source 时稳定暴露历史行 `checking1` 被后续 `checking2` 覆盖，而关闭 Mods 通过。定位 `src/main/agent/mods-model-boundary.ts`：包装层只调用 `handleLLMNewToken(chunk.text)`；LangGraph `StreamMessagesHandler` 没有拿到 callback `fields.chunk`，会构造只有文本、ID 为 `run-...` 的消息，与最终 provider message 的 ID 不同。

最小修复是在第 6 个参数传 `{ chunk }`，使用 `withText` 之后、与 yield 相同的对象。没有重新启用原始 provider callback，没有更改 provider ID 或 Renderer 合并逻辑，也没有把未经 Mods 处理的文本提前发布。保留原 authority/signal 校验。

`mods-model-boundary.test.ts` 增强真实 createAgent 回调检查：只看到 SAFE 文本并带宿主 reasoning 元数据；另用真实 provider adapter + 本地 SSE fetch fixture 连续两次复用 `provider-reused-741`，确认 live 包仍保持 provider ID 与当次文本。初版新增断言明确暴露缺失 chunk / 错误 run ID，修复后 boundary 25 项与既有 electron-stream 27 项共 52/52 通过；日志 `output/legacy-model-boundary-after.log`。模型工具自身会重新构造并丢弃 ID 的 FakeStreamingChatModel 没有被用于最终 provider ID 断言。

此单点修复通过另一 agent 的方案二审；原桌面 E2E 断言未变，最终真实 UI on/off 复验由主任务统一记录。定向通过不能单独替代 UI 历史隔离的最终证据。

### 旧浏览器测试基础设施补齐

三套既有脚本最初均在 esbuild 阶段失败，原因是直接 esbuild 不认识 Vite 的 `code-highlight-worker?worker` 默认 Worker 构造器；不是产品 Vite 构建失败。新增共享 `tests/support/browser-worker-plugin.mjs`，解析并实际 bundle worker 入口为 Blob JavaScript，导出真实 Worker 子类；构造失败与 terminate 时回收 URL。没有用空 Worker stub 替代高亮行为。

新增 `tests/browser-worker-plugin.spec.mjs` 用真实 Shiki Worker 对 TypeScript 请求做往返，验证 requestId、成功结果和 HTML，已通过。共享 helper 已获另一 agent 独立二审。

原三套脚本仅接入 helper 并保留原断言，最终结果：

- `chat-layout-browser.spec.mjs`：16 项通过，包含流式跟随、虚拟列表历史不重绘、展开状态等；`output/legacy-ui-tests/chat-layout-browser-fixed.spec.log`。
- `message-timestamps-browser.spec.mjs`：10 项通过，包含可见时间、键盘行为、窄屏、流式不重复格式化、2,000 消息虚拟化；`output/legacy-ui-tests/message-timestamps-browser-fixed.spec.log`。
- `stream-white-screen-browser.spec.ts`：5 项通过，真实 Electron Chromium 下工具格式异常局部隔离、下一次渲染恢复、应用错误边界和关闭提示；`output/legacy-ui-tests/stream-white-screen-browser-fixed.spec.log`。

时间戳 fixture 同时补齐与现有 chat-layout 一致的空权威 workspace selector，因为新 Markdown 组件依赖 ThreadProvider，而该独立 fixture 没有真实 Electron thread store。它不验证 workspace 文件预览；没有隔离时间计算或布局组件。最初失败日志仍保留，没有覆盖为通过。

### 接下来仍值得验证的产品场景

1. 企业项目模式 gate 开启后，真实点击项目→特性→绑定会话→切换其他特性，确认右侧产物和 grant 不串项目。
2. 将已通过的本地 MCP 执行/清理链进一步接到真实 Electron 用户点击启停、卸载流程，并覆盖全局 Mods on/未授权矩阵；当前组件集成与桌面元数据/持久化证据需分别理解。
3. 使用可控模型真正激活传统 Skill 和 Stop Hook，分别在 Mods 全关、项目关、项目开但未授权、已授权 next 透传下比较轮数与完成结果。
4. 同步 UAT 后验收 Windows 大小写、UNC、file/codex-file、本地 localhost 文件链接及右栏展开/折叠抽屉状态。此为版本合流工作，不是本轮擅自补入的新产品范围。

本报告不把已知基线失败改称全部无害，也不把未跑到的路径计作通过；全仓数量与剩余阻断以主任务最终证据为准。
