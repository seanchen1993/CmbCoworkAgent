import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ModControlStore } from "./control-store"
import type { CompletionEvidenceRecord } from "./v2/completion-evidence"

const folders: string[] = []
const stores: ModControlStore[] = []
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "cmb-mods-control-"))
  folders.push(folder)
  const file = join(folder, "control.sqlite")
  const store = new ModControlStore(file)
  stores.push(store)
  return { store, file }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("cmb-mods-control-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(folder, { recursive: true, force: true })
  }
})

describe("Mod durable control store", () => {
  it("recovers an unfinished capture without losing its identity or replaying it", () => {
    const { store, file } = fixture()
    const row = {
      id: "capture",
      idempotencyKey: "capture",
      workspace: "project",
      threadId: "thread",
      turnId: "turn",
      runId: "run",
      phase: "capture.started",
      status: "running",
      binding: null,
      capture: {
        workspace: "project",
        threadId: "thread",
        turnId: "turn",
        runId: "run",
        pluginDigests: { p: "digest" },
        runtimeGeneration: 1,
        configFingerprint: "config"
      },
      detail: { attempt: "attempt", businessAccepted: false },
      at: 1
    } as unknown as CompletionEvidenceRecord
    store.saveCompletionEvidence(row)
    store.close()
    stores.pop()
    const reopened = new ModControlStore(file)
    stores.push(reopened)
    expect(reopened.completionEvidence("project", "thread")).toEqual([
      {
        ...row,
        status: "interrupted",
        detail: { attempt: "attempt", businessAccepted: false, error: "MODS_PROCESS_RESTARTED" }
      }
    ])
    expect(() =>
      reopened.saveCompletionEvidence({
        ...row,
        id: "forged",
        status: "pass"
      } as unknown as CompletionEvidenceRecord)
    ).toThrow("MODS_EVIDENCE_UNBOUND")
  })

  it("atomically settles only the matching attempt and preserves completed capture across restart", () => {
    const { store, file } = fixture()
    const base = {
      id: "capture",
      idempotencyKey: "capture",
      workspace: "project",
      threadId: "thread",
      turnId: "turn",
      runId: "run",
      phase: "capture.started",
      status: "running",
      binding: null,
      capture: {
        workspace: "project",
        threadId: "thread",
        turnId: "turn",
        runId: "run",
        pluginDigests: {},
        runtimeGeneration: 1,
        configFingerprint: "config"
      },
      detail: { attempt: "attempt" },
      at: 1
    } satisfies CompletionEvidenceRecord
    store.saveCompletionEvidence(base)
    store.saveCompletionEvidence({
      ...base,
      id: "different-attempt",
      idempotencyKey: "different-attempt",
      detail: { attempt: "other" }
    })
    store.saveCompletionEvidence({
      ...base,
      id: "other-thread",
      idempotencyKey: "other-thread",
      threadId: "other-thread"
    })
    const failed = {
      ...base,
      id: "failure",
      idempotencyKey: "failure",
      phase: "capture.failed",
      status: "error",
      at: 2
    } satisfies CompletionEvidenceRecord
    store.saveCompletionEvidence(failed)
    store.saveCompletionEvidence({ ...failed, detail: { attempt: "other" } })
    const before = store.completionEvidence("project", "thread")
    expect(before.find((row) => row.id === "capture")).toMatchObject({
      status: "completed",
      binding: null,
      detail: { attempt: "attempt", settledBy: "failure", settledAt: 2 }
    })
    expect(before.find((row) => row.id === "different-attempt")?.status).toBe("running")
    expect(store.completionEvidence("project", "other-thread")[0].status).toBe("running")
    store.close()
    stores.pop()
    const reopened = new ModControlStore(file)
    stores.push(reopened)
    const after = reopened.completionEvidence("project", "thread")
    expect(after.find((row) => row.id === "capture")).toEqual(
      before.find((row) => row.id === "capture")
    )
    expect(after.find((row) => row.id === "different-attempt")?.status).toBe("interrupted")
  })
  it("persists unbound capture errors across restart but never accepts them as PASS", () => {
    const { store, file } = fixture()
    const capture = {
      workspace: "project",
      threadId: "thread",
      turnId: "turn",
      runId: "run",
      pluginDigests: { p: "digest" },
      runtimeGeneration: 4,
      configFingerprint: "config"
    }
    const record = {
      id: "capture-error",
      idempotencyKey: "attempt:capture.failed",
      workspace: "project",
      threadId: "thread",
      turnId: "turn",
      runId: "run",
      phase: "capture.failed",
      status: "error",
      binding: null,
      capture,
      detail: { error: "COMPLETION_EVIDENCE_LINK", businessAccepted: false },
      at: Date.now()
    } satisfies CompletionEvidenceRecord
    store.saveCompletionEvidence(record)
    expect(() =>
      store.saveCompletionEvidence({
        ...record,
        id: "forged",
        status: "pass"
      } as unknown as CompletionEvidenceRecord)
    ).toThrow("MODS_EVIDENCE_UNBOUND")
    store.close()
    stores.pop()
    const reopened = new ModControlStore(file)
    stores.push(reopened)
    expect(reopened.completionEvidence("project", "thread")).toEqual([record])
  })
  it("persists completion evidence with an idempotent event key", () => {
    const { store, file } = fixture()
    const record = {
      id: "evidence-1",
      idempotencyKey: "same-event",
      workspace: "project",
      threadId: "thread",
      turnId: "turn",
      runId: "run",
      phase: "check.started",
      status: "running",
      binding: {
        workspace: "project",
        threadId: "thread",
        turnId: "turn",
        runId: "run",
        pluginDigests: { p: "d" },
        runtimeGeneration: 1,
        diffFingerprint: "diff",
        stateFingerprint: "state",
        requirementVersion: "req",
        configFingerprint: "config",
        files: []
      },
      at: Date.now()
    } satisfies CompletionEvidenceRecord
    store.saveCompletionEvidence(record)
    store.saveCompletionEvidence({ ...record, id: "other-id", status: "pass" })
    expect(store.completionEvidence("project", "thread")).toEqual([record])
    store.close()
    stores.pop()
    const reopened = new ModControlStore(file)
    stores.push(reopened)
    expect(reopened.completionEvidence("project", "thread")[0]).toMatchObject({
      phase: "check.started",
      status: "interrupted"
    })
  })
  it("keeps model reservations, unknown usage and per-plugin budgets across backups and restart", () => {
    const { store, file } = fixture()
    const identity = {
      workspace: "project",
      threadId: "thread",
      turnId: "model",
      agentId: "main",
      origin: "mod" as const,
      modId: "function:demo",
      grantEpoch: 1,
      callId: "model-0"
    }
    for (let i = 0; i < 8; i++)
      store.claimFunctionModel(
        { ...identity, callId: `model-${i}` },
        { prompt: "never persist" },
        { prompt: "never persist", model: "custom:configured" },
        "custom:configured",
        4096
      )
    store.recordFunctionModelUsage("model-0", 12, 3)
    store.settle("model-0", "succeeded")
    const backup = `${file}.model-backup`
    store.backup(backup)
    const reopened = new ModControlStore(backup)
    stores.push(reopened)
    expect(() =>
      reopened.claimFunctionModel(
        { ...identity, callId: "over-budget" },
        {},
        {},
        "custom:configured",
        1
      )
    ).toThrow("MODS_MODEL_BUDGET")
    const records = reopened.audit("project")
    expect(records).toHaveLength(8)
    expect(records[0]).toMatchObject({ status: "unknown", modelUsage: { outputTokenLimit: 4096 } })
    expect(records[0].modelUsage).not.toHaveProperty("outputTokens")
    expect(records.at(-1)).toMatchObject({
      status: "succeeded",
      modelUsage: { inputTokens: 12, outputTokens: 3 }
    })
    expect(JSON.stringify(records)).not.toContain("never persist")
    expect(() =>
      reopened.claimFunctionModel(
        { ...identity, modId: "function:other", callId: "independent" },
        {},
        {},
        "custom:configured",
        1
      )
    ).not.toThrow()
  })
  it("migrates v1 state without loss and includes function state in restart and backup", () => {
    const { store, file } = fixture()
    store.setSetting("schema", "4")
    store.write("legacy", "count", 7)
    store.close()
    stores.pop()
    const migrated = new ModControlStore(file)
    stores.push(migrated)
    expect(migrated.getSetting("schema")).toBe("7")
    expect(migrated.read("legacy", "count")).toBe(7)
    migrated.functionState.set("plugin", "pref", { theme: "dark" })
    const backup = join(dirname(file), "function-backup.sqlite")
    migrated.backup(backup)
    const copy = new ModControlStore(backup)
    stores.push(copy)
    expect(copy.functionState.get("plugin", "pref")).toEqual({ theme: "dark" })
    expect(copy.read("legacy", "count")).toBe(7)
    migrated.close()
    stores.splice(stores.indexOf(migrated), 1)
    const reopened = new ModControlStore(file)
    stores.push(reopened)
    expect(reopened.functionState.get("plugin", "pref")).toEqual({ theme: "dark" })
  })
  it("recovers queued jobs as cancelled and running jobs as unknown without storing executable intent", () => {
    const { store, file } = fixture()
    for (const state of ["queued", "running"] as const)
      store.saveJob({
        id: state,
        threadId: "thread",
        workspace: "workspace",
        command: "test:write",
        state,
        createdAt: Date.now()
      })
    store.close()
    stores.pop()
    const reopened = new ModControlStore(file)
    stores.push(reopened)
    expect(
      reopened
        .jobs("thread")
        .map((job) => job.state)
        .sort()
    ).toEqual(["cancelled", "unknown"])
    expect(reopened.jobs("other")).toEqual([])
  })
  it("paginates without losing equal timestamps and keeps execution separate from publication", () => {
    const { store } = fixture()
    const identity = {
      workspace: "project",
      threadId: "thread",
      turnId: "turn",
      agentId: "main",
      origin: "model" as const,
      grantEpoch: 0,
      callId: "a"
    }
    for (const id of ["a", "b", "c"])
      store.claim(id, "host:read_file", { password: "never stored" }, { ...identity, callId: id })
    store.settle("c", "succeeded")
    store.publication("c", "digest", ["baseline-v1"], "blocked")
    store.publication("c", "digest", ["deployment-literal"], "blocked")
    const first = store.audit("project", 2)
    const second = store.audit("project", 2, first.at(-1)!.cursor)
    expect([...first, ...second].map((row) => row.callId)).toEqual(["c", "b", "a"])
    expect(first[0]).toMatchObject({
      status: "succeeded",
      publication: "blocked",
      policyDigest: "digest"
    })
    expect(JSON.stringify(first)).not.toContain("never stored")
    expect(first[0].ruleIds.sort()).toEqual(["baseline-v1", "deployment-literal"])
    expect(store.audit("other")).toEqual([])
  })
  it("exports the WAL consistently and allows scoped one-time reconciliation without replay", () => {
    const { store, file } = fixture()
    const identity = {
      workspace: "project",
      threadId: "thread",
      turnId: "turn",
      agentId: "main",
      origin: "model" as const,
      grantEpoch: 0,
      callId: "a"
    }
    store.claim("a", "host:execute", {}, identity)
    store.grant("project", "test", "digest", true)
    const path = `${file}.backup`
    store.backup(path)
    const copy = new ModControlStore(path)
    stores.push(copy)
    expect(copy.status("a")).toBe("unknown")
    expect(copy.getGrant("project", "test")?.enabled).toBe(true)
    expect(() => copy.reconcile("other", "a", "confirmed-success")).toThrow("STALE")
    copy.reconcile("project", "a", "confirmed-success")
    expect(copy.audit("project")[0]).toMatchObject({
      status: "unknown",
      reconciliation: "confirmed-success"
    })
    expect(() => copy.reconcile("project", "a", "confirmed-failure")).toThrow("STALE")
    expect(() => copy.claim("a", "host:execute", {}, identity)).toThrow("ALREADY_STARTED")
  })
  it("preserves cards and consumed action keys across restart", () => {
    const { store, file } = fixture()
    store.saveCard("card", "thread", { id: "card", nodes: [] })
    store.consumeAction("card:button")
    store.close()
    stores.pop()
    const reopened = new ModControlStore(file)
    stores.push(reopened)
    expect(reopened.cards("thread")).toEqual([{ id: "card", nodes: [] }])
    expect(reopened.actionConsumed("card:button")).toBe(true)
    expect(() => reopened.consumeAction("card:button")).toThrow("ALREADY_USED")
  })
  it("rejects reuse of a call ID, including different arguments", () => {
    const { store } = fixture()
    store.claim("turn:call", "host:write_file", { content: "one" })
    expect(() => store.claim("turn:call", "host:write_file", { content: "one" })).toThrow(
      "ALREADY_STARTED"
    )
    expect(() => store.claim("turn:call", "host:write_file", { content: "two" })).toThrow(
      "COLLISION"
    )
    store.settle("turn:call", "succeeded")
    expect(store.status("turn:call")).toBe("succeeded")
  })
  it("recovers uncompleted operations as unknown without replay", () => {
    const { store, file } = fixture()
    store.claim("pending", "remote:write", {})
    store.close()
    stores.pop()
    const reopened = new ModControlStore(file)
    stores.push(reopened)
    expect(reopened.status("pending")).toBe("unknown")
    expect(() => reopened.claim("pending", "remote:write", {})).toThrow("ALREADY_STARTED")
  })
  it("invalidates captured grants after revocation and reapproval", () => {
    const { store } = fixture()
    const grant = store.grant("workspace", "mod", "digest-1", true)
    store.assertGrant(grant)
    store.grant("workspace", "mod", "digest-1", false)
    expect(() => store.assertGrant(grant)).toThrow("REVOKED")
    store.grant("workspace", "mod", "digest-1", true)
    expect(() => store.assertGrant(grant)).toThrow("REVOKED")
  })
  it("isolates state namespaces and rolls back quota violations", () => {
    const { store } = fixture()
    store.write("one", "key", "value")
    expect(store.read("two", "key")).toBeNull()
    expect(() => store.write("one", "key", "x".repeat(70_000))).toThrow("VALUE_LIMIT")
    expect(store.read("one", "key")).toBe("value")
  })
})
