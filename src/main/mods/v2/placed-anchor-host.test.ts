import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, it, vi } from "vitest"

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
