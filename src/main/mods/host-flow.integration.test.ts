import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { afterEach, expect, it, vi } from "vitest"
import { LocalSandbox } from "../agent/local-sandbox"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { ModsManager, getModsManager, setModsManager, authorizeCurrentModInput } from "./manager"
import { withFunctionExecution } from "./v2/execution-context"
import { functionMcpToolFingerprint } from "./v2/mcp-sdk"
import type { HostFlowAuthority } from "./flow-authority"
import type { McpCapabilityTool } from "../mcp/capability-types"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function fixture(approved = true, onApproval?: () => void) {
  const root = mkdtempSync(join(tmpdir(), "mods-host-flow-"))
  const workspace = join(root, "project")
  mkdirSync(workspace)
  const confirm = vi.fn<ConstructorParameters<typeof ModsManager>[2]>(async () => {
    onApproval?.()
    return approved
  })
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    confirm,
    () => {}
  )
  const previous = getModsManager()
  setModsManager(manager)
  manager.configure(workspace, true, false)
  const threadId = basename(root)
  const controller = new AbortController()
  expect(claimLocalThreadRunLease({ threadId, owner: "mods", runId: "flow-run" }).acquired).toBe(
    true
  )
  const runtime = manager.createRuntimeAuthority({
    workspace,
    threadId,
    turnId: "flow-run",
    signal: controller.signal
  })
  let release = () => {}
  new LocalSandbox({
    rootDir: workspace,
    modWorkspace: workspace,
    modRuntimeAuthority: runtime.authority,
    modManagedExecution: true,
    runId: threadId,
    hookTurnId: "flow-run",
    windowsSandbox: "none",
    abortSignal: controller.signal,
    onModBinding: (dispose) => {
      release = dispose
    }
  })
  const authority = manager.createHostFlowAuthority({
    workspace,
    threadId,
    runId: "flow-run",
    definitionDigest: "a".repeat(64),
    runtimeAuthority: runtime.authority,
    signal: controller.signal,
    assertLive: () => {}
  })
  const run = <T>(action: () => Promise<T>) =>
    withFunctionExecution(
      {
        workspace: authority.workspace,
        threadId,
        turnId: "flow-run",
        runtimeAuthority: runtime.authority,
        leased: true,
        immediate: false,
        userInitiated: true
      },
      action
    )
  const check = (token = authority) =>
    run(() => manager.runHostFlowProjectCheck(token, "unit-test", controller.signal, 10000))
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ scripts: { test: "node suite.cjs" } })
  )
  writeFileSync(
    join(workspace, "suite.cjs"),
    'require("node:fs").writeFileSync("executed.txt", "yes"); console.log("HOST_FLOW_REAL_TEST")'
  )
  cleanup.push(async () => {
    controller.abort()
    await LocalSandbox.cancelBackgroundTasksAndWait(threadId)
    release()
    runtime.release()
    releaseLocalThreadRunLease(threadId, "mods", "flow-run")
    releaseLocalThreadRunLease(threadId, "mods", "replacement")
    manager.close()
    setModsManager(previous)
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-host-flow-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(root, { recursive: true, force: true })
  })
  return { manager, authority, runtime, workspace, threadId, controller, confirm, run, check }
}

it("runs a real project check without a plugin grant and records the host flow identity", async () => {
  const f = fixture()
  const result = await f.check()
  expect(result).toMatchObject({ passed: true, exitCode: 0 })
  expect(result.output).toContain("HOST_FLOW_REAL_TEST")
  expect(f.confirm).toHaveBeenCalledTimes(1)
  const receipt = f.manager.store
    .audit(f.authority.workspace)
    .find((entry) => entry.callId === result.executionId)
  expect(receipt).toMatchObject({
    status: "succeeded",
    publication: "published",
    identity: {
      origin: "user-action",
      flow: { runId: "flow-run", definitionDigest: "a".repeat(64) }
    }
  })
  expect(receipt?.identity?.modId).toBeUndefined()
  expect(f.manager.store.getGrant(f.authority.workspace, "function:host-flow")).toBeNull()
}, 20000)

it("does not execute a host check after approval is rejected", async () => {
  const f = fixture(false)
  await expect(f.check()).rejects.toThrow()
  expect(f.confirm).toHaveBeenCalledTimes(1)
  expect(existsSync(join(f.workspace, "executed.txt"))).toBe(false)
})

it("blocks publication when a completed host check is cancelled during final publication", async () => {
  const f = fixture()
  const publish = f.manager.publish.bind(f.manager)
  let publications = 0
  let revokedAfterResult = false
  vi.spyOn(f.manager, "publish").mockImplementation(async (...args) => {
    const result = await publish(...args)
    if (args[2] && ++publications === 2) {
      revokedAfterResult = true
      f.controller.abort(Error("cancelled while publishing"))
    }
    return result
  })
  await expect(f.check()).rejects.toThrow("cancelled while publishing")
  expect(revokedAfterResult).toBe(true)
  expect(existsSync(join(f.workspace, "executed.txt"))).toBe(true)
  expect(
    f.manager.store.audit(f.authority.workspace).find((entry) => entry.toolId === "host:execute")
  ).toMatchObject({ status: "succeeded", publication: "blocked" })
}, 20000)

it("rejects a serialized or forged host authority before approval", async () => {
  const f = fixture()
  await expect(f.check({ ...f.authority } as HostFlowAuthority)).rejects.toThrow(
    "FLOW_AUTHORITY_INVALID"
  )
  expect(f.confirm).not.toHaveBeenCalled()
})

it("rejects revoked Mods even if disabled and reenabled before invocation", async () => {
  const f = fixture()
  f.manager.configure(f.workspace, false, false)
  f.manager.configure(f.workspace, true, false)
  await expect(f.check()).rejects.toThrow()
  expect(f.confirm).not.toHaveBeenCalled()
})

it("rejects a replacement lease and a foreign execution scope", async () => {
  const f = fixture()
  await expect(
    f.manager.runHostFlowProjectCheck(f.authority, "unit-test", f.controller.signal, 1000)
  ).rejects.toThrow()
  releaseLocalThreadRunLease(f.threadId, "mods", "flow-run")
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "mods", runId: "replacement" })
  await expect(f.check()).rejects.toThrow()
  expect(f.confirm).not.toHaveBeenCalled()
})

it("rechecks host authority after an approval callback changes the scope", async () => {
  let invalidate = () => {}
  const f = fixture(true, () => invalidate())
  invalidate = () => f.controller.abort(Error("cancelled during approval"))
  await expect(f.check()).rejects.toThrow()
  expect(existsSync(join(f.workspace, "executed.txt"))).toBe(false)
})

it("routes host MCP through final-argument approval and durable execution, with no grant", async () => {
  const f = fixture()
  const tool: McpCapabilityTool = {
    capabilityId: "host-test-call",
    toolId: "mcp__local__write",
    canonicalToolId: "mcp__local__write",
    providerAlias: "local",
    providerDisplayName: "Local test service",
    visibility: "eager",
    providerKey: "local",
    toolName: "write",
    inputSchema: { type: "object" }
  }
  const invoke = vi.fn(async () => ({ raw: { content: [{ type: "text", text: "host result" }] } }))
  const binding = {
    workspace: f.authority.workspace,
    threadId: f.threadId,
    turnId: "flow-run",
    runtimeAuthority: f.runtime.authority,
    signal: f.controller.signal
  }
  const release = f.manager.bindMcp(
    binding,
    (id, args) =>
      f.manager.dispatch(binding, `mcp:${id}`, args, async () => {
        await authorizeCurrentModInput(`mcp:${id}`, { ...args, final: true })
        return invoke()
      }),
    async () => [tool],
    () => [tool]
  )
  try {
    const result = await f.run(() =>
      f.manager.invokeHostFlowMcp(
        f.authority,
        { server: "local", tool: "write", args: { value: 1 } },
        f.controller.signal,
        functionMcpToolFingerprint(tool)
      )
    )
    expect(result).toMatchObject({ content: [{ type: "text", text: "host result" }] })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(f.confirm).toHaveBeenCalledTimes(1)
    expect(f.confirm.mock.calls[0]?.[3]).toEqual({ value: 1, final: true })
  } finally {
    release()
  }
})
