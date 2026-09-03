/**
 * The collection budget is spent in the order work happens, so a long turn used
 * to come out as "the first handful of steps in full, then everything else a
 * skeleton" — and the end of a turn is where the answer is. A quarter of the
 * budget is now held back for whatever turns out to be last.
 */
import { describe, expect, it, vi } from "vitest"

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

const TURNS = 200

// Built once: three assertions on the same 200-turn trace, and this suite runs
// beside tests that assert the event loop keeps ticking.
let cached:
  | Promise<
      Awaited<ReturnType<InstanceType<typeof import("./collector").TraceCollector>["finish"]>>
    >
  | undefined

function longTurnOnce(): ReturnType<typeof longTurn> {
  cached ??= longTurn()
  return cached
}

async function longTurn(): Promise<
  Awaited<ReturnType<InstanceType<typeof import("./collector").TraceCollector>["finish"]>>
> {
  const { TraceCollector } = await import("./collector")
  const tracer = new TraceCollector("th-tail", "分析仓库", "model", { includeSkillEval: false })
  for (let i = 0; i < TURNS; i += 1) {
    const blob = `${i}-` + "a".repeat(8 * 1024)
    tracer.beginStep()
    tracer.recordToolCall({ name: "read_file", args: { path: `/a/${i}.ts`, blob } })
    tracer.endStep(`助手回复 ${i} ${blob}`)
    const nodeId = tracer.beginLlmNode({ messageId: `m${i}` })
    tracer.recordModelCall({
      messageId: `m${i}`,
      startedAt: new Date().toISOString(),
      inputMessages: [{ role: "user", content: blob }],
      outputMessage: { role: "assistant", content: `助手回复 ${i} ${blob}` },
      toolCalls: [{ name: "read_file", args: { path: `/a/${i}.ts` } }],
      tokenUsage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 }
    })
    tracer.endLlmNode({ nodeId, output: `助手回复 ${i} ${blob}` })
    tracer.addToolNode({
      name: "read_file",
      input: { path: `/a/${i}.ts` },
      llmMessageId: `m${i}`,
      toolCallId: `tc-${i}`
    })
    tracer.addToolResultNode({ toolCallId: `tc-${i}`, output: blob })
  }
  return tracer.finish("success")
}

describe("tail reserve", () => {
  it("keeps the end of a long turn readable, not just the beginning", async () => {
    const { rehydrateTraceContent } = await import("./content-refs")
    // Every read path rehydrates first; the head's output is stored as a ref to
    // the step that holds the same text, so asserting on the raw trace would be
    // asserting on an implementation detail.
    const trace = rehydrateTraceContent(await longTurnOnce())
    const llmNodes = (trace.nodes ?? []).filter((node) => node.type === "llm")
    const withOutput = llmNodes
      .map((node, index) => (node.output !== undefined ? index : -1))
      .filter((index) => index >= 0)

    expect(withOutput.length).toBeGreaterThan(10)
    // A head, then a gap, then a tail — not one run from zero.
    const head = withOutput[0]
    const last = withOutput[withOutput.length - 1]
    expect(head).toBe(0)
    expect(last).toBe(llmNodes.length - 1)
    const contiguous = withOutput.every((value, index) => value === index)
    expect(contiguous).toBe(false)

    // The last recorded turn carries its real text, which is the whole point:
    // before the reserve it was a skeleton like everything after the first few.
    const lastOutput = llmNodes[llmNodes.length - 1]?.output
    expect(typeof lastOutput).toBe("string")
    expect(String(lastOutput)).toContain("助手回复")
  }, 60_000)

  it("keeps nodes for the real last turns, not just the first 170", async () => {
    const { rehydrateTraceContent } = await import("./content-refs")
    const trace = rehydrateTraceContent(await longTurnOnce())
    const llmNodes = (trace.nodes ?? []).filter((node) => node.type === "llm")
    const turnOf = (node: { metadata?: Record<string, unknown> }): number =>
      Number(String(node.metadata?.messageId ?? "m-1").slice(1))
    const turns = llmNodes.map(turnOf).sort((a, b) => a - b)

    // Three nodes a turn against a 512 cap used to stop the tree around turn
    // 170, and the conversation view reads assistant replies off llm nodes — so
    // the last thirty turns were invisible whatever the byte budget did. The
    // cap is unchanged; the slots are just no longer all spent at the front.
    expect(turns[0]).toBe(0)
    expect(turns[turns.length - 1]).toBe(TURNS - 1)

    // Whatever survives has a parent that exists, or the renderer drops its
    // whole subtree.
    const ids = new Set((trace.nodes ?? []).map((node) => node.id))
    expect(
      (trace.nodes ?? []).every((node) => node.parentId === null || ids.has(node.parentId))
    ).toBe(true)

    // And the final turn carries its real text, not a skeleton.
    const lastNode = llmNodes.find((node) => turnOf(node) === TURNS - 1)
    expect(String(lastNode?.output ?? "")).toContain("助手回复")
  }, 60_000)

  it("takes the reserve out of the pool rather than adding to the trace", async () => {
    const { TRACE_COLLECTION_MAX_BYTES, TRACE_TAIL_RESERVE_RATIO, TraceCollectionBudget } =
      await import("./bounds")
    const budget = new TraceCollectionBudget()
    const pool = TRACE_COLLECTION_MAX_BYTES - 32 * 1024
    expect(budget.tailReserveBytes).toBe(Math.floor(pool * TRACE_TAIL_RESERVE_RATIO))
    expect(budget.remaining + budget.tailReserveBytes).toBe(pool)

    const trace = await longTurnOnce()
    expect(Buffer.byteLength(JSON.stringify(trace), "utf8")).toBeLessThan(950 * 1024)
  }, 60_000)

  it("never lets a drained budget pass the placeholder off as content", async () => {
    // takeText was fixed for this long ago; takeValue was not, and endLlmNode
    // goes through takeValue — so every skeleton turn rendered
    // "[trace budget exhausted]" as the model's reply on the trace detail page.
    // The existing assertion missed it because that test never called
    // endLlmNode.
    const trace = await longTurnOnce()
    expect(JSON.stringify(trace)).not.toContain("trace budget exhausted")
  }, 60_000)
})
