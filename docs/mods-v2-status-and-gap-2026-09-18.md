# Mods v2 当前实现状态与目标差距

> 2026-09-24：最新已实现能力、验证结果和未完成项见[当前实施状态](mods-v2-status-2026-09-24.md)。下方旧批次数字和缺口保留为历史记录，不代表最新代码。

> 2026-09-23 续作：以下验证数字是历史基线。最新代码和未提交状态以
> [续做快照](mods-v2-next-iteration-handoff-2026-09-22.md) 为准；官方参考已更新到
> Claude Code v2.1.278（声明头 2.1.277），见[契约审查](mods-v2-claude-latest-audit-2026-09-22.md)。
> 主 Agent 模型流、fork/classify、agent.offer 已进入生产链；动态来源、classic 严格
> schema/legacy next 链、engine noun 正在完成最终集成验证。历史 omission 不能继续当作
> 当前代码结论，也不能将局部测试视为全量兼容或业务验收。

**更新时间：** 2026-09-18  
**代码分支：** `codex/mods-v2`  
**当前提交：** `e1302c01 feat(mods): add live usage breakdown e2e coverage`  
**对齐目标：** Claude Code 2.1.273 的 Function Hooks / Mods 会话能力

## 结论

本工程已经具备一个可实际运行的 Mods v2 基础平台：插件可以安装、授权、在隔离运行时执行 Hook，注册命令和工具，读取真实会话，调用受控的文件、工具、模型和 MCP 能力，并使用有限的 Pane/Client UI。

当前实现已经覆盖 Claude Code Mods 的核心执行模型和安全边界，但还不是完整的 upstream parity。最重要的差距集中在动态上下文分类、完整 Hook 事件适配、主 Agent 模型控制面、完整 UI surface、内建工具 schema，以及长期稳定性和发布门禁。

## 现在已经实现的效果

### 插件安装、授权和隔离

- 可以从应用的“自定义 → 插件”安装和授权示范函数插件。
- 插件运行在独立的 utility process / QuickJS 隔离环境中。
- 每个插件拥有自己的运行时、模块状态、命令、工具定义和存储空间。
- 授权撤销、插件卸载、工作区切换、线程替换和 runtime generation 变化会使旧句柄失效。
- 插件不能绕过宿主直接写入 checkpoint、执行原生工具或取得其他线程的后端。

### Hook 和命令

当前生产链路支持：

- `session.start`
- `command.register/list/run/describe`
- `turn.start/complete/abort`
- `tool.call/register/list/check`
- `model.complete`
- `mcp.call`
- `ui.render/press/input/select/message/open/close/invalidate`

插件可以通过 `register(on)` 注册处理器，使用 matcher 限定命令、工具或输入字段，并通过 `next(e)` 继续调用链。处理器可以异步执行；取消、异常、重复调用和旧 authority 都会在宿主边界重新检查。

### 会话读取

以下会话读取已经接入真实主图或受控的只读 checkpoint 查询：

- `session.id`
- `session.cwd`
- `session.surface/surfaces`
- `session.model`
- `session.messages`
- `session.turns`
- `session.repo`
- `session.usage`

读取的是实际模型请求和 checkpoint 数据，不依赖渲染器展示日志，也不会为了查询额外创建模型调用或工具执行。

### 上下文用量和 breakdown

`session.usage()` 已支持基础上下文窗口和最近有效模型响应的 provider usage。`session.usage({ breakdown: "summary" | "full", columns })` 还会返回：

- system prompt
- system tools
- messages
- `Unattributed`
- free space
- 总 token 数、窗口上限、百分比和消息明细
- 独立的 provider `apiUsage`

`summary` 使用有界的本地序列化估算，`full` 使用更详细的 system/tools/LangChain message estimator。两者都标记 `estimated: true`，不会把估算结果冒充 provider 精确账单。当前没有真实价格账本，因此不伪造 `cost` 或 rate limit 数据。

### 显式压缩

`$.session.compact({ instructions? })` 已贯通 SDK、manager、IPC、host、runtime、checkpoint 和归档路径：

1. 先读取最新主图状态并生成无副作用的 compaction plan。
2. 检查线程 lease、checkpoint、authority、generation 和消息 fingerprint。
3. 写入内部历史归档。
4. 通过 `updateState()` 写入摘要消息和压缩边界。
5. 执行 `flushStrict()` 后才向插件返回成功。

外部返回形状为：

```ts
{ messages, tokensBefore?, tokensAfter? }
```

或：

```ts
{ skip }
```

内部归档路径保存在 checkpoint 的 `SummarizationEvent.filePath`，不会泄露给插件。主线程正在运行、会话没有可绑定主图、状态发生变化、操作取消或 authority 失效时会拒绝提交。归档 rollback 后可以重新 staging。

### 工具、模型、MCP 和 UI

- 支持原生文件读取、目录查询、权限检查和受控工具调用。
- 支持插件注册自定义工具，并将工具暴露给主 Agent 和明确绑定的共享子 Agent。
- 支持 `$.model.complete()` 的文本模型请求，经过模型配置、并发、超时和 provider usage 保护。
- 支持命名 MCP 调用、物理 MCP 连接的权限和结果保护，以及注册工具与 MCP 的嵌套调用。
- 支持有限的 Pane/Client：文本、按钮、输入框、选择框、状态、持久化 state、按键和消息回传。
- 支持桌面、定时任务、心跳、旧远程执行和部分共享子任务的真实 turn 生命周期。

示范插件当前可以使用 `/claw-session`、`/claw-usage-summary`、`/claw-usage-full`、`/claw-files`、`/claw-tools`、`/claw-turn` 和 `/claw-board` 等命令。

## 已完成的验证

| 验证项 | 结果 | 证据 |
| --- | ---: | --- |
| Mods v2 + shared Mods v2 聚焦测试 | 364/364 | `src/main/mods/v2`、`src/shared/mods/v2` |
| 重点 session/usage/compact 回归 | 21/21（本轮定向） | `session-read-host.test.ts`、`context-usage.test.ts`、`basic-sdk.test.ts` |
| utility process 函数回归 | 37/37 | `npm run test:mods:function:process` |
| 桌面 Electron E2E | 64/64 | `output/mods-validation/e2e/result.json` |
| TypeScript | 通过 | `npx tsc --noEmit -p tsconfig.node.json --composite false` |
| ESLint | 通过 | 变更文件 quiet lint |
| Electron 构建 | 通过 | `npm run build` |
| 全量 Vitest | 3610 通过、26 失败、5 跳过 | `output/mods-v2-validation/v27-vitest-full.txt` |

全量 Vitest 的 26 个失败与已知 v25 基线一致，当前不能把全仓库测试称为全绿；Mods 聚焦套件没有发现新增回归。E2E 已覆盖真实的 summary/full breakdown，但没有把长时间挂起的 compact UI 操作伪装成成功；compact 的 host/runtime、skip、lease、归档补偿和恢复路径由聚焦回归覆盖。

## 尚未实现或只实现了部分的能力

### 1. 上下文来源没有完整对齐

当前 breakdown 会明确省略动态 MCP、memory、skills、agents 来源。目标行为需要这些来源参与分类、计数和生命周期更新，而不是只返回 system/tools/messages 的估算结果。

### 2. Claude 的完整 Hook 事件没有全部接入生产触发点

兼容矩阵中仍标记为 planned-adapter 的事件包括 `PreToolUse`、`PostToolUse`、`PermissionRequest`、`SessionStart`、`SessionEnd`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PostCompact`、模型切换和任务生命周期事件等。当前实现有等价的部分内部事件，但还没有逐一提供 Claude 事件名、字段和触发时序的完整适配层。

### 3. 主 Agent 模型控制面不完整

当前 `model.complete` 是独立的文本请求能力，不等于 Claude 的完整主 Agent 模型 Hook。以下能力仍未完成：

- `turn.step`
- `model.fork`
- `model.classify`
- 主 Agent 模型请求的完整历史、工具目录和流式边界控制
- Claude 模型别名和 provider 行为的完整映射

### 4. 内建工具和 JSON Schema 还不是完全兼容

自定义工具、MCP 工具和本工程原生工具已经可以运行，但 Claude 内建 `Read`、`Bash` 等工具的参数、结果和错误 schema 尚未完全对齐。当前 JSON Schema 只支持受控子集，`$ref`、`pattern`、`format` 等关键字会被拒绝，不声称支持完整 JSON Schema。

### 5. UI surface 只覆盖 Pane/Client 子集

当前是 inline Pane/Client 实现，尚未覆盖完整的 dock、全部 UI site、`Svg`/`Code`/`diff` 等组件和构造器替换。焦点、hotkey、hover、scroll、holdToasts、完整 viewport 测量及静态 `$` SDK 使用扫描也仍待实现。

### 6. Session API 仍有 upstream 差异

`session.compact` 是 desktop-live 能力；冷会话无法伪造绑定运行时。`session.authorize` 在本工程没有 Anthropic 一方凭据时返回空结果。`session.attach`、`session.detach`、`session.receive` 等目标 API 尚未完成完整生产适配。

### 7. 资源和长期稳定性门禁未完成

还没有完成 standalone UAT、完整 5×1000 性能矩阵、长时间空闲测试、两小时稳定性测试和更完整的 compact 重启组合。当前的 P95 记录证明关键路径可运行，但不能代表长期生产稳定性。

## 与目标效果的差距

| 领域 | 当前效果 | 目标效果 | 差距判断 |
| --- | --- | --- | --- |
| 插件运行 | 可安装、授权、隔离执行和撤权失效 | 与 Claude Mods 一致的插件生命周期 | 核心模型已具备，完整事件和包生态仍有差距 |
| Hook 链 | matcher、`next`、异步、取消、权限边界可用 | Claude 全部事件名、字段、时序和错误语义 | 生产事件适配仍不完整 |
| 会话读取 | 读取真实主图、checkpoint、Git 和 live usage | 完整 Session API 和所有上下文来源 | 动态来源、冷/热语义及部分 API 缺失 |
| 上下文 breakdown | summary/full 两条估算路径，provider usage 独立 | 完整准确分类，覆盖 MCP/memory/skills/agents | 分类范围和 tokenizer 精度不足 |
| Compact | 空闲主会话可安全提交、归档、恢复和补偿 | 完整 Claude compact 生命周期和桌面行为 | 核心路径已实现，长时间/更多重启组合待补齐 |
| 工具 | 原生、注册工具、MCP、权限和审计可用 | 完整内建工具和 schema parity | 内建工具映射和部分 JSON Schema 未对齐 |
| 模型 | 独立文本 completion 可用 | 主 Agent 模型控制、fork/classify/stream 全量对齐 | 控制面明显不足 |
| UI | inline Pane/Client 可交互和持久化 | 完整 Sites、组件和输入能力 | UI surface 仍是子集 |
| 发布质量 | 聚焦 364/364、进程 37/37、E2E 64/64 | 全仓库绿灯或明确隔离、长期性能稳定 | 已通过核心回归，发布门禁未全部满足 |

## 当前适合怎么使用

当前版本适合：

- 在本工程内开发和试用自定义 Claw 插件。
- 做会话查询、上下文观察、工具包装、MCP 适配和轻量 Pane UI。
- 在安全的宿主边界内做命令、工具和模型扩展。
- 验证 Hook authority、权限、取消、审计和生命周期设计。

当前不应把它描述成：

- 可直接替换 Claude Code 的完整 Mods SDK。
- 覆盖 Claude 全部经典 Hook 的兼容运行时。
- 具备完整 provider tokenizer、动态上下文分类和长期稳定性证明的生产发行版。

## 后续实现顺序

1. 先补齐动态 MCP、memory、skills、agents 的上下文来源和 breakdown 分类。
2. 建立 Claude 经典 Hook 到本工程生产事件的适配层，逐个补齐字段、时序和失败语义。
3. 完成主 Agent 模型 Hook、turn step/fork/classify 和流式边界。
4. 补齐内建工具 schema、JSON Schema 支持范围和完整 UI surface。
5. 完成 standalone UAT、完整性能矩阵、长期稳定性和 compact 重启组合。
6. 只有上述项目和兼容矩阵中的 `fullParity` 差异全部关闭后，才把状态改为完整 upstream parity。

## 参考文档

- [最终对齐实施计划](mods-v2-final-implementation-plan.md)
- [完成度复核](mods-v2-completion-review-2026-09-18.md)
- [当前上下文用量与压缩边界](mods-v2-context-usage-2026-09-18.md)
- [函数 Mods 开发与当前支持范围](mods-v2-authoring.md)
- [兼容性矩阵](mods-v2-compatibility-matrix.json)
