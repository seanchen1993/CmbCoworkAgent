import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as db from "../../db"
import {
  captureFunctionPlacedAnchor,
  forgetFunctionPlacedCursor,
  rememberFunctionPlacedMessage
} from "./placed-anchor-host"
let directory = ""
afterEach(() => vi.restoreAllMocks())
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "mods-placed-anchor-"))
  paths.database = join(directory, "actual.sqlite")
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})
it("captures native DB display tail, never a system/tool row, without persisting transient placements", () => {
  const thread = randomUUID()
  db.createThread(thread, { workspacePath: directory })
  expect(captureFunctionPlacedAnchor(thread)).toEqual({ kind: "start" })
  db.upsertThreadMessages(thread, [
    { id: "native-user", role: "user", content: "Native question", created_at: new Date() },
    {
      id: "native-answer",
      role: "assistant",
      content: "Native answer",
      created_at: new Date(),
      provider_source_id: "provider",
      provider_occurrence: 2
    },
    { id: "tool-hidden", role: "tool", content: "Native tool", created_at: new Date() }
  ])
  expect(captureFunctionPlacedAnchor(thread)).toEqual({
    kind: "after-message",
    id: "native-answer",
    role: "assistant",
    providerSourceId: "provider",
    providerOccurrence: 2
  })
  expect(db.getThreadMessages(thread).map((m) => m.id)).toEqual([
    "native-user",
    "native-answer",
    "tool-hidden"
  ])
})
it("uses only the actual live stream cursor, expires an ended run, and rejects a recreated thread incarnation", () => {
  const thread = randomUUID()
  db.createThread(thread, { workspacePath: directory })
  let live = true
  rememberFunctionPlacedMessage(
    thread,
    { id: "partial-live", role: "assistant", content: "live" },
    () => {
      if (!live) throw Error("ended")
    }
  )
  expect(captureFunctionPlacedAnchor(thread)).toMatchObject({ id: "partial-live" })
  expect(db.getThreadMessages(thread)).toEqual([])
  live = false
  expect(captureFunctionPlacedAnchor(thread)).toEqual({ kind: "start" })
  rememberFunctionPlacedMessage(thread, { id: "old-native", role: "assistant", content: "old" })
  db.deleteThread(thread)
  db.createThread(thread, { workspacePath: directory })
  expect(captureFunctionPlacedAnchor(thread)).toEqual({ kind: "start" })
  forgetFunctionPlacedCursor(thread)
})

it("reads only runtime scope for a live cursor and leaves large stored history unchanged", () => {
  const thread = randomUUID()
  db.createThread(thread, { workspacePath: directory })
  const row = db.getThreadCore(thread)!
  db.updateThread(thread, {
    metadata: JSON.stringify({
      ...JSON.parse(row.metadata!),
      llmFileHistory: { content: "中文😀".repeat(100_000) },
      retained: "original"
    })
  })
  const original = db.getThreadCore(thread)!.metadata
  const full = vi.spyOn(db, "getThreadCore")
  const scoped = vi.spyOn(db, "getThreadRuntimeScope")
  try {
    rememberFunctionPlacedMessage(thread, { id: "visible", role: "assistant", content: "visible" })
    expect(captureFunctionPlacedAnchor(thread)).toMatchObject({ id: "visible" })
    expect(full).not.toHaveBeenCalled()
    expect(scoped).toHaveBeenCalledTimes(2)
    for (const result of scoped.mock.results) {
      expect(result.type).toBe("return")
      expect(result.value?.metadata).not.toContain("llmFileHistory")
      expect(result.value?.metadata).toContain('"retained":"original"')
    }
  } finally {
    full.mockRestore()
    scoped.mockRestore()
    forgetFunctionPlacedCursor(thread)
  }
  expect(db.getThreadCore(thread)!.metadata).toBe(original)
})

it("does not read database scope for messages that cannot create a visible anchor", () => {
  const scoped = vi.spyOn(db, "getThreadRuntimeScope")
  for (const role of ["tool", "system"] as const)
    rememberFunctionPlacedMessage("absent", { id: "hidden", role, content: "" })
  expect(scoped).not.toHaveBeenCalled()
})

it("keeps malformed metadata unchanged and cannot reuse a previously token-bound cursor", () => {
  const thread = randomUUID()
  db.createThread(thread, { workspacePath: directory })
  rememberFunctionPlacedMessage(thread, { id: "old", role: "assistant", content: "old" })
  db.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", ["{broken", thread])
  expect(db.getThreadRuntimeScope(thread)!.metadata).toBe("{broken")
  expect(captureFunctionPlacedAnchor(thread)).toEqual({ kind: "start" })
  expect(db.getThreadCore(thread)!.metadata).toBe("{broken")
  forgetFunctionPlacedCursor(thread)
})

it("never evaluates accessors, inherited fields or proxy traps while observing a queued message", () => {
  const scoped = vi.spyOn(db, "getThreadRuntimeScope")
  let reads = 0
  const inherited = Object.create({
    get content() {
      reads++
      return "late"
    }
  })
  Object.assign(inherited, { id: "inherited", role: "assistant" })
  const accessor = {
    id: "accessor",
    role: "assistant" as const,
    get content() {
      reads++
      return "late"
    }
  }
  const proxy = new Proxy(
    { id: "proxy", role: "assistant" as const, content: "late" },
    {
      get() {
        reads++
        throw Error("PROXY_MUST_NOT_RUN")
      },
      ownKeys() {
        reads++
        throw Error("PROXY_MUST_NOT_RUN")
      },
      getOwnPropertyDescriptor() {
        reads++
        throw Error("PROXY_MUST_NOT_RUN")
      },
      getPrototypeOf() {
        reads++
        throw Error("PROXY_MUST_NOT_RUN")
      }
    }
  )
  const nested = {
    id: "nested",
    role: "assistant" as const,
    content: "late",
    function_row: {
      get origin() {
        reads++
        return {}
      }
    }
  }
  for (const message of [inherited, accessor, proxy, nested])
    rememberFunctionPlacedMessage("absent", message)
  expect(reads).toBe(0)
  expect(scoped).not.toHaveBeenCalled()
})

it("preserves an ordinary empty assistant anchor and skips over-budget transient data", () => {
  const thread = randomUUID()
  db.createThread(thread, { workspacePath: directory })
  rememberFunctionPlacedMessage(thread, { id: "empty", role: "assistant", content: "" })
  expect(captureFunctionPlacedAnchor(thread)).toMatchObject({ id: "empty" })
  const scoped = vi.spyOn(db, "getThreadRuntimeScope")
  rememberFunctionPlacedMessage(thread, {
    id: "large",
    role: "assistant",
    content: Array.from({ length: 129 }, () => ({ type: "text" as const, text: "bounded" }))
  })
  expect(scoped).not.toHaveBeenCalled()
  expect(captureFunctionPlacedAnchor(thread)).toMatchObject({ id: "empty" })
  forgetFunctionPlacedCursor(thread)
})
