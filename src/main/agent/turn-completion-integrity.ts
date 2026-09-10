// ── Turn completion integrity ─────────────────────────────────────────────────
//
// LangChain's ReactAgent ends a turn on exactly ONE condition: the last
// AIMessage carries no normalized `tool_calls`. It never asks whether that
// message is a real answer, so all of these end the graph "normally":
//
//   tool(read_file result) → ai("")                        empty post-tool reply
//   tool(read_file result) → ai("继续", finish_reason=null)     half a sentence
//   ai("Now I will call read_file…") then SSE EOF           truncated transport
//   ai(…, finish_reason="length")                           cut off mid-answer
//   ai(…, finish_reason="tool_calls", tool_calls=[])        call never parsed
//
// The IPC layer above then reads "the graph stopped producing events" as "the
// user's task succeeded" and emits done + task-complete + "✅ 任务完成". Three
// different things were being conflated:
//
//   the model stream stopped producing data
//     ≠ the model's response protocol completed
//     ≠ the agent's task is done
//
// This module separates them at the only choke point that observes all three:
// an `afterModel` middleware, running exactly where LangChain would otherwise
// route to END. It classifies the final AIMessage against the PROTOCOL (finish
// signal, tool-call structure, content shape) and against the run's own task
// state (todos), then either bounces back to the model with a defect-targeted
// recovery prompt (`jumpTo: "model"`, the same mechanism the current-run steer
// queue uses) or records an unresolved defect that the IPC layer MUST read
// before it may call the turn successful.
//
// This is the Codex/Grok rule — "EOF is not completion, only an explicit
// terminal event is" — enforced one layer up from the transport, because the
// transport belongs to @langchain/openai. Whatever a broken SSE does down
// there, it surfaces here as an AIMessage that fails inspection.
//
// Deliberate non-goals:
//   - It never judges whether the ANSWER is good. "完成了" is a legitimate short
//     final reply; only protocol fields, message structure and task state gate
//     the turn — never prose length.
//   - It does not replace the /goal evaluator. A goal turn keeps its own
//     evaluator and turn budget (see goals/evaluator.ts); this gate sits UNDER
//     it and fixes the ORDINARY path, which had no completion gate at all.
//   - Every recovery path is bounded. An exhausted budget is a terminal
//     failure, never an infinite nag.

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import { TURN_COMPLETION_GATE_MARKER_PREFIX } from "../../shared/checkpoint-transcript"

/** Protocol-level defects in a model's FINAL (tool-call-free) message. */
export type TurnCompletionDefect =
  | "empty_response"
  | "reasoning_only"
  | "length_truncated"
  | "unparsed_tool_call"
  | "textual_tool_call"
  | "missing_finish_signal"

export interface TurnCompletionInspection {
  defect: TurnCompletionDefect | null
  /** Short machine-ish detail for logs and the user-facing failure reason. */
  detail: string
}

export interface TurnCompletionTodo {
  content: string
  status: "pending" | "in_progress" | "completed" | (string & {})
}

/** Defaults chosen to bound the worst case at 2 extra model calls per defect
 * class: enough for a transient truncation to recover, small enough that a
 * genuinely broken provider fails fast instead of burning the user's budget. */
export const DEFAULT_MAX_COMPLETION_RETRIES = 2
export const DEFAULT_MAX_TODO_NUDGES = 2

const TRUNCATION_FINISH_REASONS = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  "model_length",
  "content_filter_length"
])

const TOOL_CALL_FINISH_REASONS = new Set(["tool_calls", "tool_use", "function_call"])

/**
 * Provider-specific markers for "the model wrote a tool call as TEXT because the
 * harness never parsed it into a structured call".
 *
 * The marker list alone is not the test — see `containsTextualToolCall`. A bare
 * substring match over these was wrong for THIS product: the users are
 * developers, and a correct answer that explains tool-call parsing, quotes a
 * `<tool_call>` tag inline, or reviews code containing one would trip it. A
 * false positive here burns two retries and then settles a CORRECT turn as
 * failed, which is worse than the bug being guarded against.
 */
const TEXTUAL_TOOL_CALL_MARKERS = [
  "<function_calls>",
  "<invoke name=",
  "<tool_call>",
  "<|tool_call",
  "<｜tool▁call",
  "<tool▁call",
  "[TOOL_CALL]",
  "<function="
]

/**
 * Models observed emitting an explicit finish signal at least once in this
 * process, keyed by the model name the provider reports.
 *
 * `missing_finish_signal` is the softest defect: a provider that NEVER reports
 * one is not broken, it is just terse, and flagging it would fail every turn it
 * serves. So the rule is learned rather than assumed — a missing signal is a
 * defect only for a model that has already proven it sends them.
 *
 * Honest boundary: the very first call to a model in a fresh process cannot be
 * judged this way (nothing observed yet), and models that do not report a name
 * share the "unknown" bucket. Both degrade to "not a defect", never to a false
 * failure.
 */
const modelsWithObservedFinishSignal = new Set<string>()

interface GateRunState {
  retriesUsed: number
  todoNudgesUsed: number
  unresolved: TurnCompletionInspection | null
  unfinishedTodos: string[]
}

const gateStateByRun = new Map<string, GateRunState>()

function runScopedKey(threadId: string, ownerRunToken: string): string {
  return `${threadId}::${ownerRunToken}`
}

/**
 * A clean END: valid final message, nothing left open. Hand the budgets back.
 *
 * The budgets bound a STUCK model, not a whole physical run. One run can hold
 * many sub-turns (goal continuation, Stop-hook revision), each of which reaches
 * the model on its own; charging a later sub-turn for an episode an earlier one
 * already recovered from would leave a long goal run with no recovery left at
 * exactly the point it needs one. Progress — a genuinely valid final message —
 * is the only thing that refunds them, so no alternating pattern can loop: a
 * valid message ends the sub-turn.
 */
function settleRunState(state: GateRunState): void {
  state.retriesUsed = 0
  state.todoNudgesUsed = 0
  state.unresolved = null
  state.unfinishedTodos = []
}

function ensureRunState(key: string): GateRunState {
  const existing = gateStateByRun.get(key)
  if (existing) return existing
  const created: GateRunState = {
    retriesUsed: 0,
    todoNudgesUsed: 0,
    unresolved: null,
    unfinishedTodos: []
  }
  gateStateByRun.set(key, created)
  return created
}

export interface TurnCompletionGateReport {
  retriesUsed: number
  todoNudgesUsed: number
  /** Non-null when the model never produced a valid final message. */
  unresolved: TurnCompletionInspection | null
  /** Non-empty when the todo nudge budget ran out with work still open. */
  unfinishedTodos: string[]
}

/** Read what the gate observed for a physical run. The IPC layer calls this
 * before deciding whether the turn may be reported as successful. */
export function readTurnCompletionGateReport(
  threadId: string,
  ownerRunToken: string | undefined
): TurnCompletionGateReport | null {
  if (!ownerRunToken) return null
  const state = gateStateByRun.get(runScopedKey(threadId, ownerRunToken))
  if (!state) return null
  return {
    retriesUsed: state.retriesUsed,
    todoNudgesUsed: state.todoNudgesUsed,
    unresolved: state.unresolved,
    unfinishedTodos: [...state.unfinishedTodos]
  }
}

/** Drop a run's gate state. Must run on EVERY exit of a physical run (success,
 * error, abort) or the map leaks for the process lifetime. */
export function clearTurnCompletionGateState(
  threadId: string,
  ownerRunToken: string | undefined
): void {
  if (!ownerRunToken) return
  gateStateByRun.delete(runScopedKey(threadId, ownerRunToken))
}

/** Test seam: the learned finish-signal set is process-global by design. */
export function resetObservedFinishSignalsForTest(): void {
  modelsWithObservedFinishSignal.clear()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

/** Visible answer text only — reasoning/thinking blocks are excluded on
 * purpose, so a think-only reply reads as EMPTY rather than as an answer. */
export function extractVisibleText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      if (typeof block === "string") return block
      const item = asRecord(block)
      if (!item) return ""
      const type = typeof item.type === "string" ? item.type : ""
      if (type && type !== "text" && type !== "output_text") return ""
      return typeof item.text === "string" ? item.text : ""
    })
    .join("")
}

export function extractReasoningText(message: AIMessage): string {
  const parts: string[] = []
  const additional = asRecord(message.additional_kwargs)
  const reasoningContent = additional?.reasoning_content
  if (typeof reasoningContent === "string") parts.push(reasoningContent)
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      const item = asRecord(block)
      if (!item) continue
      const type = typeof item.type === "string" ? item.type : ""
      if (type !== "thinking" && type !== "reasoning" && type !== "redacted_thinking") continue
      const value = item.thinking ?? item.reasoning ?? item.text
      if (typeof value === "string") parts.push(value)
    }
  }
  return parts.join("")
}

/** The provider's terminal event, under whichever key the integration used.
 * Returns null when the stream ended without one — an EOF, not a completion. */
export function readFinishSignal(message: AIMessage): string | null {
  const sources = [asRecord(message.response_metadata), asRecord(message.additional_kwargs)]
  for (const source of sources) {
    if (!source) continue
    for (const key of ["finish_reason", "finishReason", "stop_reason", "done_reason"]) {
      const value = source[key]
      if (typeof value === "string" && value.trim()) return value.trim().toLowerCase()
    }
  }
  return null
}

function readModelKey(message: AIMessage): string {
  const metadata = asRecord(message.response_metadata)
  for (const key of ["model_name", "model", "modelName"]) {
    const value = metadata?.[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return "unknown"
}

function countRawToolCalls(message: AIMessage): number {
  const additional = asRecord(message.additional_kwargs)
  const raw = additional?.tool_calls
  return Array.isArray(raw) ? raw.length : 0
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Drop fenced blocks and inline code spans. Everything inside them is the model
 * SHOWING a tool call, not ISSUING one — protocol explanations, examples and
 * code review all live there. */
function stripCodeSpans(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
}

/**
 * True only when the model appears to have EMITTED a tool call as prose.
 *
 * Two filters, both aimed at the same failure: never fail a correct answer.
 *   - code spans are stripped first (a quoted or fenced tag is documentation);
 *   - the marker must OPEN an unquoted line. A model that emits a call instead of using
 *     the tool API puts it on its own line; prose that mentions one has it mid
 *     sentence ("代码里判断的是 <function=foo> 这种写法").
 *
 * This is deliberately biased toward MISSING a real textual call: a miss just
 * returns to "the turn ends normally", which the other defect classes
 * (empty_response / missing_finish_signal) usually catch anyway, while a false
 * positive marks a correct turn failed.
 */
export function containsTextualToolCall(text: string): boolean {
  const prose = stripCodeSpans(text).toLowerCase()
  return TEXTUAL_TOOL_CALL_MARKERS.some((marker) =>
    new RegExp(`(^|\n)[ \t*-]*${escapeRegExp(marker.toLowerCase())}`).test(prose)
  )
}

export interface InspectFinalMessageOptions {
  /**
   * Whether a model that has already proven it emits finish signals should be
   * held to that. Off in unit tests that assert a single message in isolation.
   */
  requireFinishSignal?: boolean
}

/**
 * Classify the model's FINAL message — one with no normalized tool calls, i.e.
 * the message on which LangChain is about to end the turn.
 *
 * Order matters: the most specific protocol evidence wins, so a truncated reply
 * is reported as truncation rather than as "missing finish signal", and the
 * caller's recovery prompt can name the real problem.
 */
export function inspectFinalAssistantMessage(
  message: AIMessage,
  options: InspectFinalMessageOptions = {}
): TurnCompletionInspection {
  const finishSignal = readFinishSignal(message)
  const modelKey = readModelKey(message)
  if (finishSignal) modelsWithObservedFinishSignal.add(modelKey)

  const invalidToolCalls = Array.isArray(message.invalid_tool_calls)
    ? message.invalid_tool_calls.length
    : 0
  const rawToolCalls = countRawToolCalls(message)
  const text = extractVisibleText(message.content).trim()
  const reasoning = extractReasoningText(message).trim()

  // A tool call the provider announced but never delivered in parsable form.
  // Checked before emptiness: the recovery is "re-issue the call", not "say
  // something". (The malformed-tool-call middleware promotes *parsable-ish*
  // invalid calls earlier in the chain; anything still dangling here is a call
  // this run genuinely lost.)
  if (invalidToolCalls > 0 || rawToolCalls > 0) {
    return {
      defect: "unparsed_tool_call",
      detail: `模型发出了工具调用但未能解析为结构化调用（invalid=${invalidToolCalls}, raw=${rawToolCalls}）`
    }
  }
  if (finishSignal && TOOL_CALL_FINISH_REASONS.has(finishSignal)) {
    return {
      defect: "unparsed_tool_call",
      detail: `finish_reason=${finishSignal}，但没有解析出任何工具调用`
    }
  }

  if (!text) {
    return reasoning
      ? {
          defect: "reasoning_only",
          detail: "模型只输出了思考内容，没有最终回答"
        }
      : {
          defect: "empty_response",
          detail: finishSignal
            ? `模型返回空回复（finish_reason=${finishSignal}）`
            : "模型返回空回复，且没有终止信号"
        }
  }

  if (finishSignal && TRUNCATION_FINISH_REASONS.has(finishSignal)) {
    return {
      defect: "length_truncated",
      detail: `回复被长度上限截断（finish_reason=${finishSignal}）`
    }
  }

  if (containsTextualToolCall(text)) {
    return {
      defect: "textual_tool_call",
      detail: "回复正文里出现了工具调用格式，但没有结构化 tool call"
    }
  }

  // EOF without a terminal event. Only enforced for models already observed
  // emitting one (see modelsWithObservedFinishSignal).
  const requireFinishSignal = options.requireFinishSignal !== false
  if (
    !finishSignal &&
    requireFinishSignal &&
    modelsWithObservedFinishSignal.has(modelKey) &&
    modelKey !== "unknown"
  ) {
    return {
      defect: "missing_finish_signal",
      detail: "模型流在没有终止信号的情况下结束（疑似断流）"
    }
  }

  return { defect: null, detail: "" }
}

const RECOVERY_INSTRUCTIONS: Record<TurnCompletionDefect, string> = {
  empty_response:
    "你上一条回复是空的，没有任何内容。请检查已经拿到的工具结果，继续未完成的工作；如果工作确实做完了，给出完整的最终回答。",
  reasoning_only:
    "你上一条回复只有思考过程，没有输出正式内容。请把结论写成面向用户的最终回答，或继续调用工具完成剩余工作。",
  length_truncated:
    "你上一条回复因长度上限被截断。请从截断处继续写完，不要重复已经输出过的内容，也不要重新开头。",
  unparsed_tool_call:
    "你上一条回复里的工具调用没有被正确解析，因此没有任何工具被执行、也没有任何工具结果。请重新发起这次工具调用（一次一个，参数用合法 JSON），或者在不需要工具时直接给出最终回答。",
  textual_tool_call:
    "你把工具调用当成普通文本写在了回复里，它不会被执行。请改用真正的工具调用接口重新发起，或者在不需要工具时直接给出最终回答。",
  missing_finish_signal:
    "你上一条回复在没有正常结束的情况下中断了，很可能内容并不完整。请确认剩余工作后继续完成任务，并给出完整的最终回答。"
}

/** The HumanMessage injected back into the graph. Prefixed with the plumbing
 * marker so no layer renders or persists it as a user message. */
export function buildCompletionRecoveryPrompt(
  defect: TurnCompletionDefect,
  attempt: number,
  maxAttempts: number
): string {
  return [
    `${TURN_COMPLETION_GATE_MARKER_PREFIX}${defect}]]`,
    "这是运行时的内部续跑提示，不是用户发来的新消息，回答时不要提到它。",
    RECOVERY_INSTRUCTIONS[defect],
    `（第 ${attempt}/${maxAttempts} 次续跑机会；本次仍未产出有效结果时本回合将被判定为未完成。）`
  ].join("\n")
}

export function buildTodoRecoveryPrompt(
  unfinished: readonly string[],
  attempt: number,
  maxAttempts: number
): string {
  return [
    `${TURN_COMPLETION_GATE_MARKER_PREFIX}todo]]`,
    "这是运行时的内部续跑提示，不是用户发来的新消息，回答时不要提到它。",
    "你的待办列表里还有未完成的事项：",
    ...unfinished.map((item) => `- ${item}`),
    "请继续完成它们；已经做完的用 write_todos 标记为 completed，确实做不了的先说明原因再更新列表，然后给出最终回答。",
    `（第 ${attempt}/${maxAttempts} 次续跑机会。）`
  ].join("\n")
}

export function collectUnfinishedTodos(todos: unknown): string[] {
  if (!Array.isArray(todos)) return []
  const unfinished: string[] = []
  for (const entry of todos) {
    const item = asRecord(entry) as TurnCompletionTodo | undefined
    if (!item) continue
    if (item.status !== "pending" && item.status !== "in_progress") continue
    const content = typeof item.content === "string" ? item.content.trim() : ""
    unfinished.push(content || "(未命名待办)")
  }
  return unfinished
}

/** User-facing reason for a turn the gate refused to call successful. */
export function describeTurnCompletionFailure(report: TurnCompletionGateReport): string | null {
  if (report.unresolved) {
    return `模型未能给出有效的最终结果：${report.unresolved.detail}（已重试 ${report.retriesUsed} 次）。本回合按未完成处理。`
  }
  if (report.unfinishedTodos.length > 0) {
    const preview = report.unfinishedTodos.slice(0, 3).join("；")
    const suffix = report.unfinishedTodos.length > 3 ? " 等" : ""
    return `任务结束时仍有 ${report.unfinishedTodos.length} 项待办未完成：${preview}${suffix}。本回合按未完成处理。`
  }
  return null
}

/** Fired once per injected recovery prompt, for the run's UI notice. */
export type TurnCompletionRecoveryCallback = (input: {
  kind: "defect" | "todo"
  detail: string
  attempt: number
  maxAttempts: number
}) => void

export interface TurnCompletionGateOptions {
  /** Physical run token; without one the gate is inert (subagent/task graphs
   * that the IPC layer does not settle on their own). */
  ownerRunToken?: string
  maxRetries?: number
  maxTodoNudges?: number
  todoGateEnabled?: boolean
  onRecovery?: TurnCompletionRecoveryCallback
}

interface GateGraphState {
  messages?: BaseMessage[]
  todos?: unknown
}

/**
 * Refuse to end a turn on an invalid final message.
 *
 * Placement: BEFORE `createCurrentRunMessageQueueMiddleware` in the middleware
 * array. `afterModel` hooks run in REVERSE array order, so the steer queue gets
 * to inject first — a message the user typed into a running turn continues the
 * loop on its own and outranks any recovery prompt of ours.
 */
export function createTurnCompletionGateMiddleware(
  options: TurnCompletionGateOptions = {}
): ReturnType<typeof createMiddleware> {
  const {
    ownerRunToken,
    maxRetries = DEFAULT_MAX_COMPLETION_RETRIES,
    maxTodoNudges = DEFAULT_MAX_TODO_NUDGES,
    todoGateEnabled = true,
    onRecovery
  } = options

  return createMiddleware({
    name: "turnCompletionGate",
    afterModel: {
      canJumpTo: ["model"],
      hook: async (state, runtime) => {
        const threadId =
          typeof runtime.configurable?.thread_id === "string"
            ? runtime.configurable.thread_id
            : undefined
        if (!threadId || !ownerRunToken) return undefined

        const messages = Array.isArray((state as GateGraphState).messages)
          ? ((state as GateGraphState).messages as BaseMessage[])
          : []
        const lastMessage = messages.at(-1)
        if (!AIMessage.isInstance(lastMessage)) return undefined

        const key = runScopedKey(threadId, ownerRunToken)

        // Tools were requested: the loop continues on its own. Record the finish
        // signal (a tool-call turn is the most reliable place to learn that this
        // model reports one) and stand down.
        if (Array.isArray(lastMessage.tool_calls) && lastMessage.tool_calls.length > 0) {
          const signal = readFinishSignal(lastMessage)
          if (signal) modelsWithObservedFinishSignal.add(readModelKey(lastMessage))
          const running = gateStateByRun.get(key)
          if (running) running.unresolved = null
          return undefined
        }

        const runState = ensureRunState(key)
        const inspection = inspectFinalAssistantMessage(lastMessage)

        if (inspection.defect) {
          if (runState.retriesUsed >= maxRetries) {
            // Budget spent. END is now unavoidable (this middleware cannot fail
            // the graph without losing the partial transcript), so record the
            // defect instead: the IPC layer reads it and refuses to report
            // success. That is the whole point — an unusable turn must surface
            // as failed, not as "✅ 任务完成".
            runState.unresolved = inspection
            console.warn(
              `[TurnCompletionGate] ${threadId} exhausted ${maxRetries} retries: ${inspection.defect} — ${inspection.detail}`
            )
            return undefined
          }
          runState.retriesUsed += 1
          runState.unresolved = null
          const prompt = buildCompletionRecoveryPrompt(
            inspection.defect,
            runState.retriesUsed,
            maxRetries
          )
          console.warn(
            `[TurnCompletionGate] ${threadId} retry ${runState.retriesUsed}/${maxRetries}: ${inspection.defect} — ${inspection.detail}`
          )
          onRecovery?.({
            kind: "defect",
            detail: inspection.detail,
            attempt: runState.retriesUsed,
            maxAttempts: maxRetries
          })
          return { messages: [new HumanMessage(prompt)], jumpTo: "model" as const }
        }

        // The protocol is satisfied. Now the task-state gate: a final answer
        // that leaves the model's OWN todo list open is the ordinary-path
        // analogue of the /goal evaluator's "continue" verdict.
        runState.unresolved = null
        if (!todoGateEnabled) {
          settleRunState(runState)
          return undefined
        }
        const unfinished = collectUnfinishedTodos((state as GateGraphState).todos)
        if (unfinished.length === 0) {
          settleRunState(runState)
          return undefined
        }
        if (runState.todoNudgesUsed >= maxTodoNudges) {
          runState.unfinishedTodos = unfinished
          console.warn(
            `[TurnCompletionGate] ${threadId} ended with ${unfinished.length} unfinished todos after ${maxTodoNudges} nudges`
          )
          return undefined
        }
        runState.todoNudgesUsed += 1
        runState.unfinishedTodos = []
        onRecovery?.({
          kind: "todo",
          detail: `仍有 ${unfinished.length} 项待办未完成`,
          attempt: runState.todoNudgesUsed,
          maxAttempts: maxTodoNudges
        })
        return {
          messages: [
            new HumanMessage(
              buildTodoRecoveryPrompt(unfinished, runState.todoNudgesUsed, maxTodoNudges)
            )
          ],
          jumpTo: "model" as const
        }
      }
    }
  })
}

/** True when the message immediately before the final AI reply was a tool
 * result — the exact shape from the bug report ("read_file 是最后一项"). Used by
 * tests and diagnostics; the gate itself does not need the distinction. */
export function isPostToolResultReply(messages: readonly BaseMessage[]): boolean {
  const previous = messages.at(-2)
  return ToolMessage.isInstance(previous)
}
