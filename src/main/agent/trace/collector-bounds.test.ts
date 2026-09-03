import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentTrace } from "./types"

const tempRoots: string[] = []
const adoptionContexts = new Map<string, Record<string, unknown>>()
const adapterResolvers = new Map<string, (value: unknown) => void>()

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

function mockCollectorDependencies(userInfo?: Record<string, unknown>): void {
  vi.doMock("electron", () => ({
    app: { getVersion: () => "test", isPackaged: false },
    safeStorage: {}
  }))
  vi.doMock("../../net-utils", () => ({ getLocalIP: () => "127.0.0.1" }))
  vi.doMock("../../storage", () => ({ getUserInfo: () => userInfo }))
  vi.doMock("../../ipc/skills", () => ({ listAllSkills: async () => [] }))
  vi.doMock("../../harness-board/service", () => ({
    getHarnessProjectAdapterSnapshot: (projectId: string) =>
      new Promise((resolve) => adapterResolvers.set(projectId, resolve))
  }))
  vi.doMock("../../services/adoption-tracker", () => ({
    setAdoptionContext: (threadId: string, patch: Record<string, unknown>) => {
      adoptionContexts.set(threadId, { ...(adoptionContexts.get(threadId) ?? {}), ...patch })
    },
    clearAdoptionContext: (threadId: string, expectedTraceId?: string) => {
      if (expectedTraceId && adoptionContexts.get(threadId)?.traceId !== expectedTraceId) {
        return
      }
      adoptionContexts.delete(threadId)
    },
    patchAdoptionContextForTrace: (
      threadId: string,
      expectedTraceId: string,
      patch: Record<string, unknown>
    ) => {
      const current = adoptionContexts.get(threadId)
      if (!current || current.traceId !== expectedTraceId) return false
      adoptionContexts.set(threadId, { ...current, ...patch })
      return true
    }
  }))
  vi.doMock("../skill-eval/documents", () => ({
    buildSkillEvalTraceExtension: () => undefined
  }))
  vi.doMock("../skill-eval/window", () => ({
    appendSkillEvalWindowTurn: () => ({ evalSkillNames: [] }),
    getSkillEvalWindowAssistantText: () => "",
    getSkillEvalWindowContextByRawName: () => ({})
  }))
}

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  adoptionContexts.clear()
  adapterResolvers.clear()
  delete process.env.CMB_COWORK_TRACES_DIR
  delete process.env.CMB_COWORK_TRACE_STORAGE_MODE
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("bounded trace telemetry", () => {
  it("caps huge collection fields before finish serialization", async () => {
    const root = makeRoot("trace-collector-bounds-")
    process.env.CMB_COWORK_TRACES_DIR = root
    process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
    mockCollectorDependencies()
    const { TraceCollector, flushTraceWriteQueue, getTraceWriteQueueDiagnostics } =
      await import("./collector")

    const hugeObject: Record<string, unknown> = {}
    for (let index = 0; index < 100_000; index += 1) hugeObject[`key-${index}`] = index
    const hugeText = "x".repeat(1024 * 1024)
    const hugeMessages = Array.from({ length: 1_000 }, () => ({
      role: "user" as const,
      content: hugeText
    }))
    const tracer = new TraceCollector("thread-bounds", hugeText, "model-bounds", {
      includeSkillEval: false
    })
    for (let index = 0; index < 1_000; index += 1) {
      tracer.beginStep()
      tracer.recordToolCall({
        name: "exec_command",
        args: hugeObject,
        result: hugeText
      })
      tracer.endStep(hugeText)
      tracer.recordModelCall({
        startedAt: new Date().toISOString(),
        inputMessages: hugeMessages,
        outputMessage: { role: "assistant", content: hugeText },
        toolCalls: []
      })
      tracer.addToolNode({ name: "tool", input: hugeObject, metadata: hugeObject })
    }

    const trace = await tracer.finish("error", hugeText)
    await flushTraceWriteQueue()
    const serialized = JSON.stringify(trace)
    const diagnostics = getTraceWriteQueueDiagnostics()

    expect(trace.userMessage.length).toBeLessThanOrEqual(64 * 1024)
    expect(trace.steps.length).toBeLessThanOrEqual(128)
    expect(trace.modelCalls?.length ?? 0).toBeLessThanOrEqual(64)
    expect(trace.nodes?.length ?? 0).toBeLessThanOrEqual(512)
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(1024 * 1024)
    expect(diagnostics.queuedItems).toBe(0)
    expect(diagnostics.queuedBytes).toBe(0)
    const persistedPath = join(root, "thread-bounds", `${trace.traceId}.jsonl`)
    expect(existsSync(persistedPath)).toBe(true)
    expect(Buffer.byteLength(readFileSync(persistedPath, "utf8"), "utf8")).toBeLessThan(1024 * 1024)
  }, 15_000)

  it("keeps countable skeletons once the byte budget is spent", async () => {
    const root = makeRoot("trace-collector-skeleton-")
    process.env.CMB_COWORK_TRACES_DIR = root
    process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
    mockCollectorDependencies()
    const { TraceCollector } = await import("./collector")

    const tracer = new TraceCollector("thread-skeleton", "hi", "model", {
      includeSkillEval: false
    })
    // Deliberately past TRACE_MAX_MODEL_CALLS (64) and TRACE_MAX_STEPS (128):
    // the arrays stop there, the counters must not.
    const TURNS = 300
    for (let i = 0; i < TURNS; i += 1) {
      const messageId = `m-${i}`
      const blob = `${i}-` + "a".repeat(8 * 1024)
      tracer.beginStep()
      tracer.recordToolCall({ name: "exec_command", args: { i, blob } })
      tracer.endStep(blob)
      const nodeId = tracer.beginLlmNode({ messageId })
      tracer.recordModelCall({
        messageId,
        startedAt: new Date().toISOString(),
        inputMessages: [{ role: "tool", content: blob }],
        outputMessage: { role: "assistant", content: blob },
        toolCalls: [{ name: "exec_command", args: { i } }],
        tokenUsage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050 }
      })
      tracer.endLlmNode({ nodeId, output: blob })
    }
    const trace = await tracer.finish("success")

    // The budget runs out long before 120 turns. Dropping the entries outright
    // used to take the counts with them, understating exactly the longest turns
    // — and the dashboard sums tool counts and tokens off these arrays.
    // Counted as the turn ran, so the caps on the arrays do not reach them.
    expect(trace.totalToolCalls).toBe(TURNS)
    expect(trace.totalModelCalls).toBe(TURNS)
    expect(trace.totalInputTokens).toBe(TURNS * 1000)
    expect(trace.totalOutputTokens).toBe(TURNS * 50)
    expect(trace.totalTokens).toBe(TURNS * 1050)
    // The arrays themselves still stop at their caps.
    expect(trace.modelCalls?.length).toBeLessThanOrEqual(64)
    expect(trace.steps.length).toBeLessThanOrEqual(128)

    // Skeletons carry shape, not payload.
    const skeletons = (trace.modelCalls ?? []).filter((call) => call.truncated)
    expect(skeletons.length).toBeGreaterThan(0)
    expect(skeletons.every((call) => call.inputMessages.length === 0)).toBe(true)
    expect(skeletons.every((call) => Boolean(call.startedAt))).toBe(true)
    const skeletonTools = trace.steps.flatMap((step) =>
      step.toolCalls.filter((call) => call.truncated)
    )
    expect(skeletonTools.length).toBeGreaterThan(0)
    // The tool name survives — it is a queried dimension.
    expect(skeletonTools.every((call) => call.name === "exec_command")).toBe(true)
    expect(skeletonTools.every((call) => Object.keys(call.args).length === 0)).toBe(true)
  }, 30_000)

  it("holds a trace under the persist limit even when every field is maxed out", async () => {
    const root = makeRoot("trace-collector-ceiling-")
    process.env.CMB_COWORK_TRACES_DIR = root
    process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
    mockCollectorDependencies()
    const { TraceCollector, flushTraceWriteQueue } = await import("./collector")

    // Everything at its cap at once: a full user message, a full error message,
    // 128 long skill names on both lists, long tool names, and per-turn content
    // that never repeats so nothing can be deduplicated away.
    const tracer = new TraceCollector("thread-ceiling", "U".repeat(64 * 1024), "model", {
      includeSkillEval: false
    })
    tracer.setUsedSkills(Array.from({ length: 128 }, (_, i) => `skill-${i}-${"s".repeat(200)}`))
    tracer.setEvolvedSkills(Array.from({ length: 128 }, (_, i) => `evo-${i}-${"e".repeat(200)}`))
    // The budget is spent within ~13 turns; the rest only adds GC pressure.
    for (let i = 0; i < 60; i += 1) {
      const messageId = `m-${i}`
      const blob = `${i}-` + "a".repeat(16 * 1024)
      tracer.beginStep()
      tracer.recordToolCall({ name: "exec", args: { i, blob } })
      tracer.endStep(blob)
      const nodeId = tracer.beginLlmNode({
        messageId,
        input: Array.from({ length: 12 }, (_, k) => ({
          role: "tool" as const,
          content: `${i}-${k}-` + "c".repeat(16 * 1024)
        }))
      })
      tracer.recordModelCall({
        messageId,
        startedAt: new Date().toISOString(),
        inputMessages: Array.from({ length: 12 }, (_, k) => ({
          role: "tool" as const,
          content: `${i}-${k}-` + "c".repeat(16 * 1024)
        })),
        outputMessage: { role: "assistant", content: blob, reasoning: blob },
        toolCalls: [{ name: "exec", args: { i, blob } }]
      })
      tracer.endLlmNode({ nodeId, output: blob, metadata: { reasoning: blob } })
      tracer.addToolNode({
        name: "n".repeat(300),
        input: { i, blob },
        llmMessageId: messageId,
        toolCallId: `tc-${i}`
      })
      tracer.addToolResultNode({ toolCallId: `tc-${i}`, output: blob })
    }

    const trace = await tracer.finish("error", "E".repeat(16 * 1024))
    await flushTraceWriteQueue()

    // Over TRACE_PERSISTED_MAX_BYTES the write queue drops the trace outright,
    // and only an in-memory counter records that it happened. A node input that
    // skipped the byte budget once pushed this to ~1.1MB, so pin the headroom.
    const bytes = Buffer.byteLength(JSON.stringify(trace), "utf8")
    expect(bytes).toBeLessThan(768 * 1024)
    const persistedPath = join(root, "thread-ceiling", `${trace.traceId}.jsonl`)
    expect(existsSync(persistedPath)).toBe(true)
  }, 30_000)

  it("keeps identity and tree structure intact after the collection budget is spent", async () => {
    const root = makeRoot("trace-collector-identity-")
    process.env.CMB_COWORK_TRACES_DIR = root
    process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
    // Synthetic fixture identity. "信息技术部" is the literal
    // deriveUpperOrgLevelsFromPath keys on, so it has to stay; every other
    // segment is invented.
    mockCollectorDependencies({
      userName: "测试用户甲",
      sapId: "00000001",
      ystId: "yst-00000001",
      originOrgId: "org-1",
      orgName: "测试三级部门",
      pathName: "测试总行/信息技术部/测试一级部门/测试二级部门/测试三级部门",
      originPathId: "path-1"
    })
    const { TraceCollector, flushTraceWriteQueue } = await import("./collector")

    const hugeObject: Record<string, unknown> = {}
    for (let index = 0; index < 100_000; index += 1) hugeObject[`key-${index}`] = index
    const hugeText = "x".repeat(1024 * 1024)
    const hugeMessages = Array.from({ length: 1_000 }, () => ({
      role: "user" as const,
      content: hugeText
    }))
    const tracer = new TraceCollector("thread-identity", hugeText, "model-identity", {
      includeSkillEval: false
    })
    tracer.setUsedSkills(["pdf-report@1.0.0", "xlsx-clean@2.1.0"])
    for (let index = 0; index < 1_000; index += 1) {
      tracer.beginStep()
      tracer.recordToolCall({ name: "exec_command", args: hugeObject, result: hugeText })
      tracer.endStep(hugeText)
      tracer.recordModelCall({
        startedAt: new Date().toISOString(),
        inputMessages: hugeMessages,
        outputMessage: { role: "assistant", content: hugeText },
        toolCalls: []
      })
      tracer.addToolNode({ name: "tool", input: hugeObject, metadata: hugeObject })
    }

    const trace = await tracer.finish("success")
    await flushTraceWriteQueue()

    // Identity is first-party and must survive a fully drained budget: before
    // this was fixed every one of these became "[trace budget exhausted]",
    // collapsing unrelated users into a single phantom row on the dashboard.
    expect(trace.userName).toBe("测试用户甲")
    expect(trace.sapId).toBe("00000001")
    expect(trace.ystId).toBe("yst-00000001")
    expect(trace.orgName).toBe("测试三级部门")
    expect(trace.pathName).toContain("测试三级部门")
    expect(trace.pathId).toBe("path-1")
    expect(trace.userIp).toBe("127.0.0.1")
    // pathName drives the org dimension; a placeholder silently emptied it.
    expect(trace.upperOrgLv3).toBe("测试一级部门")
    expect(trace.upperOrgLv2).toBe("测试二级部门")
    expect(trace.upperOrgLv1).toBe("测试三级部门")
    expect(trace.usedSkills).toHaveLength(2)
    expect(trace.usedSkills[0]).toContain("pdf-report")
    expect(trace.usedSkills[1]).toContain("xlsx-clean")

    const serializedTrace = JSON.stringify(trace)
    expect(serializedTrace).not.toContain("trace budget exhausted")
    expect(Buffer.byteLength(serializedTrace, "utf8")).toBeLessThan(1024 * 1024)

    // Structure: ids stay unique and every parent link resolves, so the tree
    // still rebuilds after the budget is gone.
    const nodes = trace.nodes ?? []
    const ids = new Set(nodes.map((node) => node.id))
    expect(ids.size).toBe(nodes.length)
    expect(nodes.every((node) => Boolean(node.id) && Boolean(node.startedAt))).toBe(true)
    expect(nodes.every((node) => node.parentId === null || ids.has(node.parentId))).toBe(true)
    expect(trace.steps.every((step) => step.toolCalls.every((call) => Boolean(call.name)))).toBe(
      true
    )
  }, 20_000)

  it("keeps late adapter enrichment in its trace epoch and bounds the write queue", async () => {
    const root = makeRoot("trace-collector-epoch-")
    process.env.CMB_COWORK_TRACES_DIR = root
    process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
    mockCollectorDependencies()
    const { TraceCollector, flushTraceWriteQueue, getTraceWriteQueueDiagnostics } =
      await import("./collector")

    const first = new TraceCollector("shared-thread", "first", "model", {
      includeSkillEval: false,
      harnessFeature: { projectId: "project-a", slug: "feature-a" }
    })
    const second = new TraceCollector("shared-thread", "second", "model", {
      includeSkillEval: false,
      harnessFeature: { projectId: "project-b", slug: "feature-b" }
    })
    adapterResolvers.get("project-a")?.({ id: "a", name: "adapter-a", version: "1" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(adoptionContexts.get("shared-thread")?.harnessAdapterName).not.toBe("adapter-a")
    adapterResolvers.get("project-b")?.({ id: "b", name: "adapter-b", version: "2" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(adoptionContexts.get("shared-thread")?.harnessAdapterName).toBe("adapter-b")

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 5)
    const traces = Array.from(
      { length: 40 },
      (_, index) =>
        new TraceCollector(`queue-thread-${index}`, `message-${index}`, "model", {
          includeSkillEval: false
        })
    )
    await Promise.all([
      first.finish("success"),
      second.finish("success"),
      ...traces.map((tracer) => tracer.finish("success"))
    ])
    const busyDiagnostics = getTraceWriteQueueDiagnostics()
    await flushTraceWriteQueue()
    clearInterval(ticker)
    const idleDiagnostics = getTraceWriteQueueDiagnostics()

    expect(busyDiagnostics.queuedItems).toBeLessThanOrEqual(busyDiagnostics.maxItems)
    expect(busyDiagnostics.queuedBytes).toBeLessThanOrEqual(busyDiagnostics.maxBytes)
    expect(idleDiagnostics.queuedItems).toBe(0)
    expect(idleDiagnostics.queuedBytes).toBe(0)
    expect(ticks).toBeGreaterThan(0)
  }, 15_000)

  it("finishes once when concurrent teardown paths race", async () => {
    const root = makeRoot("trace-collector-finish-once-")
    process.env.CMB_COWORK_TRACES_DIR = root
    process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
    mockCollectorDependencies()
    const { TraceCollector, flushTraceWriteQueue, setTraceReporter } = await import("./collector")
    const report = vi.fn(async () => undefined)
    setTraceReporter({ report })
    const tracer = new TraceCollector("thread-finish-once", "message", "model", {
      includeSkillEval: false
    })

    const first = tracer.finish("success")
    const second = tracer.finish("error", "late failure")
    expect(second).toBe(first)
    const [firstTrace, secondTrace] = await Promise.all([first, second])
    await flushTraceWriteQueue()
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(secondTrace).toBe(firstTrace)
    expect(firstTrace.outcome).toBe("success")
    expect(report).toHaveBeenCalledTimes(1)
    const persisted = readFileSync(
      join(root, "thread-finish-once", `${firstTrace.traceId}.jsonl`),
      "utf8"
    )
    expect(persisted.split("\n").filter(Boolean)).toHaveLength(1)
  })

  it("reads and deletes asynchronously under file, byte and directory-entry budgets", async () => {
    const root = makeRoot("trace-reader-bounds-")
    const threadId = "thread-reader"
    const threadDir = join(root, threadId)
    mkdirSync(threadDir, { recursive: true })
    process.env.CMB_COWORK_TRACES_DIR = root
    process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
    mockCollectorDependencies()
    const { deleteTraceById, readThreadTraces, readTraceById } = await import("./collector")

    const makeTrace = (traceId: string): AgentTrace => ({
      traceId,
      threadId,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
      userMessage: traceId,
      modelId: "model",
      steps: [],
      totalToolCalls: 0,
      outcome: "success",
      usedSkills: [],
      evolvedSkills: [],
      triggerSource: "chat"
    })
    for (const traceId of ["trace-a", "trace-b", "trace-c"]) {
      writeFileSync(
        join(threadDir, `000-${traceId}.jsonl`),
        `${JSON.stringify(makeTrace(traceId))}\n`,
        "utf8"
      )
    }
    writeFileSync(join(threadDir, "001-oversized.jsonl"), "x".repeat(3 * 1024 * 1024), "utf8")
    for (let index = 0; index < 4_200; index += 1) {
      writeFileSync(join(threadDir, `junk-${String(index).padStart(5, "0")}.tmp`), "", "utf8")
    }

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 5)
    const traces = await readThreadTraces(threadId)
    const selected = await readTraceById("trace-b")
    const deleted = await deleteTraceById("trace-b")
    const missing = await readTraceById("trace-b")
    clearInterval(ticker)

    expect(traces.map((trace) => trace.traceId).sort()).toEqual(["trace-a", "trace-b", "trace-c"])
    expect(selected?.traceId).toBe("trace-b")
    expect(deleted.success).toBe(true)
    expect(missing).toBeNull()
    expect(ticks).toBeGreaterThan(0)
  }, 30_000)
})
