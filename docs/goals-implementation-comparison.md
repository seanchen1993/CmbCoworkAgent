# Goals 功能实现对比：Codex、Hermes-Agent、Claude Code 与 CmbCoworkAgent

本文档用于对比 Codex、Hermes-Agent、Claude Code 的 `/goal` / goals 功能实现，并汇总 CmbCoworkAgent 当前采用的实现方案。

结论先行：

- Codex 是运行时深度集成方案：持久化目标、状态机、token/时间计量、隐藏 goal context、模型工具、自主续跑都嵌在 Rust runtime 里。
- Hermes-Agent 是外部控制循环方案：目标状态存在 SessionDB，turn 结束后用辅助 judge 模型判断，未完成就把 continuation prompt 当普通 user message 再喂一轮。
- Claude Code 的公开文档描述更接近 Hermes 的判断模型：`/goal` 设置 completion condition，每轮结束后由小快模型 evaluator 判断，未满足则自动开启下一轮；实现上是 session-scoped prompt-based Stop hook 的封装。
- CmbCoworkAgent 当前实现采用混合方案：Codex 式持久化 thread goal + Hermes/Claude 式外部 evaluator + 普通 user message continuation。这样架构简单，适合中等模型，同时比单纯让主模型自判完成更稳。

## 快速对比

| 维度         | Codex                                           | Hermes-Agent                         | Claude Code                                                      | CmbCoworkAgent 当前实现                     |
| ------------ | ----------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------- |
| 核心定位     | runtime 内建长期目标框架                        | 外部 goal loop                       | session-scoped completion condition                              | 轻量 thread goal loop                       |
| 目标粒度     | 一个 thread 一个 goal                           | 一个 session 一个 goal               | 一个 session 一个 goal                                           | 一个 thread 一个 goal                       |
| 持久化       | SQLite `thread_goals` 专表                      | `SessionDB.state_meta` JSON          | 会话级 goal，active goal 可随 resume 恢复                        | SQLite `thread_goals` 专表                  |
| 完成判断     | 主模型调用 `update_goal(status="complete")`     | 独立辅助 judge 模型                  | 小快 evaluator 模型，默认 Haiku                                  | 独立 evaluator 模型，显式配置优先，否则跟随当前有效模型 |
| 续跑方式     | runtime 注入隐藏 goal context 并启动新 turn     | 普通 user message continuation       | Stop hook wrapper 触发下一轮                                     | 同一次 `agent:invoke` 内继续 `agent.stream` |
| 预算         | token budget + wall clock                       | turn budget，默认 20                 | 文档建议可把 turn/time 限制写进 condition；状态展示 tokens/turns | turn budget，默认 15                        |
| Prompt cache | goal context 会进入模型上下文，可能影响缓存前缀 | 不改 system prompt/toolset，缓存友好 | 基于 hooks/evaluator，不让 evaluator 调工具                      | 不改 system prompt/toolset，缓存友好        |
| 子目标       | 无显式 `/subgoal`                               | 有 `/subgoal`                        | 文档强调 condition 自己写清楚                                    | 第一版不做子目标                            |
| 用户打断     | interrupt 会 pause                              | 用户消息 preempt 并 pause            | Ctrl+C / clear / hooks 约束                                      | 普通消息或 cancel 会 pause                  |
| 复杂度       | 高                                              | 中                                   | 中，细节未完全公开                                               | 中低                                        |

## Codex 的实现

参考源码：

- `/Users/chenqiang/Desktop/ai/codex/codex-rs/state/migrations/0029_thread_goals.sql`
- `/Users/chenqiang/Desktop/ai/codex/codex-rs/core/src/goals.rs`
- `/Users/chenqiang/Desktop/ai/codex/codex-rs/core/src/tools/handlers/goal_spec.rs`
- `/Users/chenqiang/Desktop/ai/codex/codex-rs/core/templates/goals/continuation.md`
- OpenAI 文档：`https://developers.openai.com/codex/use-cases/follow-goals`

### 数据模型

Codex 在 state DB 里有 `thread_goals` 表，一个 `thread_id` 对应一个 goal。核心字段：

```text
thread_id
goal_id
objective
status: active | paused | budget_limited | complete
token_budget
tokens_used
time_used_seconds
created_at_ms
updated_at_ms
```

`goal_id` 用来防止竞态：启动 continuation 前会重新读 DB，确认当前 goal 仍然是同一个 `goal_id` 且仍然 active。

### 运行时事件系统

Codex 的 goal 逻辑不是普通 slash command，而是挂在 runtime 事件上。`GoalRuntimeEvent` 包含：

```text
TurnStarted
ToolCompleted
ToolCompletedGoal
TurnFinished
MaybeContinueIfIdle
TaskAborted
ExternalMutationStarting
ExternalSet
ExternalClear
ThreadResumed
```

这些事件分别负责：

- turn 开始时捕获 active goal 和 token baseline
- tool 完成时做 usage accounting
- turn 结束时做最终 accounting
- idle 时尝试自动 continuation
- interrupt 时暂停 active goal
- thread resume 时恢复 active goal runtime 状态
- external set/clear 时同步 runtime 状态和事件

### 自动续跑机制

核心逻辑在 `maybe_start_goal_continuation_turn()`：

1. 拿 continuation lock，避免并发启动多轮。
2. 调用 `goal_continuation_candidate_if_active()` 判断是否能续跑：
   - goals feature enabled
   - 不在 Plan mode
   - 没有 active turn
   - 没有 queued response item
   - 没有 trigger-turn mailbox input
   - thread 不是 ephemeral
   - DB 中 goal 存在且 status 为 active
3. 启动前再次读取 DB，确认 `goal_id` 没变。
4. 把 continuation prompt 包成 `ResponseInputItem` 推入 pending input。
5. 创建新的 default turn 并 `start_task()`。

Plan mode 会跳过 continuation，这点对防止“计划阶段自动执行”很重要。

### Prompt 注入

Codex 使用 `core/templates/goals/continuation.md` 生成隐藏的 goal context。这个模板包含：

- 当前 objective
- tokens used / token budget / remaining tokens
- 继续行为约束
- 不要缩小目标范围
- 从当前 worktree 和外部状态取证
- 完成前要做 requirement-by-requirement audit
- 只有证据证明所有要求完成后才能调用 `update_goal(status="complete")`

Codex 的设计重点不是只告诉模型“继续”，而是反复强调“不要自以为完成”。这是它效果强的关键。

### 模型工具

Codex 暴露三个 goal 工具：

```text
get_goal
create_goal
update_goal
```

其中 `update_goal` 的 schema 只允许：

```text
status = complete
```

模型不能自己 pause、resume 或 budget-limit goal。这些状态变化由用户或系统控制。

### Codex 方案优缺点

优点：

- runtime 一体化，状态、预算、事件、UI 通知、恢复都很严谨。
- token/时间计量精细，适合长任务和企业成本控制。
- 完成审计 prompt 很强，能降低过早完成风险。
- `goal_id` + lock + DB 再读，竞态处理成熟。

缺点：

- 工程复杂度高。
- 完成判断依赖主模型自判并调用 `update_goal`。
- goal memory 只存 objective/status/usage，不存完整任务过程记忆。
- 隐藏 context 注入可能影响 prompt cache。

## Hermes-Agent 的实现

参考源码：

- `/Users/chenqiang/Desktop/ai/hermes-agent/hermes_cli/goals.py`
- `/Users/chenqiang/Desktop/ai/hermes-agent/hermes_cli/commands.py`
- `/Users/chenqiang/Desktop/ai/hermes-agent/website/docs/user-guide/features/goals.md`

### 总体架构

Hermes-Agent 的 goals 模块开头就说明了设计目标：

- goal 是 session 级 free-form objective
- 每个 turn 结束后，用辅助模型 judge 是否满足
- 不满足就把 continuation prompt 作为普通 user message 送回同一个 session
- 不改 system prompt
- 不换 toolset
- judge 失败 fail-open
- 用户真实消息优先，并暂停 goal loop

也就是说 Hermes 是“外部后置循环”，不是 runtime 内核功能。

### 数据模型

`GoalState` 存在 `SessionDB.state_meta`，key 是：

```text
goal:<session_id>
```

字段包括：

```text
goal
status: active | paused | done | cleared
turns_used
max_turns
created_at
last_turn_at
last_verdict
last_reason
paused_reason
consecutive_parse_failures
subgoals
```

Hermes 没有 token budget，使用 turn budget，默认 20 turns。

### Judge 模型

Hermes 的 `judge_goal()` 调用 auxiliary model，任务名是 `goal_judge`。它只要求输出一行 JSON：

```json
{ "done": true, "reason": "one sentence" }
```

如果 judge API 失败、辅助模型不可用、配置缺失，则 fail-open：返回 continue，不阻塞任务。

如果 judge 返回空内容、非 JSON 或坏 JSON，则 `parse_failed = true`。连续 3 次 parse failed 后，Hermes 自动 pause，并提示用户把 `goal_judge` 路由到更会遵守 JSON 合约的模型。

### Continuation prompt

普通 goal 的 continuation prompt 很短：

```text
[Continuing toward your standing goal]
Goal: {goal}

Continue working toward this goal. Take the next concrete step...
```

如果用户添加了 `/subgoal`，continuation prompt 和 judge prompt 都会带上 subgoals。

### `/subgoal`

Hermes 额外提供 `/subgoal`：

```text
/subgoal <text>
/subgoal remove <n>
/subgoal clear
```

subgoals 是用户在 goal loop 中追加的验收条件。它们同时影响：

- 下一轮 agent 要做什么
- judge 是否判定 done

这比 Codex 更实用，尤其是用户看中间结果后想补充验收条件时。

### Hermes 方案优缺点

优点：

- 实现简单，核心集中在一个 Python 模块。
- 执行者和裁判分离，降低主模型自判完成的偏差。
- 不改 system prompt/toolset，prompt cache 友好。
- fail-open + parse failure backstop 很实用。
- `/subgoal` 能动态追加验收标准。

缺点：

- judge 只能看 last response / prompt 中出现的证据，不会自己跑工具。
- turn budget 粗糙，不如 token budget 精确。
- continuation prompt 比 Codex 的完成审计弱。
- 状态存在 JSON meta，结构约束弱于专表。

## Claude Code 的实现

参考官方文档：

- `https://code.claude.com/docs/en/goal`

Claude Code 的源码实现细节没有像 Codex/Hermes 这样完整展开；下面基于官方文档描述。

### 核心心智模型

Claude Code 明确说 `/goal` 设置的是 completion condition，而不只是普通 objective。

用户输入：

```text
/goal all tests in test/auth pass and the lint step is clean
```

含义是：Claude 会持续工作，直到 evaluator 判断这个 condition 已经满足。

### 运行机制

官方文档描述：

- 一个 session 只能有一个 active goal。
- `/goal <condition>` 会立即启动一个 turn，condition 本身就是 directive。
- 每个 turn 结束后，一个 small fast model 检查 condition 是否成立。
- 如果不成立，Claude 自动开始下一轮。
- 如果成立，goal 自动 clear，并在 transcript 中记录 achieved entry。
- evaluator 不调用工具，只能根据 Claude 已经在 conversation 中暴露的内容判断。

这和 Hermes 的“独立 judge + continuation loop”非常接近。

### 与 Stop hook 的关系

Claude Code 文档直接说明：`/goal` 是 session-scoped prompt-based Stop hook 的 wrapper。

这意味着它没有为 goal 单独发明一个复杂 runtime，而是复用 hook 系统：

```text
turn finishes
  -> Stop-hook-like evaluator checks completion condition
  -> yes: clear goal
  -> no: feed reason/guidance into next turn
```

### Evaluator 模型

官方文档说 evaluator 使用 session 当前 provider 配置上的 small fast model，默认是 Haiku。Evaluator token 通常远小于主 turn 成本。

重点：

- 这不是“第三方模型”概念，而是当前 provider/config 下的小快模型。
- evaluator 不调用工具。
- 它只能评估 transcript 中已有证据。

### Status / clear / resume

Claude Code 支持：

```text
/goal
/goal clear
```

`clear` 还有别名：

```text
stop
off
reset
none
cancel
```

active goal 在 `--resume` 或 `--continue` 恢复 session 时会恢复，但 turn count、timer、token baseline 会重置。已 achieved 或 cleared 的 goal 不恢复。

### Claude Code 方案优缺点

优点：

- 产品心智模型非常清晰：设置 completion condition。
- 执行者和 evaluator 分离。
- 复用 Stop hook，架构不会过重。
- 支持 non-interactive mode 和 desktop app。
- 明确要求 condition 必须能从 Claude 输出中证明。

缺点：

- evaluator 不跑工具，完成判断依赖 transcript 中的证据。
- 如果 Claude 没把命令输出、文件变化、测试结果说清楚，evaluator 可能无法正确判断。
- 公开文档没有暴露完整底层状态机和持久化 schema。

## 三种方案的关键差异

### 1. 谁判断完成？

Codex：

- 主模型自己完成审计后调用 `update_goal(status="complete")`。
- 通过严格 prompt 降低过早完成风险。

Hermes-Agent：

- 独立 judge 模型判断。
- 主模型不决定 goal 是否 done。

Claude Code：

- 独立 small fast evaluator 判断。
- 文档明确说 completion 由 fresh model 决定。

CmbCoworkAgent：

- 采用独立 evaluator。
- 原因是当前模型是中等效果模型，不适合完全依赖主模型自判完成。

### 2. 续跑 prompt 是隐藏 context 还是普通 user message？

Codex：

- 使用 runtime-owned hidden goal context。
- 携带预算和严格完成审计协议。

Hermes-Agent：

- 普通 user message。
- 不改 system prompt/toolset。

Claude Code：

- 文档描述为 Stop-hook wrapper，evaluator reason 会指导下一轮。
- 具体输入形式未公开，但语义上接近 hook continuation。

CmbCoworkAgent：

- 普通 user message continuation。
- 和现有 `agent.stream({ messages: [new HumanMessage(prompt)] })` 架构贴合。

### 3. 成本控制

Codex：

- token budget + time used。
- `budget_limited` 是独立终态。

Hermes-Agent：

- turn budget，默认 20。
- 用尽后 pause，用户可 resume。

Claude Code：

- 文档建议把 turn/time 限制写进 condition。
- 状态会显示 turns/tokens spent。

CmbCoworkAgent：

- turn budget，默认 15。
- 用尽后 pause，用户可 `/goal resume`。

### 4. 任务记忆

Codex：

- 持久化 objective/status/usage。
- 不持久化完整任务过程记忆。

Hermes-Agent：

- 保存 goal 状态和 subgoals。
- 不保存结构化 progress/evidence ledger。

Claude Code：

- 文档强调 evaluator 看 conversation。
- 未公开 goal-scoped memory。

CmbCoworkAgent：

- 增加轻量 ledger：
  - `progress`
  - `evidence`
  - `blockers`
- 每轮 evaluator 可返回 `ledger_patch`，下一轮 continuation 会注入 ledger。
- 这是为中等模型做的加强：比只靠 transcript 稳，但不发展成重型任务账本。

## CmbCoworkAgent 当前实现

相关代码：

- `src/main/agent/goals/types.ts`
- `src/main/agent/goals/slash.ts`
- `src/main/agent/goals/goal-store.ts`
- `src/main/agent/goals/goal-manager.ts`
- `src/main/agent/goals/evaluator.ts`
- `src/main/agent/goals/evidence.ts`
- `src/main/db/index.ts`
- `src/main/ipc/agent.ts`
- `src/renderer/src/features/slash-commands/useSlashCommands.ts`
- `src/renderer/src/features/slash-commands/SlashCommandPopover.tsx`
- `tests/goals.spec.ts`
- `tests/goals-db.spec.ts`
- `tests/slash-commands-ui.spec.ts`

### 设计目标

CmbCoworkAgent 的目标不是完整复刻 Codex，而是满足：

- 不过度设计。
- 架构尽量简单。
- 对 MiniMax / DeepSeek 这类中等偏上模型尽量稳。
- 不破坏现有 renderer streaming 协议。
- 不破坏已有 hooks、auto-commit、memory、trace 流程。
- 支持长任务自动续跑。

### 数据模型

新增 SQLite 表：

```text
thread_goals
```

字段：

```text
thread_id TEXT PRIMARY KEY
goal_id TEXT
objective TEXT
completion_condition TEXT
status active | paused | complete
turns_used INTEGER
max_turns INTEGER
last_verdict TEXT
last_reason TEXT
paused_reason TEXT
consecutive_parse_failures INTEGER
ledger_json TEXT
created_at INTEGER
updated_at INTEGER
```

`objective` 保存 `/goal` 后面的完整文本。`completion_condition` 会从
`完成条件`、`完成标准`、`验证`、`验收标准`、`Done when`、`verification` 等自然语言标签中提取。

注意：`completion_condition` 只是 evaluator 的聚焦验收目标，不能替代 objective 里的 scope、constraints、stop if 等约束。

`goal_id` 用于防止目标替换竞态：evaluator 结果写回前会确认当前 active goal 仍然是同一个 `goal_id`；真正发起下一轮 continuation 前也会再确认一次，避免旧目标的评估结果污染新目标。

### 支持的命令

```text
/goal
/goal status
/goal pause
/goal resume
/goal clear
/goal stop
/goal off
/goal reset
/goal none
/goal cancel
/goal <condition>
```

其中 `stop`、`off`、`reset`、`none`、`cancel` 都被当作 clear。`done` 不作为 clear alias，避免和“标记完成”的语义混淆。

`/goal resume` 的语义是恢复目标并开启新的 turn budget window：它会把当前 goal 重新置为 active，并重置本轮续跑计数。这一点更接近 Hermes 的个人开发者体验，表示“继续再给一段自动续跑额度”，而不是 Codex 式严格 token budget 终态。

Renderer 层把 `/goal` 放在 slash popover 的“功能”区，和存量 slash 命令体验一致；实际执行仍由主进程解析和处理。

### 主流程

CmbCoworkAgent 的 renderer 对一次 `agent:invoke` 只期待一个最终 `done`。因此 goals 不能每个 continuation turn 都发一次 `done`，否则 UI 会提前结束监听。

所以当前实现把 goal loop 放在同一次 `agent:invoke` 内：

```text
user: /goal <condition>
  -> parse slash
  -> create active goal
  -> run first agent.stream
  -> run completion hooks
  -> evaluator checks current turn
      complete: mark complete, finish
      blocked: mark paused, finish
      continue: build continuation prompt, run another agent.stream
      parse failures >= 3: pause, finish
      turns_used >= max_turns: pause, finish
  -> finalize auto-commit
  -> send one final done
```

这个设计保留了现有 UI streaming 模型：一个用户请求对应一个最终 `done`。

### Evaluator

Evaluator 在 `src/main/agent/goals/evaluator.ts`。

输入：

```text
full objective
completion condition / verification target
turns used
persistent goal ledger
assistant final response this turn
tool calls observed
tool input summary + tool output evidence
used skills
```

工具证据不是无限 transcript，而是 bounded evidence packet：

- 工具输入会压缩成摘要，例如命令、路径、查询参数。
- 工具输出保留 head/tail，并保留重要行，例如测试结果、错误、diff、文件路径、controller/method/log 相关行。
- evaluator window 会根据实际使用模型的 `maxTokens` 动态计算：约为上下文的 25%，下限 1K tokens，上限 80K tokens；工具证据在该窗口内按字符预算裁剪，约占 65%，下限 2K 字符，上限 40K 字符。

这样比 Hermes 只看最后回复更稳，也比无脑传完整 transcript 更适合 CmbCoworkAgent 的性能目标。

输出 JSON：

```json
{
  "verdict": "complete | continue | blocked",
  "reason": "one concise sentence",
  "next_prompt": "optional concrete next instruction",
  "ledger_patch": {
    "progress": [],
    "evidence": [],
    "blockers": []
  }
}
```

Evaluator 模型选择：

```text
explicit goal evaluator model with apiKey
  -> current effective model with apiKey
  -> no configured evaluator/current model: blocked, pause goal
```

参数：

```text
temperature <= 0.1
maxTokens <= 1200
maxRetries = 0
no tools
```

这个设计是为了避免把工具证据悄悄发给用户没有预期的 provider。用户显式配置 goal evaluator 时使用该模型；否则 evaluator 默认跟随当前会话实际使用的模型。

### Ledger

CmbCoworkAgent 加了轻量 goal ledger：

```text
progress
evidence
blockers
```

每轮 evaluator 可以返回 `ledger_patch`。GoalManager 会：

- trim
- 去重
- 每类最多保留 30 条
- 持久化到 `ledger_json`

下一轮 continuation prompt 会带上 ledger。这样可以降低：

- 重复做已完成工作
- 忘记前一轮证据
- 过早判断完成
- 长任务中间状态丢失

这是 CmbCoworkAgent 相对 Hermes/Claude 的一点增强，但仍然比文件账本或 goal memory DB 简单。

### 安全刹车

当前实现包含这些 stop/pause 条件：

- evaluator verdict 为 `complete`：标记 complete。
- evaluator verdict 为 `blocked`：标记 paused。
- 连续 3 次 evaluator JSON 解析失败：paused。
- turn budget 用尽：paused。
- parse failure 和 turn budget 暂停的 UI notice 都统一以 `Goal 已暂停：...` 开头，方便前端按状态渲染。
- 用户发送普通消息：active goal paused。
- 用户 cancel：active goal paused。
- Stop hook halted 当前 turn：不继续 goal。
- `/goal pause`：手动 pause。
- `/goal clear`：删除 goal。

### 为什么 CmbCoworkAgent 没照搬 Codex

Codex 的方案很强，但需要：

- runtime event dispatcher
- goal runtime state
- token accounting baseline
- hidden context injection
- model-facing goal tools
- app-server goal API
- feature flag
- 多客户端状态通知
- 较复杂并发控制

CmbCoworkAgent 当前不需要这么重。强行照搬会把一个功能变成平台级改造，风险和维护成本都高。

### 为什么 CmbCoworkAgent 没完全照搬 Hermes

Hermes 很适合参考，但 CmbCoworkAgent 有两个差异：

1. CmbCoworkAgent 的 renderer stream listener 收到 `done/error` 就结束，所以 continuation 不能简单作为多个独立请求发出去。
2. CmbCoworkAgent 当前模型是中等模型，需要比 Hermes 更强一点的持久化任务状态，所以增加了 `ledger`。

### 为什么 CmbCoworkAgent 接近 Claude Code

Claude Code 把 `/goal` 定义为 completion condition，这点很适合 CmbCoworkAgent：

```text
/goal <condition>
```

第一版不做复杂 DSL，也不拆 objective/condition。用户写得越可验收，效果越好。

Evaluator 不跑工具，也和 Claude Code 一致。它只根据 agent 已经展示的证据判断，所以 prompt 里要求主 agent 最终回复中列出命令、测试和证据非常重要。

## 当前方案的效果预期

适合：

- 测试修复直到指定测试通过。
- 文档更新直到包含指定内容。
- 代码迁移直到编译/测试命令通过。
- 小到中型 refactor。
- 需要 2 到 15 轮逐步推进的任务。

不适合：

- 开放式 backlog。
- 没有明确验收标准的“优化一下项目”。
- 需要跨天、跨分支、多目标并行调度的项目管理型任务。
- evaluator 无法从 transcript 判断的隐性条件。

为了效果好，建议用户写 goal 时包含：

```text
要完成什么
完成条件是什么
必须运行什么命令
不能改什么
最终回复必须列出什么证据
```

推荐模板：

```text
/goal 完成【任务】。完成条件：
1. 【命令】通过；
2. 【文件/功能】满足【具体要求】；
3. 不允许【约束】；
4. 最终回复必须列出修改文件、执行命令和结果。
```

## 测试覆盖

当前新增测试：

- `tests/goals.spec.ts`
- `tests/goals-db.spec.ts`

覆盖：

- slash parser
- goal lifecycle
- pause/resume/clear
- evaluator JSON parsing
- complete/continue/blocked verdict
- continuation prompt
- ledger merge
- turn budget pause
- consecutive parse failure pause
- SQLite persistence
- DB close/reopen 后 goal 恢复
- `deleteThread()` 清理 goal

已跑过：

```text
npx tsx tests/goals.spec.ts
npx tsx tests/goals-db.spec.ts
npm run typecheck:node
```

也跑过一批现有主链路回归：

```text
completion-hooks
mcp-hook-halt
tool-hook-regression
read-file-tool
auto-commit
trace-telemetry
slash-skill-marker
hook-scope
git-remote
agents-md
code-adoption
```

仓库仍存在一些非 goals 红灯，例如 web typecheck 里已有 renderer 类型问题，以及部分 skill 相关测试断言问题。它们不是 goals 引入，但如果要求全仓库绿，需要单独处理。

## 后续可选增强

建议保持克制，只有真实使用发现痛点后再做：

1. 在 UI 上显示 goal 状态，而不是只用 hook notice。
2. 增加 `/goal status` 面板，展示 ledger。
3. 增加 evaluator model 配置项，允许用户指定 goal judge 模型。
4. 在 goal prompt 中自动要求主模型最终输出 verification summary。
5. 增加 Electron IPC 层 E2E 测试，覆盖 `/goal` 到 stream done 的完整链路。

不建议第一时间做：

- 多 goal 并行。
- 子目标 DAG。
- repo 内 `.goal/` 文件账本。
- evaluator 调工具。
- token 级 budget。
- 模型工具 `update_goal`。

这些会明显增加复杂度，但不一定显著提升当前 CmbCoworkAgent 的使用效果。

## 总结

CmbCoworkAgent 当前 goals 实现可以概括为：

```text
Codex 的持久化目标状态
+ Hermes / Claude Code 的独立 evaluator
+ 普通 user message continuation
+ 轻量 ledger
+ turn budget 和 pause backstop
```

它不是最重、最平台化的方案，但适合当前项目：

- 架构改动可控。
- 和现有 `agent:invoke` / `agent.stream` / renderer done 模型兼容。
- 对中等模型比“主模型自判完成”更稳。
- 不过度设计。
- 有明确测试覆盖。
