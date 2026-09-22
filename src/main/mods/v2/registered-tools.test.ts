import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionRegisteredTools } from "./registered-tools"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModIdentity, ModObject } from "../../../shared/mods/types"
import { withFunctionExecution } from "./execution-context"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), "registered-tools-"))
  const store = new ModControlStore(join(workspace, "control.sqlite"))
  const grant = store.grant(workspace, "function:demo", "digest", true)
  const host = {
    assertScope: vi.fn(),
    admit: vi.fn(async () => {}),
    publish: vi.fn(async (identity: ModIdentity, value: ModObject) => {
      store.publication(identity.callId, "protected", [], "published")
      return { ...value, text: "protected" }
    })
  }
  const tools = new FunctionRegisteredTools(store, host)
  const run = vi.fn<() => Promise<ModObject>>(async () => ({ result: "private" }))
  const call = (signal = new AbortController().signal) =>
    tools.call(
      workspace,
      "thread",
      grant,
      { tool: "mcp__demo__probe", tool_use_id: "model-id", input: "private input" },
      "model",
      signal,
      run
    )
  cleanups.push(() => {
    store.close()
    if (
      dirname(resolve(workspace)) !== resolve(tmpdir()) ||
      !basename(workspace).startsWith("registered-tools-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(workspace, { recursive: true, force: true })
  })
  return { workspace, store, grant, host, run, call }
}

it("admits before execution, publishes through policy and creates independent private-safe receipts", async () => {
  const f = fixture()
  f.run.mockImplementation(async () => {
    expect(f.host.admit.mock.calls.length).toBeGreaterThan(0)
    return { result: "private output" }
  })
  expect(await f.call()).toEqual({ result: "private output", text: "protected" })
  await f.call()
  const audit = f.store.audit(f.workspace)
  expect(audit).toHaveLength(2)
  expect(new Set(audit.map((row) => row.identity?.callId)).size).toBe(2)
  expect(audit[0]).toMatchObject({
    toolId: "function:mcp__demo__probe",
    status: "succeeded",
    publication: "published",
    identity: { origin: "model", toolCallId: "model-id", modId: "function:demo" }
  })
  expect(JSON.stringify(audit)).not.toMatch(/private input|private output/)
})

it("attributes model tools to the real turn so they appear in its durable summary", async () => {
  const f = fixture()
  await withFunctionExecution(
    {
      workspace: f.workspace,
      threadId: "thread",
      turnId: "model-turn",
      leased: true,
      immediate: false,
      userInitiated: false
    },
    () => f.call()
  )
  expect(f.store.audit(f.workspace)[0].identity?.turnId).toBe("model-turn")
  expect(f.store.turnSummary(f.workspace, "thread", "model-turn")).toMatchObject({ succeeded: 1 })
  await f.call()
  expect(
    f.store.audit(f.workspace).some((row) => row.identity?.turnId === "function-tool:thread")
  ).toBe(true)
})

it("rejects policy refusal and revoked grants before any handler or receipt", async () => {
  const f = fixture()
  f.host.admit.mockRejectedValue(new ModFunctionError("MODS_POLICY_DENIED"))
  await expect(f.call()).rejects.toThrow("MODS_POLICY_DENIED")
  f.store.grant(f.workspace, f.grant.modId, "digest", false)
  await expect(f.call()).rejects.toThrow("MODS_GRANT_REVOKED")
  expect(f.run).not.toHaveBeenCalled()
  expect(f.store.audit(f.workspace)).toEqual([])
})

it("rechecks admission-time scope and never starts a revoked handler", async () => {
  const f = fixture()
  f.host.admit.mockImplementation(async () => {
    f.store.grant(f.workspace, f.grant.modId, "digest", false)
  })
  await expect(f.call()).rejects.toThrow("MODS_GRANT_REVOKED")
  expect(f.run).not.toHaveBeenCalled()
})

it("retains completed execution and blocks publication on mid-call revocation", async () => {
  const f = fixture()
  f.run.mockImplementation(async () => {
    f.store.grant(f.workspace, f.grant.modId, "digest", false)
    return { result: "completed" }
  })
  await expect(f.call()).rejects.toThrow("MODS_GRANT_REVOKED")
  expect(f.host.publish).not.toHaveBeenCalled()
  expect(f.store.audit(f.workspace)[0]).toMatchObject({
    status: "succeeded",
    publication: "blocked"
  })
})

it("never replays failures and does not expose guest error details", async () => {
  const f = fixture()
  f.run.mockRejectedValue(Error("private execution details"))
  await expect(f.call()).rejects.toThrow(/^MODS_REGISTERED_TOOL_FAILED$/)
  expect(f.run).toHaveBeenCalledOnce()
  expect(f.store.audit(f.workspace)[0]).toMatchObject({ status: "unknown", publication: "blocked" })
})

it("preserves cancellation uncertainty and records returned tool errors as failures", async () => {
  const f = fixture()
  const abort = new AbortController()
  f.run.mockImplementation(async () => {
    abort.abort()
    throw Error("cancelled")
  })
  await expect(f.call(abort.signal)).rejects.toThrow("MODS_CANCELLED")
  expect(f.store.audit(f.workspace)[0]).toMatchObject({ status: "unknown", publication: "blocked" })
  f.run.mockResolvedValue({ deny: "unavailable" })
  await f.call()
  expect(
    f.store
      .audit(f.workspace)
      .some((row) => row.status === "failed" && row.publication === "published")
  ).toBe(true)
})
