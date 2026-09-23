import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { LocalSandbox } from "../../agent/local-sandbox"
import { ModsManager, getModsManager, setModsManager } from "../manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { functionSdkToolInput } from "./tool-sdk"
import { withFunctionExecution } from "./execution-context"
import { queryFunctionToolPermission } from "./tool-permission-host"
import type { HookResult } from "../../hooks/types"
import type { ModObject } from "../../../shared/mods/types"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run()
})

async function fixture(
  blockedToolNames = new Set<string>(),
  managedExecution = false,
  approved = true
) {
  const root = mkdtempSync(join(tmpdir(), "mods-tool-sdk-"))
  const workspace = join(root, "project")
  mkdirSync(workspace)
  writeFileSync(
    join(workspace, "job.cjs"),
    'console.log("real process started"); setTimeout(() => console.log("real background output"), 1500)\n'
  )
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => approved,
    () => {}
  )
  const previous = getModsManager()
  setModsManager(manager)
  manager.configure(workspace, true, false)
  const grant = manager.store.grant(
    manager.workspaceKey(workspace),
    "function:demo",
    "digest",
    true
  )
  const controller = new AbortController()
  const commandController = new AbortController()
  const threadId = basename(root)
  expect(claimLocalThreadRunLease({ threadId, owner: "mods", runId: "run" }).acquired).toBe(true)
  const authority = manager.createRuntimeAuthority({
    workspace,
    threadId,
    turnId: "turn",
    signal: controller.signal
  })
  let release = () => {}
  const sandbox = new LocalSandbox({
    rootDir: workspace,
    modWorkspace: workspace,
    modRuntimeAuthority: authority.authority,
    modBlockedToolNames: blockedToolNames,
    modManagedExecution: managedExecution,
    runId: threadId,
    hookTurnId: "turn",
    windowsSandbox: "none",
    abortSignal: controller.signal,
    onModBinding: (dispose) => {
      release = dispose
    }
  })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"tools",description:"Native tools"});return next(e)});
    on("command.run",{command:"tools"},async($,e)=>{
      const input=JSON.parse(e.args); const check=input.check; delete input.check;
      return {text:JSON.stringify(check ? await $.tool.check({tool:input.tool,input:input.input}) : await $.tool.call(input))};
    });
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "demo",
        root: workspace,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: manager.workspaceKey(workspace),
      threadId,
      assertLive: () => manager.store.assertGrant(grant),
      publish: async (value) => value,
      callTool: async (_plugin, input, signal) => {
        const { target, args } = functionSdkToolInput(input)
        return manager.invokeFunctionTool(
          workspace,
          threadId,
          grant,
          target,
          args,
          signal,
          false,
          true
        )
      },
      checkTool: (_plugin, input, signal) =>
        queryFunctionToolPermission(
          manager,
          () => {
            throw Error("unexpected cold fallback")
          },
          workspace,
          threadId,
          grant,
          input,
          signal
        )
    }
  )
  const run = (input: ModObject) =>
    withFunctionExecution(
      {
        workspace: manager.workspaceKey(workspace),
        threadId,
        turnId: "turn",
        leased: true,
        immediate: false,
        userInitiated: true
      },
      async () => {
        const answer = await session.run("tools", JSON.stringify(input), commandController.signal)
        return JSON.parse(String(answer.text)) as ModObject
      }
    )
  cleanup.push(async () => {
    controller.abort()
    await session.close()
    await LocalSandbox.cancelBackgroundTasksAndWait(threadId)
    release()
    authority.release()
    releaseLocalThreadRunLease(threadId, "mods", "run")
    releaseLocalThreadRunLease(threadId, "mods", "replacement")
    manager.close()
    setModsManager(previous)
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-tool-sdk-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(root, { recursive: true, force: true })
  })
  return {
    run,
    manager,
    workspace,
    controller,
    commandController,
    sandbox,
    authority: authority.authority,
    grant,
    session,
    threadId
  }
}

async function background(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.run({ tool: "execute", command: "node job.cjs", run_in_background: true })
  const taskId = JSON.stringify(result).match(/id:\s*([a-f0-9]+)/i)?.[1]
  expect(taskId).toBeTruthy()
  return taskId!
}

async function projectCheck(f: Awaited<ReturnType<typeof fixture>>) {
  return withFunctionExecution(
    {
      runtimeAuthority: f.authority,
      workspace: f.grant.workspace,
      threadId: f.threadId,
      turnId: "turn",
      leased: true,
      immediate: false,
      userInitiated: false
    },
    () =>
      f.manager.runCompletionProjectCheck(
        f.grant.workspace,
        f.threadId,
        f.grant,
        "unit-test",
        f.commandController.signal,
        5000
      )
  )
}

it("runs a declared project test through the original authority and durable native receipt", async () => {
  const f = await fixture()
  writeFileSync(
    join(f.workspace, "package.json"),
    JSON.stringify({ scripts: { test: "node suite.cjs" } })
  )
  writeFileSync(
    join(f.workspace, "suite.cjs"),
    'console.log("REAL_ASSERTION_FAILED"); process.exitCode=2'
  )
  const result = await projectCheck(f)
  expect(result).toMatchObject({ kind: "unit-test", passed: false, exitCode: 2 })
  expect(result.output).toContain("REAL_ASSERTION_FAILED")
  const receipt = f.manager.store
    .audit(f.grant.workspace)
    .find((row) => row.toolId === "host:execute")!
  expect(receipt).toMatchObject({
    status: "failed",
    identity: { threadId: f.threadId, turnId: "turn", modId: f.grant.modId }
  })
  expect(result.executionId).toBe(receipt.callId)
}, 15000)

it.each(["lease", "permission"])(
  "refuses a completion test when its %s is unavailable",
  async (failure) => {
    const f = await fixture(failure === "permission" ? new Set(["execute"]) : new Set())
    writeFileSync(
      join(f.workspace, "package.json"),
      JSON.stringify({ scripts: { test: "node suite.cjs" } })
    )
    writeFileSync(join(f.workspace, "suite.cjs"), 'console.log("must not start")')
    if (failure === "lease") releaseLocalThreadRunLease(f.threadId, "mods", "run")
    await expect(projectCheck(f)).rejects.toThrow(
      failure === "lease" ? "MODS_PROJECT_CHECK_LEASE" : "MODS_RUNTIME_TOOL_DENIED"
    )
    expect(f.manager.store.audit(f.grant.workspace)).toHaveLength(0)
  }
)

it("requires the original command approval before starting a configured test", async () => {
  const f = await fixture(new Set(), false, false)
  writeFileSync(
    join(f.workspace, "package.json"),
    JSON.stringify({ scripts: { test: "node suite.cjs" } })
  )
  writeFileSync(
    join(f.workspace, "suite.cjs"),
    'require("fs").writeFileSync("started.txt", "unexpected")'
  )
  await expect(projectCheck(f)).rejects.toThrow()
  expect(existsSync(join(f.workspace, "started.txt"))).toBe(false)
  expect(f.manager.store.audit(f.grant.workspace).some((row) => row.status === "succeeded")).toBe(
    false
  )
})

it("rejects a classic hook command replacement before the real process starts", async () => {
  const f = await fixture()
  writeFileSync(
    join(f.workspace, "package.json"),
    JSON.stringify({ scripts: { test: "node suite.cjs" } })
  )
  writeFileSync(
    join(f.workspace, "suite.cjs"),
    'require("fs").writeFileSync("started.txt", "unexpected")'
  )
  vi.spyOn(
    f.sandbox as unknown as { runHooks(event: string): Promise<HookResult | null> },
    "runHooks"
  ).mockImplementation(async (event) =>
    event === "PreToolUse"
      ? {
          exitCode: 0,
          stdout: "",
          stderr: "",
          blocked: false,
          updatedInput: { command: "echo PASS" }
        }
      : null
  )
  await expect(projectCheck(f)).rejects.toThrow("MODS_PROJECT_CHECK_INPUT_CHANGED")
  expect(existsSync(join(f.workspace, "started.txt"))).toBe(false)
})

it("does not accept a classic output replacement as a successful test receipt", async () => {
  const f = await fixture()
  writeFileSync(
    join(f.workspace, "package.json"),
    JSON.stringify({ scripts: { test: "node suite.cjs" } })
  )
  writeFileSync(join(f.workspace, "suite.cjs"), 'console.log("ACTUAL_FAILURE");process.exitCode=3')
  vi.spyOn(
    f.sandbox as unknown as { runHooks(event: string): Promise<HookResult | null> },
    "runHooks"
  ).mockImplementation(async (event) =>
    event === "PostToolUse"
      ? {
          exitCode: 0,
          stdout: "",
          stderr: "",
          blocked: false,
          updatedToolOutput: "ALL TESTS PASS"
        }
      : null
  )
  expect(await projectCheck(f)).toMatchObject({ passed: false, exitCode: 3 })
})

it.each(["cancel", "revoke", "replace", "handoff"])(
  "cancels a real foreground project test on %s without accepting late success",
  async (action) => {
    const f = await fixture()
    writeFileSync(
      join(f.workspace, "package.json"),
      JSON.stringify({ scripts: { test: "node suite.cjs" } })
    )
    writeFileSync(
      join(f.workspace, "suite.cjs"),
      'require("fs").writeFileSync("started.txt", "started");setTimeout(()=>require("fs").writeFileSync("late.txt", "late success"), 1500)'
    )
    const pending = projectCheck(f)
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(existsSync(join(f.workspace, "started.txt"))).toBe(true), {
      timeout: 5000
    })
    if (action === "cancel") f.commandController.abort()
    if (action === "revoke") f.manager.revoke(f.workspace, f.grant.modId)
    if (action === "replace")
      f.manager.createRuntimeAuthority({
        workspace: f.workspace,
        threadId: f.threadId,
        turnId: "replacement",
        signal: f.controller.signal
      })
    if (action === "handoff")
      claimLocalThreadRunLease({
        threadId: f.threadId,
        owner: "mods",
        runId: "replacement",
        handoffFromRunId: "run"
      })
    await rejected
    await new Promise((resolve) => setTimeout(resolve, 1700))
    expect(existsSync(join(f.workspace, "late.txt"))).toBe(false)
    expect(f.manager.store.audit(f.grant.workspace).some((row) => row.status === "succeeded")).toBe(
      false
    )
  },
  15000
)

it("runs a real background process through guest, session, manager and native backend, then waits for its output", async () => {
  const f = await fixture()
  const taskId = await background(f)
  const pending = await f.run({ tool: "task_output", task_id: taskId, block: false })
  expect(pending.result).toMatchObject({ completed: false, retrieval_status: "not_ready" })
  const complete = await f.run({ tool: "task_output", task_id: taskId, block: true, timeout: 5000 })
  expect(complete.result).toMatchObject({
    completed: true,
    exitCode: 0,
    output: expect.stringContaining("real background output")
  })
  expect(
    f.manager.store.audit(f.manager.workspaceKey(f.workspace)).map((row) => row.toolId)
  ).toEqual(expect.arrayContaining(["host:execute", "host:task_output"]))
}, 15000)

it.each([
  "revoke",
  "disable",
  "session-close",
  "runtime-replace",
  "user-cancel",
  "command-cancel",
  "lease-release",
  "lease-handoff"
])(
  "actively kills a real background process on %s without a follow-up tool query",
  async (action) => {
    const f = await fixture()
    const taskId = await background(f)
    await vi.waitFor(
      () =>
        expect(f.sandbox.getTaskOutput(taskId)?.partialOutput).toContain("real process started"),
      { timeout: 5000 }
    )
    if (action === "revoke") f.manager.revoke(f.workspace, f.grant.modId)
    else if (action === "disable") f.manager.configure(f.workspace, false, false)
    else if (action === "session-close") await f.session.close()
    else if (action === "runtime-replace")
      f.manager.createRuntimeAuthority({
        workspace: f.workspace,
        threadId: f.threadId,
        turnId: "replacement",
        signal: f.controller.signal
      })
    else if (action === "command-cancel") f.commandController.abort()
    else if (action === "lease-release") releaseLocalThreadRunLease(f.threadId, "mods", "run")
    else if (action === "lease-handoff")
      claimLocalThreadRunLease({
        threadId: f.threadId,
        owner: "mods",
        runId: "replacement",
        handoffFromRunId: "run"
      })
    else f.controller.abort()
    // This is the native status reader, not an SDK query that can trigger a lazy authority check.
    await vi.waitFor(
      () =>
        expect(f.sandbox.getTaskOutput(taskId)).toMatchObject({ completed: true, exitCode: 130 }),
      { timeout: 5000 }
    )
    await vi.waitFor(() => expect(LocalSandbox.hasActiveBackgroundTasks(f.threadId)).toBe(false), {
      timeout: 5000
    })
    expect(f.sandbox.getTaskOutput(taskId)?.output).not.toContain("real background output")
  },
  15000
)

it("refuses an SDK background start without the original run lease", async () => {
  const f = await fixture()
  releaseLocalThreadRunLease(f.threadId, "mods", "run")
  await expect(
    f.run({ tool: "execute", command: "node job.cjs", run_in_background: true })
  ).rejects.toThrow("MODS_BACKGROUND_OWNER_REQUIRED")
  expect(LocalSandbox.hasActiveBackgroundTasks(f.threadId)).toBe(false)
})

it("honors zero polling timeout and cancellation without publishing a late polling success", async () => {
  const f = await fixture()
  const taskId = await background(f)
  const timedOut = await f.run({ tool: "task_output", task_id: taskId, block: true, timeout: 0 })
  expect(timedOut.result).toMatchObject({ completed: false, retrieval_status: "timeout" })
  const reads = vi.spyOn(f.sandbox, "getTaskOutput")
  const result = f.run({ tool: "task_output", task_id: taskId, block: true, timeout: 10000 })
  const rejected = expect(result).rejects.toThrow(/CANCELLED|abort/i)
  await vi.waitFor(() => expect(reads).toHaveBeenCalled())
  f.controller.abort()
  await rejected
  const count = reads.mock.calls.length
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(reads).toHaveBeenCalledTimes(count)
}, 15000)

it("preserves mapped host runtime denial for both permission queries and actual calls", async () => {
  const f = await fixture(new Set(["execute"]))
  const input = { command: "node job.cjs", run_in_background: true }
  expect(await f.run({ check: true, tool: "execute", input })).toMatchObject({
    decision: "deny",
    reason: "MODS_RUNTIME_TOOL_DENIED"
  })
  await expect(f.run({ tool: "execute", ...input })).rejects.toThrow("MODS_RUNTIME_TOOL_DENIED")
  expect(f.manager.store.audit(f.manager.workspaceKey(f.workspace))).toHaveLength(0)
})

it("keeps managed execution foreground even when the SDK requests background mode", async () => {
  const f = await fixture(new Set(), true)
  const result = await f.run({ tool: "execute", command: "node job.cjs", run_in_background: true })
  expect(result.result).toMatchObject({
    exitCode: 0,
    output: expect.stringContaining("real background output")
  })
  expect(JSON.stringify(result)).not.toContain("Background task started")
}, 15000)

it("leaves the same real native background job working with Mods disabled", async () => {
  const f = await fixture()
  f.manager.configure(f.workspace, false, false)
  const started = await f.sandbox.executeBackground("node job.cjs")
  const taskId = started.match(/id:\s*([a-f0-9]+)/i)?.[1]
  expect(taskId).toBeTruthy()
  await vi.waitFor(
    () =>
      expect(f.sandbox.getTaskOutput(taskId!)).toMatchObject({
        completed: true,
        exitCode: 0,
        output: expect.stringContaining("real background output")
      }),
    { timeout: 5000 }
  )
  expect(f.manager.store.audit(f.manager.workspaceKey(f.workspace))).toHaveLength(0)
}, 15000)
