import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  safeStorage: {}
}))
vi.mock("../../net-utils", () => ({ getLocalIP: () => "127.0.0.1" }))
vi.mock("../../storage", () => ({ getUserInfo: () => null }))
vi.mock("../../ipc/skills", () => ({ listAllSkills: async () => [] }))
vi.mock("../../harness-board/service", () => ({
  getHarnessProjectAdapterSnapshot: () => null
}))
vi.mock("../../services/adoption-tracker", () => ({
  clearAdoptionContext: () => undefined,
  setAdoptionContext: () => undefined
}))

const { TraceCollector } = await import("./collector")
const { TurnTraceRecorder, getTraceUsageMetadata, isTraceToolError, recordAssistantMessageTrace } =
  await import("./turn-trace-recorder")

type Tracer = InstanceType<typeof TraceCollector>

function tracer(): Tracer {
  return new TraceCollector("thread-1", "看下当前工作区状态", "model-a")
}

/** What the dashboard reads back off a finished trace. */
function summarize(trace: {
  modelCalls?: Array<{ tokenUsage?: { inputTokens?: number; outputTokens?: number } }>
  nodes?: Array<{ type: string; name?: string; input?: unknown; output?: unknown }>
  steps?: Array<{ toolCalls: Array<{ name: string; args: unknown }> }>
  modelName?: string
  totalInputTokens?: number
  totalOutputTokens?: number
}): Record<string, unknown> {
  const toolNodes = (trace.nodes ?? []).filter((node) => node.type === "tool")
  return {
    modelCalls: trace.modelCalls?.length ?? 0,
    llmNodes: (trace.nodes ?? []).filter((node) => node.type === "llm").length,
    toolNodes: toolNodes.map((node) => ({ name: node.name, input: node.input })),
    toolResults: (trace.nodes ?? []).filter((node) => node.type === "tool_result").length,
    steps: (trace.steps ?? []).map((step) => step.toolCalls),
    modelName: trace.modelName,
    inputTokens: trace.totalInputTokens,
    outputTokens: trace.totalOutputTokens
  }
}

function ai(id: string, content: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: ["langchain_core", "messages", "AIMessage"],
    kwargs: { id, type: "ai", content, ...extra }
  }
}

function human(id: string, content = "看下当前工作区状态"): unknown {
  return {
    id: ["langchain_core", "messages", "HumanMessage"],
    kwargs: { id, type: "human", content }
  }
}

function toolResult(id: string, toolCallId: string, content: string): unknown {
  return {
    id: ["langchain_core", "messages", "ToolMessage"],
    kwargs: { id, type: "tool", tool_call_id: toolCallId, name: "ls", content }
  }
}

const USAGE = { input_tokens: 120, output_tokens: 35, total_tokens: 155 }
const LS_CALL = { id: "call-1", name: "ls", args: { path: "src" } }

/** One realistic turn: user asks, model calls ls, tool answers, model replies. */
function turnSnapshot(): unknown {
  return {
    messages: [
      human("u1"),
      ai("a1", "", {
        tool_calls: [LS_CALL],
        usage_metadata: USAGE,
        response_metadata: { model_name: "deepseek-v4-flash" }
      }),
      toolResult("t1", "call-1", "src/index.ts\nsrc/app.ts"),
      ai("a2", "工作区有两个文件。", { usage_metadata: { input_tokens: 200, output_tokens: 12 } })
    ]
  }
}

describe("trace metadata helpers", () => {
  it("reads token usage from each shape a provider may use", () => {
    expect(getTraceUsageMetadata({ usage_metadata: USAGE })).toEqual(USAGE)
    expect(getTraceUsageMetadata({ response_metadata: { token_usage: USAGE } })).toEqual(USAGE)
    expect(getTraceUsageMetadata({ response_metadata: { usage: USAGE } })).toEqual(USAGE)
    expect(getTraceUsageMetadata({})).toBeUndefined()
  })

  it("flags tool errors from a status field, a flag, or an error prefix", () => {
    expect(isTraceToolError({ status: "error" }, "ok")).toBe(true)
    expect(isTraceToolError({ is_error: true }, "ok")).toBe(true)
    expect(isTraceToolError({ additional_kwargs: { is_error: true } }, "ok")).toBe(true)
    expect(isTraceToolError({}, "Error: no such file")).toBe(true)
    expect(isTraceToolError({}, "src/index.ts")).toBe(false)
  })
})

describe("recordAssistantMessageTrace", () => {
  it("records a model call with its token usage and the API's model name", async () => {
    const collector = tracer()
    const messages = (turnSnapshot() as { messages: unknown[] }).messages
    recordAssistantMessageTrace({
      tracer: collector,
      messages: messages as never,
      index: 1,
      messageKey: "a1",
      providerMessageId: "a1"
    })
    const trace = await collector.finish("success")
    const result = summarize(trace)
    expect(result.modelCalls).toBe(1)
    expect(result.llmNodes).toBe(1)
    expect(result.modelName).toBe("deepseek-v4-flash")
    expect(result.inputTokens).toBe(120)
    expect(result.outputTokens).toBe(35)
  })

  it("keeps the streamed reasoning when the snapshot message carries none", async () => {
    const collector = tracer()
    const messages = (turnSnapshot() as { messages: unknown[] }).messages
    recordAssistantMessageTrace({
      tracer: collector,
      messages: messages as never,
      index: 1,
      messageKey: "a1",
      providerMessageId: "a1",
      streamedReasoning: "先看目录结构"
    })
    const trace = await collector.finish("success")
    expect(trace.modelCalls?.[0]?.outputMessage?.reasoning).toBe("先看目录结构")
  })
})

describe("TurnTraceRecorder", () => {
  it("records a whole turn: model calls, tokens, tool node and tool result", async () => {
    const collector = tracer()
    const recorder = new TurnTraceRecorder({ tracer: collector, userMessageId: "u1" })
    recorder.onStreamChunk("values", turnSnapshot())
    const result = summarize(await collector.finish("success"))

    expect(result.modelCalls).toBe(2)
    expect(result.llmNodes).toBe(2)
    expect(result.toolNodes).toEqual([{ name: "ls", input: { path: "src" } }])
    expect(result.toolResults).toBe(1)
    expect(result.inputTokens).toBe(320)
    expect(result.outputTokens).toBe(47)
    expect(result.modelName).toBe("deepseek-v4-flash")
  })

  it("counts a model call once when the same snapshot arrives repeatedly", async () => {
    const collector = tracer()
    const recorder = new TurnTraceRecorder({ tracer: collector, userMessageId: "u1" })
    recorder.onStreamChunk("values", turnSnapshot())
    recorder.onStreamChunk("values", turnSnapshot())
    recorder.onStreamChunk("values", turnSnapshot())
    const result = summarize(await collector.finish("success"))
    expect(result.modelCalls).toBe(2)
    expect(result.toolNodes).toHaveLength(1)
    expect(result.toolResults).toBe(1)
    expect(result.inputTokens).toBe(320)
  })

  it("leaves an earlier turn's model calls out of this turn's totals", async () => {
    const collector = tracer()
    const recorder = new TurnTraceRecorder({ tracer: collector, userMessageId: "u2" })
    recorder.onStreamChunk("values", {
      messages: [
        human("u1", "上一轮"),
        ai("a0", "上一轮回答", { usage_metadata: { input_tokens: 999, output_tokens: 999 } }),
        human("u2"),
        ai("a1", "这一轮回答", { usage_metadata: { input_tokens: 10, output_tokens: 5 } })
      ]
    })
    const result = summarize(await collector.finish("success"))
    expect(result.modelCalls).toBe(1)
    expect(result.inputTokens).toBe(10)
    expect(result.outputTokens).toBe(5)
  })

  it("records a step with its tool calls from the messages stream", async () => {
    const collector = tracer()
    const recorder = new TurnTraceRecorder({ tracer: collector, userMessageId: "u1" })
    recorder.onStreamChunk("messages", [ai("a1", "", { tool_calls: [LS_CALL] })])
    const result = summarize(await collector.finish("success"))
    expect(result.steps).toEqual([[{ name: "ls", args: { path: "src" } }]])
  })

  it("marks a failed tool result as an error", async () => {
    const collector = tracer()
    const recorder = new TurnTraceRecorder({ tracer: collector, userMessageId: "u1" })
    recorder.onStreamChunk("values", {
      messages: [
        human("u1"),
        ai("a1", "", { tool_calls: [LS_CALL] }),
        toolResult("t1", "call-1", "Error: no such directory")
      ]
    })
    const trace = await collector.finish("success")
    const resultNode = trace.nodes?.find((node) => node.type === "tool_result")
    expect(resultNode?.status).toBe("error")
  })

  it("never lets a malformed payload escape into the run", () => {
    const recorder = new TurnTraceRecorder({ tracer: tracer(), userMessageId: "u1" })
    expect(() => recorder.onStreamChunk("values", null)).not.toThrow()
    expect(() => recorder.onStreamChunk("messages", "nonsense")).not.toThrow()
    expect(() => recorder.onStreamChunk("custom", { anything: true })).not.toThrow()
  })
})

describe("tool node input completion", () => {
  it("fills in args that were still streaming when the node was created", async () => {
    const collector = tracer()
    // The streamed delta reaches the collector first, with args unassembled.
    collector.addToolNode({ name: "ls", input: {}, toolCallId: "call-1" })
    // The values snapshot then carries the complete call.
    collector.addToolNode({ name: "ls", input: { path: "src" }, toolCallId: "call-1" })
    const trace = await collector.finish("success")
    const toolNodes = trace.nodes?.filter((node) => node.type === "tool") ?? []
    expect(toolNodes).toHaveLength(1)
    expect(toolNodes[0]?.input).toEqual({ path: "src" })
  })

  it("does not let a later empty observation erase a recorded input", async () => {
    const collector = tracer()
    collector.addToolNode({ name: "ls", input: { path: "src" }, toolCallId: "call-1" })
    collector.addToolNode({ name: "ls", input: {}, toolCallId: "call-1" })
    const trace = await collector.finish("success")
    const toolNodes = trace.nodes?.filter((node) => node.type === "tool") ?? []
    expect(toolNodes[0]?.input).toEqual({ path: "src" })
  })

  it("upgrades a name that was still unknown when the node was created", async () => {
    const collector = tracer()
    collector.addToolNode({ name: "unknown", toolCallId: "call-1" })
    collector.addToolNode({ name: "read_file", input: { path: "a.ts" }, toolCallId: "call-1" })
    const trace = await collector.finish("success")
    const toolNodes = trace.nodes?.filter((node) => node.type === "tool") ?? []
    expect(toolNodes[0]?.name).toBe("read_file")
  })
})

describe("desktop and IM produce the same trace", () => {
  it("records identical model calls, tokens and tool nodes for one turn", async () => {
    const snapshot = turnSnapshot() as { messages: unknown[] }

    // Desktop: its own loop walks the snapshot and calls the shared units.
    const desktopCollector = tracer()
    const llmNodeByKey = new Map<string, string>()
    for (let i = 1; i < snapshot.messages.length; i += 1) {
      const kwargs = (snapshot.messages[i] as { kwargs: Record<string, unknown> }).kwargs
      if (kwargs.type === "ai") {
        const recorded = recordAssistantMessageTrace({
          tracer: desktopCollector,
          messages: snapshot.messages as never,
          index: i,
          messageKey: kwargs.id as string,
          providerMessageId: kwargs.id as string
        })
        llmNodeByKey.set(kwargs.id as string, recorded.llmNodeId)
      }
    }
    const desktop = summarize(await desktopCollector.finish("success"))

    // IM: the recorder drives the same units off the raw stream.
    const imCollector = tracer()
    new TurnTraceRecorder({ tracer: imCollector, userMessageId: "u1" }).onStreamChunk(
      "values",
      snapshot
    )
    const im = summarize(await imCollector.finish("success"))

    expect(im.modelCalls).toBe(desktop.modelCalls)
    expect(im.llmNodes).toBe(desktop.llmNodes)
    expect(im.inputTokens).toBe(desktop.inputTokens)
    expect(im.outputTokens).toBe(desktop.outputTokens)
    expect(im.modelName).toBe(desktop.modelName)
  })
})
