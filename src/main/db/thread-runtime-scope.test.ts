import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import { resolveCapabilityContext } from "../mods/capability-context"
import { resolveClawThread } from "../mods/claw-scope"

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
