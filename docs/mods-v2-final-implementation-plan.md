# Mods v2 最终对齐实施计划

**版本：** v27

**日期：** 2026-09-18

**开发分支：** `codex/mods-v2`

**目标工作区：** `C:\ai\CmbCoworkAgent-mods-v2`

本文档用于指导 Mods v2 后续实现、代码检视和最终验收。后续开发不得修改 UAT 工作区 `C:\ai\CmbCoworkAgent`，所有改动先在本分支完成并验证。

> **v27 复核更新（2026-09-18）**：`session.usage` 的 `summary/full` 已接入不同的本地/详细估算路径；
> `session.compact` 的外部结果已收敛为 `{ messages, tokensBefore?, tokensAfter? }` 或 `{ skip }`，内部归档指针仍保留在
> checkpoint；归档 rollback 后可重新 staging；Mods v2 + shared 目录当前 364/364 通过，跨进程函数回归 37/37 通过。
> 单 worker 全量 Vitest 为 3610 通过、26 失败、5 跳过且无 unhandled error，失败数与已知基线一致；桌面 E2E 为 64/64，
> 新增 usage summary/full 已覆盖。动态 breakdown 来源、B3–B8 和完整性能门禁仍未完成，不能标记最终 full parity。

## 1. 最终目标

让本工程的 Mods 模块具备与 Claude Code 当前 Function Hooks / Mods 会话能力一致的使用模型：

- 插件可以读取当前真实会话，而不是读取伪造或过期快照。
- 插件可以在安全边界内触发显式上下文压缩。
- 压缩操作具有明确的准备、校验、提交和失败语义。
- 插件可以读取当前上下文用量和 breakdown。
- 插件、主线程、子线程、工具调用和 checkpoint 之间具有稳定的 authority、lease、generation 和 scope 隔离。
- 插件卸载、授权撤销、线程切换、工作区切换和 AbortSignal 都能及时终止旧操作。
- 所有新增能力都有 SDK、IPC、host、runtime、持久化、异常路径和 E2E 覆盖。

## 2. 当前状态

### 2.1 已完成能力

以下能力已经实现并完成了聚焦验证：

1. `session.repo`、`session.model`、`session.messages`、`session.turns`、`session.usage` 的基础会话读取。
2. live session view 与真实主图消息状态绑定。
3. function session 的 authority、scope、generation 和失效检查。
4. 主线程运行 lease 与插件读写边界。
5. `$.session.compact({ instructions? })` SDK 接口。
6. 显式压缩的 `skip`、`messages`、`tokensBefore`、`tokensAfter` 返回契约。
7. 显式压缩拒绝当前主线程正在运行的场景。
8. 压缩前使用最新真实模型请求的 system message、tools 和 runtime 上下文。
9. 压缩后通过 `agent.updateState()` 和 `checkpointer.flushStrict()` 提交 checkpoint。
10. 基础 SDK、host、IPC、manager、runtime 和 authority 层的紧凑测试。

### 2.2 当前验证结果

- TypeScript 类型检查通过。
- Mods v2 与 shared Mods v2 目录聚焦测试通过：364 个测试。
- DeepAgents 压缩相关测试通过：78 个测试。
- Electron 构建通过。
- 修改文件的 quiet ESLint 通过。
- v25 全量基线已确认：已知 26 个失败、5 个跳过，不能把这些历史失败误判为本批次回归。

### 2.3 当前未完成项

1. breakdown 的动态 MCP、memory、skills、agents 分类仍保持 omission，尚未达到完整 upstream parity。
2. 显式压缩的历史归档指针和重启恢复语义仍需补齐更多真实重启验证。
3. 显式压缩与 checkpoint 并发更新的一致性仍需继续加固。
4. standalone UAT、完整性能回检和更长稳定性门禁仍未全部达到发布门禁。
5. 本轮 source/doc 修复提交前仍需完成最终检视和验证记录。

## 3. 历史调研、设计和反编译参考材料

新会话开始实现前，先按下面顺序阅读。所有路径均相对于
`C:\ai\CmbCoworkAgent-mods-v2`，历史产物只作为设计证据，不能直接复制实现。

### 3.1 用户提供的原始架构文档

```text
C:\Users\87624\xwechat\_files\wxid_amfml3ktb7tu21\_a7a4\msg\file\2026-09\EXTERNAL.Function.Hooks.Core.Architecture.pdf
```

重点关注：Function Hooks 的分层、宿主 authority、hook registration、调用链、取消和生命周期语义。

### 3.2 总体目标与早期方案

```text
docs/mods-v2-parity-design-2026-09-16.md
docs/mods-v2-implementation-2026-09-16.md
docs/mods-v2-final-implementation-plan.md
docs/mods-implementation-progress.md
docs/mods-completion-worklog.md
output/mods-insight-2026-09-17/mods-insight-final-target.txt
```

阅读目的：了解为什么要做 Mods、目标使用方式、已放弃的方案、批次边界以及“对齐 Claude Code”具体指什么。

### 3.3 Host、authority 和运行时基础

```text
docs/mods-v2-host-foundation-2026-09-17.md
docs/mods-v2-agent-authority-design-2026-09-17.md
docs/mods-v2-runtime-authority-2026-09-17.md
docs/mods-v2-agent-instances-2026-09-17.md
docs/mods-v2-turn-lifecycle-2026-09-18.md
docs/mods-v2-background-turns-2026-09-18.md
docs/mods-v2-child-turns-2026-09-18.md
docs/mods-v2-turn-presentation-2026-09-18.md
docs/mods-v2-refusal-turns-2026-09-18.md
```

阅读目的：理解 authority、generation、lease、主 agent 与子 agent 隔离、后台 turn、取消和 turn completion 的已有约束。后续 compact 或 usage 实现不能绕过这些边界。

### 3.4 Session、工具和 SDK 设计

```text
docs/mods-v2-session-read-2026-09-18.md
docs/mods-v2-authoring.md
docs/mods-v2-context-usage-2026-09-18.md
docs/mods-v2-tool-catalog-2026-09-17.md
docs/mods-v2-tool-permission-2026-09-17.md
docs/mods-v2-mcp-sdk-2026-09-17.md
docs/mods-v2-mcp-tool-routing-2026-09-17.md
docs/mods-v2-registered-mcp-2026-09-17.md
docs/mods-v2-compatibility-matrix.json
```

阅读目的：保持 session read、tool routing、MCP、权限、SDK 输入输出和兼容性矩阵的一致性，避免新增能力破坏既有 contract。

### 3.5 Claude Code 反编译产物

反编译版本固定为 Claude Code 2.1.273：

```text
output/claude-code-2.1.273-analysis/manifest.json
output/claude-code-2.1.273-analysis/formatted/chunk-hr43png0.js
output/claude-code-2.1.273-analysis/extracted/chunk-c5xn880r.js
output/claude-code-2.1.273-analysis/extracted/chunk-x1btkhgs.js
output/claude-code-2.1.273-analysis/extract_bun.py
output/claude-reference/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts
```

重点检索位置：

- `session.compact` 的输入校验、active-turn 拒绝、返回的 `messages/tokensBefore/tokensAfter/skip`。
- `session.usage` 的 `breakdown`、`columns`、`contextData`、`Dyn`、`Fyn`、`War`。
- `contextData` 的 categories、messages、system prompt、system tools、MCP tools、agents、memory、skills、API usage 计算。
- host session bound、live read、context window 和 rate limit 的缺省语义。

反编译产物是行为依据，不是可直接拷贝的源码。无法从本工程运行时确认的 Claude Code 字段必须保持 omission 或明确 unavailable，禁止填充虚假数据。

### 3.6 压缩控制器专项研究

```text
output/mods-v2-validation/context-controller-research.md
output/mods-v2-validation/claude-code-2.1.273.d.ts
output/mods-v2-validation/claude-conformance.txt
output/mods-v2-validation/claude-sdk-conformance.txt
output/mods-v2-validation/claude-state-conformance.txt
output/mods-v2-validation/usage-full-comparison.txt
output/mods-v2-validation/usage-standalone-comparison.json
output/mods-v2-validation/session-read-standalone-comparison.json
```

这组材料已经冻结了以下结论：

- compact 必须区分 prepare 和 commit。
- prepare 阶段不产生 archive 或 checkpoint 副作用。
- active main turn 期间拒绝 compact。
- compact 的返回消息是实际投影的消息数组，不是消息数量。
- usage breakdown 应来自真实 context data，不能用静态常量模拟。

### 3.7 历史验证产物

```text
output/mods-v2-validation/vitest-full.txt
output/mods-v2-validation/vitest-full.json
output/mods-v2-validation/usage-e2e-final-result.json
output/mods-v2-validation/session-read-standalone-final.txt
output/mods-v2-validation/host-foundation-standalone.txt
output/mods-v2-validation/host-foundation-performance-final.txt
output/mods-v2-validation/background-final-tests.txt
output/mods-v2-validation/child-final-tests.txt
output/mods-v2-validation/turn-full-first.txt
```

这些文件用于比较历史基线、失败数量、standalone 结果和性能趋势。执行新验证时不要覆盖旧产物，使用带批次和日期的新文件名。

### 3.8 禁止直接应用的临时产物

```text
output/mods-v2-validation/v26-rejected-draft.patch
```

该 patch 是被拒绝的实验实现，只能用于了解错误方向，不能应用或恢复。它错误地把 usage 归因于单一 Messages 类别。

## 4. 分批实施计划

### 批次 0：基线冻结与代码检视

**目的：** 在新增实现前固定现状，避免后续把既有问题当作新回归。

**工作内容：**

- 确认分支为 `codex/mods-v2`。
- 确认所有改动只发生在 `C:\ai\CmbCoworkAgent-mods-v2`。
- 复核 v26 当前 17 个修改文件的接口调用链。
- 复核 `session.compact` 从 SDK 到 runtime、checkpoint 的完整路径。
- 将消息比较从不稳定的对象序列化升级为必要时的稳定 fingerprint。
- 复核每个异步边界是否调用 `signal.throwIfAborted()`、`assertLive()` 和 `session.assertLive()`。

**完成标准：**

- 没有跨分支或跨 workspace 的修改。
- 不存在绕过 manager/authority 的直接 checkpoint 写入。
- 现有 v25 测试不出现新增失败。

### 批次 1：实现 `session.usage` breakdown

**目的：** 对齐 Claude Code `contextData({ detail, terminalWidth })` 的公开结果，而不是继续返回 unavailable。

**实现内容：**

- 扩展共享类型，支持 `context.breakdown`。
- 增加 `summary` 和 `full` 的输入校验。
- 保留 `columns` 参数并验证正整数边界。
- 在 context controller 中暴露最新模型请求的真实 system message、tools、messages 和 model。
- 使用真实 provider usage 计算 `apiUsage`。
- 使用现有 LangChain token estimator 计算可确认的 system、tools、messages 分类。
- 对无法确认的 token 使用 `unattributed`，禁止伪造 MCP、memory、skills 或 agents 数值。
- 输出 `totalTokens`、`maxTokens`、`percentage`、`categories`、`model` 和 `messageBreakdown`。
- 没有有效模型请求时保持明确的 `MODS_CONTEXT_BREAKDOWN_UNAVAILABLE`。
- 通过 host、IPC、SDK 和 live session 测试验证结果形状及生命周期。

**参考依据：**

- Claude Code 2.1.273 反编译产物中的 `contextData`、`Dyn`、`MOt`、`War` 和 `Fyn`。
- `output/claude-code-2.1.273-analysis/formatted/chunk-hr43png0.js`。

**完成标准：**

- `summary` 和 `full` 都有可验证的结果。
- `full` 至少正确表达 system/tools/messages 和 API usage。
- 不能把估算值冒充 provider 精确值。
- breakdown 读取不会创建 checkpoint、归档或模型调用副作用。

### 批次 2：补齐显式压缩的归档与恢复

**目的：** 让显式压缩不仅更新内存 checkpoint，也具备稳定的历史恢复语义。

**实现内容：**

- 明确 `prepare` 阶段与 `commit` 阶段的边界。
- 准备阶段只生成压缩计划，不写 archive、不更新 checkpoint。
- 提交阶段按固定顺序写入归档和 checkpoint。
- 内部保留真实归档 `filePath` 或等价归档标识，但插件结果不暴露该字段。
- 归档失败时保持 checkpoint 原子性，不能返回虚假的成功结果。
- 重启后恢复压缩摘要、usageStartIndex 和归档指针。
- 验证 `skip` 完全无副作用。
- 验证压缩后 `session.messages`、`session.usage` 和 `session.compact` 读取的一致性。

**完成标准：**

- 重启进程后压缩结果仍可恢复。
- 归档失败和 checkpoint 失败均能返回明确错误。
- 没有重复归档、孤儿归档或旧摘要复活。
- 现有自动压缩行为保持不变。

### 批次 3：并发、权限和生命周期加固

**目的：** 复核显式压缩和 breakdown 在真实插件生命周期中的安全性。

**场景：**

- 主线程运行期间调用 compact。
- compact 准备期间出现新的用户消息。
- checkpoint 被其他流程更新。
- 插件被卸载或授权被撤销。
- 工作区、线程或 runtime generation 发生变化。
- AbortSignal 在读取、估算、压缩模型调用、checkpoint flush 和 archive 写入期间触发。
- 子 agent 读取主 agent session。
- 同一线程多个插件并发读取。

**完成标准：**

- 旧 authority、旧 generation 和旧 lease 均不能提交结果。
- 所有被取消操作最终释放引用、监听器和定时器。
- 不会把子 agent 状态误当成主 agent 状态。
- 不会因并发读取引入 checkpoint mutation。

### 批次 4：代码检视与聚焦回归

**执行顺序：**

1. 修改文件 `eslint --quiet`。
2. `npx tsc --noEmit -p tsconfig.node.json --composite false`。
3. Mods v2 全目录测试。
4. context usage、summarization、session compact 专项测试。
5. SDK 输入输出契约测试。
6. IPC、scope、authority、lease 失败路径测试。
7. `git diff --check`。
8. 变更代码人工检视：状态机、异步边界、持久化、错误码、类型收窄。

**完成标准：**

- 新增行为每条都有回归测试。
- 没有通过 `any`、类型断言或空对象绕过契约检查的实现。
- 所有错误码均能映射到可诊断的失败原因。

### 批次 5：全量构建、E2E 和性能回检

**执行内容：**

- 全量 Vitest。
- Electron main/preload/renderer build。
- standalone UAT。
- Mods v2 E2E 全流程。
- compact 成功、skip、失败、取消、重启恢复场景。
- 1000 次 no-op/live read 性能测试。
- `session.usage` breakdown 读取 P95。
- 与 v25 基线比较测试失败数、耗时和内存趋势。

**通过门槛：**

- 全量失败数不超过已知基线 26 个。
- 跳过数不超过已知基线 5 个。
- 不出现新增进程泄漏。
- no-op 和 live read P95 没有明显回归。
- E2E 覆盖 compact、usage breakdown、scope invalidation 和 restart recovery。

### 批次 6：提交与交付

**提交前检查：**

- `git status --short` 只包含预期源代码、测试和文档。
- 删除临时日志、patch、生成 bundle 和本地凭据。
- 更新 `docs/mods-v2-authoring.md` 使用说明。
- 更新 `docs/mods-v2-compatibility-matrix.json`。
- 更新 `docs/mods-v2-context-usage-2026-09-18.md`。
- 记录全量测试、E2E 和性能结果。

**建议提交：**

```text
feat(mods): align session compaction and context breakdown
```

## 5. 关键设计约束

### 4.1 不伪造上下文数据

只有运行时实际提供的数据才能进入 breakdown。估算 token 必须标注为估算；provider usage 必须单独保留，不能混成一个未经说明的精确值。

### 4.2 不在读取操作中写状态

`session.messages`、`session.turns`、`session.usage` 和 breakdown 都是读取操作，不能因为读取而更新 checkpoint、归档、摘要事件或模型调用计数。

### 4.3 压缩必须是显式的状态转换

显式 compact 只能在主线程空闲时执行，必须经过：

```text
capture latest request
    -> prepare compaction plan
    -> validate scope and unchanged checkpoint
    -> commit checkpoint/archive
    -> flush strictly
    -> project result
```

任何一步失败，都不能返回看似成功的消息结果。

### 4.4 兼容性优先于新增抽象

新增类型和返回字段应尽量保持 Claude Code 的字段名称和语义。对于本工程暂时无法支持的字段，使用明确的 unavailable 或 omission，不创建本地私有字段冒充 Claude Code 行为。

## 6. 新会话接续指令

新会话开始时执行：

```text
继续 C:\ai\CmbCoworkAgent-mods-v2 的 codex/mods-v2 分支。不要丢弃未提交改动。阅读 docs/mods-v2-final-implementation-plan.md，从批次 1 开始实现 session.usage breakdown，然后按批次 2 到 6 完成归档一致性、并发检视、全量测试、E2E、性能回检和最终提交。
```
