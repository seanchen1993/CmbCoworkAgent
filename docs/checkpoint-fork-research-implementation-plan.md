# 从 checkpoint fork 新会话：调研方案与实施方案

本文档说明 CmbCoworkAgent 如何参考 `C:\ai\codex` 实现“从某个 checkpoint fork 出新会话”的能力。文档分为两部分：

- 调研方案：明确要验证什么、参考哪些实现、产出哪些结论。
- 实施方案：给出本工程可落地的接口、数据、流程、阶段拆分、测试和风险控制。

## 1. 背景与目标

当前 CmbCoworkAgent 已经使用 LangGraph checkpoint 持久化每个 thread 的运行状态。用户希望能够在已有会话的某个历史 checkpoint 上创建一个新会话，新会话保留该 checkpoint 之前的上下文和 graph state，并从该点继续发展，源会话保持不变。

目标能力：

1. 用户可以从当前会话的最新 checkpoint fork 出新会话。
2. 用户可以从历史 checkpoint fork 出新会话。
3. fork 后的新会话拥有独立 `thread_id`、独立 checkpoint 文件、独立 UI 状态。
4. 源会话的 metadata、checkpoint、运行状态不被修改。
5. fork 后继续发送消息时，复用现有 `createAgentRuntime({ threadId })` 恢复路径。

非目标能力：

1. 第一阶段不支持运行中会话的无损实时 fork。
2. 第一阶段不支持 coordinator worker / workflow subagent 的内部 checkpoint 作为 fork 源。
3. 第一阶段不做跨 workspace fork，也不自动复制工作区文件快照。
4. 第一阶段不把 fork 做成完整 rollback/branch tree 产品，仅记录来源关系。

## 2. 参考实现调研方案

### 2.1 调研对象

重点参考 `C:\ai\codex` 中 app-server 与 core 的 fork 实现：

| 范围 | 文件 | 关注点 |
| --- | --- | --- |
| app-server 请求处理 | `C:\ai\codex\codex-rs\app-server\src\request_processors\thread_processor.rs` | `thread/fork` 参数解析、源 thread 读取、新 thread 响应契约 |
| core thread 管理 | `C:\ai\codex\codex-rs\core\src\thread_manager.rs` | `ForkSnapshot`、从历史创建新 thread、`forked_from_id` 语义 |
| 历史截断 | `C:\ai\codex\codex-rs\core\src\thread_rollout_truncation.rs` | `lastTurnId` 截断边界、in-progress turn 拒绝策略 |
| 协议定义 | `C:\ai\codex\codex-rs\app-server-protocol\src\protocol\v2\thread.rs` | `ThreadForkParams`、`ThreadForkResponse` 字段设计 |
| 测试 | `C:\ai\codex\codex-rs\app-server\tests\suite\v2\thread_fork.rs` | 不修改源会话、复制历史、新 id、通知和错误用例 |

### 2.2 Codex 可借鉴结论

Codex 的 fork 不是修改源会话，而是从源会话的持久化历史创建一个新 thread：

- 新 thread 拥有新的 id。
- 新 thread 记录 `forked_from_id`。
- 源会话 rollout 文件不被修改。
- 可以通过 `lastTurnId` 截断到某个 persisted canonical turn 的稳定边界，并拒绝 in-progress turn。
- fork 后新 thread 状态为 idle，可立即继续 turn。
- 支持模型、cwd、权限等配置 override。
- 对运行中或非稳定边界有明确拒绝/截断策略。

对应到本工程，Codex 的“历史前缀”可以映射为 LangGraph 的“checkpoint tuple”。本工程不需要重放 rollout；更适合直接复制 checkpoint tuple 到新 thread。

对齐边界：

- 已对齐：新 id、不修改源 thread、记录 fork 来源、fork 后 idle、支持指定历史点 fork。
- P0/P1 阶段性差异：Codex 对运行中 fork 可通过 `ForkSnapshot::Interrupted` 自动补 interrupted boundary；本工程 P0/P1 选择拒绝运行中、interrupt、pending approval checkpoint，P3 再对齐 interrupted boundary 语义。
- 暂不对齐：Codex 协议还支持 `path`、`ephemeral`、`excludeTurns`，以及更完整的模型、权限、cwd、response 配置 override。MVP 只开放白名单 override，避免把运行态 metadata 引入 fork。
- 必须对齐：历史/消息级 fork 不能命中半轮 checkpoint。P1/P2 的 checkpoint summary 和 message resolver 必须标注并使用稳定 turn 边界，等价于 Codex `lastTurnId` 的 persisted canonical turn 约束。

## 3. 本工程现状调研方案

### 3.1 当前关键实现

| 范围 | 文件 | 当前能力 |
| --- | --- | --- |
| thread IPC | `src/main/ipc/threads.ts` | 已有 create/update/delete/history/latest-checkpoint/export |
| runtime checkpoint 缓存 | `src/main/agent/runtime.ts` | `getCheckpointer`、`withCheckpointer`、LRU、pin、close 协调 |
| checkpoint 存储 | `src/main/checkpointer/sqljs-saver.ts` | SQLite checkpoints/writes 表、`getTuple/list/put/putWrites/deleteThread` |
| checkpoint 文件路径 | `src/main/storage.ts` | `getThreadCheckpointPath(threadId)`，每个 thread 一个 sqlite |
| renderer thread store | `src/renderer/src/lib/store.ts` | `createThread/selectThread/deleteThread/updateThread` |
| renderer checkpoint 恢复 | `src/renderer/src/lib/thread-context.tsx` | 打开 thread 时从 `threads:getHistory` 恢复消息、todo、interrupt、goal UI |
| preload API | `src/preload/index.ts`、`src/preload/index.d.ts` | `window.api.threads.*` 暴露层 |

### 3.2 当前阻塞点

最大阻塞点是 `SqlJsSaver` 当前每个 `(thread_id, checkpoint_ns)` 只保留 1 个 checkpoint：

```text
maxCheckpointsPerNamespace = 1
```

这满足“恢复最新状态”，但不满足“从某个历史 checkpoint fork”。因此需要引入可配置保留策略。

第二个阻塞点是 fork 时不能只复制 `checkpoint.checkpoint.channel_values.messages`。完整恢复依赖：

- checkpoint 主体；
- metadata；
- pending writes；
- checkpoint namespace；
- 部分 renderer `thread_values` 中的展示层时间和 transcript 数据。

如果只复制消息列表，后续继续运行可能丢失 LangGraph 节点状态、interrupt 状态、tool pending write、todo 和子任务状态。

## 4. 调研工作拆分

### 4.1 Codex 行为验证

验证项：

1. fork 是否修改源会话。
2. fork 后的新 thread 如何记录来源。
3. `lastTurnId` 是如何定义稳定边界的。
4. 运行中 turn 如何处理。
5. fork response 和 started notification 有哪些字段。
6. 配置 override 如何继承或覆盖。

产出：

- Codex fork 行为对照表。
- 本工程可复用语义与不可复用实现清单。

### 4.2 本工程 checkpoint 结构验证

验证项：

1. `SqlJsSaver.getTuple` 返回的 tuple 是否包含恢复所需完整数据。
2. `pendingWrites` 在 HITL 或中间状态下是否存在。
3. `put` + `putWrites` 是否足以把源 checkpoint 写入新 thread。
4. `checkpoint.id` 保持不变时，新 thread 的 `list(... limit: 1)` 是否可读为最新 checkpoint。
5. 多 checkpoint 保留后 sqlite 大小和内存影响。

产出：

- checkpoint fork 最小可行样例测试。
- checkpoint 保留数量和文件大小建议。

### 4.3 UI 恢复链路验证

验证项：

1. 新 thread 插入 store 后，`thread-context` 是否能按现有逻辑恢复 transcript。
2. `thread_values.messageTimes` 不复制时会产生什么 UI 差异。
3. `subagentTranscripts` 是否需要复制。
4. active goal、workflow、coordinator worker 状态是否应该复制。

产出：

- `thread_values` 白名单字段。
- fork 后 UI 状态预期。

### 4.4 并发与运行态验证

验证项：

1. source thread 正在运行时 fork 是否安全。
2. checkpointer LRU close/pin 是否会与 fork 操作冲突。
3. fork 写新 checkpoint 时是否需要 flush。
4. delete source thread 时是否影响 forked thread。

产出：

- MVP 并发限制。
- 后续支持运行中 fork 的设计预案。

## 5. 实施方案总览

推荐实现路径：

```text
保留多个 checkpoint
-> 新增 main IPC: threads:fork
-> 复制 checkpoint tuple 到新 thread
-> 复制展示层 thread_values 白名单
-> preload + renderer store 接入
-> 侧边栏入口
-> 历史 checkpoint 列表和消息级 fork 入口
```

核心原则：

1. fork 是创建新 thread，不改变源 thread。
2. fork 复制完整 checkpoint tuple，不重放消息。
3. 新 thread 使用新的 checkpoint sqlite 文件。
4. renderer 仍通过现有 `threads:history` 恢复 UI。
5. 第一阶段运行中 source thread 直接拒绝。

## 6. 数据设计

### 6.1 Thread metadata

新 thread metadata 继承源 thread 的安全字段，并补充 fork 元信息：

```ts
{
  title: "Fork: <source title>",
  workspacePath: source.metadata.workspacePath,
  model: source.metadata.model,
  agentMode: source.metadata.agentMode,
  memoryEnabled: source.metadata.memoryEnabled,
  forkedFromThreadId: sourceThreadId,
  forkedFromCheckpointId: checkpointId,
  forkedFromCheckpointNs: checkpointNs,
  forkedAt: new Date().toISOString()
}
```

不建议继承：

- active workflow run 状态；
- coordinator worker 运行态；
- pending notification；
- scheduled/heartbeat/chatx 专用标识；
- transient UI loading 状态；
- goal active runtime 状态。

### 6.2 Thread values 白名单

建议复制：

| key | 说明 | 是否复制 |
| --- | --- | --- |
| `messageTimes` | 可见消息时间 | 是 |
| `messageTimeOrder` | 可见消息时间顺序兜底 | 是 |
| `internalGoalMessageTimes` | 内部 goal prompt 时间 | 是 |
| `internalGoalMessageTimeOrder` | 内部 goal prompt 时间顺序兜底 | 是 |
| `subagentTranscripts` | 展示用子任务 transcript | 可选，MVP 可复制 |

不建议复制其他未知字段。后续新增字段时再显式加入白名单。

历史 checkpoint fork 时不能无条件复制整份白名单。renderer 恢复会把目标 thread 的 `messageTimes` / `messageTimeOrder` 应用到 fork checkpoint 的 transcript；如果把源会话最新的整份时间表复制过去，会携带 fork 点之后的消息 id 和顺序兜底，合成 id 或 order fallback 下可能错配。

过滤规则：

1. 先从目标 checkpoint 提取可见消息 id、内部 goal prompt id 和最终 transcript 顺序。
2. `messageTimes` 只保留目标 checkpoint 可见消息 id 对应项。
3. `internalGoalMessageTimes` 只保留目标 checkpoint 内部 goal prompt id 对应项。
4. `messageTimeOrder` 按目标 checkpoint 最终可见 transcript 顺序重建，不直接复制源数组。
5. `internalGoalMessageTimeOrder` 按目标 checkpoint 内部 goal prompt 顺序重建。
6. `subagentTranscripts` 仅保留目标 checkpoint 中仍存在 owner/tool call 的 transcript；无法可靠关联时 MVP 可不复制。

实现约束：

- fork handler 应构造完整的 `filteredThreadValues`，并把它作为目标 thread 的最终 `thread_values` 写入。
- 不要先复制源 thread 的 `thread_values`，再调用 `mergeThreadValues` 或类似 merge API 写过滤补丁。当前 `mergeThreadValueObjects` 会按 id 追加/合并 `messageTimeOrder`，语义不是“替换为过滤后的完整数组”，容易把 fork 点之后的顺序残留到新 thread。
- 如果 `dbCreateThread` 不能直接接收 `thread_values`，则在创建 row 后调用 `dbUpdateThread(targetThreadId, { thread_values: JSON.stringify(filteredThreadValues) })` 这类“整字段替换”接口；不要使用 thread values merge 接口。

共享实现约束：

- main handler 不要在 IPC 内重写一套 renderer transcript 恢复顺序。当前相关逻辑分散在 `thread-context.tsx`、`goal-transcript.ts`、`checkpoint-message-times.ts`，需要把“从 checkpoint 提取可见消息 id、内部 goal id、最终展示顺序、稳定边界标记”的纯逻辑抽到 shared。
- 建议新增 `src/shared/checkpoint-transcript.ts`，提供：
  - `deriveCheckpointTranscriptIndex(checkpoint)`：返回 visible message ids、internal goal ids、display order、last visible message id。
  - `deriveCheckpointForkability(tuple, context)`：基于 checkpoint metadata、pending writes、interrupt、pending approval 和 legacy fallback context 返回 durable boundary id、`isStableTurnBoundary`、`boundarySource`、unstable reason。
  - `buildFilteredThreadValues(sourceThreadValues, transcriptIndex)`：按 shared index 构造完整 `filteredThreadValues`。
- renderer 恢复链路和 main fork handler 都复用该 shared 模块；fixture 测试覆盖同一批 checkpoint，避免 main 与 renderer 对 transcript 顺序、合成 id、goal prompt 顺序产生分叉。

### 6.3 稳定 turn boundary 定义

当前工程里的 `turnId` 主要服务 hook、UI 分桶和 user message 关联，不是 Codex 那种可持久化、可截断的 canonical turn boundary。因此 `isStableTurnBoundary` 不能直接依赖现有 `turnId`。

新增 checkpoint metadata durable marker，作为未来 checkpoint 的唯一稳定边界来源。不要在 graph 运行中预先猜测稳定边界；应在 agent stream 成功 drain、最终 checkpoint 已经持久化之后，再标记最新 root checkpoint：

```ts
interface ForkBoundaryMetadata {
  version: 1
  kind: "turn_complete"
  boundaryId: string
  userMessageId?: string
  lastVisibleMessageId?: string
  completedAt: string
  source: "agent_run_complete" | "scheduled_run_complete" | "heartbeat_run_complete"
}
```

可存放在 checkpoint metadata 的 `cmb_fork_boundary` 字段。`boundaryId` 由 main 生成，要求 durable、进程重启后不变；可以使用 `turn_complete:${threadId}:${checkpoint.id}`，不要使用临时 hook/UI turn id 作为唯一依据。现有 hook/UI `turnId` 只能作为辅助字段，例如 `userMessageId`。

marker 写入机制：

1. 在 `SqlJsSaver` 增加专用方法，例如 `updateCheckpointMetadata(config, updater)` 或 `markForkBoundary(config, boundary)`。
2. 该方法只能更新 `checkpoints.metadata` 字段，必须保留原 row 的 `parent_checkpoint_id`、`checkpoint`、`type` 和 `writes`。
3. 不要用现有 `put()` 回写同一个 checkpoint 的 metadata。当前 `put()` 会把传入 config 的 `checkpoint_id` 当作 `parent_checkpoint_id`；如果拿它回写 marker，要么清空 parent，要么把 checkpoint 误设成自己的 parent。
4. marker 写入步骤应为：`getTuple(latest root)` -> 校验无 interrupt / pending approval / pendingWrites -> 构造 `cmb_fork_boundary` -> 原地 UPDATE metadata -> `flush()`。
5. 如果 marker 写入失败，只记录 warn，不回退已完成的 agent turn；该 checkpoint 后续按缺少 marker 处理，P1/P2 不可 fork，P0 只有满足 legacy 最新 idle fallback 时才可 fork。

不得写 `turn_complete` marker 的路径：

- 用户 cancel。
- agent run error 或最终未成功完成。
- HITL interrupt / pending approval 暂停。
- model failover 中失败的候选尝试；只有最终成功完成的那一次可以标记最终最新 checkpoint。
- `agent:resume` / `agent:interrupt` 仍停在审批或错误状态。
- worker / workflow subagent 内部 checkpoint，除非后续阶段显式支持该 namespace 的 fork。

P0/P1 中，一个 checkpoint 只有同时满足以下条件才是 stable boundary：

1. root namespace。
2. metadata 含合法 `cmb_fork_boundary.kind === "turn_complete"`。
3. checkpoint 不含 `__interrupt__`。
4. 不存在 pending approval。
5. `tuple.pendingWrites.length === 0`。

旧会话 fallback：

- 仅允许 `threads:fork` 不传 `checkpointId`、即 fork 最新 checkpoint 时使用。
- source thread 必须通过 fork/run lock 内的 busy 检查，且无 active run、workflow/coordinator pending、interrupt、pending approval、pendingWrites。
- fallback 结果标记为 stable，`stableTurnId = "legacy_latest_idle:" + checkpoint.id`，并记录 `boundarySource: "legacy_latest_idle_fallback"`。
- P1 历史 checkpoint 列表和 P2 消息级 resolver 不对缺少 marker 的旧 checkpoint 做稳定性猜测；缺 marker 时返回 `isStableTurnBoundary: false`，`unstableReason: "missing_boundary_marker"`。

P3 如要支持运行中 fork，可以新增 `kind: "interrupted_boundary"` 或独立 marker，并定义 pending approval 继承语义；该 marker 不属于 P0/P1 stable boundary。

### 6.4 Checkpoint 保留策略

P0 只做“从最新 checkpoint fork”，不需要调整 checkpoint 保留数量，沿用当前每个 root namespace 保留 1 个 checkpoint 的行为即可。这样先降低内存和回归风险。

P1 支持历史 checkpoint fork 时，再引入可配置保留策略。`SqlJsSaver` 增加构造参数：

```ts
interface SqlJsSaverOptions {
  maxCheckpointsPerNamespace?: number
}
```

P1 推荐默认：

- root thread 默认保留 30 个 checkpoint。
- worker/workflow subagent thread 仍保留 1 个 checkpoint。
- 后续可加全局设置或 feature gate。

runtime 创建 checkpointer 时根据 thread id 判断：

```ts
const isEphemeralWorker =
  threadId.includes("__worker__") || threadId.includes("__wf_")

new SqlJsSaver(dbPath, undefined, {
  maxCheckpointsPerNamespace: isEphemeralWorker ? 1 : 30
})
```

如果担心内存，可增加 sqlite 文件大小软上限。超过上限时临时退化为较小保留数量。

## 7. IPC 与 API 设计

### 7.1 Main IPC

新增 handler：

```ts
ipcMain.handle("threads:fork", async (_event, params: ThreadForkParams) => {
  // validate
  // acquire source thread fork/run lock
  // load source thread and workspacePath
  // check source busy states
  // read source checkpoint tuple
  // reject non-root namespace / interrupt / pending approval for P0/P1
  // build filtered thread_values
  // write destination checkpoint with standalone saver and close it
  // create destination thread
  // replace destination thread_values
  // return thread
})
```

参数：

```ts
interface ThreadForkParams {
  sourceThreadId: string
  checkpointId?: string
  title?: string
  overrides?: ThreadForkOverrides
}

interface ThreadForkOverrides {
  title?: string
  model?: string
  workspacePath?: string | null
  memoryEnabled?: boolean
  agentMode?: "normal" | "coordinator" | "workflow"
}
```

MVP/P1 公开 API 不暴露任意 `checkpointNs`。后端固定使用 root namespace `""`，并在 handler 内校验：任何非空 namespace 都视为非法。这样与“第一阶段不支持 worker/workflow subagent 内部 checkpoint”保持一致。后续如果要支持 worker fork，应新增明确的能力和白名单，而不是复用这个参数。

`overrides` 必须是白名单字段。不得允许任意 metadata override，因为 thread metadata 会驱动 scheduled、heartbeat、workflow、coordinator 等恢复逻辑。禁止从外部写入 `scheduledTaskId`、`isHeartbeat`、`workflowRun`、`chatx*`、worker notification、pending 状态等运行态标识。

响应：

```ts
interface ThreadForkResponse {
  thread: Thread
  sourceThreadId: string
  sourceCheckpointId: string
  sourceCheckpointNs: ""
}
```

### 7.2 Checkpoint 列表 API

新增：

```ts
ipcMain.handle("threads:list-forkable-checkpoints", async (_event, threadId: string) => {
  // list root namespace checkpoints, return lightweight summaries
})
```

返回：

```ts
interface ForkableCheckpoint {
  checkpointId: string
  checkpointNs: ""
  createdAt?: string
  messageCount: number
  lastMessagePreview: string
  lastUserMessagePreview?: string
  isStableTurnBoundary: boolean
  stableTurnId?: string
  boundarySource?: "metadata_marker" | "legacy_latest_idle_fallback"
  unstableReason?: "missing_boundary_marker" | "in_progress_turn" | "interrupt" | "pending_approval" | "pending_writes" | "unknown"
  hasInterrupt: boolean
  hasPendingWrites: boolean
}
```

MVP 也可以先不做该 API，只支持从最新 checkpoint fork。

P1 列表中可以展示不稳定 checkpoint，但默认应禁用 fork 按钮；main handler 仍必须校验 `isStableTurnBoundary`，不能只依赖 UI。

### 7.3 消息到 checkpoint 解析 API

消息级 fork 不应该依赖 renderer 用 checkpoint summary 猜测“哪个 checkpoint 包含 messageId”。`ForkableCheckpoint` 的摘要默认不返回完整 message id 集，避免把大量历史传到 renderer。

新增后端解析接口：

```ts
ipcMain.handle(
  "threads:resolve-fork-checkpoint-for-message",
  async (_event, params: { threadId: string; messageId: string }) => {
    // scan root namespace checkpoints newest -> oldest or oldest -> newest
    // return the smallest stable turn-boundary prefix that contains messageId
  }
)
```

返回：

```ts
interface ForkCheckpointResolution {
  checkpointId: string
  checkpointNs: ""
  messageId: string
  messageCount: number
  isStableTurnBoundary: true
  stableTurnId: string
  boundarySource: "metadata_marker"
} | null
```

解析规则：

1. 只考虑 root namespace checkpoint。
2. 用 shared `deriveCheckpointTranscriptIndex` 判断 checkpoint 是否包含 `messageId`。
3. 用 shared `deriveCheckpointForkability(tuple, { allowLegacyLatestFallback: false })` 判断稳定性。
4. 只接受 `isStableTurnBoundary === true` 的 checkpoint；in-progress turn、interrupt、pending approval、pendingWrites checkpoint 不作为消息级 fork 目标。
5. 返回“包含该 messageId 的最小稳定前缀”，而不是“最小包含 checkpoint”。如果某条消息只存在于尚未完成的 turn 中，返回 `null` 并提示用户等待当前轮完成。

如果未来需要纯列表前端匹配，可在 summary 中增加 bounded 字段，例如最近 N 个可见 message id：

```ts
visibleMessageIdsTail?: string[]
```

但默认推荐后端解析，保证消息 id 提取逻辑与 checkpoint 反序列化逻辑在同一侧。

### 7.4 Preload

在 `window.api.threads` 增加：

```ts
fork: (params: ThreadForkParams) => Promise<ThreadForkResponse>
listForkableCheckpoints: (threadId: string) => Promise<ForkableCheckpoint[]>
resolveForkCheckpointForMessage: (
  params: { threadId: string; messageId: string }
) => Promise<ForkCheckpointResolution>
```

同步更新 `src/preload/index.d.ts`。

### 7.5 Renderer store

在 Zustand store 增加：

```ts
forkThread: (
  params: ThreadForkParams,
  options?: ThreadNavigationOptions
) => Promise<Thread>
```

行为与 `createThread` 一致：

- 将新 thread 插入列表顶部；
- 切换 `currentThreadId`；
- 重置 focus panel；
- 进入 `mainView: "thread"`。

## 8. 核心实现流程

### 8.0 fork/run 临界区

fork 不能只做一次 busy 判断。必须为每个 thread 增加统一的 fork/run mutation lock，或复用现有 `AsyncKeyedLock` 抽出共享锁：

```ts
const threadRunMutationLock = new AsyncKeyedLock()
```

需要纳入同一把 source thread 锁的入口：

- `threads:fork`
- `threads:delete`
- `threads:update` 中会影响 `workspacePath`、`agentMode`、运行态 metadata 或 checkpoint 归属判断的更新
- `agent:invoke`
- `agent:resume`
- `agent:cancel` / interrupt 相关入口
- scheduler / heartbeat 对同一 thread 的自动 invoke
- workflow/coordinator notification 触发的同 thread 后台恢复

`threads:fork` 必须在拿到 `sourceThreadId` 锁之后再做 busy 判断，并在同一临界区内读取 checkpoint tuple、校验 stable boundary、校验 interrupt/pending approval/pendingWrites。这样避免 busy 判断后、读取 checkpoint 前又启动新 run，导致 fork 到 mid-turn 状态。

如果第一阶段不想让 invoke 排队，`agent:invoke` / `resume` / `cancel` 至少要能感知同一把锁：当 fork 正在读取源 checkpoint 时，这些入口应拒绝或等待，而不是与 fork 交叉执行。

`threads:delete` 必须纳入同一把锁，否则 fork 正在读取源 checkpoint 时并发删除会让 row、checkpoint 文件和清理补偿互相踩踏。`threads:update` 至少要在 fork 临界区内拒绝或等待 `workspacePath`、`agentMode`、scheduled/heartbeat/workflow/coordinator 相关字段更新，避免 busy 判断使用旧 metadata、目标 metadata 复制使用新 metadata。

### 8.1 fork 主流程

```text
1. 校验 sourceThreadId
2. 获取 sourceThreadId 的 fork/run mutation lock
3. 读取 source thread row，并从源 metadata 得到 workspacePath / agentMode
4. 调 isThreadForkBusy({ threadId, workspacePath, agentMode })；MVP busy 则拒绝
5. 读取 source checkpoint tuple
6. 校验 checkpoint 属于 root namespace
7. 用 shared forkability 校验 checkpoint 位于 stable turn boundary
8. P0/P1 校验 checkpoint 不包含 __interrupt__ / pending approval / pendingWrites
9. 从 shared transcript index 提取可见消息 id、内部 goal id 和 transcript 顺序
10. 构造完整 filteredThreadValues
11. 生成 newThreadId
12. 创建新 thread metadata
13. 使用独立 target SqlJsSaver 写入 tuple.checkpoint + tuple.metadata
14. flush 并 close target saver
15. dbCreateThread(newThreadId, metadata)
16. 以整字段替换方式写入 filteredThreadValues
17. 返回标准 Thread
```

原子性要求：

- 不采用“先创建 thread row，再写 checkpoint”的顺序。`createThread` 会立刻落库并 `saveToDisk()`，而 checkpoint 是另一个 sqlite 文件；如果后续 checkpoint 写入失败，会留下无法恢复历史的空会话。
- 推荐顺序是先写目标 checkpoint 并 flush 成功，再创建 thread row。这样即使进程在 row 创建前崩溃，最多留下一个无 row 引用的孤儿 checkpoint 文件，不会在 UI 中出现空会话。
- 目标写入必须使用独立创建的 `SqlJsSaver`，不要通过 runtime `getCheckpointer` / `withCheckpointer` 取得缓存 saver。否则失败清理时删除了文件，缓存 saver 后续异步 flush 仍可能把已删除文件重新写出来。
- 成功路径也要 `await targetSaver.close()` 后再创建 thread row，确保目标 sqlite 文件已经落盘且没有挂起 flush。
- 如果 checkpoint 写入或 flush 失败：先 `await targetSaver.close()`，再删除 target checkpoint 文件，不创建 thread row。
- 如果 thread row 创建或 thread_values 复制失败：先确认 target saver 已关闭，再删除 target checkpoint 文件，删除已创建的 thread row。
- 如果实现最终选择复用 runtime 缓存 saver，失败清理必须先调用 `closeCheckpointer(targetThreadId)`，再执行 `deleteThreadCheckpoint(targetThreadId)`；但 MVP 推荐完全避免缓存 saver。
- 清理动作失败只记录 warn，但 handler 必须向调用方返回失败，避免 renderer 插入半成品 thread。

### 8.2 checkpoint tuple 复制

推荐使用现有 saver API，不直接拼 SQL。目标 saver 用 fork handler 内部独立实例，并在成功/失败路径都显式 close：

```ts
const checkpointNs = ""
const tuple = await sourceSaver.getTuple({
  configurable: {
    thread_id: sourceThreadId,
    checkpoint_ns: checkpointNs,
    checkpoint_id: checkpointId
  }
})

await targetSaver.put(
  { configurable: { thread_id: targetThreadId, checkpoint_ns: checkpointNs } },
  tuple.checkpoint,
  tuple.metadata
)
```

注意：这里的 `put()` 只用于把源 checkpoint 状态写入新的 target thread。源 thread 上的 stable boundary marker 必须使用 6.3 中的 metadata 原地更新 helper，不能用 `put()` 回写源 checkpoint metadata。

上面的写法会刻意清空新 thread 中该 checkpoint 的 `parent_checkpoint_id`。这是 MVP/P1 的推荐语义：fork 结果是“从该 checkpoint 继续”的新会话，不承诺在新会话内继续 time-travel 到 fork 点之前的 checkpoint。

如果未来要让 forked thread 保留完整 time-travel 前缀，需要改成复制源 checkpoint 前缀，并重写 parent 链：

1. 从目标 checkpoint 沿 `parentConfig` 读取祖先 checkpoint，或按 `list(before)` 找到稳定前缀。
2. 按旧到新顺序写入目标 thread。
3. 每次 `put` 的 config 携带前一个目标 checkpoint id，让 `parent_checkpoint_id` 指向新 thread 内的父节点。
4. P3 明确 pending approval / interrupted boundary 语义后，才同步复制允许的 pending writes。

在实现完整前缀复制之前，文档和 API 不应声称“完整复制 tuple 链”，只能声称复制“选定 checkpoint 的可恢复状态”。

P0/P1 不复制 `pendingWrites`。只要 `tuple.pendingWrites.length > 0`，summary 标记 `unstableReason: "pending_writes"`，`threads:fork` handler 直接拒绝。这样避免把 HITL、tool retry 或中间节点写入提前带入新会话。

底层 helper 可以保留“复制 pending writes”的能力，供 P3 interrupted fork 使用；该 helper 必须按 task id 分组写入：

```ts
for (const [taskId, writes] of groupPendingWrites(tuple.pendingWrites)) {
  await targetSaver.putWrites(
    {
      configurable: {
        thread_id: targetThreadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: tuple.checkpoint.id
      }
    },
    writes,
    taskId
  )
}
```

注意：`CheckpointTuple.pendingWrites` 的结构是 `[taskId, channel, value][]`，`putWrites` 需要 `[channel, value][]`。

### 8.3 源 thread busy 策略

MVP 策略：

- 如果 `isThreadForkBusy({ threadId, workspacePath, agentMode })` 返回 true，拒绝 fork。
- 错误文案：`当前会话仍在运行，请停止或等待完成后再 fork。`

签名建议：

```ts
interface ThreadForkBusyInput {
  threadId: string
  workspacePath?: string | null
  agentMode?: "normal" | "coordinator" | "workflow"
}
```

`isThreadForkBusy` 需要统一覆盖以下状态：

1. 前台 active agent run。
2. workflow active run。
3. workflow pending notification，包含 renotify 尚未耗尽的待汇报结果。
4. coordinator worker running。
5. coordinator worker notification 未确认或待处理。
6. coordinator manager 中仍有 parent thread pending notification。

该判断应复用或抽取已有模式切换保护中的状态检查逻辑，避免只检查 activeRuns 而漏掉后台 workflow/coordinator 状态。

workflow pending notification 不能只靠 `threadId` 查。现有 workflow run manager 的 pending notification 查询依赖当前 `workspacePath`；fork handler 必须使用源 thread metadata 中的 workspacePath 传入 busy 判断，不能使用 fork overrides 的 workspacePath。如果源 thread 是 workflow/coordinator 相关模式但缺少 workspacePath，建议 fail closed，返回 busy 或明确错误，避免漏放“结果待汇报”的 thread。

### 8.4 interrupt / pending approval 校验

P0/P1 不继承 pending approval。主流程必须在读取 source checkpoint tuple 后、写入目标 checkpoint 前显式校验：

- checkpoint `channel_values` 中存在 `__interrupt__` 时拒绝。
- tuple / summary 标记存在 pending approval 时拒绝。
- UI 可以隐藏或禁用这类 checkpoint，但 main handler 仍必须做服务端校验。

错误文案建议：`该 checkpoint 正在等待审批，请先处理审批后再 fork。`

P3 若要支持从 interrupt checkpoint fork，需要单独定义审批归属、pending writes 复制、恢复审批 UI、审批后续跑语义，不能让 P0/P1 主流程默认复制 pending approval。

### 8.5 运行中 fork 后续策略

- 参考 Codex `ForkSnapshot::Interrupted`，在运行中 fork 前先注入一次 interrupt boundary。
- 或提供“fork 最近稳定 checkpoint”按钮，避免处理 mid-turn 状态。

## 9. UI 实施方案

### 9.1 MVP 入口

侧边栏 thread 右键菜单增加：

```text
Fork 当前会话
```

点击后：

1. 调 `forkThread({ sourceThreadId: thread.thread_id })`。
2. 成功后 toast：`已从当前 checkpoint 创建新会话`。
3. 自动切换到新会话。

### 9.2 历史 checkpoint 入口

后续增加一个弹窗：

```text
从 checkpoint fork
```

弹窗展示：

- checkpoint 时间；
- 消息数量；
- 最后一条用户消息摘要；
- 最后一条助手消息摘要；
- fork 按钮。

### 9.3 消息级 fork

消息气泡菜单增加：

```text
从这里 fork
```

实现方式：

1. 取消息 id。
2. 调 `resolveForkCheckpointForMessage({ threadId, messageId })`。
3. 后端返回包含该 messageId 的最小稳定 turn-boundary checkpoint 前缀。
4. 调 `threads:fork({ sourceThreadId: threadId, checkpointId })`。

若找不到 checkpoint，提示：

```text
该消息附近没有可 fork 的稳定 checkpoint，无法从这里 fork。
```

## 10. 测试方案

### 10.1 单元测试

新增 `tests/thread-fork.spec.ts`：

1. 从最新 checkpoint fork：
   - 新 thread id 不同；
   - metadata 包含 `forkedFromThreadId`；
   - checkpoint 可被新 thread `getTuple` 读取；
   - 源 checkpoint 不变；
   - 新格式 checkpoint 依赖 `cmb_fork_boundary` 判定 stable；
   - 旧会话最新 idle checkpoint 缺 marker 时走 `legacy_latest_idle_fallback`。

2. stable boundary marker 写入：
   - agent run 成功完成后，最新 root checkpoint metadata 含合法 `cmb_fork_boundary`；
   - marker 写入使用 metadata 原地 UPDATE，不调用 `put()` 回写同一 checkpoint；
   - marker 写入后，原 checkpoint 的 `parentConfig` / `parent_checkpoint_id` 不变；
   - marker 写入失败时，不破坏 agent turn，但该 checkpoint 在 P1/P2 中按 `missing_boundary_marker` 处理；
   - cancel、error、interrupt、pending approval、failover 中失败的候选尝试都不会写 `turn_complete` marker。

3. 从指定 checkpoint fork：
   - 保留多个 checkpoint；
   - 指定 checkpoint id；
   - 新 thread 恢复到指定 checkpoint。
   - 非 stable turn boundary checkpoint 被拒绝。
   - 缺少 `cmb_fork_boundary` 的历史 checkpoint 标记为 `missing_boundary_marker`，不会被 P1 当作 stable。
   - `messageTimes/messageTimeOrder` 只包含目标 checkpoint 内的消息。
   - 目标 `thread_values` 是过滤后的完整对象，不通过 merge 残留 fork 点之后的 message id。

4. pending writes 策略：
   - P0/P1 遇到 `tuple.pendingWrites.length > 0` 时拒绝 fork；
   - checkpoint summary 的 `unstableReason` 为 `pending_writes`；
   - 底层 tuple copy helper 可单测 pendingWrites 分组写入，但该能力只供 P3 interrupted fork 使用。

5. 复制 thread values 白名单：
   - `messageTimes` 被复制；
   - 未知字段不复制。
   - main 和 renderer 使用同一个 shared transcript/id 提取函数；
   - fixture 覆盖普通对话、tool call、goal prompt、合成 id fallback、subagent transcript。

6. 源 thread busy：
   - active agent run 返回 true 时拒绝；
   - workflow active/pending 返回 true 时拒绝；
   - workflow pending notification 使用源 thread 的 `workspacePath` 查询；
   - coordinator worker running/pending notification 返回 true 时拒绝；
   - busy 判断后、checkpoint 读取前尝试启动 invoke/resume 时，会被同一把 fork/run lock 拦住；
   - fork 读源 checkpoint 时并发 `threads:delete` 或关键 `threads:update` 会被同一把锁拒绝或等待。

7. interrupt / pending approval 拒绝：
   - checkpoint 含 `__interrupt__` 时 P0/P1 拒绝；
   - checkpoint 存在 pending approval 时 P0/P1 拒绝；
   - renderer 隐藏/禁用后，main handler 仍做服务端校验。

8. 失败补偿：
   - checkpoint 写入失败时，不创建 thread row；
   - thread row 创建后复制 thread_values 失败时，删除 row 和目标 checkpoint 文件；
   - target saver 被 close；
   - 删除目标 checkpoint 文件后，不会被缓存 saver 的异步 flush 重新写出。

9. namespace 校验：
   - 非 root namespace 请求被拒绝；
   - worker/workflow subagent checkpoint 不能通过普通 fork API 创建新主会话。

10. 消息级 checkpoint 解析：
   - `resolveForkCheckpointForMessage` 返回包含目标 messageId 的最小稳定 checkpoint 前缀；
   - 包含目标 messageId 但处于 in-progress turn 的 checkpoint 不会被返回；
   - 找不到 messageId 时返回 null。

### 10.2 回归测试

需要确保不破坏已有测试：

- `tests/checkpointer-lru.spec.ts`
- `tests/sqljs-saver-async-flush.spec.ts`
- `tests/thread-checkpoint-cleanup.spec.ts`
- `tests/checkpoint-message-times.spec.ts`

### 10.3 手工测试

1. 创建会话，发送两轮消息。
2. 从侧边栏 fork。
3. 新会话应显示相同历史。
4. 在新会话继续发送消息。
5. 回到源会话，确认源会话历史未改变。
6. 删除源会话，确认 fork 会话仍可打开。

## 11. 风险与控制

### 11.1 checkpoint 数量导致内存上升

风险：

sql.js 会把 sqlite 整体加载到内存，保留更多 checkpoint 会增加内存。

控制：

- P0 不调整保留数量；
- P1 再将 root thread 默认提升到 30 个；
- worker thread 保持 1 个；
- 后续增加文件大小上限；
- 保留 LRU checkpointer cache 现有机制。

### 11.2 pending writes 复制不完整

风险：

如果 P0/P1 复制 pending writes，可能把 HITL approval、tool retry 或中间节点写入带到新 thread，造成重复 tool call、审批归属混乱或无法正确 resume。

控制：

- P0/P1 对任何非空 `tuple.pendingWrites` 都拒绝 fork；
- checkpoint summary 将 pending writes 标为 `unstableReason: "pending_writes"`；
- checkpoint summary 标注 `isStableTurnBoundary` / `unstableReason` / `hasInterrupt` / `hasPendingWrites`，UI 默认不把非稳定 checkpoint 作为普通历史 fork 选项；
- 底层 helper 的 pendingWrites 复制能力只作为 P3 interrupted fork 的测试目标；
- 从 interrupt checkpoint 继承 pending approval 是 P3 单独验收路径，不能混入 P0/P1。

### 11.3 active goal 状态不一致

风险：

复制 goal DB 状态会导致两个 thread 共享一个逻辑目标，续跑混乱。

控制：

- 不复制 `thread_goals` 表。
- checkpoint transcript 中的历史 goal 消息保留。
- fork 后 goal 面板默认为无 active goal。
- 后续如需支持 goal fork，生成新的 goal id 并复制 paused 状态。

### 11.4 coordinator / workflow 运行态不一致

风险：

复制 coordinator worker 或 workflow run 状态会导致后台任务归属混乱。

控制：

- metadata 白名单不复制 worker/workflow run 状态。
- 第一阶段 normal thread 优先。
- coordinator/workflow thread 可以 fork transcript，但不复制运行态 worker。

### 11.5 从消息级 fork 找不到 checkpoint

风险：

checkpoint 已被 prune，或只存在包含该 messageId 的半轮 checkpoint，没有稳定 turn boundary。

控制：

- UI 提示明确。
- 增加 checkpoint 保留数量。
- 使用后端 `resolveForkCheckpointForMessage` 做解析，只返回最小稳定前缀。
- 未来可维护 messageId -> checkpointId 索引提升性能。
- 如果消息属于当前 in-progress turn，提示用户等待当前轮完成后再 fork。

### 11.6 fork 失败留下半成品

风险：

thread row 和 checkpoint 文件不是同一个事务。如果先创建 row 再写 checkpoint，失败会在 UI 中留下空会话；如果先写 checkpoint 再创建 row，崩溃可能留下无 row 引用的孤儿 checkpoint 文件。

控制：

- 先写 checkpoint 并 flush，再创建 thread row。
- 目标 checkpoint 写入使用独立 `SqlJsSaver`，成功/失败都先 close，再做 row 创建或文件删除。
- handler catch 中做补偿清理：close target saver、删除目标 checkpoint 文件、删除已创建的 thread row。
- 如果误用 runtime 缓存 saver，清理前必须先 `closeCheckpointer(targetThreadId)`，否则异步 flush 可能在 unlink 后重新写出文件。
- 后续可增加启动时 orphan checkpoint sweep：删除没有对应 thread row 且超过一定年龄的 root checkpoint 文件。

### 11.7 busy 判断与新 run 竞态

风险：

只在 fork 开始时做一次 busy 判断，随后 `agent:invoke`、`resume`、workflow notification 或 coordinator worker 可能在 checkpoint 读取前启动，让 fork 命中 mid-turn checkpoint。

同一窗口内并发 `threads:delete` 会删除源 row 和 checkpoint 文件；并发 `threads:update` 可能改变 `workspacePath`、`agentMode` 或运行态 metadata，使 busy 判断、metadata 复制和 checkpoint 读取看到不一致状态。

控制：

- 为 source thread 使用统一 fork/run mutation lock。
- busy 判断、checkpoint 读取、stable boundary 校验、interrupt/pending approval/pendingWrites 校验必须处于同一临界区。
- run 相关入口需要使用同一把锁，或在锁被 fork 占用时拒绝/等待。
- `threads:delete` 和关键 `threads:update` 需要使用同一把锁，或在 fork 临界区内拒绝。
- `isThreadForkBusy` 入参包含源 thread 的 `workspacePath`，workflow pending notification 查询不能只按 `threadId`。

### 11.8 thread_values merge 残留

风险：

先复制源 `thread_values` 再 merge 过滤补丁，会因为 `messageTimeOrder` 的追加合并语义保留 fork 点之后的消息顺序，导致历史 checkpoint 恢复后的时间和顺序错配。

控制：

- 根据目标 checkpoint 消息 id 构造完整 `filteredThreadValues`。
- 写入目标 thread 时整字段替换，不调用 thread values merge API。
- transcript/id 提取逻辑放到 shared，main 和 renderer 复用同一套 fixture 测试。
- 单元测试断言 fork 点之后的 message id 不存在于目标 `messageTimes` 和 `messageTimeOrder`。

### 11.9 非稳定 checkpoint 被误 fork

风险：

历史/消息级 fork 如果只找“包含 messageId 的 checkpoint”，可能命中 tool call、assistant streaming、approval 等半轮状态，fork 后出现半截消息、重复 tool call 或无法继续的 pending 状态。

控制：

- checkpoint summary 增加 `isStableTurnBoundary` / `stableTurnId` / `unstableReason`。
- `threads:fork` main handler 校验 stable boundary，不信任 UI。
- `resolveForkCheckpointForMessage` 只返回包含目标消息的最小稳定前缀。
- P3 再对齐 Codex `ForkSnapshot::Interrupted`，为运行中 fork 自动补 interrupted boundary。

## 12. 分阶段实施计划

### P0：最新 checkpoint fork

范围：

- `threads:fork` 支持不传 checkpointId，默认 fork 最新 checkpoint。
- agent / scheduled / heartbeat run 成功完成后，通过专用 metadata update helper 标记最新 root checkpoint 的 `cmb_fork_boundary`；失败、取消、interrupt、pending approval 和未最终成功的 failover 尝试不得写 marker。
- marker 写入 helper 必须保证只更新 metadata，不能改变原 checkpoint 的 `parent_checkpoint_id` / `parentConfig`。
- 最新 checkpoint 如果包含 `__interrupt__` 或 pending approval，P0 默认拒绝并提示用户先处理审批；审批继承放到 P3。
- 最新 checkpoint 必须通过 shared stable boundary 校验；运行中或半轮 checkpoint 拒绝。
- 最新 checkpoint 如果存在 pendingWrites，P0 默认拒绝；pendingWrites 复制只属于 P3/helper 能力。
- 公开 API 只允许 root namespace。
- source thread 使用 fork/run mutation lock；busy 判断使用源 `workspacePath`。
- `threads:delete` 和关键 `threads:update` 纳入同一 source thread mutation lock。
- 独立 target `SqlJsSaver` 先写 checkpoint、flush、close，再创建 thread row；失败时补偿清理。
- `thread_values` 使用过滤后的完整对象整字段写入，不走 merge。
- 抽出 shared transcript/id 提取和 filtered thread_values 构造逻辑。
- `overrides` 使用 metadata 白名单。
- preload 类型同步。
- renderer store `forkThread`。
- 侧边栏菜单入口。
- 单元测试覆盖最新 checkpoint fork。

验收：

- 用户可从一个 idle 会话 fork 新会话。
- 新会话能恢复历史并继续对话。
- 源会话不变。
- 等待审批的 interrupted 会话不会被 P0 静默 fork 成可审批分支。

### P1：指定 checkpoint fork

范围：

- `SqlJsSaver` 支持可配置保留数量。
- `threads:list-forkable-checkpoints`。
- checkpoint summary，标注 `isStableTurnBoundary` / `stableTurnId` / `unstableReason` / `hasInterrupt` / `hasPendingWrites`，默认列表隐藏或禁用非稳定 checkpoint。
- fork dialog。
- 指定 checkpoint 如果存在 pendingWrites，P1 拒绝 fork。
- 按目标 checkpoint 消息 id 过滤 `thread_values` 白名单。
- 单元测试覆盖历史 checkpoint。

验收：

- 用户可选择历史 checkpoint 创建新会话。
- checkpoint 不存在时错误明确。
- 半轮 / in-progress checkpoint 不可被 fork。

### P2：消息级 fork

范围：

- `threads:resolve-fork-checkpoint-for-message`。
- MessageBubble 菜单入口。
- messageId 到最小稳定 checkpoint 前缀的匹配逻辑。
- 找不到 checkpoint 的 UI 提示。

验收：

- 用户可在消息气泡上选择“从这里 fork”。
- fork 后新会话恢复到包含该消息的最小稳定完成边界。
- 如果该消息只存在于当前 in-progress turn，提示等待当前轮完成。

### P3：运行中 fork

范围：

- 最近稳定 checkpoint fork。
- 或先 interrupt 源会话再 fork。
- interrupt checkpoint 的 pending approval 继承与审批恢复。
- 对齐 Codex `Interrupted` snapshot 语义。
- 评估是否补齐 Codex 的 `path`、`ephemeral`、`excludeTurns` 和更完整 override 字段。

验收：

- 源会话运行中时，用户仍可选择安全 fork 策略。
- 不产生重复 tool call 或半截消息状态。

## 13. 建议优先级

建议先实现 P0 + P1，不急于做运行中 fork。

原因：

- 本工程已有 checkpoint 恢复链路，P0/P1 可以快速复用。
- 最大风险在 checkpoint 保留和 pending writes，先通过测试打牢。
- 运行中 fork 涉及 interrupt boundary、tool execution 和 UI pending 状态，适合在稳定 fork 后再做。

最终推荐方案：

```text
以 checkpoint tuple 为 fork 单元
以 thread metadata 记录来源关系
以 thread_values 白名单恢复展示体验
以保守并发策略保证源会话不被污染
```
