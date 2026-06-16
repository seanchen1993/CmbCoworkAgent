# Deep Interview Spec: Solo 模式 subagent 执行可见性 + 超时韧性

## Metadata
- Interview ID: di-subagent-vis-timeout-20260611
- Rounds: 6
- Final Ambiguity Score: 19.5%
- Type: brownfield
- Generated: 2026-06-11
- Threshold: 0.2
- Threshold Source: default
- Initial Context Summarized: no
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.85 | 0.35 | 0.2975 |
| Constraint Clarity | 0.80 | 0.25 | 0.2000 |
| Success Criteria | 0.75 | 0.25 | 0.1875 |
| Context Clarity | 0.80 | 0.15 | 0.1200 |
| **Total Clarity** | | | **0.805** |
| **Ambiguity** | | | **0.195** |

> Overall scores use the coverage-weighted weakest (min) across the two active components.

## Topology
| Component | Status | Description | Coverage / Deferral Note |
|-----------|--------|-------------|--------------------------|
| 执行过程可见性 | active | Solo 模式主 agent 调 `task(subagent_type=...)` 时，子agent内部步骤可实时、可展开地呈现 | 覆盖验收 AC-1..AC-5 |
| 超时韧性 | active | 子agent内部后台 shell 命令的 600s wall-clock 硬上限改为 idle-based + 到限不杀转后台续跑 | 覆盖验收 AC-6..AC-10 |

参考项目（C:\ai 下本地源码，作为实现期方法输入，非交付物）：`opencode`、`codex`、`Copaw`/`copaw`、`openclaw`。

## Goal
在 Solo（非 Team）模式下，主 agent 通过 deepagents `task` 工具启动的子agent，需满足两件事：

1. **可见性**：主对话流里默认折叠显示该子agent的实时状态（在跑 / 当前工具 / 已耗时 / 心跳）；点击可展开看到子agent**运行中正在逐步推进的完整嵌套过程**（思考、工具调用、输出），而非现在"只有一个 task 调用转圈、结束才返回一大块结果"。展开运行中的子agent必须是**实时**的（看得到它正在跑、不是卡死）。

2. **超时韧性**：子agent内部经由 `execute(run_in_background:true)` → `task_output` 跑的长耗时后台 shell 命令（编译/测试/脚本），不再被 600s wall-clock 一刀切杀掉返回 exit 124。改为 **idle/心跳保活**（只要有 stdout/进展就重置计时），并在真正到限时**不强杀、转后台续跑**，主/子agent可稍后通过 `task_output` 继续等待或恢复，拿到结果而非失败。

## Constraints
- 仅针对 **Solo 模式 subagent（deepagents `createSubAgentMiddleware` + `task` 工具）**；明确**不是** Team 模式的 coordinator-worker（那套已有 `WorkerStreamPanel` / `onProgress`）。
- 可见性底层需为子agent嵌套图开启实时流式（LangGraph `subgraphs: true` 或等效），并将子图事件按命名空间归属到对应 `task` 工具调用，供渲染层做嵌套展示。
- 主对话默认折叠以避免刷屏；实时全量内容仅在用户展开时呈现。
- 超时修复落点确认在 **`src/main/agent/local-sandbox.ts` 的后台执行层**（`BACKGROUND_TIMEOUT_MS = 600_000`，`executeBackground` → `executeRaw`，超时分支返回 exit 124：`local-sandbox.ts:4765 / 4850 / 5707 / 6037`）。deepagents 子agent本身无 wall-clock 上限（仅受会话 `abortSignal` + `recursionLimit:1000`），故**不改 subagent 包装层的超时**。
- idle 判定的"进展信号"对后台 shell 命令 = stdout/stderr 字节流；保留一个 idle 上限（长时间无任何输出仍可终止）。
- 到限"转后台续跑"需复用既有 `backgroundTasks` 机制与 `task_output` 轮询语义，保持 abort（用户取消）与正常完成路径不变。

## Non-Goals
- 不改动 Team 模式 coordinator-worker 的可见性/超时（已有方案）。
- 不引入对 deepagents 子agent整体思考循环的 wall-clock 超时（确认当前不存在该上限，也不新增）。
- 不做"运行中主流全量逐字刷屏"（已被否决，改为默认折叠 + 展开实时）。
- 本期不强制要求把子agent transcript 永久落盘做历史回放（实时可见是硬需求；结束后回放为可选增强）。

## Acceptance Criteria
- [ ] AC-1：Solo 模式触发一个会调用 `task` 的请求，主对话流中出现一个**默认折叠**的子agent卡片，显示实时状态（在跑/当前工具/已耗时/心跳）。
- [ ] AC-2：展开一个**正在运行**的子agent卡片，能看到其内部步骤**实时逐步出现**（思考、工具调用、工具结果、输出），可观察到它在推进。
- [ ] AC-3：子agent内部的工具调用与输出正确归属到该 `task` 调用下，不串到主 agent 流里。
- [ ] AC-4：折叠态不产生刷屏；展开/折叠可自由切换且不丢已产生内容。
- [ ] AC-5：子agent结束后卡片显示终态与最终结果，展开仍可查看其走过的过程。
- [ ] AC-6：子agent内 `execute(run_in_background:true)` 的长命令，只要持续有 stdout 输出，运行**超过 600s 不被终止**（idle 计时被进展重置）。
- [ ] AC-7：真正长时间无任何输出的卡死命令，仍会在设定的 **idle 上限**后被终止（避免永久挂起）。
- [ ] AC-8：到达（idle 或可配置）限制时，命令**不被强杀为 exit 124 失败**，而是转为后台续跑状态；`task_output` 可继续等待/恢复并最终拿到结果。
- [ ] AC-9：被动终止（确需终止时）向子agent返回**已产生的部分输出 + 明确状态**，而非裸 exit 124，使子agent可据此继续决策。
- [ ] AC-10：用户主动取消（abort，exit 130）与命令正常完成的现有行为保持不变（无回归）。

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 痛点是 Team 模式 worker | 用户纠正 | 实为 Solo 模式 deepagents subagent（`task` 工具） |
| "看不到过程"是没有任何 UI | 代码已有流式管线 | 真因：子图未开 `subgraphs` 流式，主流只见 `task` 调用 + 终态结果 |
| 看得到 = 全量逐字刷屏到主流 | Contrarian：刷屏/性能代价 | 选定"默认折叠卡片 + 可展开嵌套完整过程" |
| 展开后看完整即可（结束回放） | Simplifier：实时是成本最大分叉 | 用户确认**必须运行中实时**，需 subgraphs 实时流式 |
| 600s 超时加在 subagent 本身 | 查证代码 | 确认 600s 仅是 `BACKGROUND_TIMEOUT_MS`，打中的是后台 shell 命令，非 subagent |
| 修复应改 subagent 包装层 | 落点查证 | 落点在 `local-sandbox` 后台执行层 |
| 期望行为=调高/去掉上限 | 询问期望 | 选定 idle/心跳保活 + 到限不杀转后台续跑 |

## Technical Context
- **子agent机制**：`src/main/agent/runtime.ts:1407` `createSubAgentMiddleware`（deepagents），主 run 在 `src/main/ipc/agent.ts:4584` 以 `agent.stream(input, { streamMode: ["messages","values"], recursionLimit: 1000 })` 消费；主 run **无** token-idle 超时（那个 `TOKEN_IDLE_TIMEOUT_MS=60_000` 只在 `agent.ts:2789` 的技能草稿生成路径）。
- **可见性缺口**：子agent作为嵌套图运行，未以 `subgraphs: true` 流式冒泡，渲染层（`stream-converter.ts` / 主对话渲染 / `WorkerStreamPanel.tsx` 仅服务 Team 模式）因而看不到子agent内部事件。需新增子图流式 + 主对话内嵌套子agent卡片渲染。
- **超时现场**：`src/main/agent/local-sandbox.ts:4765` `BACKGROUND_TIMEOUT_MS=600_000`；`executeBackground`（4788）以该值调 `executeRaw`（4847-4852）；`collectAndResolve` 在 `timedOut` 分支返回 `exit 124`（5705-5707，另 6036）；`createTimeoutMetadata`（4685）。后台任务存于静态 `backgroundTasks` Map（4768），用独立 `AbortController`，可跨会话存活——天然适配"转后台续跑"。
- **task_output 语义**：`runtime.ts:1137` 阻塞轮询（默认 30s，可传 timeout，最大 600_000），timeout 返回 `retrieval_status:"timeout"` 让模型再调——与"到限转后台、可继续等"方向一致。
- **参考实现待读**：`C:\ai\codex`、`C:\ai\opencode`（idle-based 超时 + 后台续跑）、`C:\ai\Copaw`/`openclaw`（嵌套子agent/任务展示）——实现期对照。

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Subagent (`task`) | core domain | subagent_type, prompt, status, elapsed, current_tool, nested_steps | spawned by Main Agent; runs nested graph; may invoke Background Command |
| Subagent Card (UI) | core domain | collapsed/expanded, live_status, nested_transcript | renders Subagent stream events |
| Subagent Stream Event | supporting | type(thinking/tool_call/tool_result/output), namespace | bubbled from subgraph; attributed to a `task` call |
| Background Command | core domain | task_id, command, stdout, started_at, idle_timer, status, exit_code | started by `execute(run_in_background)`; polled by `task_output`; capped by timeout policy |
| Timeout Policy | core domain | mode(idle vs wall-clock), idle_limit, on_limit(kill vs continue) | governs Background Command termination |
| task_output | supporting | task_id, block, timeout, retrieval_status | reads/awaits Background Command result |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 3 (Subagent, Subagent Card, Stream Event) | 3 | - | - | N/A |
| 2 | 5 (+Background Command, task_output) | 2 | - | 3 | 60% |
| 3 | 6 (+Timeout Policy) | 1 | - | 5 | 83% |
| 4 | 6 | 0 | 0 | 6 | 100% |
| 5 | 6 | 0 | 0 | 6 | 100% |
| 6 | 6 | 0 | 0 | 6 | 100% |

本体在 R4 后完全收敛（连续 3 轮零变化），领域模型稳定。

## Interview Transcript
<details>
<summary>Full Q&A (6 rounds)</summary>

### Round 0 — Topology
**Q:** 拆成 2 个顶层组件（可见性 / 超时韧性），参考项目作为方法输入，对吗？
**A:** 两个组件都对。
（补充：C:\ai 下有 opencode/codex/Copaw/openclaw 源码。）

### Round 1 — 可见性 / Goal
**Q:** 既然已有 WorkerStreamPanel+onProgress，"看不到过程"最准确是哪种？
**A:**（澄清）说的不是 Team 模式 worker，而是 Solo 模式 subagent。
**Q'(重定向):** Solo 模式调 task 时你实际看到什么？
**A:** 只有一个 task 调用，转圈等结果。

### Round 2 — 超时韧性 / Goal+Criteria
**Q:** 超时中断的症状是哪些？
**A:** 子agent(task工具)超时限制 600s，第60次心跳(~601s)强制终止，返回 exit code 124。

### Round 3 — 超时韧性 / Goal+Criteria
**Q:** 针对 600s 硬上限，"修好后"希望哪种行为？
**A:** 改成 idle/心跳保活；超时不杀、转后台续跑。

### Round 4 — 可见性 / Constraints+Criteria（Contrarian）
**Q:** 真需要每步实时流到主流吗？要的"看得到"是哪个粒度？
**A:** 可展开的嵌套完整过程。

### Round 5 — 超时∩可见性 / Scope（查证）
**Q:** 600s/exit124 打中的是谁？
**A:** 不确定，你查证。→ 查证结论：打中后台 shell 命令（local-sandbox BACKGROUND_TIMEOUT_MS），非 subagent 本身。

### Round 6 — 可见性 / Criteria（Simplifier）
**Q:** 运行中实时 vs 结束后回放？
**A:** 必须运行中实时。
</details>
