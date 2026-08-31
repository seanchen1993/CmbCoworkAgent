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

function mockCollectorDependencies(): void {
  vi.doMock("electron", () => ({
    app: { getVersion: () => "test", isPackaged: false },
    safeStorage: {}
  }))
  vi.doMock("../../net-utils", () => ({ getLocalIP: () => "127.0.0.1" }))
  vi.doMock("../../storage", () => ({ getUserInfo: () => undefined }))
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
      if (
        expectedTraceId &&
        adoptionContexts.get(threadId)?.traceId !== expectedTraceId
      ) {
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
    const tracer = new TraceCollector(
      "thread-bounds",
      hugeText,
      "model-bounds",
      { includeSkillEval: false }
    )
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
    expect(Buffer.byteLength(readFileSync(persistedPath, "utf8"), "utf8")).toBeLessThan(
      1024 * 1024
    )
  }, 15_000)

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
    const traces = Array.from({ length: 40 }, (_, index) =>
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
    const { TraceCollector, flushTraceWriteQueue, setTraceReporter } =
      await import("./collector")
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
