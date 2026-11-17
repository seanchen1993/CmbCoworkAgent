import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { afterEach, expect, it, vi } from "vitest"
import { closeDatabase, createThread, initializeDatabase, upsertThreadMessages } from "../db"
import {
  CompactionDiagnostics,
  createCompactionDiagnosticSink
} from "../services/context-compaction-diagnostics"
import { registerThreadHandlers } from "./threads"

const mocks = vi.hoisted(() => ({ directory: "", output: "" }))
vi.mock("electron", () => ({
  app: { getAppPath: () => "/unused", getVersion: () => "test", isPackaged: false },
  BrowserWindow: {
    fromWebContents: () => null,
    getFocusedWindow: () => null,
    getAllWindows: () => []
  },
  dialog: { showSaveDialog: async () => ({ filePath: mocks.output }) }
}))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getDbPath: () => join(mocks.directory, "app.sqlite"),
  getMemorySessionOptInMigrationState: () => ({ migrated: true })
}))
vi.mock("../agent/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/runtime")>()),
  withCheckpointer: async (_id: string, run: (saver: unknown) => unknown) =>
    run({
      list: async function* () {
        yield* []
      }
    })
}))
vi.mock("../agent/context-history-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/context-history-path")>()),
  getProjectThreadDataDirectory: async () => mocks.directory
}))

afterEach(async () => {
  vi.restoreAllMocks()
  await closeDatabase()
  if (mocks.directory) await rm(mocks.directory, { recursive: true, force: true })
})

it("includes durable compaction failure diagnostics in the real session ZIP export", async () => {
  mocks.directory = await mkdtemp(join(tmpdir(), "cmb-compaction-export-"))
  mocks.output = join(mocks.directory, "session.zip")
  vi.spyOn(console, "log").mockImplementation(() => {})
  await initializeDatabase()
  createThread("thread-export", { title: "test", workspacePath: mocks.directory })
  upsertThreadMessages("thread-export", [
    { id: "user", role: "user", content: "continue", created_at: new Date(0) }
  ])
  const diagnostic = new CompactionDiagnostics({
    reason: "provider_overflow",
    reportedInputTokens: 139_000
  })
  diagnostic.record("summary_error", { error: { message: "maximum context length", status: 485 } })
  await diagnostic.finish(
    "failed",
    createCompactionDiagnosticSink(mocks.directory, {
      threadId: "thread-export",
      modelId: "model",
      model: "deepseek"
    })
  )
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerThreadHandlers({
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler)
  } as never)
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, mainFrame: {} })
  const result = await handlers.get("threads:exportSession")!({ sender }, "thread-export")
  expect(result).toEqual({ success: true, filePath: mocks.output })
  expect(sender.eventNames()).toEqual([])
  const zip = new AdmZip(mocks.output)
  expect(zip.getEntries().map((entry) => entry.entryName)).toEqual(
    expect.arrayContaining([
      "session.json",
      "session.md",
      "raw_api_call.json",
      "context_compaction.json"
    ])
  )
  expect(JSON.parse(zip.readAsText("session.json")).messages).toEqual([
    expect.objectContaining({ role: "user", content: "continue" })
  ])
  expect(JSON.parse(zip.readAsText("context_compaction.json")).lastFailure).toMatchObject({
    status: "failed",
    context: { reportedInputTokens: 139_000, reason: "provider_overflow" }
  })
})
