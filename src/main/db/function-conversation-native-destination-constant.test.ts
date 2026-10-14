import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as appDb from "./index"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { FunctionConversationStore } from "./function-conversation-store"
import {
  assertFunctionConversationNativeDestinationDataCurrent,
  readFunctionConversationNativeDestination,
  recordFunctionConversationNativeDestinationInTransaction
} from "./function-conversation-native-destination"
import type { NativeSqliteReadOne } from "./native-sqlite-adapter"

let directory = ""
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-destination-constant-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterAll(async () => {
  const failures: unknown[] = []
  try {
    await appDb.closeDatabase()
  } catch (reason) {
    failures.push(reason)
  }
  if (directory) {
    try {
      const within = relative(resolve(tmpdir()), resolve(directory))
      if (!within || within.startsWith("..") || isAbsolute(within))
        throw Error("An actual isolated fixture directory is required")
      rmSync(directory, { recursive: true, force: true })
    } catch (reason) {
      failures.push(reason)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, "Actual destination cleanup failed")
})

describe("fixed native destination comparison data", () => {
  it("rejects changed SQL data even when the retained original mapping row changes with it", () => {
    const database = appDb.getDb(),
      store = new FunctionConversationStore(database)
    const invocationId = randomUUID()
    const physical = appDb.createThread(randomUUID(), { workspacePath: directory })
    const projection = appDb.createThread(randomUUID(), {
      workspacePath: directory,
      isInternalFlowRuntime: true,
      isFunctionConversationProjection: true,
      parentThreadId: physical.thread_id,
      modsAgentRunId: invocationId
    })
    const parent = store.ensureMain(
      {
        threadId: physical.thread_id,
        workspace: directory,
        incarnation: captureThreadIncarnation(physical),
        checkpointNamespace: ""
      },
      () => {
        /* This isolated data regression has no external Source to revoke. */
      }
    )
    let sourceCalls = 0
    const guard = () => {
      sourceCalls++
    }
    const input = {
      parent,
      invocationId,
      checkpointThreadId: physical.thread_id,
      checkpointIncarnation: captureThreadIncarnation(physical),
      destinationThreadId: projection.thread_id,
      destinationIncarnation: captureThreadIncarnation(projection),
      originalMetadata: projection.metadata ?? "",
      assertCurrent: guard
    }
    const child = store.createChild(
      parent,
      { invocationId, checkpointNamespace: `actual-fixed:${randomUUID()}` },
      guard,
      (actual) => recordFunctionConversationNativeDestinationInTransaction(database, actual, input)
    )
    database.run(
      "ALTER TABLE function_conversation_native_destinations ADD COLUMN retained_extra TEXT"
    )
    const originalValue = JSON.stringify({ body: '完整🙂\u0000\n"\\'.repeat(256) })
    database.run("UPDATE function_conversation_native_destinations SET retained_extra=?", [
      originalValue
    ])
    const prepare = database.prepareReadOne.bind(database)
    const retained: { row: ReturnType<NativeSqliteReadOne> } = { row: undefined }
    const observer = vi.spyOn(database, "prepareReadOne").mockImplementation((sql) => {
      const read = prepare(sql)
      return (bindings) => {
        const row = read(bindings)
        if (
          sql ===
          "SELECT * FROM function_conversation_native_destinations WHERE conversation_id=? AND branch_id=?"
        )
          retained.row = row
        return row
      }
    })
    try {
      const beforeCapture = sourceCalls
      const destination = readFunctionConversationNativeDestination(database, child, parent, guard)
      expect(sourceCalls).toBe(beforeCapture + 2)
      const originalRow = retained.row
      if (!originalRow) throw Error("The original actual mapping row is required")
      expect(originalRow.retained_extra).toBe(originalValue)
      const changed = JSON.stringify({ body: "完整新内容🙂" })
      originalRow.retained_extra = changed
      database.run("UPDATE function_conversation_native_destinations SET retained_extra=?", [
        changed
      ])
      expect(
        database.prepareReadOne(
          "SELECT retained_extra FROM function_conversation_native_destinations"
        )([])
      ).toEqual({ retained_extra: changed })
      const beforeCurrent = sourceCalls
      expect(() => destination.assertCurrent()).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
      expect(sourceCalls).toBe(beforeCurrent + 1)
      expect(() =>
        assertFunctionConversationNativeDestinationDataCurrent(destination, database)
      ).toThrow("MODS_CONVERSATION_DESTINATION_CHANGED")
      expect(sourceCalls).toBe(beforeCurrent + 1)
    } finally {
      observer.mockRestore()
    }
  })
})
