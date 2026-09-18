# Mods v2 最终对齐实施计划

**版本：** v26

**日期：** 2026-09-18

**开发分支：** `codex/mods-v2`

**目标工作区：** `C:\ai\CmbCoworkAgent-mods-v2`

本文档用于指导 Mods v2 后续实现、代码检视和最终验收。后续开发不得修改 UAT 工作区 `C:\ai\CmbCoworkAgent`，所有改动先在本分支完成并验证。

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
- Mods v2 目录聚焦测试通过：347 个测试。
- DeepAgents 压缩相关测试通过：78 个测试。
- Electron 构建通过。
- 修改文件的 quiet ESLint 通过。
- v25 全量基线已确认：已知 26 个失败、5 个跳过，不能把这些历史失败误判为本批次回归。

### 2.3 当前未完成项

1. `session.usage({ breakdown: "summary" | "full" })` 仍未实现。
2. 显式压缩的历史归档指针和重启恢复语义仍需补齐。
3. 显式压缩与 checkpoint 并发更新的一致性仍需进一步加固。
4. v26 尚未重新执行全量 Vitest、standalone UAT、E2E 和性能回检。
5. 当前 v26 改动尚未提交。

## 3. 分批实施计划

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
- 返回真实 `filePath` 或等价归档标识。
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

## 4. 关键设计约束

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

## 5. 新会话接续指令

新会话开始时执行：

```text
继续 C:\ai\CmbCoworkAgent-mods-v2 的 codex/mods-v2 分支。不要丢弃未提交改动。阅读 docs/mods-v2-final-implementation-plan.md，从批次 1 开始实现 session.usage breakdown，然后按批次 2 到 6 完成归档一致性、并发检视、全量测试、E2E、性能回检和最终提交。
```

