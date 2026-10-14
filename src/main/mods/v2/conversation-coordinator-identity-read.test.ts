import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as appDb from "../../db"
import { FunctionConversationStore } from "../../db/function-conversation-store"
import { ModRuntimeAuthorities } from "../runtime-instance"
import {
  FunctionConversationCoordinator,
  type FunctionConversationCoordinatorHost
} from "./conversation-coordinator"
import type { FunctionConversationOwnerContext } from "./session-conversation-host"
import { projectFunctionSessionApiMessages } from "./session-api-transcript"

const QUERY = "SELECT created_at, metadata FROM threads WHERE thread_id = ? LIMIT 1"
let directory = ""
const owners: Array<() => void> = []

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-coordinator-identity-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})

afterEach(async () => {
  const failures: unknown[] = []
  for (const close of owners.splice(0)) {
    try {
      close()
    } catch (reason) {
      failures.push(reason)
    }
  }
  vi.restoreAllMocks()
  try {
    await appDb.closeDatabase()
  } catch (reason) {
    failures.push(reason)
  }
  try {
    const within = relative(resolve(tmpdir()), resolve(directory))
    if (!within || within.startsWith("..") || resolve(directory) === resolve(tmpdir()))
      throw Error("Actual isolated fixture path required")
    rmSync(directory, { recursive: true, force: true })
  } catch (reason) {
    failures.push(reason)
  }
  if (failures.length) throw new AggregateError(failures, "Actual identity fixture cleanup failed")
})

function fixture(readCheckpoint?: FunctionConversationCoordinatorHost["readCurrentCheckpoint"]) {
  const threadId = randomUUID(),
    workspace = "C:/coordinator-identity-workspace"
  const thread = appDb.createThread(threadId, {
    workspacePath: workspace,
    complete: '完整🙂\u0000\n"\\'.repeat(4000)
  })
  const context: FunctionConversationOwnerContext = {
    owner: {},
    workspace,
    threadId,
    signal: new AbortController().signal,
    readOnly: false,
    assertCurrent: () => {
      /* This fixture has no separate Guest lifecycle. */
    }
  }
  const coordinator = new FunctionConversationCoordinator(
    new FunctionConversationStore(appDb.getDb()),
    {
      authorities: new ModRuntimeAuthorities(),
      assertScope: () => {
        /* The fixture owns this isolated workspace. */
      },
      readCurrentCheckpoint:
        readCheckpoint ??
        (async (_id, signal, guard) => {
          signal.throwIfAborted()
          guard()
          return null
        }),
      protect: async (_context, value, signal, guard) => {
        signal.throwIfAborted()
        guard()
        return value
      },
      apiMessages: projectFunctionSessionApiMessages,
      changed: () => {
        /* No renderer is mounted in this actual DB regression. */
      }
    }
  )
  owners.push(coordinator.openConversationOwner(context))
  const prepare = (
    guard = () => {
      /* Native source remains live unless a test changes it. */
    }
  ) => coordinator.prepareNativeRuntime(workspace, threadId, context.signal, guard)
  const replace = () => {
    appDb.getDb().run("DELETE FROM threads WHERE thread_id = ?", [threadId])
    appDb.createThread(threadId, { workspacePath: workspace })
    appDb
      .getDb()
      .run("UPDATE threads SET created_at = ? WHERE thread_id = ?", [thread.created_at, threadId])
  }
  return { threadId, thread, prepare, replace }
}

function observeIdentity() {
  const database = appDb.getDb(),
    prepare = database.prepareReadOne.bind(database)
  const rows: unknown[] = []
  const failure: { active: boolean; reason: unknown } = { active: false, reason: undefined }
  vi.spyOn(database, "prepareReadOne").mockImplementation((sql) => {
    const read = prepare(sql)
    if (sql !== QUERY) return read
    return (bindings) => {
      const row = read(bindings)
      rows.push(row)
      if (failure.active) throw failure.reason
      return row
    }
  })
  return { rows, failure }
}

describe("native Coordinator fresh identity guard", () => {
  it("keeps complete metadata fresh and the public six-field thread shape", async () => {
    const f = fixture(),
      observation = observeIdentity()
    const runtime = await f.prepare()
    if (!runtime) throw Error("Actual native runtime required")
    expect(observation.rows.length).toBeGreaterThan(0)
    expect(
      observation.rows.every(
        (row) =>
          JSON.stringify(row) ===
          JSON.stringify({
            created_at: f.thread.created_at,
            metadata: f.thread.metadata
          })
      )
    ).toBe(true)
    const complete = appDb.getThreadCore(f.threadId)
    expect(Object.keys(complete ?? {})).toEqual([
      "thread_id",
      "created_at",
      "updated_at",
      "metadata",
      "status",
      "title"
    ])
    const metadata = JSON.stringify({
      ...JSON.parse(f.thread.metadata ?? "{}"),
      latest: "完整新内容"
    })
    appDb.getDb().run("UPDATE threads SET metadata = ? WHERE thread_id = ?", [metadata, f.threadId])
    const before = observation.rows.length
    runtime.assertCurrent()
    expect(observation.rows.length).toBe(before + 1)
    expect(observation.rows.at(-1)).toEqual({ created_at: f.thread.created_at, metadata })
  })

  it.each(["delete", "recreate"])(
    "rejects %s immediately after the original source callback",
    async (mode) => {
      const f = fixture(),
        observation = observeIdentity()
      let calls = 0
      await expect(
        f.prepare(() => {
          calls++
          if (mode === "recreate") f.replace()
          else appDb.getDb().run("DELETE FROM threads WHERE thread_id = ?", [f.threadId])
        })
      ).rejects.toThrow("MODS_CONVERSATION_THREAD_CHANGED")
      expect(calls).toBe(1)
      expect(observation.rows).toHaveLength(1)
      if (mode === "delete") expect(observation.rows[0]).toBeUndefined()
      else expect(appDb.getThreadCore(f.threadId)?.created_at).toBe(f.thread.created_at)
    }
  )

  it("rejects a same-millisecond replacement across the actual checkpoint await", async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const f = fixture(async (_id, signal, guard) => {
      signal.throwIfAborted()
      guard()
      entered.resolve()
      await release.promise
      return null
    })
    const observation = observeIdentity(),
      preparing = f.prepare()
    try {
      await entered.promise
      const before = observation.rows.length
      f.replace()
      release.resolve()
      await expect(preparing).rejects.toThrow("MODS_CONVERSATION_THREAD_CHANGED")
      expect(observation.rows.length).toBe(before + 1)
      expect(appDb.getThreadCore(f.threadId)?.created_at).toBe(f.thread.created_at)
    } finally {
      release.resolve()
      await Promise.allSettled([preparing])
    }
  })

  it.each([new Error("ACTUAL_IDENTITY_READ_REJECTED"), undefined])(
    "preserves the actual identity reader rejection %s and permits a new fresh read",
    async (reason) => {
      const f = fixture(),
        observation = observeIdentity()
      observation.failure.active = true
      observation.failure.reason = reason
      expect(await Promise.allSettled([f.prepare()])).toEqual([{ status: "rejected", reason }])
      expect(observation.rows).toHaveLength(1)
      observation.failure.active = false
      const runtime = await f.prepare()
      if (!runtime) throw Error("A new actual native runtime is required after reader recovery")
      const before = observation.rows.length
      runtime.assertCurrent()
      expect(observation.rows.length).toBe(before + 1)
    }
  )
})
