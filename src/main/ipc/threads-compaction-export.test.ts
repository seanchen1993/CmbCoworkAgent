import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { afterEach, expect, it, vi } from "vitest"
import {
  CompactionDiagnostics,
  createCompactionDiagnosticSink
} from "../services/context-compaction-diagnostics"

const mocks = vi.hoisted(() => ({ directory: "", output: "", workspace: "/test-workspace" }))
vi.mock("electron", () => ({
  app: { getAppPath: () => "/unused", getVersion: () => "test", isPackaged: false },
  BrowserWindow: {
    fromWebContents: () => null,
    getFocusedWindow: () => null,
    getAllWindows: () => []
  },
  dialog: { showSaveDialog: async () => ({ filePath: mocks.output }) }
}))
vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getThreadCore: () => ({
    thread_id: "thread-export",
    title: "test",
    created_at: 0,
    updated_at: 0,
    metadata: JSON.stringify({ workspacePath: mocks.workspace })
  }),
  getThreadMessages: () => [
    { id: "user", role: "user", content: "continue", created_at: new Date(0) }
  ]
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
  if (mocks.directory) await rm(mocks.directory, { recursive: true, force: true })
})

it("includes durable compaction failure diagnostics in the real session ZIP export", async () => {
  mocks.directory = await mkdtemp(join(tmpdir(), "cmb-compaction-export-"))
  mocks.output = join(mocks.directory, "session.zip")
  vi.spyOn(console, "log").mockImplementation(() => {})
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
  const { registerThreadHandlers } = await import("./threads")
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerThreadHandlers({
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler)
  } as never)
  const result = await handlers.get("threads:exportSession")!(
    { sender: { id: 1 } },
    "thread-export"
  )
  expect(result).toEqual({ success: true, filePath: mocks.output })
  const zip = new AdmZip(mocks.output)
  expect(zip.getEntries().map((entry) => entry.entryName)).toEqual(
    expect.arrayContaining([
      "session.json",
      "session.md",
      "raw_api_call.json",
      "context_compaction.json"
    ])
  )
  expect(JSON.parse(zip.readAsText("context_compaction.json")).lastFailure).toMatchObject({
    status: "failed",
    context: { reportedInputTokens: 139_000, reason: "provider_overflow" }
  })
})
