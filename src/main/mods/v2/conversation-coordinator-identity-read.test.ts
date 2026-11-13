import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Preserve actual native dispatch while observing a real indexed read. Installing a spy
// after these methods are captured would correctly disable the path under test.
const identityProbe = vi.hoisted(() => ({
  prepared: undefined as (() => void) | undefined,
  read: undefined as (() => void) | undefined,
  hits: 0,
  rawPrepares: 0,
  indexedReads: 0,
  restore: undefined as (() => void) | undefined
}))
vi.mock("node:sqlite", async importOriginal => {
  const actual = await importOriginal<typeof import("node:sqlite")>()
  const prepareDescriptor = Object.getOwnPropertyDescriptor(actual.DatabaseSync.prototype, "prepare")!
  const getDescriptor = Object.getOwnPropertyDescriptor(actual.StatementSync.prototype, "get")!
  const prepare = actual.DatabaseSync.prototype.prepare
  const queries = new WeakMap<import("node:sqlite").StatementSync, string>()
  const selected = (sql: string | undefined) => !!sql && sql.startsWith("SELECT created_at,") &&
    sql.includes("INDEXED BY idx_threads_runtime_scope_v1")
  Object.defineProperty(actual.DatabaseSync.prototype, "prepare", { ...prepareDescriptor,
    value: function(this: import("node:sqlite").DatabaseSync, sql: string) {
      const statement = Reflect.apply(prepare, this, [sql])
      if (sql === "SELECT created_at, metadata FROM threads WHERE thread_id = ? LIMIT 1")
        identityProbe.rawPrepares++
      queries.set(statement, sql)
      if (selected(sql) && identityProbe.prepared) {
        const callback = identityProbe.prepared
        identityProbe.prepared = undefined
        identityProbe.hits++
        callback()
      }
      return statement
    } })
  Object.defineProperty(actual.StatementSync.prototype, "get", { ...getDescriptor,
    value: function(this: import("node:sqlite").StatementSync, ...args: unknown[]) {
      const row = Reflect.apply(getDescriptor.value, this, args)
      if (selected(queries.get(this))) identityProbe.indexedReads++
      if (selected(queries.get(this)) && identityProbe.read) {
        const callback = identityProbe.read
        identityProbe.read = undefined
        identityProbe.hits++
        callback()
      }
      return row
    } })
  identityProbe.restore = () => {
    Object.defineProperty(actual.DatabaseSync.prototype, "prepare", prepareDescriptor)
    Object.defineProperty(actual.StatementSync.prototype, "get", getDescriptor)
  }
  return actual
})
afterAll(() => identityProbe.restore?.())

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as appDb from "../../db"
import * as identityReads from "../../db/function-conversation-thread-identity-read"
import * as incarnations from "../../services/thread-incarnation"
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
  identityProbe.prepared = undefined
  identityProbe.read = undefined
  identityProbe.hits = 0
  identityProbe.rawPrepares = 0
  identityProbe.indexedReads = 0
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
  function largeHistory(f: ReturnType<typeof fixture>) {
    const metadata = JSON.stringify({ ...JSON.parse(f.thread.metadata ?? "{}"),
      llmFileHistory: "完整文件历史".repeat(20000) })
    appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", [metadata, f.threadId])
    return metadata
  }

  it.each([
    ["delete", false], ["recreate", false], ["delete", true], ["recreate", true]
  ] as const)("rejects source-callback %s through an actual indexed read (warm %s)", async (mode, warm) => {
    const f = fixture()
    largeHistory(f)
    let mutate = !warm, calls = 0
    const callback = () => {
      calls++
      if (!mutate) return
      if (mode === "recreate") f.replace()
      else appDb.getDb().run("DELETE FROM threads WHERE thread_id=?", [f.threadId])
    }
    const runtime = warm ? await f.prepare(callback) : undefined
    const beforeReads = identityProbe.indexedReads
    const beforeRawPrepares = identityProbe.rawPrepares
    const beforeCalls = calls
    mutate = true
    if (warm) {
      if (!runtime) throw Error("Actual native runtime required")
      expect(() => runtime.assertCurrent()).toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    } else await expect(f.prepare(callback)).rejects.toThrow("MODS_CONVERSATION_THREAD_CHANGED")
    expect(calls).toBe(beforeCalls + 1)
    expect(identityProbe.indexedReads).toBe(beforeReads + 1)
    expect(identityProbe.rawPrepares).toBe(beforeRawPrepares)
    if (mode === "recreate") expect(appDb.getThreadCore(f.threadId)?.created_at).toBe(f.thread.created_at)
  })

  it.each(["raw", "matcher"] as const)(
    "retains complete input for a replaced %s binding after native preparation",
    async kind => {
      const f = fixture(), metadata = largeHistory(f)
      const runtime = await f.prepare()
      if (!runtime) throw Error("Actual native runtime required")
      const rows: Array<string | null | undefined> = []
      if (kind === "raw") {
        const original = identityReads.readFunctionConversationThreadIdentityCurrent
        vi.spyOn(identityReads, "readFunctionConversationThreadIdentityCurrent").mockImplementation((db, id) => {
          const row = original(db, id)
          rows.push(row?.metadata)
          return row
        })
      } else {
        const original = incarnations.matchesThreadIncarnation
        vi.spyOn(incarnations, "matchesThreadIncarnation").mockImplementation((row, expected) => {
          rows.push(row?.metadata)
          return original(row, expected)
        })
      }
      runtime.assertCurrent()
      expect(rows).toEqual([metadata])
    }
  )

  it.each(["raw", "matcher"] as const)(
    "rereads complete public input when %s changes during an actual indexed get",
    async kind => {
      const f = fixture(), metadata = largeHistory(f)
      const runtime = await f.prepare()
      if (!runtime) throw Error("Actual native runtime required")
      const rows: Array<string | null | undefined> = []
      identityProbe.read = () => {
        if (kind === "raw") {
          const original = identityReads.readFunctionConversationThreadIdentityCurrent
          vi.spyOn(identityReads, "readFunctionConversationThreadIdentityCurrent").mockImplementation((db, id) => {
            const row = original(db, id)
            rows.push(row?.metadata)
            return row
          })
        } else {
          const original = incarnations.matchesThreadIncarnation
          vi.spyOn(incarnations, "matchesThreadIncarnation").mockImplementation((row, expected) => {
            rows.push(row?.metadata)
            return original(row, expected)
          })
        }
      }
      runtime.assertCurrent()
      expect(identityProbe.hits).toBe(1)
      expect(rows).toEqual([metadata])
    }
  )

  it.each(["prepared", "read"] as const)(
    "keeps bounded captured interpretation after a late parser change during native %s",
    phase => {
      const f = fixture(), metadata = largeHistory(f)
      const expected = incarnations.captureThreadIncarnation(f.thread)
      let metadataParses = 0
      identityProbe[phase] = () => {
        const original = JSON.parse
        vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
          metadataParses++
          return original(text, reviver)
        })
      }
      const row = identityReads.readFunctionConversationThreadIncarnationCurrent(appDb.getDb(), f.threadId)
      expect(identityProbe.hits).toBe(1)
      expect(row?.metadata).toBe(f.thread.metadata)
      expect(row?.metadata?.length).toBeLessThan(metadata.length)
      expect(incarnations.matchesThreadIncarnation(row, expected)).toBe(true)
      expect(metadataParses).toBe(0)
      appDb.getDb().run("UPDATE threads SET metadata=? WHERE thread_id=?", [
        JSON.stringify({ cmb_thread_incarnation: "actual-replacement" }), f.threadId
      ])
      const replaced = identityReads.readFunctionConversationThreadIncarnationCurrent(appDb.getDb(), f.threadId)
      expect(incarnations.matchesThreadIncarnation(replaced, expected)).toBe(false)
      expect(metadataParses).toBe(0)
    }
  )

  it("keeps a failed nested temporary reader from deleting the outer raw cache or busy marker", () => {
    const f = fixture(), metadata = largeHistory(f), database = appDb.getDb()
    expect(identityReads.readFunctionConversationThreadIdentityCurrent(database, f.threadId)?.metadata).toBe(metadata)
    const rawPrepares = identityProbe.rawPrepares
    let rejected = false, reason: unknown = "not caught"
    identityProbe.prepared = () => {
      const factory = vi.spyOn(database, "prepareReadOne").mockImplementation(() => () => { throw undefined })
      try { identityReads.readFunctionConversationThreadIncarnationCurrent(database, f.threadId) }
      catch (error) { rejected = true; reason = error }
      finally { factory.mockRestore() }
    }
    const row = identityReads.readFunctionConversationThreadIncarnationCurrent(database, f.threadId)
    expect(identityProbe.hits).toBe(1)
    expect(rejected).toBe(true)
    expect(reason).toBeUndefined()
    expect(row?.metadata).not.toBe(metadata)
    expect(identityReads.readFunctionConversationThreadIdentityCurrent(database, f.threadId)?.metadata).toBe(metadata)
    expect(identityProbe.rawPrepares).toBe(rawPrepares)
    expect(identityReads.readFunctionConversationThreadIncarnationCurrent(database, f.threadId)).toEqual(row)
  })

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
