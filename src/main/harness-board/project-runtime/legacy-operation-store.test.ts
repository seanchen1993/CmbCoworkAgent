import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { LegacyOperationStore } from "./legacy-operation-store"

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
