import { mkdtempSync, rmSync } from "node:fs"
import { AsyncResource } from "node:async_hooks"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionRegisteredTools } from "./registered-tools"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModIdentity, ModObject } from "../../../shared/mods/types"
import { captureFunctionExecutionGuard, currentFunctionExecution, scheduleFunctionTool, withFunctionExecution } from "./execution-context"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { ModRuntimeAuthorities } from "../runtime-instance"

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

it.each(["desktop", "im"] as const)("runs an admitted registered action under its original %s main-task lease", async (owner) => {
  const f = fixture()
  const registry = new ModRuntimeAuthorities()
  const instance = registry.create({ workspace: f.workspace, threadId: "thread", turnId: "turn" })
  expect(claimLocalThreadRunLease({ threadId: "thread", owner, runId: "native" }).acquired).toBe(true)
  cleanups.push(() => { registry.close(); releaseLocalThreadRunLease("thread", owner, "native") })
  f.host.admit.mockImplementation(async () => {
    expect(currentFunctionExecution()?.userInitiated).toBe(false)
  })
  const queue = { enqueue: vi.fn(() => { throw Error("own lease queued") }) }
  let late!: () => Promise<unknown>
  f.run.mockImplementation(async () => {
    expect(currentFunctionExecution()?.userInitiated).toBe(true)
    const invoke = () => scheduleFunctionTool(queue as never, f.workspace, "thread", "mcp:call",
      new AbortController().signal, async (_signal, readOnly, userInitiated) => {
        expect([readOnly, userInitiated]).toEqual([false, true])
        return { result: "native-mcp" }
      })
    late = new (await import("node:async_hooks")).AsyncResource("late-registered").bind(invoke)
    return invoke()
  })
  await withFunctionExecution({ workspace: f.workspace, threadId: "thread", turnId: "turn",
    runtimeAuthority: instance.authority, userInitiated: false, leased: true, immediate: false },
  async () => {
    expect(await f.call()).toMatchObject({ result: "native-mcp" })
    expect(currentFunctionExecution()?.userInitiated).toBe(false)
  })
  await expect(late()).rejects.toThrow("MODS_CALL_SCOPE_EXPIRED")
  expect(queue.enqueue).not.toHaveBeenCalled()
})

it.each(["scheduler", "mods", "child", "no-authority", "immediate", "replacement"] as const)(
  "does not promote a registered action from %s provenance", async (scenario) => {
    const f = fixture()
    const registry = new ModRuntimeAuthorities()
    const owner = scenario === "scheduler" || scenario === "mods" ? scenario : "desktop"
    const agentId = scenario === "child" ? "worker" : "main"
    const instance = registry.create({ workspace: f.workspace, threadId: "thread", turnId: "turn", agentId })
    expect(claimLocalThreadRunLease({ threadId: "thread", owner, runId: "native" }).acquired).toBe(true)
    cleanups.push(() => { registry.close(); releaseLocalThreadRunLease("thread", owner, "native") })
    if (scenario === "replacement") f.host.admit.mockImplementation(async () => {
      releaseLocalThreadRunLease("thread", owner, "native")
      expect(claimLocalThreadRunLease({ threadId: "thread", owner, runId: "native" }).acquired).toBe(true)
    })
    f.run.mockImplementation(async () => scheduleFunctionTool({} as never, f.workspace, "thread", "mcp:call",
      new AbortController().signal, async () => ({ result: "must not execute" })))
    const tools = new FunctionRegisteredTools(f.store, f.host)
    await expect(withFunctionExecution({ workspace: f.workspace, threadId: "thread", turnId: "turn", agentId,
      ...(scenario !== "no-authority" ? { runtimeAuthority: instance.authority } : {}),
      userInitiated: false, leased: true, immediate: scenario === "immediate" },
    () => tools.call(f.workspace, "thread", f.grant, { tool: "mcp__demo__probe", tool_use_id: "native", agentId },
      "model", new AbortController().signal, f.run))).rejects.toThrow("MODS_WRITE_REQUIRES_USER_ACTION")
  }
)

it.each(["replacement", "parent-settled"] as const)("retains the original registered-action fence in nested host scopes (%s)", async (failure) => {
  const f = fixture()
  const registry = new ModRuntimeAuthorities()
  const instance = registry.create({ workspace: f.workspace, threadId: "thread", turnId: "turn" })
  expect(claimLocalThreadRunLease({ threadId: "thread", owner: "desktop", runId: "native" }).acquired).toBe(true)
  cleanups.push(() => { registry.close(); releaseLocalThreadRunLease("thread", "desktop", "native") })
  let nested!: Promise<ModObject>
  let captured!: () => void
  const external = new AsyncResource("registered-action-native-reply")
  cleanups.push(() => { external.emitDestroy() })
  let resume!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.run.mockImplementation(async () => {
    const original = currentFunctionExecution()!
    nested = withFunctionExecution(original, async () => {
      captured = captureFunctionExecutionGuard(f.workspace, "thread")
      expect(() => external.runInAsyncScope(captured)).not.toThrow()
      entered()
      await new Promise<void>(resolve => { resume = resolve })
      return scheduleFunctionTool({} as never, f.workspace, "thread", "mcp:call",
        new AbortController().signal, async () => ({ result: "must not execute" }))
    })
    // Observe the failure immediately so a deliberately detached test branch never
    // becomes an unhandled rejection before the native parent has settled.
    void nested.catch(() => {})
    await ready
    if (failure === "replacement") {
      releaseLocalThreadRunLease("thread", "desktop", "native")
      expect(claimLocalThreadRunLease({ threadId: "thread", owner: "desktop", runId: "native" }).acquired).toBe(true)
      expect(() => external.runInAsyncScope(captured)).toThrow("MODS_CALL_SCOPE_CHANGED")
      resume()
      return nested
    }
    return { result: "parent completed" }
  })
  const parent = () => withFunctionExecution({ workspace: f.workspace, threadId: "thread", turnId: "turn",
    runtimeAuthority: instance.authority, userInitiated: false, leased: true, immediate: false }, () => f.call())
  if (failure === "replacement") await expect(parent()).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  else {
    await parent()
    expect(() => external.runInAsyncScope(captured)).toThrow("MODS_CALL_SCOPE_EXPIRED")
    resume()
  }
  await expect(nested).rejects.toThrow(failure === "replacement" ? "MODS_CALL_SCOPE_CHANGED" : "MODS_CALL_SCOPE_EXPIRED")
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
