import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { resolveCapabilityContext } from "../mods/capability-context"
import { resolveClawThread } from "../mods/claw-scope"
import { withHostRuntimeTiming } from "../services/host-runtime-timing"
import { denyFunctionConversationForkReady } from "./function-conversation-fork-gate"

const paths = vi.hoisted(() => ({ database: "" }))
vi.mock("../storage", () => ({
  getDbPath: () => paths.database,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
import * as appDb from "./index"

let directory = ""
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-runtime-scope-"))
  paths.database = join(directory, "actual.sqlite")
  await appDb.initializeDatabase()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await appDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})
function insert(metadata: string | null, id = randomUUID()) {
  appDb
    .getDb()
    .run(
      "INSERT INTO threads(thread_id,created_at,updated_at,metadata,status,title) VALUES(?,?,?,?,?,?)",
      [id, 100, 200, metadata, "idle", "Original title"]
    )
  return id
}
function update(id: string, metadata: unknown) {
  appDb
    .getDb()
    .run("UPDATE threads SET metadata=? WHERE thread_id=?", [JSON.stringify(metadata), id])
}
function context(id: string, read = appDb.getThreadRuntimeScope) {
  return resolveCapabilityContext(directory, id, {
    thread: read,
    projectWorkspaces: () => undefined,
    hostProject: (_id, _workspace, binding) =>
      (binding as { projectId?: string }).projectId === "original-project"
  })
}

describe("fresh read-only thread runtime scope projection", () => {
  it("keeps large-history display fences current after fork denial and same-ID recreation", () => {
    const raw = JSON.stringify({ cmb_thread_incarnation: "original", llmFileHistory: "x".repeat(5 * 1024 * 1024) })
    const id = insert(raw), database = appDb.getDb()
    const target = { threadId: id, incarnation: captureThreadIncarnation(appDb.getThreadCore(id)!) }
    expect(appDb.withCanonicalThreadMessageReadScope(id, () => "ready")).toBe("ready")
    expect(() => appDb.withCanonicalThreadMessageReadScope(id, reader => {
      reader.runGuard(() => denyFunctionConversationForkReady(database, target))
      return "must not publish"
    })).toThrow("MODS_CONVERSATION_FORK_PREPARING")
    expect(appDb.getThreadCore(id)?.metadata).toBe(raw)
    database.run("DELETE FROM threads WHERE thread_id=?", [id])
    insert('{"cmb_thread_incarnation":"replacement"}', id)
    expect(appDb.withCanonicalThreadMessageReadScope(id, () => "replacement")).toBe("replacement")
  })

  it("preserves the full metadata interpreter at the ordinary writer's fork gate", () => {
    const raw = JSON.stringify({ cmb_thread_incarnation: "stored", llmFileHistory: "x".repeat(50000) })
    const id = insert(raw), parse = JSON.parse
    denyFunctionConversationForkReady(appDb.getDb(), {
      threadId: id, incarnation: { token: "custom-interpreter", legacyCreatedAt: 100 }
    })
    vi.spyOn(JSON, "parse").mockImplementation((value: string) => value === raw
      ? { cmb_thread_incarnation: "custom-interpreter" } : parse(value))
    expect(() => appDb.upsertThreadMessages(id, [{ id: randomUUID(), role: "user",
      content: "must not write", created_at: new Date(100) }]))
      .toThrow("MODS_CONVERSATION_FORK_PREPARING")
  })

  it("preserves a cached custom core reader at the ordinary writer's fork gate", () => {
    const raw = JSON.stringify({ cmb_thread_incarnation: "stored", llmFileHistory: "x".repeat(50000) })
    const id = insert(raw), database = appDb.getDb(), prepare = database.prepareReadOne.bind(database)
    const custom = JSON.stringify({ cmb_thread_incarnation: "custom-reader" })
    const factory = vi.spyOn(database, "prepareReadOne").mockImplementation(sql => {
      const read = prepare(sql)
      return bindings => {
        const row = read(bindings)
        return row && sql.includes("SELECT thread_id, created_at, updated_at, metadata")
          ? { ...row, metadata: custom } : row
      }
    })
    expect(appDb.getThreadCore(id)?.metadata).toBe(custom)
    factory.mockRestore()
    denyFunctionConversationForkReady(database, {
      threadId: id, incarnation: { token: "custom-reader", legacyCreatedAt: 100 }
    })
    expect(() => appDb.upsertThreadMessages(id, [{ id: randomUUID(), role: "assistant",
      content: "must not write", created_at: new Date(100) }]))
      .toThrow("MODS_CONVERSATION_FORK_PREPARING")
  })

  it.each([1, 2])("keeps full metadata if timing callback %s changes its interpreter", turn => {
    const raw = JSON.stringify({ cmb_thread_incarnation: "kept", llmFileHistory: "x".repeat(50000) })
    const id = insert(raw), parse = JSON.parse, now = performance.now.bind(performance)
    let calls = 0
    vi.spyOn(performance, "now").mockImplementation(() => {
      if (++calls === turn) JSON.parse = ((value: string) => value === raw
        ? { cmb_thread_incarnation: "custom-interpreter" } : parse(value)) as typeof JSON.parse
      return now()
    })
    try {
      const identity = withHostRuntimeTiming(() => appDb.getThreadCanonicalIdentity(id))!
      expect(identity.metadata).toBe(raw)
      expect(captureThreadIncarnation(identity).token).toBe("custom-interpreter")
    } finally { JSON.parse = parse }
  })

  it("keeps the original core reader when prepare's regexp callback changes interpretation", () => {
    const raw = JSON.stringify({ cmb_thread_incarnation: "kept", llmFileHistory: "x".repeat(50000) })
    const id = insert(raw), parse = JSON.parse, test = RegExp.prototype.test
    let changed = false
    vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, value: string) {
      if (!changed && value.includes("SELECT thread_id, created_at, updated_at, metadata")) {
        changed = true
        JSON.parse = ((text: string) => text === raw
          ? { cmb_thread_incarnation: "prepare-interpreter" } : parse(text)) as typeof JSON.parse
      }
      return Reflect.apply(test, this, [value])
    })
    try {
      const identity = appDb.getThreadCanonicalIdentity(id)!
      expect(changed).toBe(true)
      expect(identity.metadata).toBe(raw)
      expect(captureThreadIncarnation(identity).token).toBe("prepare-interpreter")
    } finally { JSON.parse = parse }
  })

  it("preserves canonical identity for duplicate keys, non-TEXT metadata and legacy timestamps", () => {
    const id = insert(null)
    const cases = [null, "{broken", "null", "[]", "42", "{}",
      '{"cmb_thread_incarnation":null,"llmFileHistory":"large"}',
      '{"cmb_thread_incarnation":"first","cmb_thread_incarnation":"last","llmFileHistory":1}',
      '{"cmb_thread_incarnation":"first","cmb_thread_incarnation":null,"llmFileHistory":1}',
      '{"llmFileHistory":1,"llmFileHistory":2,"cmb_thread_incarnation":"last"}',
      '{"cmb_thread_incarnation":"\\ud800","llmFileHistory":1}',
      new Uint8Array(Buffer.from('{"cmb_thread_incarnation":"blob-token","llmFileHistory":1}')),
      new Uint8Array([0, 1, 255]), 123]
    for (const metadata of cases) {
      appDb.getDb().run("UPDATE threads SET metadata=?,created_at=100 WHERE thread_id=?", [metadata, id])
      const full = appDb.getThreadCore(id)!, identity = appDb.getThreadCanonicalIdentity(id)!
      const expected = captureThreadIncarnation(full)
      expect(captureThreadIncarnation(identity)).toEqual(expected)
      expect(matchesThreadIncarnation(identity, expected)).toBe(true)
      if (typeof full.metadata !== "string") expect(identity.metadata).toEqual(full.metadata)
      appDb.getDb().run("UPDATE threads SET created_at=101 WHERE thread_id=?", [id])
      expect(matchesThreadIncarnation(appDb.getThreadCanonicalIdentity(id), expected))
        .toBe(matchesThreadIncarnation(appDb.getThreadCore(id), expected))
    }
  })

  it("returns the full original input when the metadata interpreter is overridden", () => {
    const raw = JSON.stringify({ cmb_thread_incarnation: "kept", llmFileHistory: "x".repeat(50000) })
    const id = insert(raw), original = JSON.parse
    const parse = vi.spyOn(JSON, "parse").mockImplementation((value: string) => {
      const result = original(value)
      if (value === raw) return { ...result, cmb_thread_incarnation: "custom-interpreter" }
      return result
    })
    const identity = appDb.getThreadCanonicalIdentity(id)!
    expect(identity.metadata).toBe(raw)
    expect(captureThreadIncarnation(identity).token).toBe("custom-interpreter")
    expect(parse).toHaveBeenCalledWith(raw)
  })

  it("keeps a cached custom core reader after its public factory is restored", () => {
    const raw = JSON.stringify({ cmb_thread_incarnation: "kept", llmFileHistory: "x".repeat(50000) })
    const id = insert(raw), database = appDb.getDb(), prepare = database.prepareReadOne.bind(database)
    let reads = 0
    const wrapped = vi.spyOn(database, "prepareReadOne").mockImplementation(sql => {
      const read = prepare(sql)
      return bindings => { reads++; return read(bindings) }
    })
    expect(appDb.getThreadCore(id)?.metadata).toBe(raw)
    wrapped.mockRestore()
    const before = reads
    expect(appDb.getThreadCanonicalIdentity(id)?.metadata).toBe(raw)
    expect(reads).toBe(before + 1)
  })

  it("keeps canonical identity fresh after large history changes and same-ID recreation", () => {
    const raw = JSON.stringify({ cmb_thread_incarnation: "kept", llmFileHistory: "x".repeat(100000) })
    const id = insert(raw)
    const identity = appDb.getThreadCanonicalIdentity(id)!
    expect(identity.metadata!.length).toBeLessThan(100)
    const expected = captureThreadIncarnation(identity)
    update(id, { cmb_thread_incarnation: "kept", llmFileHistory: "changed".repeat(100000) })
    expect(matchesThreadIncarnation(appDb.getThreadCanonicalIdentity(id), expected)).toBe(true)
    appDb.getDb().run("DELETE FROM threads WHERE thread_id=?", [id])
    expect(appDb.getThreadCanonicalIdentity(id)).toBeNull()
    insert('{"cmb_thread_incarnation":"replacement"}', id)
    expect(matchesThreadIncarnation(appDb.getThreadCanonicalIdentity(id), expected)).toBe(false)
  })

  it("omits only top-level history while preserving complete scope values and the original persisted bytes", () => {
    const history = { adopted: "x".repeat(1024 * 1024) }
    const metadata = {
      cmb_thread_incarnation: randomUUID(),
      workspacePath: directory,
      llmFileHistory: history,
      llmModifiedFiles: ["retained"],
      llmRecentlyRevertedFiles: [],
      remoteState: "historical",
      targetKind: "inbox",
      remoteReadOnly: true,
      nested: { llmFileHistory: "must remain", explicitNull: null },
      extra: [false, 0, ""],
      hostProjectRuntime: {
        projectId: "original-project",
        operationId: "operation",
        stageId: "stage"
      }
    }
    const raw = JSON.stringify(metadata),
      id = insert(raw)
    const full = appDb.getThreadCore(id)!,
      scope = appDb.getThreadRuntimeScope(id)!
    const { llmFileHistory: omitted, ...remaining } = metadata
    expect(omitted).toBe(history)
    expect(JSON.parse(scope.metadata!)).toEqual(remaining)
    expect({ ...scope, metadata: null }).toEqual({ ...full, metadata: null })
    expect(scope.metadata!.length).toBeLessThan(2000)
    expect(context(id)).toEqual(context(id, appDb.getThreadCore))
    expect(captureThreadIncarnation(scope)).toEqual(captureThreadIncarnation(full))
    expect(appDb.getThreadCore(id)!.metadata).toBe(raw)
  })

  it.each(["{broken", "[]", "null", "42", null])(
    "retains malformed or non-object metadata rejection for %s",
    (raw) => {
      const id = insert(raw)
      expect(appDb.getThreadRuntimeScope(id)?.metadata).toBe(raw)
      expect(() => context(id)).toThrow()
      expect(() => context(id, appDb.getThreadCore)).toThrow()
      expect(appDb.getThreadCore(id)?.metadata).toBe(raw)
    }
  )

  it("observes parent-chain identity, workspace, binding revocation and delete/recreate on every read", () => {
    const parentMetadata = {
      cmb_thread_incarnation: randomUUID(),
      workspacePath: directory,
      hostProjectRuntime: { projectId: "original-project", operationId: "operation" },
      llmFileHistory: { old: "x".repeat(50000) }
    }
    const parent = insert(JSON.stringify(parentMetadata))
    const child = insert(
      JSON.stringify({
        cmb_thread_incarnation: randomUUID(),
        workspacePath: directory,
        isInternalFlowRuntime: true,
        parentThreadId: parent
      })
    )
    const original = context(child),
      incarnation = captureThreadIncarnation(appDb.getThreadRuntimeScope(parent)!)
    expect(original).toEqual(context(child, appDb.getThreadCore))
    update(parent, { ...parentMetadata, llmFileHistory: { newer: "y".repeat(100000) } })
    expect(context(child)).toEqual(original)
    update(parent, { ...parentMetadata, hostProjectRuntime: { projectId: "revoked" } })
    expect(() => context(child)).toThrow("CAPABILITY_PROJECT_UNAVAILABLE")
    update(parent, { ...parentMetadata, workspacePath: join(directory, "other") })
    expect(() => context(child)).toThrow("CAPABILITY_CONTEXT_CHANGED")
    appDb.getDb().run("DELETE FROM threads WHERE thread_id=?", [parent])
    expect(appDb.getThreadRuntimeScope(parent)).toBeNull()
    expect(() => context(child)).toThrow("CAPABILITY_CONTEXT_CHANGED")
    insert(JSON.stringify({ ...parentMetadata, cmb_thread_incarnation: randomUUID() }), parent)
    expect(matchesThreadIncarnation(appDb.getThreadRuntimeScope(parent), incarnation)).toBe(false)
    expect(context(child).identity).not.toBe(original.identity)
  })

  it("keeps ordinary Claw parent classification identical and freshly rejects a changed workspace", () => {
    const parent = insert(
      JSON.stringify({
        workspacePath: directory,
        cmb_thread_incarnation: "parent",
        agentMode: "normal",
        llmFileHistory: { records: "large".repeat(10000) }
      })
    )
    const childMetadata = {
      workspacePath: directory,
      isInternalFlowRuntime: true,
      cmb_thread_incarnation: "child",
      parentThreadId: parent
    }
    const child = insert(JSON.stringify(childMetadata))
    expect(resolveClawThread(child, appDb.getThreadRuntimeScope)).toEqual(
      resolveClawThread(child, appDb.getThreadCore)
    )
    expect(resolveClawThread(child, appDb.getThreadRuntimeScope)?.threadId).toBe(parent)
    update(parent, { workspacePath: join(directory, "changed"), agentMode: "normal" })
    expect(() => resolveClawThread(child, appDb.getThreadRuntimeScope)).toThrow(
      "CLAW_PARENT_SCOPE_INVALID"
    )
  })

  it("does not reuse a returned row or scope authorization across database changes", () => {
    const id = insert(JSON.stringify({ workspacePath: directory, cmb_thread_incarnation: "one" }))
    const first = appDb.getThreadRuntimeScope(id)!
    first.metadata = "{}"
    update(id, { workspacePath: "new", cmb_thread_incarnation: "two", remoteReadOnly: true })
    const next = appDb.getThreadRuntimeScope(id)!
    expect(JSON.parse(next.metadata!)).toEqual({
      workspacePath: "new",
      cmb_thread_incarnation: "two",
      remoteReadOnly: true
    })
    expect(next).not.toBe(first)
  })
})
