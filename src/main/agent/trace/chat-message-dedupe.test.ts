/**
 * The LLM input window slides one call at a time and each call records it
 * twice (llm node input + model call), so the same message text used to land in
 * a trace ~9 times and crowd the collection budget. The collector now stores
 * each message once and refs the repeats; buildTraceTree puts them back before
 * anything renders. These tests pin both halves: the saving, and that the
 * rendered windows are unchanged.
 */
import { describe, expect, it, vi } from "vitest"
import type { AgentTrace, TraceChatMessage, TraceNode } from "./types"

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

const MODEL_INPUT_WINDOW = 12

/** Mirror of the real ai/tool alternating sequence a turn produces. */
function buildConversation(turns: number): TraceChatMessage[] {
  const messages: TraceChatMessage[] = [
    { role: "system", content: "S".repeat(4000) },
    { role: "user", content: "分析这个项目" }
  ]
  for (let index = 0; index < turns; index += 1) {
    messages.push({ role: "assistant", content: `调用工具 ${index}` })
    messages.push({ role: "tool", content: `工具 ${index} 的输出 ${"x".repeat(4000)}` })
  }
  return messages
}

/** Mirror of ipc/agent.ts: for every assistant message, record the 12 before it. */
function windowsFor(messages: TraceChatMessage[]): TraceChatMessage[][] {
  const windows: TraceChatMessage[][] = []
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role !== "assistant") continue
    windows.push(messages.slice(Math.max(0, i - MODEL_INPUT_WINDOW), i))
  }
  return windows
}

async function runTrace(messages: TraceChatMessage[]): Promise<AgentTrace> {
  const { TraceCollector } = await import("./collector")
  const tracer = new TraceCollector("thread-dedupe", "分析这个项目", "model-x", {
    includeSkillEval: false
  })
  for (const window of windowsFor(messages)) {
    tracer.beginLlmNode({ startedAt: new Date().toISOString(), input: window })
    tracer.recordModelCall({
      startedAt: new Date().toISOString(),
      inputMessages: window,
      outputMessage: { role: "assistant", content: "ok" },
      toolCalls: []
    })
  }
  return tracer.finish("success")
}

function llmInputs(nodes: TraceNode[]): TraceChatMessage[][] {
  return nodes
    .filter((node) => node.type === "llm")
    .map((node) => (Array.isArray(node.input) ? (node.input as TraceChatMessage[]) : []))
}

describe("chat message dedupe", () => {
  it("stores each message once and refs the repeats", async () => {
    const messages = buildConversation(10)
    const trace = await runTrace(messages)

    const recorded = [
      ...llmInputs(trace.nodes ?? []).flat(),
      ...(trace.modelCalls ?? []).flatMap((call) => call.inputMessages)
    ]
    const full = recorded.filter((message) => typeof message.mid === "string")
    const refs = recorded.filter((message) => typeof message.ref === "string")

    expect(refs.length).toBeGreaterThan(full.length * 3)
    // Every distinct message is stored exactly once across the whole trace.
    expect(new Set(full.map((message) => message.mid)).size).toBe(full.length)
    // No ref ever carries content of its own.
    expect(refs.every((message) => message.content === "")).toBe(true)
  })

  it("rebuilds windows that are byte-identical to what was recorded", async () => {
    const messages = buildConversation(10)
    const trace = await runTrace(messages)
    const { buildTraceTree } = await import("./tree-builder")

    const rebuilt = llmInputs(buildTraceTree(trace))
    const expected = windowsFor(messages)

    expect(rebuilt).toHaveLength(expected.length)
    rebuilt.forEach((window, index) => {
      expect(window.map((message) => ({ role: message.role, content: message.content }))).toEqual(
        expected[index].map((message) => ({ role: message.role, content: message.content }))
      )
    })
    // Nothing downstream should ever meet a ref.
    expect(JSON.stringify(rebuilt)).not.toContain('"ref"')
  })

  it("frees enough budget that a long turn still records every model call", async () => {
    const trace = await runTrace(buildConversation(40))
    const { buildTraceTree } = await import("./tree-builder")
    // 40 turns => 40 assistant messages, capped at TRACE_MAX_MODEL_CALLS (64).
    expect(trace.modelCalls?.length).toBe(40)
    expect((trace.nodes ?? []).filter((node) => node.type === "llm")).toHaveLength(40)
    // The last call must still hold real content, not a budget casualty.
    const lastWindow = llmInputs(buildTraceTree(trace)).at(-1) ?? []
    expect(lastWindow.length).toBeGreaterThan(0)
    expect(lastWindow.some((message) => message.content.length > 100)).toBe(true)
  })

  it("keeps a dangling ref harmless when its stored copy was dropped", async () => {
    const { buildTraceTree } = await import("./tree-builder")
    const trace = {
      traceId: "t1",
      threadId: "th1",
      nodes: [
        { id: "trace:t1", type: "trace", parentId: null, startedAt: "0" },
        {
          id: "llm:1",
          type: "llm",
          parentId: "trace:t1",
          startedAt: "0",
          input: [
            { role: "user", content: "存在的", mid: "aaaa" },
            { role: "tool", content: "", ref: "missing" }
          ]
        }
      ]
    } as unknown as AgentTrace

    const window = llmInputs(buildTraceTree(trace))[0]
    expect(window[0].content).toBe("存在的")
    expect(window[1].content).toBe("")
  })
})
