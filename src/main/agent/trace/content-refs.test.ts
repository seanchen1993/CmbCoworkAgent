/**
 * A trace used to store the same content up to three times because the renderer
 * has three fallback chains (steps / modelCalls / nodes) and the collector
 * cannot know which will fire. Storage now keeps one copy and refs the rest.
 * These tests pin the saving, and — the part that actually matters — that no
 * read path can hand a ref to a consumer.
 */
import { describe, expect, it, vi } from "vitest"
import type { AgentTrace } from "./types"

vi.mock("electron", () => ({
  app: { getVersion: () => "test", isPackaged: false },
  safeStorage: {}
}))
vi.mock("../../net-utils", () => ({ getLocalIP: () => "127.0.0.1" }))
vi.mock("../../storage", () => ({ getUserInfo: () => undefined }))
vi.mock("../../ipc/skills", () => ({ listAllSkills: async () => [] }))
vi.mock("../../harness-board/service", () => ({
  getHarnessProjectAdapterSnapshot: async () => null
}))
vi.mock("../../services/adoption-tracker", () => ({
  setAdoptionContext: () => {},
  clearAdoptionContext: () => {},
  patchAdoptionContextForTrace: () => false
}))
vi.mock("../skill-eval/documents", () => ({ buildSkillEvalTraceExtension: () => undefined }))
vi.mock("../skill-eval/window", () => ({
  appendSkillEvalWindowTurn: () => ({ evalSkillNames: [] }),
  getSkillEvalWindowAssistantText: () => "",
  getSkillEvalWindowContextByRawName: () => ({})
}))

const ARGS = { path: "/repo/src/main/agent/runtime.ts", pattern: "p".repeat(2000) }
const TEXT = "助手回复 " + "z".repeat(1500)
const REASONING = "推理 " + "r".repeat(800)
const USAGE = { inputTokens: 1234, outputTokens: 56, totalTokens: 1290 }

/** Mirror of the recorder order in ipc/agent.ts for one tool-using turn. */
async function recordTurns(turns: number): Promise<AgentTrace> {
  const { TraceCollector } = await import("./collector")
  const tracer = new TraceCollector("th-refs", "分析这个仓库", "model-x", {
    includeSkillEval: false
  })
  for (let i = 0; i < turns; i += 1) {
    const messageId = `msg-${i}`
    tracer.beginStep()
    tracer.recordToolCall({ name: "read_file", args: ARGS })
    tracer.endStep(TEXT)
    const nodeId = tracer.beginLlmNode({ messageId, startedAt: new Date().toISOString() })
    tracer.recordModelCall({
      messageId,
      startedAt: new Date().toISOString(),
      inputMessages: [{ role: "user", content: "分析这个仓库" }],
      outputMessage: { role: "assistant", content: TEXT, reasoning: REASONING },
      toolCalls: [{ name: "read_file", args: ARGS }],
      tokenUsage: USAGE
    })
    tracer.endLlmNode({
      nodeId,
      output: TEXT,
      status: "success",
      metadata: { tokenUsage: USAGE, reasoning: REASONING }
    })
    tracer.addToolNode({
      name: "read_file",
      input: ARGS,
      llmMessageId: messageId,
      toolCallId: `tc-${i}`
    })
  }
  return tracer.finish("success")
}

describe("trace content refs", () => {
  it("keeps the literal on the flattest structure and refs the copies", async () => {
    const trace = await recordTurns(5)

    // The canonical copy lands on the step, because recordToolCall/endStep run
    // before the model call and the nodes — the flattest structure wins by
    // arrival order, which is what keeps a cloud query able to reach it.
    expect(trace.steps[0].toolCalls[0].args).toEqual(ARGS)
    expect(trace.steps[0].assistantText).toBe(TEXT)
    expect(trace.steps[0].toolCalls[0].argsMid).toEqual(expect.any(String))
    expect(trace.steps[0].assistantTextMid).toEqual(expect.any(String))
    // Repeats collapse wherever they are — later steps included.
    expect(trace.steps[1].toolCalls[0].argsRef).toEqual(expect.any(String))
    expect(trace.steps[1].toolCalls[0].args).toEqual({})

    // model calls and nodes carry ids instead of the bytes.
    const call = (trace.modelCalls ?? [])[0]
    expect(call.toolCalls[0].argsRef).toEqual(expect.any(String))
    expect(call.toolCalls[0].args).toEqual({})
    expect(call.outputMessage.contentRef).toEqual(expect.any(String))
    expect(call.outputMessage.content).toBe("")

    const llmNode = (trace.nodes ?? []).find((node) => node.type === "llm")
    expect(llmNode?.output).toHaveProperty("__traceRef")
    expect(llmNode?.metadata?.reasoning).toHaveProperty("__traceRef")
    const toolNode = (trace.nodes ?? []).find((node) => node.type === "tool")
    expect(toolNode?.input).toHaveProperty("__traceRef")
  })

  it("restores every value, and no read path leaks a ref", async () => {
    const trace = await recordTurns(5)
    const { rehydrateTraceContent } = await import("./content-refs")
    const { buildTraceTree } = await import("./tree-builder")

    const whole = rehydrateTraceContent(trace)
    for (const call of whole.modelCalls ?? []) {
      expect(call.toolCalls[0].args).toEqual(ARGS)
      expect(call.outputMessage.content).toBe(TEXT)
      expect(call.outputMessage.reasoning).toBe(REASONING)
    }
    for (const node of whole.nodes ?? []) {
      if (node.type === "llm") {
        expect(node.output).toBe(TEXT)
        expect(node.metadata?.reasoning).toBe(REASONING)
      }
      if (node.type === "tool") expect(node.input).toEqual(ARGS)
    }
    expect(JSON.stringify(whole)).not.toContain("__traceRef")
    expect(JSON.stringify(buildTraceTree(trace))).not.toContain("__traceRef")
  })

  it("rehydration is idempotent and leaves ref-free traces alone", async () => {
    const { rehydrateTraceContent } = await import("./content-refs")
    const trace = await recordTurns(3)
    const once = rehydrateTraceContent(trace)
    expect(rehydrateTraceContent(once)).toEqual(once)

    const plain = {
      traceId: "t",
      threadId: "th",
      steps: [],
      usedSkills: []
    } as unknown as AgentTrace
    expect(rehydrateTraceContent(plain)).toBe(plain)
  })

  it("degrades a dangling ref to empty rather than junk", async () => {
    const { rehydrateTraceContent } = await import("./content-refs")
    const trace = {
      traceId: "t",
      threadId: "th",
      steps: [
        {
          index: 0,
          startedAt: "0",
          assistantText: "留下的",
          assistantTextMid: "keep",
          toolCalls: []
        }
      ],
      modelCalls: [
        {
          startedAt: "0",
          inputMessages: [],
          outputMessage: { role: "assistant", content: "", contentRef: "gone" },
          toolCalls: [{ name: "t", args: {}, argsRef: "gone" }]
        }
      ],
      usedSkills: []
    } as unknown as AgentTrace

    const whole = rehydrateTraceContent(trace)
    expect(whole.modelCalls?.[0].outputMessage.content).toBe("")
    expect(whole.modelCalls?.[0].toolCalls[0].args).toEqual({})
  })
})
