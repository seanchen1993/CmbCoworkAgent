import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { beforeEach, describe, expect, it } from "vitest"
import {
  isVisibleTranscriptMessage,
  isWorkflowPlumbingTranscriptContent
} from "../../shared/checkpoint-transcript"
import {
  clearTurnCompletionGateState,
  collectUnfinishedTodos,
  createTurnCompletionGateMiddleware,
  describeTurnCompletionFailure,
  inspectFinalAssistantMessage,
  readFinishSignal,
  readTurnCompletionGateReport,
  resetObservedFinishSignalsForTest,
  type TurnCompletionGateOptions
} from "./turn-completion-integrity"

/**
 * The bug this file pins: LangChain's ReactAgent ends a turn whenever the last
 * AIMessage has no tool_calls, and CmbCowork read that graph exit as "the
 * user's task succeeded". Every case below is a real reproduction from the
 * report — a turn that used to end as ✅ 任务完成 with nothing useful produced.
 */

const THREAD = "thread-under-test"
const RUN = "run-token-1"

/** `null` models a graph running without a thread id (no configurable key). */
function runtime(threadId: string | null): { configurable: Record<string, unknown> } {
  return { configurable: threadId ? { thread_id: threadId } : {} }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookResult = any

async function runGate(
  state: { messages: BaseMessage[]; todos?: unknown },
  options: TurnCompletionGateOptions = {},
  threadId: string | null = THREAD
): Promise<HookResult> {
  const middleware = createTurnCompletionGateMiddleware({
    ownerRunToken: RUN,
    ...options
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
  const afterModel = middleware.afterModel
  const hook = typeof afterModel === "function" ? afterModel : afterModel.hook
  return await hook(state, runtime(threadId))
}

function jumpedToModel(result: HookResult): boolean {
  return result?.jumpTo === "model" && Array.isArray(result?.messages)
}

/** The recovery message must be a HumanMessage: LangChain's afterModel router
 * short-circuits to END when `messages.at(-1)` is a tool-call-free AIMessage,
 * BEFORE it ever looks at `jumpTo`. Appending a non-AI message is what makes
 * the jump reachable at all. */
function injectedHumanText(result: HookResult): string {
  const message = result.messages[0]
  expect(HumanMessage.isInstance(message)).toBe(true)
  return typeof message.content === "string" ? message.content : ""
}

function aiMessage(
  content: AIMessage["content"],
  metadata: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): AIMessage {
  return new AIMessage({
    content,
    response_metadata: { model_name: "test-model", ...metadata },
    ...extra
  } as ConstructorParameters<typeof AIMessage>[0])
}

function toolResultThen(final: AIMessage): BaseMessage[] {
  return [
    new HumanMessage("看一下这个文件"),
    new AIMessage({
      content: "",
      tool_calls: [{ name: "read_file", args: { file_path: "a.ts" }, id: "call_1" }]
    }),
    new ToolMessage({ content: "file contents", tool_call_id: "call_1" }),
    final
  ]
}

beforeEach(() => {
  clearTurnCompletionGateState(THREAD, RUN)
  resetObservedFinishSignalsForTest()
})

describe("final message inspection", () => {
  it("accepts a genuine final answer, however short", () => {
    // A terse reply is NOT a defect. The gate judges protocol, never prose
    // length — "完成了" is a legitimate answer and must still end the turn.
    const inspection = inspectFinalAssistantMessage(aiMessage("完成了", { finish_reason: "stop" }))
    expect(inspection.defect).toBeNull()
  })

  it("flags an empty reply that follows a tool result", () => {
    const inspection = inspectFinalAssistantMessage(aiMessage("", { finish_reason: "stop" }))
    expect(inspection.defect).toBe("empty_response")
  })

  it("flags a reply that only contains reasoning", () => {
    const inspection = inspectFinalAssistantMessage(
      aiMessage([{ type: "thinking", thinking: "let me consider the file…" }], {
        finish_reason: "stop"
      })
    )
    expect(inspection.defect).toBe("reasoning_only")
  })

  it("flags a length-truncated answer", () => {
    const inspection = inspectFinalAssistantMessage(
      aiMessage("第一步是修改 runtime.ts，第二", { finish_reason: "length" })
    )
    expect(inspection.defect).toBe("length_truncated")
  })

  it("flags finish_reason=tool_calls with nothing parsed", () => {
    const inspection = inspectFinalAssistantMessage(
      aiMessage("正在读取文件", { finish_reason: "tool_calls" })
    )
    expect(inspection.defect).toBe("unparsed_tool_call")
  })

  it("flags a raw provider tool call that never became a structured call", () => {
    const inspection = inspectFinalAssistantMessage(
      new AIMessage({
        content: "",
        response_metadata: { model_name: "test-model", finish_reason: "stop" },
        additional_kwargs: {
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              // Truncated argument JSON — the reason it never became a
              // normalized tool_call in the first place.
              function: { name: "read_file", arguments: '{"file_path": "a.t' }
            }
          ]
        }
      })
    )
    expect(inspection.defect).toBe("unparsed_tool_call")
  })

  it("flags a tool call the model wrote as plain text", () => {
    const inspection = inspectFinalAssistantMessage(
      aiMessage('<tool_call>{"name": "read_file"}</tool_call>', { finish_reason: "stop" })
    )
    expect(inspection.defect).toBe("textual_tool_call")
  })

  it("still flags a call emitted on its own line after some prose", () => {
    const inspection = inspectFinalAssistantMessage(
      aiMessage('好的，我来读取文件：\n<tool_call>{"name": "read_file"}</tool_call>', {
        finish_reason: "stop"
      })
    )
    expect(inspection.defect).toBe("textual_tool_call")
  })

  // 这个产品的用户就是开发者，问的就是工具调用怎么解析。误判的终点是把一个
  // 正确回合判成失败——比漏判贵得多，所以下面每一种都必须放行。
  it.each([
    ["行内代码引用标签", "该解析器通过匹配 `<tool_call>` 标签识别工具调用。"],
    [
      "引用块中的日志示例",
      '日志中的错误格式如下：\n> <tool_call>{"name":"read_file"}</tool_call>\n这只是引用的日志。'
    ],
    ["嵌套引用中的标签", '  > > <invoke name="read_file">'],
    ["列表内引用中的标签", '- > <tool_call>{"name":"read_file"}</tool_call>'],
    ["句中裸提及标签", "代码里判断的是 <function=foo> 这种写法，注意不要漏掉闭合。"],
    [
      "围栏代码块里的示例",
      '下面是模型误发的形态：\n```\n<tool_call>{"name":"x"}</tool_call>\n```\n应当被识别并重试。'
    ],
    [
      "解释参数结构",
      '你可以调用 read_file 工具，参数是 {"file_path": "a.ts"}，name/arguments 都是必填的。'
    ]
  ])("does not flag %s", (_label, content) => {
    expect(
      inspectFinalAssistantMessage(aiMessage(content, { finish_reason: "stop" })).defect
    ).toBeNull()
  })

  it("treats a missing finish signal as EOF only for models known to send one", () => {
    const noSignal = aiMessage("Now I will call read_file to check the config…")
    // Nothing observed yet for this model → cannot judge, must not fail.
    expect(inspectFinalAssistantMessage(noSignal).defect).toBeNull()

    // One well-formed response teaches the gate that this model reports a
    // finish_reason; a later reply without one is then a truncated stream.
    inspectFinalAssistantMessage(aiMessage("好的", { finish_reason: "stop" }))
    expect(inspectFinalAssistantMessage(noSignal).defect).toBe("missing_finish_signal")
  })

  it("never flags a provider that reports no name", () => {
    inspectFinalAssistantMessage(
      new AIMessage({ content: "ok", response_metadata: { finish_reason: "stop" } })
    )
    const anonymous = new AIMessage({ content: "继续", response_metadata: {} })
    expect(inspectFinalAssistantMessage(anonymous).defect).toBeNull()
  })

  it("reads the finish signal under any integration's key", () => {
    expect(readFinishSignal(aiMessage("x", { finish_reason: "STOP" }))).toBe("stop")
    expect(readFinishSignal(aiMessage("x", { stop_reason: "end_turn" }))).toBe("end_turn")
    expect(readFinishSignal(aiMessage("x", { done_reason: "stop" }))).toBe("stop")
    expect(readFinishSignal(aiMessage("x"))).toBeNull()
  })
})

describe("gate: reported reproductions", () => {
  it('tool → ai("") continues instead of ending the turn', async () => {
    const result = await runGate({
      messages: toolResultThen(aiMessage("", { finish_reason: "stop" }))
    })
    expect(jumpedToModel(result)).toBe(true)
    expect(injectedHumanText(result)).toContain("空的")
    // The turn is still recoverable, so nothing is recorded as unresolved yet.
    expect(readTurnCompletionGateReport(THREAD, RUN)?.unresolved).toBeNull()
  })

  it('tool → ai("继续", finish_reason=null) continues', async () => {
    inspectFinalAssistantMessage(aiMessage("好的", { finish_reason: "stop" }))
    const result = await runGate({
      messages: toolResultThen(aiMessage("继续"))
    })
    expect(jumpedToModel(result)).toBe(true)
    expect(injectedHumanText(result)).toContain("中断")
  })

  it("partial text then EOF without a finish reason continues", async () => {
    inspectFinalAssistantMessage(aiMessage("好的", { finish_reason: "stop" }))
    const result = await runGate({
      messages: [new HumanMessage("看下配置"), aiMessage("Now I will call read_file...")]
    })
    expect(jumpedToModel(result)).toBe(true)
  })

  it("finish_reason=length asks the model to continue, not to restart", async () => {
    const result = await runGate({
      messages: [
        new HumanMessage("写个方案"),
        aiMessage("方案第一步是", { finish_reason: "length" })
      ]
    })
    expect(jumpedToModel(result)).toBe(true)
    const prompt = injectedHumanText(result)
    expect(prompt).toContain("截断")
    expect(prompt).toContain("不要重复")
  })

  it("finish_reason=tool_calls with no parsed call continues", async () => {
    const result = await runGate({
      messages: [new HumanMessage("读文件"), aiMessage("好的", { finish_reason: "tool_calls" })]
    })
    expect(jumpedToModel(result)).toBe(true)
    expect(injectedHumanText(result)).toContain("没有被正确解析")
  })

  it("a normal tool call is left alone — the loop already continues", async () => {
    const result = await runGate({
      messages: [
        new HumanMessage("读文件"),
        new AIMessage({
          content: "",
          response_metadata: { model_name: "test-model", finish_reason: "tool_calls" },
          tool_calls: [{ name: "read_file", args: {}, id: "call_1" }]
        })
      ]
    })
    expect(result).toBeUndefined()
  })

  it("a valid final answer after a tool call ends the turn", async () => {
    const result = await runGate({
      messages: toolResultThen(aiMessage("文件里定义了三个导出函数。", { finish_reason: "stop" }))
    })
    expect(result).toBeUndefined()
    expect(describeTurnCompletionFailure(readTurnCompletionGateReport(THREAD, RUN)!)).toBeNull()
  })

  it("a valid final answer with no tools at all ends the turn", async () => {
    const result = await runGate({
      messages: [
        new HumanMessage("你好"),
        aiMessage("你好，有什么可以帮你？", { finish_reason: "stop" })
      ]
    })
    expect(result).toBeUndefined()
  })
})

describe("gate: bounded retries", () => {
  it("stops retrying and records the defect so the turn cannot report success", async () => {
    const empty = { messages: toolResultThen(aiMessage("", { finish_reason: "stop" })) }

    expect(jumpedToModel(await runGate(empty, { maxRetries: 2 }))).toBe(true)
    expect(jumpedToModel(await runGate(empty, { maxRetries: 2 }))).toBe(true)
    // Budget spent: no third nag.
    expect(await runGate(empty, { maxRetries: 2 })).toBeUndefined()

    const report = readTurnCompletionGateReport(THREAD, RUN)!
    expect(report.retriesUsed).toBe(2)
    expect(report.unresolved?.defect).toBe("empty_response")
    expect(describeTurnCompletionFailure(report)).toContain("未完成")
  })

  it("clears the defect as soon as the model recovers", async () => {
    await runGate({ messages: toolResultThen(aiMessage("", { finish_reason: "stop" })) })
    await runGate({ messages: toolResultThen(aiMessage("", { finish_reason: "stop" })) })
    await runGate({ messages: toolResultThen(aiMessage("", { finish_reason: "stop" })) })
    expect(readTurnCompletionGateReport(THREAD, RUN)?.unresolved).not.toBeNull()

    const recovered = await runGate({
      messages: toolResultThen(aiMessage("读完了，一共 42 行。", { finish_reason: "stop" }))
    })
    expect(recovered).toBeUndefined()
    expect(describeTurnCompletionFailure(readTurnCompletionGateReport(THREAD, RUN)!)).toBeNull()
  })

  it("refunds the budget on a clean settle, so a later sub-turn still has retries", async () => {
    // One physical run can hold many sub-turns (goal continuation, Stop-hook
    // revision). A hiccup the model already recovered from must not leave a
    // later sub-turn with nothing left when it needs a retry.
    const empty = { messages: toolResultThen(aiMessage("", { finish_reason: "stop" })) }
    await runGate(empty)
    await runGate(empty)
    expect(readTurnCompletionGateReport(THREAD, RUN)?.retriesUsed).toBe(2)

    await runGate({ messages: toolResultThen(aiMessage("读完了。", { finish_reason: "stop" })) })
    expect(readTurnCompletionGateReport(THREAD, RUN)?.retriesUsed).toBe(0)

    // The next sub-turn gets a full budget rather than failing on its first defect.
    expect(jumpedToModel(await runGate(empty))).toBe(true)
  })

  it("is inert without a run token, so subagent graphs are untouched", async () => {
    const middleware = createTurnCompletionGateMiddleware({}) as unknown as {
      afterModel: { hook: (state: unknown, rt: unknown) => Promise<HookResult> }
    }
    const result = await middleware.afterModel.hook(
      { messages: toolResultThen(aiMessage("", { finish_reason: "stop" })) },
      runtime(THREAD)
    )
    expect(result).toBeUndefined()
  })

  it("is inert without a thread id", async () => {
    const result = await runGate(
      { messages: toolResultThen(aiMessage("", { finish_reason: "stop" })) },
      {},
      null
    )
    expect(result).toBeUndefined()
  })

  it("reports each recovery so the user sees why the turn kept going", async () => {
    const seen: string[] = []
    await runGate(
      { messages: toolResultThen(aiMessage("", { finish_reason: "stop" })) },
      { onRecovery: (input) => seen.push(`${input.kind}:${input.attempt}/${input.maxAttempts}`) }
    )
    expect(seen).toEqual(["defect:1/2"])
  })
})

describe("gate: unfinished todos", () => {
  const answered = () => ({
    messages: [
      new HumanMessage("做三件事"),
      aiMessage("第一件做完了。", { finish_reason: "stop" })
    ],
    todos: [
      { content: "改 runtime.ts", status: "completed" },
      { content: "改 agent.ts", status: "in_progress" },
      { content: "补测试", status: "pending" }
    ]
  })

  it("collects only the open items", () => {
    expect(collectUnfinishedTodos(answered().todos)).toEqual(["改 agent.ts", "补测试"])
    expect(collectUnfinishedTodos(undefined)).toEqual([])
    expect(collectUnfinishedTodos([{ content: "x", status: "completed" }])).toEqual([])
  })

  it("nudges a protocol-valid answer that leaves work open", async () => {
    const result = await runGate(answered(), { maxTodoNudges: 1 })
    expect(jumpedToModel(result)).toBe(true)
    const prompt = injectedHumanText(result)
    expect(prompt).toContain("改 agent.ts")
    expect(prompt).toContain("补测试")
  })

  it("settles as incomplete once the nudge budget is spent", async () => {
    await runGate(answered(), { maxTodoNudges: 1 })
    const result = await runGate(answered(), { maxTodoNudges: 1 })
    expect(result).toBeUndefined()

    const report = readTurnCompletionGateReport(THREAD, RUN)!
    expect(report.unfinishedTodos).toEqual(["改 agent.ts", "补测试"])
    expect(describeTurnCompletionFailure(report)).toContain("2 项待办未完成")
  })

  it("ends normally once every todo is closed", async () => {
    const result = await runGate({
      messages: [
        new HumanMessage("做三件事"),
        aiMessage("三件都做完了。", { finish_reason: "stop" })
      ],
      todos: [
        { content: "改 runtime.ts", status: "completed" },
        { content: "改 agent.ts", status: "completed" }
      ]
    })
    expect(result).toBeUndefined()
    expect(describeTurnCompletionFailure(readTurnCompletionGateReport(THREAD, RUN)!)).toBeNull()
  })

  it("can be switched off without touching the protocol gate", async () => {
    expect(await runGate(answered(), { todoGateEnabled: false })).toBeUndefined()
    expect(readTurnCompletionGateReport(THREAD, RUN)?.unfinishedTodos).toEqual([])

    clearTurnCompletionGateState(THREAD, RUN)
    const stillGated = await runGate(
      { messages: toolResultThen(aiMessage("", { finish_reason: "stop" })), todos: [] },
      { todoGateEnabled: false }
    )
    expect(jumpedToModel(stillGated)).toBe(true)
  })

  it("keeps a protocol defect ahead of the todo nudge", async () => {
    // An empty reply with open todos is an empty reply first: re-asking for the
    // answer is the useful move, listing todos at a model that said nothing is not.
    const result = await runGate({
      messages: toolResultThen(aiMessage("", { finish_reason: "stop" })),
      todos: [{ content: "补测试", status: "pending" }]
    })
    expect(injectedHumanText(result)).toContain("空的")
  })
})

describe("recovery prompts are runtime plumbing, not conversation", () => {
  it("is filtered out of every transcript surface", async () => {
    const result = await runGate({
      messages: toolResultThen(aiMessage("", { finish_reason: "stop" }))
    })
    const injected = injectedHumanText(result)

    // Persisted history, checkpoint restore, renderer display and the
    // "does this thread have user content" guards all route through these two.
    expect(isWorkflowPlumbingTranscriptContent(injected)).toBe(true)
    expect(isVisibleTranscriptMessage("user", injected)).toBe(false)

    // A real user message that merely mentions the gate is still conversation.
    expect(isVisibleTranscriptMessage("user", "为什么会有 CMB_TURN_COMPLETION_GATE_V1？")).toBe(
      true
    )
  })
})

describe("gate state lifecycle", () => {
  it("is scoped per run and cleared on exit", async () => {
    await runGate({ messages: toolResultThen(aiMessage("", { finish_reason: "stop" })) })
    expect(readTurnCompletionGateReport(THREAD, RUN)?.retriesUsed).toBe(1)
    expect(readTurnCompletionGateReport(THREAD, "another-run")).toBeNull()
    expect(readTurnCompletionGateReport("another-thread", RUN)).toBeNull()

    clearTurnCompletionGateState(THREAD, RUN)
    expect(readTurnCompletionGateReport(THREAD, RUN)).toBeNull()
  })
})
