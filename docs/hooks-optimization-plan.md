# Hook 体系优化 — PR 拆分与兼容性设计

> 分支：`feature/optimize-hook-types`（基于 `origin/main`）
> 目标：扩展 Hook 类型与能力，向 Claude Code 上游靠拢；**所有改动严格向前兼容**，存量用户配置与运行行为不变。
> 范围参考：[c:/ai/claude-code/src/entrypoints/sdk/coreSchemas.ts](../../claude-code/src/entrypoints/sdk/coreSchemas.ts) 中的 `HOOK_EVENTS`、[c:/ai/claude-code/src/utils/hooks/hooksConfigManager.ts](../../claude-code/src/utils/hooks/hooksConfigManager.ts) 中的 `getHookEventMetadata`。

---

## 0. 现状基线（写在最前面，便于后续每个 PR 自检）

### 0.1 当前真正"被运行时触发"的事件（共 10 个）

| 事件 | 触发点 | 阻塞语义 |
|------|--------|----------|
| PreToolUse | [src/main/agent/local-sandbox.ts:1766](../src/main/agent/local-sandbox.ts#L1766) | 同步，可阻断 |
| PostToolUse | local-sandbox.ts 多处 | 同步，可修订/halt |
| PreSkillUse | [src/main/agent/local-sandbox.ts:2875](../src/main/agent/local-sandbox.ts#L2875) | 同步，可阻断 |
| PostSkillUse | [src/main/agent/skill-lifecycle/completion-hooks.ts](../src/main/agent/skill-lifecycle/completion-hooks.ts) | 同步，可修订/halt |
| UserPromptSubmit | [src/main/ipc/agent.ts:1623](../src/main/ipc/agent.ts#L1623) | 同步，可阻断/重写 |
| SessionStart | [src/main/hooks/session-lifecycle.ts:48](../src/main/hooks/session-lifecycle.ts#L48) | fire-and-forget |
| SessionEnd | [src/main/hooks/session-lifecycle.ts:70](../src/main/hooks/session-lifecycle.ts#L70) | await 但不阻断 |
| Stop | [src/main/agent/skill-lifecycle/completion-hooks.ts:313](../src/main/agent/skill-lifecycle/completion-hooks.ts#L313) | 同步，可修订/halt |
| SubagentStop | [src/main/ipc/agent.ts:298](../src/main/ipc/agent.ts#L298) | 同步，可 halt |
| Notification | [src/main/agent/runtime.ts:1748](../src/main/agent/runtime.ts#L1748) | fire-and-forget（仅审批入口）|

### 0.2 `HookEvent` 联合声明里"看得见但触发不了"的事件（10 个）

`PostToolUseFailure`、`StopFailure`、`SubagentStart`、`PreCompact`、`PostCompact`、`PermissionRequest`、`PermissionDenied`、`Setup`、`CwdChanged`、`FileChanged`。

> **关键结论（兼容性影响）**：这 10 个事件**今天不可能存在于用户数据中**：
> - IPC 创建被 [src/main/ipc/hooks.ts:57](../src/main/ipc/hooks.ts#L57) 拒绝（`isSupportedHookEvent` 守门）
> - 存储读取被 [src/main/storage.ts:2476、2533、2625、2826、3131](../src/main/storage.ts#L2476) 过滤
> - CC settings.json 导入走同一个 `isSupportedHookEvent` 门
>
> 因此把它们扩进 `SUPPORTED_HOOK_EVENTS` 是**纯增量**，不需要数据迁移。

### 0.3 持久化与跨进程契约（不能动）

- `HookConfig` 序列化形态 → `~/.cmbcoworkagent/hooks.json` + 插件/技能 `hooks.json`
- 命令型 hook 的 stdin payload key（`hook_event_name / session_id / cwd / tool_name / tool_input / tool_response / prompt / skill_name / ...`）
- 命令型 hook 的环境变量（`HOOK_EVENT / TOOL_NAME / TOOL_ARGS / TOOL_RESULT / WORKSPACE_PATH / CLAUDE_PROJECT_DIR / SESSION_ID / USER_PROMPT / SKILL_* / PLUGIN_* / HOOK_SOURCE_*`）
- `parseHookJsonOutput` 当前识别的 9 个顶层字段（`additionalContext / systemMessage / requiredSkill / updatedInput / suppressOutput / continue / stopReason / decision / reason`）

**所有 PR 都遵守"上述键名与含义不动，只新增"。**

---

## 1. 公共兼容性约束（CC1–CC8）

| 编号 | 约束 | 实施要求 |
|------|------|----------|
| CC1 | `HookEvent` 联合类型只新增，不删除 | 保留所有现有事件名，包括尚未触发的 |
| CC2 | `HookConfig` 现有字段语义、可选性不变 | 新增字段一律 `optional`；序列化时 `undefined` 不写出 |
| CC3 | stdin payload 现有 key 不动 | 仅新增 key，且当上下文不存在对应字段时不写出该 key |
| CC4 | 环境变量现有命名不动 | 同上；不重命名、不删除 |
| CC5 | `parseHookJsonOutput` 现有解析行为不变 | 新字段走 `??` 叠加，平铺优先级保持 |
| CC6 | matcher 现有行为不变（PreSkillUse/PostSkillUse 匹配 skillName，其余匹配 toolName，`*` 匹配一切）| 新 matcher 维度走独立字段（如 `eventMatchers`），与旧 matcher AND 组合，缺省时恒真 |
| CC7 | CC settings.json 导入语义不变 | 新增事件解析时保持现有顺序与默认值 |
| CC8 | 不引入新的同步阻塞点 | 新事件默认 fire-and-forget；阻断/halt 能力必须显式标注 |

每个 PR 在 PR description 中**逐条声明"满足/不涉及"**这 8 条；评审时按表勾选。

---

## 2. PR 拆分总览

| # | PR 名 | Tier | 预计 LOC | 兼容风险 | 依赖 |
|---|------|------|---------|----------|------|
| PR-01 | stdin payload 补三字段 | T0 | ~80 | 零 | — |
| PR-02 | `parseHookJsonOutput` 兼容 `hookSpecificOutput.initialUserMessage / watchPaths`（仅解析，不消费）| T0 | ~60 | 零 | — |
| PR-03 | PostToolUseFailure + StopFailure 接入（fire-and-forget）| T0 | ~200 | 零 | — |
| PR-04 | SubagentStart 接入（fire-and-forget）| T0 | ~80 | 零 | — |
| PR-05 | UI 徽章 `[暂未实现]` 标注 | T0 | ~40 | 零（纯文案）| — |
| PR-06 | PreCompact / PostCompact 接入（wrapper 中间件方案）| T1 | ~250 | **中**（依赖 langchain summarization 行为）| 独立 |
| PR-07 | `eventMatchers` 多维 matcher（默认行为不变）| T1 | ~300 | 低 | PR-03 |
| PR-08 | PermissionRequest + 决策改写 | T1 | ~400 | 中 | PR-07（共用 matcher 框架）|
| PR-09 | async hook 协议 | T2 | ~200 | 中 | 独立 |
| PR-10+ | T2/T3 余项 | — | — | — | 视项目情况另议 |

> **本轮目标**：合入 PR-01 → PR-08（含 PreCompact/PostCompact，按用户确认）。

---

## 3. 各 PR 详细设计

### PR-01 — stdin payload 补 `transcript_path` / `permission_mode` / `agent_id`

**目标**：让命令型 hook 脚本能读到这三个上游标准字段。

**改动**
1. `HookContext`（[src/main/hooks/runner.ts](../src/main/hooks/runner.ts) 顶部 type）新增 optional 字段：
   - `transcriptPath?: string`
   - `permissionMode?: string`
   - `agentId?: string`
2. [src/main/hooks/runner.ts:163 `buildHookStdinPayload`](../src/main/hooks/runner.ts#L163) 末尾追加：
   ```ts
   if (context.transcriptPath) payload.transcript_path = context.transcriptPath
   if (context.permissionMode) payload.permission_mode = context.permissionMode
   if (context.agentId) payload.agent_id = context.agentId
   ```
3. `HookEnv` ([src/main/hooks/types.ts:167](../src/main/hooks/types.ts#L167)) 增加同名 env：`TRANSCRIPT_PATH / PERMISSION_MODE / AGENT_ID`（命名跟现有大写惯例）。
4. `buildHookEnv` 同步追加（仅在字段存在时写入）。
5. 各调用点**暂不**强制填充——保持原有调用形态，新字段全为 undefined 时输出与今天完全一致。
6. 选择性填充：
   - `transcriptPath`：[src/main/hooks/session-lifecycle.ts](../src/main/hooks/session-lifecycle.ts) 拿 thread 的 history 路径。
   - `agentId`：子 Agent 调用路径（[src/main/ipc/agent.ts](../src/main/ipc/agent.ts) 已有 subagentId）。
   - `permissionMode`：YOLO/审批模式标志（[src/main/agent/runtime.ts](../src/main/agent/runtime.ts) 已有 yoloMode）。

**兼容性自检**
- CC1 不涉及；CC2 通过（仅 HookContext 新字段，非持久化）；CC3 通过（仅新增 key）；CC4 通过；CC5–CC8 不涉及。

**测试**
- 新增 `tests/hook-stdin-payload.spec.ts`：构造 `HookContext` 全空 → dump payload，与 baseline 字符串严格相等。
- `HookContext` 三字段填充时 → 包含新 key 且其他 key 未变。

**回滚**：单 PR revert 即可。无数据迁移。

---

### PR-02 — `parseHookJsonOutput` 兼容 `hookSpecificOutput.initialUserMessage / watchPaths`（仅解析）

**目标**：识别上游 SessionStart hook 已使用的两个嵌套字段，本 PR **只把它们解析进 `HookResult`，不接消费侧**。

**改动**
1. `HookResult`（[src/main/hooks/types.ts:122](../src/main/hooks/types.ts#L122)）新增：
   - `initialUserMessage?: string`
   - `watchPaths?: string[]`
2. [src/main/hooks/runner.ts:642 `parseHookJsonOutput`](../src/main/hooks/runner.ts#L642) 增加嵌套读取（fall through 到平铺，保持 `??` 优先级）。
3. **不**修改任何消费方——SessionStart 流程仍按今天工作。

**兼容性自检**
- CC5 通过：原有 9 个顶层字段优先级不变；新字段仅在 hook 显式产出时填充，否则 undefined。

**测试**
- `parseHookJsonOutput({stdout: '{"hookSpecificOutput":{"initialUserMessage":"X"}}'})` → `result.initialUserMessage === "X"`
- 平铺 9 字段的现有 fixture 集 → 输出逐字段一致。

**为什么提前做**：T3 阶段实现 SessionStart 自动注入 / FileChanged watch 注册时，可直接消费 `HookResult` 字段，不必再回头改解析器。

---

### PR-03 — PostToolUseFailure + StopFailure 接入

**目标**：补两个最有观测价值的失败事件；均按 CC 上游语义为 fire-and-forget（输出忽略）。

**改动**
1. `SUPPORTED_HOOK_EVENTS` 增加 `"PostToolUseFailure"`, `"StopFailure"`。
2. UI 创建对话框 [src/renderer/src/components/customize/AddHookDialog.tsx:50 `HOOK_EVENTS`](../src/renderer/src/components/customize/AddHookDialog.tsx#L50) 加入这两项。
3. **PostToolUseFailure 触发点**：扫描 [src/main/agent/local-sandbox.ts](../src/main/agent/local-sandbox.ts) 所有工具调用的 try/catch 分支，在 catch 后 fire-and-forget 调用 runHooks，payload 字段（按 CC 上游 hook 输入）：
   ```json
   { "tool_name": "...", "tool_input": {...}, "tool_use_id": "...",
     "error": "...", "error_type": "...", "is_interrupt": false, "is_timeout": false }
   ```
   `tool_use_id` 取 LangChain 调用 id。
4. **StopFailure 触发点**：[src/main/ipc/agent.ts:2558 外层 turn catch 的 `if (!isAbortError)` 分支](../src/main/ipc/agent.ts#L2558)。**不是** completion-hooks.ts：那里只处理 Stop hook 的修订/halt，turn 真正因为 API 错误结束的位置在 agent.ts 的外层 catch。需要互斥关系：在该分支里 fire StopFailure 后，**抑制后续 Stop hook 的 fire 路径**（具体通过给 completion-hooks 传一个 `turnEndedInError: true` 标志，让它跳过 Stop hook）。AbortError 分支（用户取消）不触发任何一者。mid-stream failover 成功不触发——failover 链耗尽并把错误抛到外层 catch 时才触发。

   payload：`{ "error": "<enum>", "raw_message": "<原始 error.message>" }`，其中 `<enum>` 取值见下。

5. **错误分类器（本 PR 自带）**：**本项目无现成枚举分类器**——[src/main/agent/failover.ts](../src/main/agent/failover.ts) 只有二值 `isRetryableApiError`。本 PR 在 failover.ts 同文件新加一个 `classifyApiError(error): StopFailureErrorCode`，复用其 `getStatusCode` / `RETRYABLE_MESSAGE_PATTERNS` 原语，按以下**最小可靠子集**输出（**不强行对齐 CC 全集**——拿不到信号的枚举值不引入）：

   | 枚举 | 判定依据（按优先级从高到低）|
   |------|-----------------------------|
   | `authentication_failed` | status === 401 \|\| status === 403 |
   | `invalid_request` | status === 400（含 `billing_error`、`max_output_tokens`，都归这里——本项目无法可靠区分；上游 CC 也允许 `unknown`） |
   | `rate_limit` | status === 429 \|\| message 含 `"rate limit"` |
   | `server_error` | status ∈ [500, 599] \|\| message 含 `"internal server error" / "bad gateway" / "service unavailable" / "gateway timeout"` |
   | `network_error` | error.code ∈ `{ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENOTFOUND, EPIPE, EAI_AGAIN}` \|\| message 含 `"fetch failed" / "socket hang up" / "network error" / "timeout"` |
   | `unknown` | 其它 |

   **不引入** `billing_error / max_output_tokens` 这两个 CC 上游枚举——本项目没有可靠信号源（没有 Anthropic/OpenAI SDK 类型化错误，只有 langchain 透传的 message string + status）。若后续接入官方 SDK 的类型化错误可单独 PR 扩。文档与 hook 输入 schema 注释明确"枚举值集合可能随 SDK 升级扩展，hook 脚本应对未知值做默认兜底"。
5. **runner.ts 分发**：在 `runHooks` 内（[src/main/hooks/runner.ts:921 起的 event 分支](../src/main/hooks/runner.ts#L921)）为这两个事件落到现有的"fire-and-forget 分支"（与 Notification 同款）；**不读 stdout 决策、不影响 turn**。

**兼容性自检**
- CC1 通过（不删事件）；CC2 不涉及；CC3 仅新增 payload key；CC8 通过（fire-and-forget）。
- 性能：调用方仍会进入 `runHooks`，但 [src/main/hooks/runner.ts:919 `matched.length === 0` 早返回](../src/main/hooks/runner.ts#L919) 路径已存在 —— 0 匹配时不 spawn 任何子进程、不执行 prompt LLM 调用、不读写持久化。

**测试**（按"可观测副作用"维度断言，不假设 `runHooks` 调不调用）
- 工具人为抛错 + 已配置 1 条 PostToolUseFailure command hook → spawn 计数 +1，hook log 写入 1 条记录；hook 试图通过 exit 2 阻断的意图被忽略，工具错误仍按原路径返回。
- 模拟 API 错误结束 turn → StopFailure spawn 计数 +1；Stop spawn 计数为 0（互斥）。
- **0 个对应 hook 时的零副作用断言**：spawn 计数为 0、hook log 无新增、`onHookResult` 回调零次触发。**不**断言 `runHooks` 被调用次数（调用方仍会走入早返回）。
- 错误分类映射单测：每个枚举值至少一条 fixture，避免业务错误误标为 `server_error`。

**已知风险**：
1. StopFailure 与 Stop 互斥的实现需要在 [src/main/ipc/agent.ts:2532 catch 块](../src/main/ipc/agent.ts#L2532) 与 completion-hooks 之间加一条信号——具体是给 completion-hooks 增加一个 `turnEndedInError?: boolean` 入参（或者一个 thread 级 `markTurnEndedInError(threadId)` 函数）。这个改动**算入本 PR 范围**，但要小心：completion-hooks 现在是被 deepagents middleware 触发的，我们的额外信号要走 thread/turn 维度的旁路（不能阻塞中间件）。
2. `classifyApiError` 的枚举集合**与 CC 上游不完全一致**——少了 `billing_error / max_output_tokens`，多了 `network_error`（CC 没有，但本项目作为 Electron 桌面端网络异常很常见，单独枚举对 hook 编写更有用）。文档与 hook 输入 schema 必须显式说明这是"本项目方言"。

---

### PR-04 — SubagentStart 接入

**目标**：与 SubagentStop 对称——但触发点不在 SubagentStop 附近。

**SubagentStop 现状回顾**：现有 [src/main/ipc/agent.ts:253 `maybeRunSubagentStopHooksFromStreamPayload`](../src/main/ipc/agent.ts#L253) 是从 stream 里的 **task ToolMessage** 推断出来的——即子 Agent 已经完成、结果回写时才触发。这是"完成"信号，不是"启动"信号。

**SubagentStart 的正确触发位置**：AIMessage 携带的 `tool_calls` 数组里出现 `name === "task"` 时——即父 Agent **刚决定**要派发子任务、子 Agent 即将开始的瞬间。代码上对应 [src/main/ipc/agent.ts:1980 toolCalls 提取分支](../src/main/ipc/agent.ts#L1980) 与 [:1993 `for (let tcIndex...) { ... if (tcName === "task") ...}`](../src/main/ipc/agent.ts#L1993)（以及 ~2094、~2840、~3189 的同类提取点）。

**改动**
1. `SUPPORTED_HOOK_EVENTS` + AddHookDialog 加 `"SubagentStart"`。
2. 抽一个 `maybeRunSubagentStartHooksFromToolCall` 工具函数（与 `maybeRunSubagentStopHooksFromStreamPayload` 对称），在每个 AIMessage tool_call 提取点扫描 `tcName === "task"` 时调用：
   - 用 `tc.id` 作为 `agent_id`（与 SubagentStop 用 `tool_call_id` 保持一致——这样 Start 和 Stop 能通过同一个 id 串起来）。
   - `agent_type` 取自 `tc.args.subagent_type`（deepagents 的 task 工具参数；如果不存在则空）。
   - **幂等去重**：复用现有 `_countedAiMsgIds` 同款机制——给一个新的 `_firedSubagentStartIds: Set<string>`，键 = `tc.id`。AIMessage 在 streaming + values snapshot 中可能重复出现（见 agent.ts:1831 注释），不去重会重复触发。
3. payload（fire-and-forget）：
   ```json
   { "agent_id": "<tool_call_id>", "agent_type": "<subagent_type>",
     "tool_call_id": "<same as agent_id>", "task_description": "<tc.args.description>" }
   ```
4. matcher 仍走 `getMatcherTarget` 现有逻辑 → 对 SubagentStart 默认匹配 `toolName`（永远是 `"task"`，意义不大但兼容旧 matcher 语义）；后续 PR-07 引入 `eventMatchers` 后可按 `agent_type` 细分。
5. 4 个 tool_call 提取点都加一遍——可以在抽出的工具函数里集中处理；调用方传 `toolCalls + msgId + firedSubagentStartIds + workspacePath + threadId + turnId + hookScope + onHookResult`。

**兼容性自检**：与 PR-03 同；额外强调"AIMessage 重复投递的去重不依赖现有 `_countedAiMsgIds`"，避免与 metrics 路径耦合。

**测试**
- 构造一个 task tool_call → SubagentStart spawn +1。
- 同一 `tc.id` 在 streaming chunk + values snapshot 中各出现一次 → 只触发 1 次。
- 同一对话内有 N 个 task 调用 → 触发 N 次。
- `agent_id` 与对应 SubagentStop 的 `subagent.id` 字符串相等（用同 `tool_call_id`）。

---

### PR-05 — UI 徽章 `[暂未实现]` 标注

**目标**：消除 [HooksPanel.tsx EVENT_BADGE](../src/renderer/src/components/customize/HooksPanel.tsx) 显示 20 种但运行时只支持其中部分的认知歧义。

**改动**
1. HooksPanel 渲染 hook 列表时，按 `SUPPORTED_HOOK_EVENTS` 计算"是否未实现"，未实现的徽章 tooltip 追加：
   > ⚠️ 当前运行时尚未触发该事件。若该 hook 来自插件/技能或导入的 CC settings，配置会被保留但不会执行。
2. AddHookDialog 已经只列出可创建的 10 个事件 → 不需要改。
3. **不删任何徽章**——CC2/CC1 双重保护。

**兼容性自检**：纯前端，零代码逻辑改动。

---

### PR-06 — PreCompact / PostCompact 接入（**第一版已撤回，标注待重做**）

**当前状态**：撤回。`SUPPORTED_HOOK_EVENTS` 不含这两个事件，AddHookDialog 不开放创建，HooksPanel 徽章打 `⚠️ [暂未实现]`，运行时不触发。

**第一版做了什么 / 为什么撤回**

第一版思路：在 [src/main/agent/runtime.ts](../src/main/agent/runtime.ts) 的 middleware 列表里用一对 `beforeModel` bridge 把 `createSummarizationMiddleware` 夹中间——Pre bridge 用 char/4 估算预测压缩、Post bridge 扫描 `state.messages` 找 `lc_source === "summarization"` 标记。**两个核心假设都错了**：

1. **PostCompact 基本不会触发**。
   deepagents 的 [`createSummarizationMiddleware`](../node_modules/deepagents/dist/index.js)（≈ line 2436）其实跑在 **`wrapModelCall`** 而不是 `beforeModel`（line 2929 `async wrapModelCall(request, handler)`）。压缩结果通过 `Command.update._summarizationEvent.summaryMessage` 写到中间件**私有 state**（line 2918），**不写回 `state.messages`**。所以放在 summarization 后面的 `beforeModel` bridge 在自己的执行点上看不到 summary marker——`findSummaryMessageId(state.messages)` 永远返回 undefined。

2. **PreCompact 预测与真实压缩条件不一致**。
   真实的 deepagents 判定要看 effective messages（含 `_summarizationEvent` 替换后）、system prompt、tools、参数截断、`tokenEstimationMultiplier`、context-overflow fallback 等。bridge 的 char/4 + `state.messages.length` 既无法预测 fallback 路径触发，也会在已有 summary 后继续按原始 `state.messages` 估算 → **既会误触发也会漏触发**。

**下一次实现的正确方向（设计草案，不在本批次内做）**

不再用"前后三明治 beforeModel bridge"。改为**包裹/复用 summarization 自身的 `wrapModelCall`**：

- 方案 W1（推荐）：再写一个 middleware，其 `wrapModelCall` 调用 inner handler 后**观察 `Command.update._summarizationEvent`** ——前后状态对比即可可靠判定"本次 model 调用前是否发生了压缩"。
  - PostCompact：观察到 `_summarizationEvent` 在 inner handler 内部被赋值（或前后对比 `request.state._summarizationEvent` 与返回 Command 的 update）→ fire-and-forget。
  - PreCompact：把 inner handler 包装成"先快速调 shouldSummarize 等价判定（直接 import deepagents 的内部函数有限制，可读 `_summarizationEvent`、`getEffectiveMessages` 等公开导出，若没导出则放弃 Pre 仅做 Post）"，或者**完全放弃 Pre**——CC 上游 Pre 的核心价值是"在压缩前做导出 / 状态快照"，但本项目压缩流程是同步的，Pre 与 Post 时间间隔毫秒级，**Post 一个就够用**。
- 方案 W2（备选）：patch-package 给 deepagents 加一个 `onCompactionStart / onCompactionEnd` 回调，最准但绑定版本。

无论哪条路，**必须做到的事**：
- 不在 `beforeModel` 阶段扫描 `state.messages` 找 summary marker——根本看不到。
- payload 字段只承诺能从 `_summarizationEvent` 可靠拿到的（如 `cutoffIndex`、`summaryMessage.content.length`、`filePath`）。
- AddHookDialog / HooksPanel 同步打开（与撤回逆操作）。
- RightPanel.tsx 的 `EVENT_BADGE_COLORS` / `EVENT_LABEL` 同步加两行——撤回时已经不需要改是因为 SUPPORTED 没加；重做时**必须同步**否则 RightPanel 会用 `bg-muted` 兜底而不是设计色。
- `forcedOutcome` 字段对这两个事件在 IPC 校验层 / UI 编辑层都拒绝接受——本批次撤回时也未拒绝（依赖运行时不触发 ⇒ 配了也无害）；重做时必须显式拒绝，否则 hook log 会出现"看似强制阻断了"的误导记录。

**与 CC1 的关系**：本次撤回**不**把 `PreCompact`、`PostCompact` 从 `HookEvent` 联合类型移除——这两个 string literal 保留在 [src/main/hooks/types.ts:15-16](../src/main/hooks/types.ts#L15)。下游 storage / IPC / UI 仍可识别"这是个 Compact 类事件"，只是 SUPPORTED 闸门把它挡在创建与触发之外。

**回滚记录**（如果某次又要把它带回来对照）
- 删除 `src/main/agent/middleware/compact-hook-bridge.ts`
- `runtime.ts`：去掉 import；`createDeepAgent` params 解构去掉 `preCompactBridge / postCompactBridge`；两个 middleware 数组去掉 `...(preCompactBridge ? [...] : [])`；`createAgentRuntime` 内 `createDeepAgent` 调用去掉对应入参；删除 `compactBridgeDeps / fireCompactHook / enabledCompactHookCount` 一段。
- `types.ts`：`SUPPORTED_HOOK_EVENTS` 去掉两行；保留 `HookEvent` 联合声明。
- `AddHookDialog.tsx`：`HOOK_EVENTS` 去掉两行。
- `HooksPanel.tsx`：PreCompact / PostCompact 的 tip 改回 `[暂未实现]` 文案。

---

### PR-07 — `eventMatchers` 多维 matcher

**目标**：在不破坏 `matcher: "execute"` 类存量配置的前提下，按事件不同字段做精细匹配（例如 Notification 按 `notification_type`、SessionStart 按 `source`）。

**新字段不能只改 HookConfig 和 runner**——需要贯通整个读写链。下面按"创建/编辑 → 持久化 → 读取 → 触发 → 导入/导出"5 段分别列出改点，缺一就会**静默丢字段**。

#### 7.1 数据形态

`HookConfig` + `HookUpsert` 同步新增 optional：
```ts
eventMatchers?: Record<string, string>  // 键为事件特定字段名（snake_case），值为匹配模式（支持正则同 matcher）
```

#### 7.2 必须改的全链路文件清单

| 段 | 文件 / 位置 | 改动 | 缺则后果 |
|----|-------------|------|---------|
| 类型 | [src/main/hooks/types.ts:79 `HookConfig`、:187 `HookUpsert`](../src/main/hooks/types.ts#L79) | 加 optional 字段 | 编译/类型层不通 |
| 类型 | [src/renderer/src/types.ts:255 `export type {...}`](../src/renderer/src/types.ts#L255) | 自动 re-export，无需手改，但要确认 | 前端取不到类型 |
| 校验 | [src/main/ipc/hooks.ts:56 `validateHookConfig`](../src/main/ipc/hooks.ts#L56) | 加 `validateEventMatchers(config.eventMatchers, config.event)` | IPC 创建 / 编辑被默认拒绝（缺少 schema） |
| 写入 | [src/main/storage.ts:3194 `upsertHook`](../src/main/storage.ts#L3194) | 在 `const next: HookConfig = {...}` 里加 `eventMatchers: parseEventMatchers(config.eventMatchers, config.event)` | **创建/编辑时被静默丢弃** |
| 读取（flat）| [src/main/storage.ts:2542 flat 解析路径](../src/main/storage.ts#L2542) | 在 return 对象里加 `eventMatchers: parseEventMatchers(h.eventMatchers, h.event)` | 旧 PR 写进文件 → 重启后读不出来 |
| 读取（workspace flat）| [src/main/storage.ts:2635](../src/main/storage.ts#L2635) | 同上 | workspace hooks 失效 |
| 读取（plugin flat）| [src/main/storage.ts:2834](../src/main/storage.ts#L2834) | 同上 | 插件 hooks 失效 |
| 读取（skill）| [src/main/storage.ts:3142](../src/main/storage.ts#L3142) | 同上 | 技能 hooks 失效 |
| CC 导入 | [src/main/storage.ts:2470 `expandCcHooksSettings` / :2484 matcher 提取](../src/main/storage.ts#L2470) | **本 PR 不引入智能翻译**：CC settings.json 里的 `matcher` 字段继续整字符串落到 `HookConfig.matcher`，**不**自动迁移到 `eventMatchers`。但要补一条 `eventMatchers` 字段透传——若 CC 文件里出现该键（非标准扩展），保留它不丢 | 跨产品导入字段丢失 |
| 触发 | [src/main/hooks/runner.ts:111 `getMatcherTarget`、:887 `hookMatchesRunCriteria`](../src/main/hooks/runner.ts#L887) | 加 `matchesEventSpecific(hook.eventMatchers, event, context)`；`eventMatchers` 缺省返回 true | 触发判定不读新字段 |
| 触发 | runner.ts `HookContext` 接口 | 加 `sessionStartSource? / sessionEndReason? / notificationType? / stopFailureError? / compactTrigger?` 等新可选字段（按 7.3 表）| context 无字段可读 |
| 调用 | [src/main/hooks/session-lifecycle.ts](../src/main/hooks/session-lifecycle.ts)、各触发点 | 把 `source` / `reason` / `notification_type` 等填进 HookContext | matcher 永远拿不到值 |
| UI 编辑 | [src/renderer/src/components/customize/AddHookDialog.tsx](../src/renderer/src/components/customize/AddHookDialog.tsx) | 按事件 metadata 条件渲染新字段输入区；保存时一并提交 `eventMatchers` | 用户在 UI 上配不出新匹配 |
| 插件/技能 hooks.json 保留策略 | 插件文件加载器（同 storage.ts plugin 读取路径）| `eventMatchers` 出现在插件 hooks.json 时按 optional 解析 | 插件作者写了被丢弃 |

#### 7.3 字段 → context 路径映射（per-event metadata，对应 CC `matcherMetadata`）

| 事件 | 支持字段 | HookContext 取值来源 |
|------|----------|----------------------|
| SessionStart | `source` | `context.sessionStartSource`（新加；值：`startup / resume / clear / compact`）|
| SessionEnd | `reason` | `context.sessionEndReason`（新加；值：`clear / logout / prompt_input_exit / other`）|
| Notification | `notification_type` | `context.notificationType`（新加；目前唯一值 `permission_prompt`）|
| SubagentStart / SubagentStop | `agent_type` | `context.subagent?.type`（已存在结构，扩字段）|
| StopFailure | `error` | `context.stopFailureError`（PR-03 引入）|
| PreCompact / PostCompact | `trigger` | `context.compactTrigger`（PR-06 引入）|

#### 7.4 校验函数 `validateEventMatchers`

```ts
function validateEventMatchers(em: Record<string,string> | undefined, event: HookEvent): void {
  if (em === undefined) return
  if (typeof em !== "object" || em === null || Array.isArray(em)) throw new Error("eventMatchers 必须为对象")
  const allowedFields = EVENT_MATCHER_FIELDS[event] ?? []
  for (const [k, v] of Object.entries(em)) {
    if (!allowedFields.includes(k)) throw new Error(`事件 ${event} 不支持 matcher 字段 ${k}`)
    if (typeof v !== "string" || !v.trim()) throw new Error(`eventMatchers.${k} 必须为非空字符串`)
  }
}
```

未列在 `EVENT_MATCHER_FIELDS[event]` 的字段被拒绝——避免用户误配；同时**白名单需要在前后端共享**（建议落在 types.ts 同文件，避免漂移）。

#### 7.5 兼容性自检

- CC2 通过（新增 optional）；CC6 通过（`eventMatchers` 缺省时 AND 项恒真）。
- CC7 通过（CC 导入语义：`matcher` 字段继续按旧路径解析；`eventMatchers` 只在 CC 文件主动写出时保留）。
- 持久化双向兼容：旧版二进制读新版文件 → `eventMatchers` 被 `typeof` 检查丢弃，行为退化为旧 matcher；新版二进制读旧版文件 → `eventMatchers === undefined`，AND 项恒真，行为完全等同今天。

#### 7.6 测试

- 现有 hook（无 `eventMatchers`）→ 现有 hook-scope / hook-stdin-payload fixture 字节级一致。
- `eventMatchers: { source: "resume" }` 的 SessionStart hook → 仅在 resume 路径触发；其他 source 不触发；同时 `matcher` 仍按 toolName 工作（即 SessionStart 无 toolName 时 `matcher: "*"` 仍生效）。
- 7.2 表里每一行至少一条往返测试：upsert(create) → list → 验证 `eventMatchers` 完整。
- 校验失败用例：传入非白名单字段 → IPC 报错；传入空字符串 → 报错。
- CC 导入文件包含 `eventMatchers` 扩展键 → 解析后保留，行为正确；不包含 → 不报错。

---

### PR-08 — PermissionRequest + 决策改写（**复杂度最高的一个 PR，建议独立 review**）

**目标**：用 hook 决定权限弹窗的 allow/deny/interrupt，对齐 CC 的"自动模式"。

**先看清现状再设计**
- 审批入口在 [src/main/agent/runtime.ts:1707 `requestApproval`](../src/main/agent/runtime.ts#L1707)，是个 `Promise<ApprovalDecision>` 工厂——子进程/工具调用挂在这个 promise 上等用户点按钮。
- [runtime.ts:1737 Notification](../src/main/agent/runtime.ts#L1737) 是在 `pendingApprovals.set` 后、`webContents.send(approval:request)` 前 fire-and-forget 触发的。
- 当前 `parseHookJsonOutput` [runner.ts:642](../src/main/hooks/runner.ts#L642) 只把 nested `permissionDecision` 映射为 `decision: "block" | "approve"`——这套二值表达**不足以覆盖** CC 的 PermissionRequest 输出，后者是：
  ```ts
  { behavior: "allow", updatedInput?, updatedPermissions? }
  | { behavior: "deny",  message?, interrupt? }
  ```

#### 8.1 数据形态扩展

`HookResult` 新增完整结构（不复用现有 `decision` 字段）：
```ts
permissionRequest?: {
  behavior: "allow" | "deny"
  updatedInput?: Record<string, unknown>
  updatedPermissions?: Array<{ ... }>  // 与 CC 一致的 PermissionUpdate 形态
  message?: string
  interrupt?: boolean
}
```
**不动** `HookResult.decision`——它继续用于 PreToolUse 的 block/approve 语义；混用会让两套表达彼此污染。

`parseHookJsonOutput` 增加对 `hookSpecificOutput.{hookEventName: "PermissionRequest", decision: {...}}` 的识别（按 CC schema 嵌套形态，[claude-code/src/types/hooks.ts:120-134](../../claude-code/src/types/hooks.ts#L120) 是参考）。

#### 8.2 多 hook 冲突策略（必须显式写下来）

存在 N 条匹配 PermissionRequest hook 时，**按以下规则聚合**：

| 任意 hook 出现 | 最终决策 |
|---------------|----------|
| `interrupt: true`（带任何 behavior）| `interrupt`（拒绝 + 停止 turn）— **最高优先级**，立即生效，不等其他 hook |
| 至少一个 `behavior: "deny"`（无 interrupt）| `deny`（拒绝当前调用，turn 继续）|
| 所有 hook 都明确 `behavior: "allow"` | `allow`（采用第一条 `updatedInput`，merge 所有 `updatedPermissions`）|
| 任意一条未给出明确 behavior（解析失败 / 超时 / hook 自身错误）| **回落原审批 UI**——视为 hook 弃权 |

**串行 vs 并行**：本 PR 按**串行**执行 hook，遇到 interrupt 立即短路（避免不必要的 IPC / LLM 调用）。不并行的原因：interrupt 短路语义在并行下需要 abort 已发出的子进程，复杂度高。

**hook 自身超时**：每条 hook 仍受自身 `timeout` 控制；超时记为弃权（不是 deny），保持与 prompt hook fallback 一致的"宽松"默认。

#### 8.3 审批入口改造

`requestApproval` 改造为：

```ts
requestApproval = async (req) => {
  const permRequestContext = { /* tool_name, tool_input, tool_use_id */ }
  const enabledHooks = resolveEnabledHooksForRun(workspacePath, "PermissionRequest", permRequestContext, hookScope)

  // 0 hook → 走原路径（一行变化，保证零回归）
  if (enabledHooks.length === 0) {
    return originalRequestApprovalLogic(req)  // 内部仍 fire Notification + 弹窗
  }

  // 有 hook → 同步聚合
  const aggregated = await runPermissionRequestHooks(enabledHooks, permRequestContext, onHookResult)

  switch (aggregated.kind) {
    case "interrupt":  return { type: "reject", tool_call_id: ..., interrupt: true }
    case "deny":       return { type: "reject", tool_call_id: ..., message: aggregated.message }
    case "allow":      return { type: "approve", tool_call_id: ..., updatedInput: aggregated.updatedInput }
    case "abstain":    return originalRequestApprovalLogic(req)  // 弹窗 fallback
  }
}
```

**Notification 触发位置不变**：仍在弹窗发出前 fire-and-forget。这样 PermissionRequest 给出明确 allow/deny 时**不弹窗、不触发 Notification**（避免无意义提醒）；abstain 回落时弹窗与 Notification 都按今天工作。

**`ApprovalDecision` 类型扩展**：现状是 `{ type: "approve" | "reject", tool_call_id }`；新增 optional `interrupt?: boolean` 与 `updatedInput?` / `message?`。消费方（local-sandbox 和 backend 的 `requestApproval` 调用方）按需读取——不读则等价于今天。

#### 8.4 兼容性自检

- CC2 / CC3 / CC5 通过（仅新增字段）。
- CC8 显式妥协：PermissionRequest 是同步事件。妥协方式 = "0 hook 时完全走旧路径"，零额外延时（强制 e2e 断言 ≤ 当前 + 5ms）。
- 自动模式从未启用过的用户：行为完全等同今天。
- `ApprovalDecision` 类型扩展：所有调用方对新字段只用 `??` 默认值，旧分支保留。

#### 8.5 测试（**最低要求**，每条都必须有）

1. 0 个 PermissionRequest hook → `requestApproval` 调用栈与今天逐字节一致（用 trace 校验）；Notification 仍触发；审批弹窗仍弹出。
2. 单 hook 返回 `behavior: "allow", updatedInput: {cmd: "rewritten"}` → 工具收到 rewritten cmd，无弹窗，无 Notification。
3. 单 hook 返回 `behavior: "deny", message: "X"` → 工具被拒，error 含 X，无弹窗。
4. 单 hook 返回 `behavior: "deny", interrupt: true` → 工具被拒 + turn 停止；后续 tool_call 不再投递。
5. 2 hook，一个 allow / 一个 deny → 最终 deny（按 8.2 表）。
6. 2 hook，一个 allow / 一个超时 → abstain → 回落弹窗。
7. 2 hook，第一个 interrupt → 第二个不执行（短路验证：第二个 hook 的 spawn 计数为 0）。
8. parseHookJsonOutput 同时收到旧 `decision` 字段和新 `hookSpecificOutput.permissionRequest` → 后者优先解析为 `permissionRequest`，旧 `decision` 仍按 PreToolUse 语义保留（防止串场）。
9. e2e：审批延时基线 → 0 hook 场景 ≤ baseline + 5ms。

#### 8.6 回滚

`requestApproval` 头部"if enabledHooks.length === 0 → originalRequestApprovalLogic"那一段保持完整，去掉下半段即可完全回到今天；`parseHookJsonOutput` 的新解析分支独立可单独 revert。

---

### PR-09 — async hook 协议（`{"async": true, "asyncTimeout": N}`）

**目标**：让慢扫描类 hook 可以后台跑，不阻塞 turn。

**改动**
1. `parseHookJsonOutput` 解析 `async: true` → 在 `HookResult` 增加 `async?: { timeoutMs: number }`。
2. `executeHook` 检测到 async → 立即返回一个 "placeholder result"（exitCode 0，blocked false），后台继续等子进程；完成后通过新的 `onLateHookResult` callback 触发一条 UI/日志事件。
3. **关键**：async hook 永远 **不** 影响 `blocked / decision / continue / stopReason`——这些字段只对同步 hook 生效。文档明确说明。

**兼容性自检**
- CC5 通过（新增字段叠加）；CC8 通过（async 是降阻塞，永远不会让原本非阻塞变阻塞）。

---

### PR-10+（暂不进本轮）

- T2-1 `hookSpecificOutput` 判别联合统一化
- T2-3 callback 类型 hook
- T3-1 CwdChanged / FileChanged + `CLAUDE_ENV_FILE`
- T3-2 WorktreeCreate / WorktreeRemove

→ 单独议题，需要独立设计文档。

---

## 4. 全局回归基线

无论合入哪个 PR，下列基线必须保持：

### 4.1 必跑测试
1. [tests/hook-scope.spec.ts](../tests/hook-scope.spec.ts) — 0 diff
2. [tests/hook-scope-e2e.spec.ts](../tests/hook-scope-e2e.spec.ts) — 0 diff
3. [tests/git-hook-collection-path.spec.ts](../tests/git-hook-collection-path.spec.ts) — 0 diff
4. **新增** `tests/hook-stdin-payload.spec.ts`（PR-01 引入；后续每个 PR 必须在不破坏已有 fixture 的前提下 append 新 fixture）

### 4.2 必跑端到端场景
1. 创建一个 PreToolUse hook，工具调用被阻断 → 行为与今天一致。
2. 创建一个 prompt 类型 hook，模型超时 fallback 行为 → 一致。
3. 一个含 `forcedOutcome=always-halt` 的 Stop hook → 一致。
4. 0 个 hook 时一轮对话的 hook 路径耗时 → 与 baseline 偏差 ≤ 5ms。
5. 导入一份历史 CC settings.json → 解析出的 HookConfig 数组与 baseline 等价。

### 4.3 持久化兼容性
- 写入 hooks.json 后用旧版二进制读取（git revert 到本 PR 前），应能正常加载所有不含新字段的 hook，新字段被无害丢弃。
- 反向：旧版写的 hooks.json 用新版读取，新字段 undefined，行为等同于今天。

---

## 5. PR 模板（每个 PR 的 description 复用）

```markdown
## 目标
<一句话>

## 兼容性自检
- [ ] CC1 — HookEvent 联合不删除：满足 / 不涉及
- [ ] CC2 — HookConfig 现有字段不变：满足 / 不涉及
- [ ] CC3 — stdin payload key 不变：满足 / 不涉及
- [ ] CC4 — 环境变量命名不变：满足 / 不涉及
- [ ] CC5 — parseHookJsonOutput 现有字段优先级不变：满足 / 不涉及
- [ ] CC6 — matcher 现有行为不变：满足 / 不涉及
- [ ] CC7 — CC settings.json 导入语义不变：满足 / 不涉及
- [ ] CC8 — 不引入新同步阻塞点：满足 / 显式妥协（说明）

## 回归测试
- [ ] 4.1 所有现有 spec 0 diff
- [ ] 4.2 五个端到端场景通过
- [ ] 4.3 持久化双向兼容

## 回滚步骤
<一句话或一条命令>
```

---

## 6. 开放问题（合入前需确认）

1. **手动 `/compact` 是否存在？** PR-06 的 trigger payload 是否需要 `manual` 选项？经核实 [runtime.ts:1047 createSummarizationMiddleware](../src/main/agent/runtime.ts#L1047) 是自动触发的中间件，未见用户主动调用入口。本文档按"目前仅 `auto`"实现，但 `trigger` 字段保留为字符串，便于将来加。
2. ~~**StopFailure 的错误分类**~~ **已核实**：本项目唯一的错误处理是 [src/main/agent/failover.ts](../src/main/agent/failover.ts)，且只有二值 `isRetryableApiError`。PR-03 自带 `classifyApiError`，输出 6 值最小集（`authentication_failed / invalid_request / rate_limit / server_error / network_error / unknown`），见 PR-03 详细设计。**与 CC 上游不完全一致**——已记入"本项目方言"备注，无后续阻塞。
3. **PR-06 阻断能力**：本文档已采用方案 B1（纯观测，不阻断）以避免自相矛盾。如果未来需要"PreCompact 真阻断压缩"，会作为独立 PR 通过 patch-package 走方案 A——本轮**不实现**，PR-06 的 UI 描述与 AddHookDialog 校验都会显式拦截 `forcedOutcome` 字段。
4. **PR-08 Notification 与 PermissionRequest 共存**：本文档已选定方案——0 PermissionRequest hook 或 hook 集体 abstain → 走旧路径（含 Notification + 弹窗）；hook 给出明确决策 → 不弹窗、不触发 Notification。若产品希望"哪怕 hook 决定 allow 也要 Notification 提醒"，请提出，会在 PR-08 实现时改为并行触发。
5. **PR-07 CC 导入回译**：CC SessionStart 的 matcher 字段是 `"startup|resume"`。本文档**不引入智能转换**——CC 导入的 SessionStart hook 仍按 toolName 匹配（即 `*` 才生效），含义错位但与今天行为一致。若希望同步转译，请单独提一个增量 PR。

→ 第 1 / 3 / 4 / 5 项均为决策已默认到位，待用户认可即可。所有 PR 均可启动。
