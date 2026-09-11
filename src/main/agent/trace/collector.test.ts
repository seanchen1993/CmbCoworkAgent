import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
vi.mock("../skill-eval/documents", () => ({
  buildSkillEvalTraceExtension: () => undefined
}))
vi.mock("../skill-eval/window", () => ({
  appendSkillEvalWindowTurn: () => ({ evalSkillNames: [] }),
  getSkillEvalWindowAssistantText: () => "",
  getSkillEvalWindowContextByRawName: () => ({})
}))

import {
  flushPendingTraceReports,
  flushTraceWriteQueue,
  hasPendingTraceReports,
  setTraceReporter,
  TraceCollector
} from "./collector"

let tracesDir = ""
let previousStorageMode: string | undefined
let previousTracesDir: string | undefined

beforeEach(async () => {
  await flushPendingTraceReports(1_000)
  await flushTraceWriteQueue()
  tracesDir = mkdtempSync(join(tmpdir(), "trace-collector-test-"))
  previousStorageMode = process.env.CMB_COWORK_TRACE_STORAGE_MODE
  previousTracesDir = process.env.CMB_COWORK_TRACES_DIR
  process.env.CMB_COWORK_TRACE_STORAGE_MODE = "plaintext"
  process.env.CMB_COWORK_TRACES_DIR = tracesDir
})

afterEach(async () => {
  await flushPendingTraceReports(1_000)
  await flushTraceWriteQueue()
  setTraceReporter({
    async report() {
      return undefined
    }
  })
  if (previousStorageMode === undefined) delete process.env.CMB_COWORK_TRACE_STORAGE_MODE
  else process.env.CMB_COWORK_TRACE_STORAGE_MODE = previousStorageMode
  if (previousTracesDir === undefined) delete process.env.CMB_COWORK_TRACES_DIR
  else process.env.CMB_COWORK_TRACES_DIR = previousTracesDir
  rmSync(tracesDir, { recursive: true, force: true })
})

describe("TraceCollector completion", () => {
  it("persists and reports only the first terminal outcome", async () => {
    const reportedOutcomes: string[] = []
    setTraceReporter({
      async report(trace) {
        reportedOutcomes.push(trace.outcome)
      }
    })
    const tracer = new TraceCollector("thread-cancelled", "stop this run", "model-test")

    const firstFinish = tracer.finish("cancelled", "User stopped the run")
    const duplicateFinish = tracer.finish("error", "late provider error")

    expect(duplicateFinish).toBe(firstFinish)
    const [firstTrace, duplicateTrace] = await Promise.all([firstFinish, duplicateFinish])
    await Promise.all([flushPendingTraceReports(1_000), flushTraceWriteQueue()])

    expect(firstTrace).toBe(duplicateTrace)
    expect(firstTrace.outcome).toBe("cancelled")
    expect(firstTrace.errorMessage).toBe("User stopped the run")
    expect(reportedOutcomes).toEqual(["cancelled"])

    const traceFile = join(tracesDir, firstTrace.threadId, `${firstTrace.traceId}.jsonl`)
    const persistedLines = readFileSync(traceFile, "utf8").trim().split(/\r?\n/)
    expect(persistedLines).toHaveLength(1)
    expect(JSON.parse(persistedLines[0])).toMatchObject({
      traceId: firstTrace.traceId,
      outcome: "cancelled",
      errorMessage: "User stopped the run"
    })
  })

  it("lets graceful shutdown wait for a scheduled report", async () => {
    let releaseReport: (() => void) | undefined
    const reportGate = new Promise<void>((resolve) => {
      releaseReport = resolve
    })
    setTraceReporter({
      async report() {
        await reportGate
      }
    })
    const tracer = new TraceCollector("thread-shutdown", "finish before quit", "model-test")

    await tracer.finish("cancelled")
    expect(hasPendingTraceReports()).toBe(true)

    const flush = flushPendingTraceReports(1_000)
    releaseReport?.()

    await expect(flush).resolves.toBe(true)
    expect(hasPendingTraceReports()).toBe(false)
  })
})
