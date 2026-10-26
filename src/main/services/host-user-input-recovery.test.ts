import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { HostProjectStore } from "../harness-board/project-runtime/host-store"
import {
  hostProjectFixture,
  prepareFixture,
  TEST_FINGERPRINT
} from "../harness-board/project-runtime/host-fixtures.test-helper"
import { isHostUserInputRecoverable } from "./host-user-input-recovery"
import { captureThreadIncarnation } from "./thread-incarnation"
import type { HostUserInputRecord } from "./host-user-input-store"

const cleanup: Array<() => void> = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((run) => run())
)
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "host-input-recovery-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "state.sqlite")
  const store = new HostProjectStore(path)
  cleanup.push(() => store.close())
  const project = store.create(hostProjectFixture(root))
  const operation = store.prepare(prepareFixture())
  const ticket = store.start(operation.operationId, TEST_FINGERPRINT)
  store.bindExecutionThread(ticket, "thread")
  const thread = {
    created_at: 1,
    metadata: JSON.stringify({
      cmb_thread_incarnation: "original",
      workspacePath: root,
      hostProjectRuntime: {
        projectId: project.projectId,
        operationId: operation.operationId,
        stageId: operation.stageId,
        pluginDigest: project.pluginDigest
      }
    })
  }
  const record: HostUserInputRecord = {
    schemaVersion: 1,
    status: "waiting",
    response: null,
    reason: null,
    request: { requestId: "request", threadId: "thread", questions: [], createdAt: "2026-10-23" },
    binding: {
      projectId: project.projectId,
      operationId: operation.operationId,
      stageId: operation.stageId,
      installedPluginId: project.installedPluginId,
      expectedVersion: 1,
      pluginDigest: project.pluginDigest,
      inputFingerprint: TEST_FINGERPRINT,
      incarnationKey: JSON.stringify(captureThreadIncarnation(thread))
    }
  }
  return { store, record, thread, path, ticket }
}

it("recovers only a question tied to the exact durable original operation, never changes unknown", () => {
  const f = fixture()
  f.store.recoverInterrupted()
  expect(isHostUserInputRecoverable(f.record, f.path, f.thread, () => true)).toBe(true)
  expect(f.store.getOperation(f.record.binding.operationId)?.status).toBe("unknown")
  expect(f.store.get(f.record.binding.projectId)?.version).toBe(1)
})

it("rejects recreated threads, moved workspaces, revoked installation and forged operation bindings", () => {
  const f = fixture()
  expect(isHostUserInputRecoverable(f.record, f.path, f.thread, () => false)).toBe(false)
  const metadata = JSON.parse(f.thread.metadata)
  for (const changed of [
    { ...metadata, cmb_thread_incarnation: "replacement" },
    { ...metadata, workspacePath: join(tmpdir(), "another-workspace") },
    {
      ...metadata,
      hostProjectRuntime: { ...metadata.hostProjectRuntime, operationId: "different" }
    }
  ]) {
    expect(
      isHostUserInputRecoverable(
        f.record,
        f.path,
        { ...f.thread, metadata: JSON.stringify(changed) },
        () => true
      )
    ).toBe(false)
  }
  for (const patch of [
    { expectedVersion: 2 },
    { inputFingerprint: "f".repeat(64) },
    { pluginDigest: "f".repeat(64) },
    { installedPluginId: "other" }
  ]) {
    expect(
      isHostUserInputRecoverable(
        { ...f.record, binding: { ...f.record.binding, ...patch } },
        f.path,
        f.thread,
        () => true
      )
    ).toBe(false)
  }
})

it("never offers a pending answer after cancellation or terminal settlement", () => {
  const f = fixture()
  f.store.cancel(f.record.binding.operationId)
  expect(isHostUserInputRecoverable(f.record, f.path, f.thread, () => true)).toBe(false)
  f.store.recordResult(f.ticket, { outcome: "cancelled", receipts: [] })
  expect(isHostUserInputRecoverable(f.record, f.path, f.thread, () => true)).toBe(false)
})
