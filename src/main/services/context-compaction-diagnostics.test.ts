import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  COMPACTION_DIAGNOSTICS_FILE,
  CompactionDiagnostics,
  createCompactionDiagnosticSink,
  readCompactionDiagnostics
} from "./context-compaction-diagnostics"

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cmb-compaction-diagnostics-"))
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

it("exports valid JSON with a reason when no compaction has been recorded", async () => {
  expect(JSON.parse(await readCompactionDiagnostics(directory))).toEqual({
    version: 1,
    reports: [],
    unavailableReason: "no_compaction_recorded"
  })
  expect(JSON.parse(await readCompactionDiagnostics(null)).unavailableReason).toBe(
    "workspace_unavailable"
  )
})

it("persists failure and retry details independently of runtime memory, retaining the last failure across later successes", async () => {
  const sink = createCompactionDiagnosticSink(directory, {
    threadId: "thread-a",
    modelId: "model-a",
    model: "deepseek"
  })
  const failed = new CompactionDiagnostics({
    reason: "threshold",
    tokens: 800_000,
    reportedTotalTokens: 139_000
  })
  failed.record("summary_retry_trim", { beforeRequestBytes: 3_200_000, afterRequestBytes: 650_000 })
  await failed.finish("failed", sink)
  for (let index = 0; index < 6; index++) {
    await new CompactionDiagnostics({ reason: "threshold", index }).finish("completed", sink)
  }
  // Read only from disk, as an export after a restart does.
  const payload = JSON.parse(await readFile(join(directory, COMPACTION_DIAGNOSTICS_FILE), "utf8"))
  expect(payload.reports).toHaveLength(5)
  expect(payload.lastFailure.id).toBe(failed.report.id)
  expect(payload.lastFailure.context).toMatchObject({
    threadId: "thread-a",
    model: "deepseek",
    reportedTotalTokens: 139_000
  })
  expect(payload.lastFailure.events).toContainEqual(
    expect.objectContaining({
      event: "summary_retry_trim",
      details: { beforeRequestBytes: 3_200_000, afterRequestBytes: 650_000 }
    })
  )
  expect(JSON.parse(await readCompactionDiagnostics(directory))).toEqual(payload)
})

it("serializes concurrent subagent writers and lets export await an in-flight write", async () => {
  const identity = { threadId: "parent", modelId: "model", model: "deepseek" }
  const first = createCompactionDiagnosticSink(directory, identity)
  const second = createCompactionDiagnosticSink(directory, identity)
  const writes = [
    new CompactionDiagnostics({ owner: "child-a" }).finish("failed", first),
    new CompactionDiagnostics({ owner: "child-b" }).finish("completed", second)
  ]
  const exported = JSON.parse(await readCompactionDiagnostics(directory))
  await Promise.all(writes)
  expect(
    exported.reports.map((record: { context: { owner: string } }) => record.context.owner)
  ).toEqual(["child-a", "child-b"])
  expect(exported.lastFailure.context.owner).toBe("child-a")
})

it("does not mask a model outcome when diagnostic persistence fails", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  await expect(
    new CompactionDiagnostics({}).finish("failed", async () => {
      throw new Error("disk full")
    })
  ).resolves.toBeUndefined()
})

it("exports a readable missing-data reason for corrupt diagnostic JSON", async () => {
  await writeFile(join(directory, COMPACTION_DIAGNOSTICS_FILE), "{broken")
  expect(JSON.parse(await readCompactionDiagnostics(directory)).unavailableReason).toBe(
    "diagnostic_read_failed"
  )
})
