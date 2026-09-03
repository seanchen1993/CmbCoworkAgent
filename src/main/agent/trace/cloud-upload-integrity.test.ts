/**
 * The cloud path must not lose a trace, and must not show blank panels for
 * values that deduplication had shared. Both are easy to break invisibly: the
 * upload has no size gate of its own, so a trace only goes missing if the
 * sanitiser throws, and the sanitiser's oversized fallback rebuilds model calls
 * and nodes field by field — it would carry the emptied values and drop the
 * pointers that explain them.
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

const ARGS = { path: "/repo/src/main/agent/runtime.ts", pattern: "p".repeat(1200) }
const TEXT = "助手回复 " + "z".repeat(1200)

/** A turn heavy enough to spend the budget and reach the oversized fallback. */
async function heavyTrace(turns: number): Promise<AgentTrace> {
  const { TraceCollector } = await import("./collector")
  const tracer = new TraceCollector("th-cloud", "分析这个仓库", "model-x", {
    includeSkillEval: false
  })
  for (let i = 0; i < turns; i += 1) {
    const messageId = `m-${i}`
    tracer.beginStep()
    tracer.recordToolCall({ name: "read_file", args: ARGS })
    tracer.endStep(TEXT)
    const nodeId = tracer.beginLlmNode({ messageId })
    tracer.recordModelCall({
      messageId,
      startedAt: new Date().toISOString(),
      inputMessages: [{ role: "user", content: "分析这个仓库" }],
      outputMessage: { role: "assistant", content: TEXT },
      toolCalls: [{ name: "read_file", args: ARGS }],
      tokenUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 }
    })
    tracer.endLlmNode({ nodeId, output: TEXT })
    tracer.addToolNode({
      name: "read_file",
      input: ARGS,
      llmMessageId: messageId,
      toolCallId: `tc-${i}`
    })
  }
  return tracer.finish("success")
}

describe("cloud upload integrity", () => {
  it("uploads a self-contained document with no pointers left in it", async () => {
    const { sanitizeTraceForCloudUpload } = await import("./sanitizer")
    const { rehydrateTraceContent } = await import("./content-refs")

    for (const turns of [5, 200]) {
      const trace = await heavyTrace(turns)
      // The trace as stored does share values — otherwise this proves nothing.
      if (turns > 5) expect(JSON.stringify(trace)).toContain('Ref":')

      const uploaded = sanitizeTraceForCloudUpload(rehydrateTraceContent(trace))
      const serialized = JSON.stringify(uploaded)
      expect(serialized).not.toContain('Ref":')
      expect(serialized).not.toContain('Mid":')

      // Whatever survives truncation must be real content, never an emptied
      // value whose pointer was dropped on the way out.
      for (const call of uploaded.modelCalls ?? []) {
        for (const toolCall of call.toolCalls) {
          if (Object.keys(toolCall.args).length > 0) {
            expect(JSON.stringify(toolCall.args)).toContain("/repo/src")
          }
        }
      }
      for (const step of uploaded.steps) {
        for (const toolCall of step.toolCalls) {
          if (!toolCall.truncated && Object.keys(toolCall.args).length > 0) {
            expect(JSON.stringify(toolCall.args)).toContain("/repo/src")
          }
        }
      }
    }
  }, 60_000)

  it("bounds the uploaded document without ever dropping the trace", async () => {
    const { sanitizeTraceForCloudUpload } = await import("./sanitizer")
    const { rehydrateTraceContent } = await import("./content-refs")

    for (const turns of [5, 200]) {
      const trace = await heavyTrace(turns)
      const uploaded = sanitizeTraceForCloudUpload(rehydrateTraceContent(trace))
      // The upload path has no size gate of its own; the sanitiser compresses
      // and, past its hard limit, summarises. Nothing is ever discarded.
      expect(uploaded.traceId).toBe(trace.traceId)
      expect(uploaded.outcome).toBe("success")
      expect(uploaded.totalToolCalls).toBe(turns)
      expect(uploaded.totalInputTokens).toBe(turns * 1000)
      expect(uploaded.totalModelCalls).toBe(turns)
      // HARD_TRACE_BYTES (96KB) triggers the summarising pass, it does not cap
      // the result: the summary still carries every model call, node and step,
      // so a maxed-out turn uploads ~380KB. Pinned so a change in the entry
      // caps shows up here rather than on the network.
      expect(Buffer.byteLength(JSON.stringify(uploaded), "utf8")).toBeLessThan(420 * 1024)
    }
  }, 60_000)

  it("still renders a conversation from the uploaded document", async () => {
    const { sanitizeTraceForCloudUpload } = await import("./sanitizer")
    const { rehydrateTraceContent } = await import("./content-refs")
    const { buildTraceTree } = await import("./tree-builder")

    const trace = await heavyTrace(200)
    const uploaded = sanitizeTraceForCloudUpload(rehydrateTraceContent(trace))
    // What the dashboard does with an ES hit: rehydrate, then build the tree.
    const nodes = buildTraceTree(rehydrateTraceContent(uploaded))
    expect(nodes.length).toBeGreaterThan(0)
    // Every node still has the structure the conversation view walks.
    expect(nodes.every((node) => Boolean(node.id) && Boolean(node.startedAt))).toBe(true)
    const ids = new Set(nodes.map((node) => node.id))
    expect(nodes.every((node) => node.parentId === null || ids.has(node.parentId))).toBe(true)
    // Assistant text reaches the view through one of its fallback chains.
    const hasText =
      nodes.some((node) => typeof node.output === "string" && node.output.length > 0) ||
      (uploaded.modelCalls ?? []).some((call) => (call.outputMessage.content ?? "").length > 0) ||
      uploaded.steps.some((step) => step.assistantText.length > 0)
    expect(hasText).toBe(true)
  }, 60_000)
})
