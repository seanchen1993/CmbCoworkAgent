# Consensus Plan (v2): Solo subagent 执行可见性 + 后台命令超时韧性

Status: pending approval (consensus reached — Critic APPROVED, 0 critical/major remaining)
Source spec: `.omc/specs/deep-interview-subagent-visibility-timeout.md`
Mode: `--consensus --direct` (RALPLAN-DR short)
Revision: v2.1 — Architect+Critic consensus feedback applied; Critic confirmation = APPROVE (see Changelog)

## Requirements Summary
Solo（非 Team）模式下主 agent 经 deepagents `task` 工具启动的子agent：
1. **可见性**：主对话流中默认折叠、可展开看到子agent**运行中实时**的完整嵌套过程（思考/工具调用/工具结果/输出）。
2. **超时韧性**：子agent内部 `execute(run_in_background:true)` 跑的长耗时后台 shell 命令，把 600s wall-clock 硬上限改为 **idle/心跳保活（永不因 idle 杀进程）+ 仅在绝对上限兜底时优雅终止并交付部分输出**。

## ⚠️ 关键纠偏（Architect/Critic 共识，已采纳）
1. **可见性并非"看不到"而是"被丢弃"**：子agent内部消息**已**在现有 2 元组 `messages` 流上到达，并在 `stream-converter.ts:124-125` 因 `ns.includes("tools:")` 被**主动丢弃**。`subgraphs:true` 是"归属/保真度"杠杆，不是唯一启用手段。故新增更轻的 **A1'**（停止丢弃 + 按既有 `checkpoint_ns` 归属，不动 chunk 形状），并以 **Phase 0 实证探针**决定走 A1' 还是 A1。
2. **超时语义自相矛盾已消除**：原 AC"不杀 + 续跑"与"终止 + 交回部分输出"互斥。**定稿：idle 永不杀进程（仅心跳/liveness + 实时部分输出），唯一硬杀 = 绝对上限兜底**，且兜底终止用 `capReached` 标志而非裸 exit 124（避免误触发 `local-sandbox.ts:1301` 的 sandbox-escape 重试）。
3. **AC-9 原不可构建**：`getTaskOutput` 在完成前不返回任何输出（`local-sandbox.ts:4926-4927`），`outputChunks` 仅在完成时填充（`4870`），`task_output` 仅在 `completed` 返回输出（`runtime.ts:1185`）。必须**新增实时输出管线**作为一等步骤。
4. **`subgraphs:true` 爆炸半径=7 处解构 + 元数据读**，非 1 处；必须集中化 `normalizeStreamChunk` shim 并枚举全部站点。
5. **后台判定**须以 `options.background===true`（`isBackgroundExecution` 真实信号，`5082-5089`）为准，**不可**用 `timeoutMs === BACKGROUND_TIMEOUT_MS` 等值判断（改常量会破坏 `5088` 回退分支）。

## RALPLAN-DR Summary

### Principles
1. 复用既有管线优先于重写。
2. 不改 deepagents 子agent的执行语义（思考循环/recursionLimit 不动）。
3. 默认零打扰：折叠态不刷屏、不显著增加 IPC/state。
4. 无回归：取消(130)、命令正常完成、前台 60s execute、Team 模式 worker 行为不变。
5. **可证伪验收**：每条 AC 由具体事件计数/退出码/状态字段观测，禁止"肉眼可见"。

### Decision Drivers (top 3)
1. 用户硬需求=运行中**实时**可见（R6）→ 需要子agent内部增量事件实时上屏；具体走 A1' 还是 A1 由 Phase 0 探针的**证据**决定（不再凭断言）。
2. 超时真凶=`local-sandbox` 后台执行层 600s wall-clock（exit 124）→ 改 idle 保活 + 绝对上限兜底。
3. 两处都在高频流式/进程生命周期热路径 → **回归风险**为首要约束，倾向最小侵入 + 集中化 shim + 特性开关。

### Viable Options

**Component A 可见性**
- **A1'（默认，待 Phase 0 证实）**：停止/反转 `stream-converter.ts:124-125` 的 `tools:` 丢弃，按**既有** `langgraph_checkpoint_ns` 把子agent内部消息路由到 subagent 桶；**不启用 `subgraphs:true`，chunk 形状不变**。
  - Pros：爆炸半径≈0；复用既有 `activeSubagents`/`Subagent`/`checkpoint_ns`。
  - Cons：若该版本 LangGraph 在无 `subgraphs` 时只冒泡子agent的 AI 汇总而非 thinking/tool 增量，则不足以满足 AC-A2 的"实时增量思考"。
- **A1（备选，仅当 Phase 0 证明 A1' 不足）**：streamConfig 加 `subgraphs:true`，引入集中化 `normalizeStreamChunk(chunk) → {namespace,mode,data}`，应用于**全部 7 处**解构站点 + `payload[1]` 元数据读 + `values` 通道，特性开关包裹。
  - Pros：获得真正的子图 node/value 级实时事件，保真度最高。
  - Cons：7 站点迁移 + worker-chunk 泄漏到 Solo 主流的高回归面。
- **A2（否决）**：结束后回放 → 违反 R6 实时硬需求（strawman，已剔除）。
- **A3（否决）**：全量 token 刷主流 → R4 已否决。

**Component B 超时**
- **B1+B3（选定，合并）**：idle 计时仅作**心跳/liveness 与实时部分输出刷新**，**永不杀进程**；唯一硬杀 = `BACKGROUND_ABSOLUTE_MAX_MS` 绝对上限兜底；兜底终止返回部分输出 + `capReached` 状态（非 124）。配套**实时输出管线**使运行中可读部分输出。
  - Pros：与"不杀、续跑"需求一致；治本；与 `task_output` 轮询契约相容。
  - Cons：需新增 live-output 管线；绝对上限仍是 wall-clock（缓解：取值很大且有理据）。
- **B2（否决）**：仅调高/可配置 wall-clock → R3 否决纯 wall-clock。

## Implementation Steps

### Phase 0 — 实证探针（investigation-only，无产品改动；决定 A1' vs A1）
0a. 在开发环境对一次会调用 `task` 的 Solo 请求，临时打点（dev-only 日志，不进产品分支）观测现有 2 元组 `messages` 流：子agent内部的 **thinking 增量 / tool_call / tool_result** 是否已携带 `tools:` 命名空间实时到达 `StreamConverter.processChunk`（参 `stream-converter.ts:104,124`）。
0b. 结论写入本计划的 ADR："Driver #1 证据"。
  - 若**已实时到达** → 采用 **A1'**，Component A 走"un-drop + 归属"路径，跳过 7 站点迁移。
  - 若**未到达/仅汇总** → 采用 **A1**，执行集中化 shim（步骤 6'-9'）。
0c. 同步探针 `values` 通道在 `subgraphs:true` 下是否新增命名空间维度（影响 `agent.ts:5249/5262` 的 values 消费）。

### Phase 1 — 超时韧性（独立可交付，先行）
1. **实时输出管线（C2，前置基础设施）**：在 `executeBackground`（`local-sandbox.ts:4788`）创建 `task` 时，向 `executeRaw` 传入 `onChunk` 回调，将 stdout/stderr 实时追加到 `task.outputChunks`；改 `getTaskOutput`（`4920+`）在 `!completed` 时返回已累计的部分输出（新增 `partialOutput` 字段）；改 `task_output`（`runtime.ts:1160-1204`）的 `not_ready`/`timeout` 分支带出 `partialOutput`。处理与完成时 `4870` push 的**去重/竞态**（用已有 `task.completed` 守卫 `4855/4867`，避免双重 append）。`partialOutput` 复用既有 `maxOutputBytes` 截断守卫（`5646/5657`），并在中途触顶时带 `partialTruncated:true`，使 agent 知道部分读已被截断而非全量。
2. **idle 心跳（M3 正确门控）**：在 `executeRaw` 的**两个** collect 块（沙箱 `~5615` 数据处理器 `5641/5652`；非沙箱/Windows `~5924` 数据处理器 `5948/5961`）中，当 `options.background === true` 时启用可重置 idle 计时器：每次 `data` 事件 `resetIdle()`（带 `resolved||aborted||timedOut` 早退守卫，参 `5664/5672-5678`）。idle 触发**不杀进程**，只发心跳状态（"已 Xs 无输出"）并刷新部分输出。**不**用 `timeoutMs === BACKGROUND_TIMEOUT_MS` 判断后台；保留 `BACKGROUND_TIMEOUT_MS`（`4765`）以免破坏 `isBackgroundExecution` 的 `5088` 回退分支。
3. **绝对上限兜底（B3，唯一硬杀）**：新增 `BACKGROUND_ABSOLUTE_MAX_MS`（建议默认 7_200_000=2h，可配置）。达到时杀进程，`collectAndResolve`（`5670+`）走新分支返回 `{ output: 部分输出+metadata, exitCode: 124, capReached: true }`（用 `capReached` 标志，**不**注入 `createTimeoutMetadata` 的 sparse-sentinel，从而不满足 `local-sandbox.ts:1301-1303` 三重门，避免误触 sandbox-escape）。
4. **单测**：`local-sandbox` 覆盖 AC-7/8/9/10（持续输出 >600s 不杀；长 idle 无输出不杀且可经 `task_output` 读到 `partialOutput` 与心跳状态；达绝对上限杀并返回部分输出 + `capReached`；abort 130 / 正常 exit / 前台 60s 回归）。

### Phase 2 — 可见性（依 Phase 0 结论二选一）
**若 A1'：**
5. 改 `stream-converter.ts:124-125`：不再丢弃 `tools:` 命名空间消息，改为按 `checkpoint_ns` 解析出 subagent 标识，发为带 subagent id 的 `message-delta`/`tool-message` 事件（复用 `activeSubagents` Map `101`、`Subagent` 类型、`formatSubagentName`）。
6. 建立 `task` 工具调用 id ↔ subagent namespace 映射；去重集合（`agent.ts` `_countedAiMsgIds`/`_subagentStartFired`/`_subagentStopFired`）适配带 namespace 的子消息（防主流 usage 重复计数 → AC-A6）。

**若 A1（备选）：**
6'. 新增集中化 `normalizeStreamChunk(chunk): {namespace, mode, data}`（2/3 元组自适应，默认 `namespace=""`）。
7'. 在**全部 7 处**消费站点接入（**注意目录限定**，部分文件名在 `ipc/` 与 `services/` 各有一份，执行前先消歧）：
  - `src/main/ipc/agent.ts` 的 **3 个**消费循环：`~5254 / ~6452 / ~7157`（这 3 个计入"7 处"中的 3 个）；
  - `src/main/services/scheduler.ts:~208`、`src/main/ipc/chatx.ts:~256`、`src/main/ipc/heartbeat.ts:~302`、`src/main/agent/runtime.ts:~3099`；
  - **A1 分支执行前必须确认**：`scheduler/chatx/heartbeat` 是否在 `ipc/` 与 `services/` 各存在副本且均消费该流，若是一并纳入。
  并修 `messageStreamMetadata`（`ipc/agent.ts:~2246` 读 `payload[1]`）显式接收 `data`；复核 `isCoordinatorWorkerStreamChunk`（`~2254-2275`，三处循环 `~5256/6455/7160` 调用）在新元组下仍正确过滤 worker chunk（防泄漏到 Solo 主流）。`streamConfig`（`~4528`）加 `subgraphs:true`，特性开关包裹（开关须在全部站点读取，否则开关本身=多站点改动）。
8'. 处理 `values` 通道在 subgraphs 下的命名空间维度（`ipc/agent.ts:~5249/5262`）。

**共同（渲染层）：**
9. `ToolCallRenderer.tsx` + `MessageBubble.tsx`（或复用 `WorkerStreamPanel.tsx` 展示组件）为 `task` 调用渲染**折叠/可展开嵌套卡片**：折叠=实时状态行（当前工具+已耗时+心跳，**不转发逐字增量**）；展开=实时嵌套 transcript。`thread-context.tsx` 的 `handleCustomEvent` 承载嵌套结构与增量。
10. **折叠态节流契约（AC-A4 量化）**：折叠时服务端**不转发**子agent逐字 `message-delta`；心跳 ≤ 1/s。

### Phase 3 — 联调与回归
11. 全量回归：Team 模式 worker 不受影响（重点复核 A1 路径下 `isCoordinatorWorkerStreamChunk`）；前台 execute、abort、failover 流式不回归。
12. `npm run typecheck && npm run typecheck:web` + 相关 vitest/tsx。

## Acceptance Criteria (falsifiable)

### Component A — 可见性
- [ ] AC-A1：触发 `task` 后，renderer 收到该 subagent 的 `SubagentStart` 事件且主对话出现默认折叠卡片（断言事件 + 初始折叠 state）。
- [ ] AC-A2：子agent运行期间（结束前），renderer 收到 **≥3 个**携带该 subagent namespace 的 `message-delta`/`tool-message` 事件，且出现在该 `task` 工具结果事件**之前**（断言事件序与计数）。
- [ ] AC-A3：子agent内部消息均带 subagent/namespace 标识，主 agent 流（namespace="" ）**不含**任何子agent内部消息（单测断言分流）。
- [ ] AC-A4：折叠态下，单位时间转发到 renderer 的子agent逐字 `message-delta` 数 = 0；心跳事件 ≤ 1/s（断言计数/速率）。
- [ ] AC-A5：子agent结束后 `SubagentStop` 触发、卡片显示终态；展开仍可见其过程事件序列（断言 transcript 非空）。
- [ ] AC-A6：带 namespace 的子消息不被计入主 agent usage 桶；单测断言去重集合行为。

### Component B — 超时
- [ ] AC-B7：后台命令每 ≤idle 窗口输出一次、持续 700s，**exit code ≠ 124/非 capReached**，最终拿到完整输出（断言退出码 + 输出）。
- [ ] AC-B8：后台命令长时间无输出（> idle 窗口、< 绝对上限），进程**不被杀**；`task_output` 轮询返回 `partialOutput` + 心跳状态（"已 Xs 无输出"），`completed:false`（断言进程存活 + 返回字段）。
- [ ] AC-B9：仅当达到 `BACKGROUND_ABSOLUTE_MAX_MS` 时进程被杀，返回**部分输出 + `capReached:true`**，且**不**满足 `local-sandbox.ts:1301` 三重门（断言返回字段 + 不触发 sandbox-escape 重试）。
- [ ] AC-B10：用户取消仍 exit 130；命令正常完成仍返回真实 exit code；前台 `execute` 60s 行为不变（三条回归用例）。

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| A1 路径 2→3 元组破坏 7 站点 + `payload[1]`，worker chunk 泄漏进 Solo 主流 | 高 | 集中化 `normalizeStreamChunk` 覆盖全部站点；A1 仅在 Phase 0 证明 A1' 不足时启用；特性开关；回归 AC-A3 + worker 过滤断言 |
| Phase 0 探针结论错误导致选错方案 | 中 | 探针为 dev-only 打点，结论写入 ADR 并可复跑；A1/A1' 任一都能满足 AC，差别仅成本 |
| 实时输出管线与完成时 `4870` push 竞态/双重 append | 中 | 复用 `task.completed` 守卫（`4855/4867`）；append 幂等；单测竞态 |
| idle 计时器与 abort/正常 exit 竞态、timer 泄漏 | 高 | `resetIdle` 带 `resolved/aborted/timedOut` 早退；两个 collect 块均在 `collectAndResolve` 清理；门控 `options.background===true` |
| 改 `BACKGROUND_TIMEOUT_MS` 破坏 `isBackgroundExecution:5088` 回退 | 中 | 保留该常量与等值分支；idle/兜底用**新**常量；改前审计 5088 |
| 绝对上限 124 误触 `1301` sandbox-escape 重试 | 低-中（三重门已收窄） | 用 `capReached` 标志，不注入 sparse-timeout sentinel；断言不触发 |
| 折叠态仍刷屏 | 中 | 服务端折叠时不转发逐字增量（AC-A4 量化） |

## Verification Steps
1. `npm run typecheck && npm run typecheck:web`
2. `npx vitest run`（local-sandbox idle/绝对上限/部分输出；stream-converter namespace 分流/去重；tool-call-extraction；worker 过滤回归）
3. Phase 0 探针脚本结论复核（A1'/A1 判定）。
4. 手动：Solo 触发 general-purpose subagent 验证 AC-A1..A6（基于事件断言而非肉眼）。
5. 手动：后台跑持续输出 700s（AC-B7）、长 idle 无输出（AC-B8）、达绝对上限（AC-B9）、取消/正常完成/前台（AC-B10）。
6. 回归：Team 模式一次协作任务确认 worker 流式/通知不变。

## ADR

**Decision**：
- 可见性：默认 **A1'**（停止丢弃 `tools:` 子agent消息 + 按既有 `checkpoint_ns` 归属，不动 chunk 形状）；仅当 **Phase 0 实证探针**证明无 `subgraphs:true` 时拿不到子agent thinking/tool 实时增量，才升级到 **A1**（集中化 `normalizeStreamChunk` + `subgraphs:true` + 7 站点）。
- 超时：**idle 永不杀进程**（仅心跳/liveness + 实时部分输出）；唯一硬杀 = `BACKGROUND_ABSOLUTE_MAX_MS` 绝对上限兜底，终止用 `capReached` 标志返回部分输出（非裸 124）。新增实时输出管线为前置基础设施。

**Drivers**：运行中实时可见（R6）；超时真凶在 local-sandbox 后台层；高频热路径回归风险优先。

**Alternatives considered**：A1'（轻）/ A1（重）/ A2 回放（否决，违实时）/ A3 全量刷屏（否决）；B1+B3 合并（选定）/ B2 调高 wall-clock（否决）。

**Why chosen**：A1' 以近零风险满足实时需求、复用既有已到达的子agent消息（counter-evidence=显式丢弃点）；将 A1 风险延后到证据驱动。超时 idle=liveness + 绝对上限唯一杀，消除"不杀 vs 交回部分输出"的 AC 矛盾并与 `task_output` 契约相容。

**Consequences**：超时策略从 600s wall-clock 改为 2h 绝对上限（policy change，符合用户"续跑"意图）；新增实时输出管线（Phase 1/2 共用）；A1 路径若启用需集中化 shim 与 worker 过滤回归。

**Follow-ups**：① Phase 0 探针确定 A1'/A1；② `values` 通道命名空间维度核实；③ 绝对上限默认值与可配置项确认；④ 折叠态节流阈值定标。

## Changelog (v1 → v2，已采纳 Architect+Critic 反馈)
- 采纳 A1'（Architect/Critic M1）：新增轻量选项 + Phase 0 实证探针，纠正"subgraphs 必需"的无据断言。
- 解决 C1：idle 永不杀 + 绝对上限唯一硬杀，重写 AC-B8/B9 为互斥可证伪两条。
- 解决 C2：新增实时输出管线为一等步骤，删除"task_output 已兼容部分读"的错误声明。
- 解决 C3：列出全部 7 处解构站点 + `payload[1]` + `values` 通道 + 集中化 `normalizeStreamChunk` + worker 过滤回归 AC。
- 解决 M3：idle 门控改 `options.background===true`，保留 `BACKGROUND_TIMEOUT_MS` 以护 `5088`。
- 解决 M2：可见性 AC 全部改为事件计数/状态断言，去除"肉眼可见"。
- 124 误触：用 `capReached` 标志（Critic 指出三重门已收窄，故降级但仍修正）。
- v2.1（Critic 确认轮的两条 minor）：① 站点引用加目录限定（`ipc/` vs `services/`）并标注 A1 分支执行前消歧"7 处"计数；② `partialOutput` 复用 `maxOutputBytes` 截断并加 `partialTruncated` 标志。
