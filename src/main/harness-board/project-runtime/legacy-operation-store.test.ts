import { copyFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it, vi } from "vitest"
import { LegacyOperationStore, legacyRecoveryRevision } from "./legacy-operation-store"
import { LegacyOptInIndex } from "./legacy-opt-in-index"

it("releases an unreadable ledger on initialization failure so it can be repaired", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-operation-unreadable-"))
  const path = join(root, "operations.sqlite")
  const close = vi.spyOn(DatabaseSync.prototype, "close")
  try {
    writeFileSync(path, Buffer.alloc(8192, 0x5a))
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect(() => new LegacyOperationStore(path)).toThrow(
        expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 26 })
      )
      expect(close).toHaveBeenCalledTimes(attempt)
    }
    renameSync(path, join(root, "unreadable.sqlite"))
    const repaired = new LegacyOperationStore(path)
    try {
      expect(repaired.recoverInterrupted()).toEqual([])
    } finally {
      repaired.close()
    }
  } finally {
    close.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})

it("shares an atomic legacy lease across instances and retains unknown ownership on restart", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-operation-store-"))
  const path = join(root, "operations.sqlite")
  const first = new LegacyOperationStore(path),
    second = new LegacyOperationStore(path)
  try {
    first.enable({
      projectId: "project",
      workspace: root,
      installedPluginId: "installed",
      packageId: "author-name",
      packageVersion: "1",
      mods: null,
      packageDigest: "a".repeat(64)
    })
    const input = {
      projectId: "project",
      featureId: "feature-a",
      workspace: root,
      installedPluginId: "installed",
      packageDigest: "a".repeat(64),
      threadId: "thread",
      threadIncarnation: "incarnation",
      requestId: "request",
      inputDigest: "b".repeat(64)
    }
    const admitted = first.admit(input)
    expect(() => second.admit({ ...input, featureId: "feature-b", requestId: "other" })).toThrow(
      "LEGACY_OPERATION_ACTIVE"
    )
    expect(() => second.settle({}, "succeeded", "normal")).toThrow("LEGACY_TICKET_INVALID")
    expect(second.recoverInterrupted()).toEqual([admitted.operation.operationId])
    expect(second.get(admitted.operation.operationId)?.status).toBe("unknown")
    expect(() => first.admit({ ...input, requestId: "retry" })).toThrow("LEGACY_OPERATION_ACTIVE")
    expect(() => first.settle(admitted.ticket, "succeeded", "late")).toThrow(
      "LEGACY_OPERATION_SETTLED"
    )
  } finally {
    first.close()
    second.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it("does not replay an already settled request and does not label business state validated", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-operation-result-"))
  const store = new LegacyOperationStore(join(root, "operations.sqlite"))
  try {
    store.enable({
      projectId: "project",
      workspace: root,
      installedPluginId: "installed",
      packageId: "author-name",
      packageVersion: "1",
      mods: null,
      packageDigest: "a".repeat(64)
    })
    const input = {
      projectId: "project",
      featureId: "feature",
      workspace: root,
      installedPluginId: "installed",
      packageDigest: "a".repeat(64),
      threadId: "thread",
      threadIncarnation: "incarnation",
      requestId: "request",
      inputDigest: "b".repeat(64)
    }
    const admitted = store.admit(input)
    expect(store.settle(admitted.ticket, "succeeded", "normal")).toMatchObject({
      status: "succeeded",
      businessStateValidity: "unknown"
    })
    expect(() => store.admit(input)).toThrow("LEGACY_OPERATION_ALREADY_RECORDED")
    expect(store.admit({ ...input, requestId: "explicit-next" }).operation.status).toBe("started")
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function retainedProject(projectId: string, workspace: string) {
  return {
    projectId, workspace, installedPluginId: "installed", packageId: "fixture",
    packageVersion: "1", packageDigest: "a".repeat(64), mods: null
  }
}

function indexedProjects(index: LegacyOptInIndex) {
  return new Set(index.read()?.keys())
}

it("migrates old bindings and only removes markers after a durable disable", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-index-migration-"))
  const path = join(root, "operations.sqlite")
  const index = new LegacyOptInIndex(join(root, "bindings.sqlite"))
  const old = new LegacyOperationStore(path)
  const original = retainedProject("old", root)
  try {
    old.enable(original)
    expect(index.read()).toBeUndefined()
  } finally { old.close() }
  const first = new LegacyOperationStore(path, undefined, undefined, undefined, index)
  const second = new LegacyOperationStore(path, undefined, undefined, undefined, index)
  try {
    first.refreshOptInIndex()
    expect(indexedProjects(index)).toEqual(new Set(["old"]))
    const refresh = first.refreshOptInIndex.bind(first)
    vi.spyOn(first, "refreshOptInIndex").mockImplementationOnce(() => {
      expect(first.getBinding("old")).toBeUndefined()
      expect(() => second.enable(original)).toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      second.enable(retainedProject("parallel", join(root, "other")))
      second.enable(original)
      refresh()
    })
    first.disable("old")
    expect(indexedProjects(index)).toEqual(new Set(["old", "parallel"]))
    first.disable("old")
    expect(indexedProjects(index)).toEqual(new Set(["parallel"]))
  } finally {
    first.close()
    second.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it("treats existing empty or unrelated SQLite files as unavailable without overwriting the index", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-index-damaged-"))
  const path = join(root, "operations.sqlite")
  const index = new LegacyOptInIndex(join(root, "bindings.sqlite"))
  try {
    writeFileSync(path, "")
    expect(index.read()).toBeUndefined()
    expect(() => new LegacyOperationStore(path, undefined, undefined, undefined, index))
      .toThrow("LEGACY_LEDGER_INVALID")
    const unrelated = new DatabaseSync(path)
    unrelated.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)")
    unrelated.close()
    index.write(new Map([["retained", "fixture-generation"]]))
    expect(() => new LegacyOperationStore(path, undefined, undefined, undefined, index))
      .toThrow("LEGACY_LEDGER_INVALID")
    expect(indexedProjects(index)).toEqual(new Set(["retained"]))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("failure after writing a positive marker retains protection across a healthy ledger refresh", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-index-rollback-"))
  const index = new LegacyOptInIndex(join(root, "bindings.sqlite"))
  const path = join(root, "operations.sqlite")
  const store = new LegacyOperationStore(path, undefined, undefined, undefined, index)
  const peer = new LegacyOperationStore(path, undefined, undefined, undefined, index)
  try {
    store.refreshOptInIndex()
    expect(peer.protectsProject("rolled-back")).toBe(false)
    const write = index.write.bind(index)
    vi.spyOn(index, "write").mockImplementationOnce((ids) => {
      write(ids)
      throw Error("synthetic failure after marker publication")
    })
    expect(() => store.enable(retainedProject("rolled-back", root))).toThrow("synthetic failure")
    expect(store.getBinding("rolled-back")).toBeUndefined()
    expect(peer.getBinding("rolled-back")).toBeUndefined()
    expect(peer.protectsProject("rolled-back")).toBe(true)
    expect(indexedProjects(index)).toEqual(new Set(["rolled-back"]))
    store.refreshOptInIndex()
    expect(store.protectsProject("rolled-back")).toBe(true)
    expect(indexedProjects(index)).toEqual(new Set(["rolled-back"]))
  } finally {
    peer.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it("preserves positive evidence when the ledger is restored from a valid older backup", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-index-older-ledger-"))
  const path = join(root, "operations.sqlite")
  const index = new LegacyOptInIndex(join(root, "bindings.sqlite"))
  const backup = join(root, "backup.sqlite")
  let store: LegacyOperationStore | undefined
  try {
    new LegacyOperationStore(backup).close()
    store = new LegacyOperationStore(path, undefined, undefined, undefined, index)
    const project = retainedProject("protected", root)
    store.enable(project)
    const restoredWhileOpen = new DatabaseSync(path)
    try { restoredWhileOpen.exec("DELETE FROM legacy_bindings") }
    finally { restoredWhileOpen.close() }
    expect(store.getBinding("protected")).toBeUndefined()
    expect(store.protectsProject("protected")).toBe(true)
    store.close()
    store = undefined
    renameSync(path, join(root, "original-retained.sqlite"))
    renameSync(backup, path)
    store = new LegacyOperationStore(path, undefined, undefined, undefined, index)
    store.refreshOptInIndex()
    expect(store.getBinding("protected")).toBeUndefined()
    expect(store.protectsProject("protected")).toBe(true)
    expect(() => store!.enable(project)).toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
    store.disable("protected")
    expect(indexedProjects(index)).toEqual(new Set(["protected"]))
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it("repairs committed disable after index failure without accepting a receipt from an older opt-in", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-disable-marker-"))
  const path = join(root, "operations.sqlite")
  const index = new LegacyOptInIndex(join(root, "bindings.sqlite"))
  const backup = join(root, "old-disabled.sqlite")
  const project = retainedProject("protected", root)
  const open = () => new LegacyOperationStore(path, undefined, undefined, undefined, index)
  let store: LegacyOperationStore | undefined
  try {
    store = open()
    store.enable(project)
    const oldGeneration = index.read()?.get(project.projectId)
    const warn = vi.spyOn(console, "warn").mockImplementationOnce(() => {})
    vi.spyOn(index, "write").mockImplementationOnce(() => { throw Error("index interrupted") })
    store.disable(project.projectId)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    expect(store.getBinding(project.projectId)).toBeUndefined()
    expect(index.read()?.get(project.projectId)).toBe(oldGeneration)
    store.close()
    store = undefined
    copyFileSync(path, backup)

    store = open()
    store.refreshOptInIndex()
    expect(store.protectsProject(project.projectId)).toBe(false)
    store.disable(project.projectId)
    store.enable(project)
    const newGeneration = index.read()?.get(project.projectId)
    expect(newGeneration).toBeTruthy()
    expect(newGeneration).not.toBe(oldGeneration)
    store.close()
    store = undefined
    renameSync(path, join(root, "new-enabled.sqlite"))
    renameSync(backup, path)

    store = open()
    store.refreshOptInIndex()
    expect(store.getBinding(project.projectId)).toBeUndefined()
    expect(store.protectsProject(project.projectId)).toBe(true)
    expect(index.read()?.get(project.projectId)).toBe(newGeneration)
  } finally {
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(["pre-index", "versioned"] as const)(
  "does not let a restored %s enabled binding adopt or disable another generation",
  (format) => {
    const root = mkdtempSync(join(tmpdir(), "legacy-replaced-enabled-"))
    const path = join(root, "operations.sqlite")
    const backup = join(root, "older-enabled.sqlite")
    const project = retainedProject("project", root)
    const index = new LegacyOptInIndex(join(root, "bindings.sqlite"))
    const open = () => new LegacyOperationStore(path, undefined, undefined, undefined, index)
    let store: LegacyOperationStore | undefined
    try {
      if (format === "versioned") {
        store = open()
        store.enable(project)
        store.close()
        store = undefined
        copyFileSync(path, backup)
        store = open()
        store.disable(project.projectId)
      } else {
        const older = new LegacyOperationStore(backup)
        older.enable(project)
        older.close()
        store = open()
      }
      store.enable(project)
      const currentGeneration = index.read()?.get(project.projectId)
      expect(currentGeneration).toBeTruthy()
      store.close()
      store = undefined
      renameSync(path, join(root, "current-enabled.sqlite"))
      renameSync(backup, path)

      store = open()
      store.refreshOptInIndex()
      expect(() => store!.getBinding(project.projectId)).toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      expect(() => store!.disable(project.projectId)).toThrow("PROJECT_LEGACY_RUNTIME_UNAVAILABLE")
      expect(index.read()?.get(project.projectId)).toBe(currentGeneration)
    } finally {
      store?.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

it("does not recover or release records owned by an observed live external process", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-live-owner-"))
  const path = join(root, "operations.sqlite")
  const first = new LegacyOperationStore(path)
  const second = new LegacyOperationStore(path)
  try {
    const project = retainedProject("project", root)
    first.enable(project)
    const { operation, ticket } = first.admit({
      projectId: project.projectId, workspace: project.workspace, installedPluginId: project.installedPluginId,
      packageDigest: project.packageDigest, featureId: "feature", threadId: "thread", threadIncarnation: "thread",
      requestId: "request", inputDigest: "b".repeat(64),
      owner: { processId: process.pid, incarnation: "different-runtime-owner" }
    })
    expect(second.recoverInterrupted()).toEqual([])
    expect(second.get(operation.operationId)?.status).toBe("started")
    const unknown = first.settle(ticket, "unknown", "not-confirmed")
    const authorize = vi.fn()
    expect(() => second.reconcile({
      projectId: project.projectId, operationId: unknown.operationId, expectedRevision: legacyRecoveryRevision(unknown),
      checkedOriginalResult: true
    }, authorize)).toThrow("LEGACY_OPERATION_ACTIVE")
    expect(authorize).not.toHaveBeenCalled()
  } finally {
    first.close()
    second.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it("guards every root and execution workspace pair across old projects sharing the installed plugin", () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-workspace-claims-"))
  const path = join(root, "operations.sqlite")
  const first = new LegacyOperationStore(path)
  const second = new LegacyOperationStore(path)
  const project = retainedProject("first", join(root, "root"))
  const executionWorkspace = join(root, "execution")
  const input = {
    projectId: project.projectId, workspace: project.workspace, installedPluginId: project.installedPluginId,
    packageDigest: project.packageDigest, featureId: "feature", executionWorkspace, threadId: "thread",
    threadIncarnation: "first", requestId: "request", inputDigest: "b".repeat(64)
  }
  const admitOther = (nextProjectId: string, workspace: string, execution: string) => {
    const other = retainedProject(nextProjectId, workspace)
    second.enable(other)
    return second.admit({ ...input, projectId: other.projectId, workspace: other.workspace,
      executionWorkspace: execution })
  }
  try {
    first.enable(project)
    const firstOperation = first.admit(input)
    expect(() => admitOther("root-is-execution", executionWorkspace, join(root, "other-1")))
      .toThrow("LEGACY_OPERATION_ACTIVE")
    expect(() => admitOther("execution-is-root", join(root, "other-2"), project.workspace))
      .toThrow("LEGACY_OPERATION_ACTIVE")
    expect(() => admitOther("same-execution", join(root, "other-3"), executionWorkspace))
      .toThrow("LEGACY_OPERATION_ACTIVE")
    first.settle(firstOperation.ticket, "unknown", "original_interrupted")
    const record = first.get(firstOperation.operation.operationId)!
    expect(() => first.disable(project.projectId)).toThrow("LEGACY_OPERATION_ACTIVE")
    const review = {
      projectId: project.projectId, operationId: record.operationId,
      expectedRevision: legacyRecoveryRevision(record), checkedOriginalResult: true as const
    }
    const authorize = vi.fn()
    const result = first.reconcile(review, authorize)
    expect(result).toMatchObject({ status: "reconciled", businessStateValidity: "unknown",
      terminalCode: "original_interrupted", reconciliation: { actor: "desktop-user" } })
    expect(second.reconcile(review, authorize)).toEqual(result)
    expect(authorize).toHaveBeenCalledOnce()
    expect(() => second.reconcile({ ...review, expectedRevision: "c".repeat(64) }, authorize))
      .toThrow("LEGACY_RECOVERY_REVIEW_CHANGED")
    expect(() => second.admit(input)).toThrow("LEGACY_OPERATION_ALREADY_RECORDED")
    expect(second.admit({ ...input, requestId: "manual-next" }).operation.status).toBe("started")
  } finally {
    first.close()
    second.close()
    rmSync(root, { recursive: true, force: true })
  }
})
