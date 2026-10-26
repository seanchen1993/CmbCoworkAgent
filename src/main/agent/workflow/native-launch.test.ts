import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { AIMessage } from "@langchain/core/messages"
import type { WorkflowSubagentDeps } from "./subagent"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
vi.mock("../../db", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../db")>(),
  getPersistedThreadWorkspaceBindings: () => []
}))
vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => "workflow-native-test",
    getVersion: () => "2.0.0"
  },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] },
  ipcMain: { handle: () => {}, on: () => {} }
}))
import { registerNativeWorkflowLaunch, executeNativeWorkflowLaunch } from "./native-launch"
import { ApprovalStore } from "../approval-store"
import { workflowRunManager } from "./run-manager"
import { loadWorkflowRunAsync } from "./run-store"
import type { NativePlatformCallContext } from "../../mods/v2/platform-capabilities-types"
import type { ApprovalDecision } from "../../types"
import { parseRetainedAgentProfile } from "../agent-registry"

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
})
async function fixture(executionResources?: import("../../plugins/runtime-source-scope").RuntimeExecutionResources) {
  const root = await mkdtemp(join(tmpdir(), "wf-native-launch-"))
  closes.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv("CMB_COWORK_AGENT_HOME", join(root, "data"))
  let current = true
  const context = {
    workspace: root,
    threadId: "native-thread",
    incarnation: "native-incarnation",
    generation: "native-generation",
    caller: {
      name: "example",
      provider: "example",
      digest: "a".repeat(64),
      generation: "plugin-generation"
    },
    signal: new AbortController().signal,
    assertCurrent: () => {
      if (!current) throw Error("STALE_NATIVE_CALLER")
    },
    publish: () => {},
    invoke: vi.fn()
  } as NativePlatformCallContext
  const approve = vi.fn(
    async (): Promise<ApprovalDecision> => ({ type: "approve", tool_call_id: "native-test" })
  )
  const model = vi.fn<WorkflowSubagentDeps["createRuntime"]>(async () => {
    throw Error("MODEL_MUST_NOT_RUN")
  })
  const close = registerNativeWorkflowLaunch(
    {
      executionResources,
      threadId: context.threadId,
      workspacePath: root,
      readYoloMode: () => true,
      approvalStore: new ApprovalStore(),
      requestApproval: approve,
      agentProfiles: [],
      subagentDeps: {
        createRuntime: model,
        cleanupThread: async () => {},
        isRetryableApiError: () => false
      }
    },
    context.assertCurrent
  )
  closes.push(async () => {
    close()
    const id = workflowRunManager.activeRunId(context.threadId)
    if (id) {
      workflowRunManager.cancel(context.threadId, id)
      await workflowRunManager.waitForRunLifecycle(context.threadId, id)
    }
  })
  const script =
    'export const meta={name:"native-test",description:"deterministic"}; return {evidence:"actual engine"}'
  return {
    root,
    context,
    approve,
    model,
    script,
    stale: () => {
      current = false
    }
  }
}

it("native start and resume use the actual approved workflow tool and original run manager", async () => {
  const f = await fixture()
  const result = await executeNativeWorkflowLaunch(f.context, "start", { script: f.script })
  expect(result.status).toBe("launched")
  await workflowRunManager.waitForRunLifecycle(f.context.threadId, String(result.runId))
  const run = await loadWorkflowRunAsync(f.root, f.context.threadId, String(result.runId))
  expect(run).toMatchObject({
    status: "completed",
    result: { evidence: "actual engine" },
    nativeParent: { provider: "example", digest: f.context.caller.digest }
  })
  expect(f.approve).toHaveBeenCalledTimes(1)
  expect(f.model).not.toHaveBeenCalled()
  const resumed = await executeNativeWorkflowLaunch(f.context, "resume", { runId: result.runId })
  expect(resumed.runId).toBe(result.runId)
  await workflowRunManager.waitForRunLifecycle(f.context.threadId, String(result.runId))
})

it("native launch uses the original manager for named agent reuse, merge approval and cold journal replay", async () => {
  const f = await fixture()
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim()
  git(f.root, "init", "--initial-branch=main")
  git(f.root, "config", "user.name", "Native Workflow Test")
  git(f.root, "config", "user.email", "native@example.test")
  git(f.root, "config", "core.autocrlf", "false")
  await writeFile(join(f.root, ".gitignore"), "data/\n")
  git(f.root, "add", ".gitignore")
  git(f.root, "commit", "-m", "initial")
  const checkouts: string[] = []
  f.model.mockImplementation(async (options) => ({
    stream: async () =>
      (async function* () {
        const cwd = options.worktreeIsolation!.workspaceRoot
        checkouts.push(cwd)
        const name = `step-${checkouts.length}.txt`
        await writeFile(join(cwd, name), name)
        git(cwd, "add", name)
        git(cwd, "commit", "-m", name)
        yield ["values", { messages: [new AIMessage(git(cwd, "rev-parse", "HEAD"))] }]
      })()
  }))
  const script = `export const meta={name:"native resources",description:"reuse, seal and promote"};
    const r=await worktree({op:"acquire",resourceId:"code"});
    await agent("first",{resourceHandle:r.handle});
    const head=await agent("second",{resourceHandle:r.handle});
    await worktree({op:"seal",handle:r.handle,expectedCommit:head});
    return await worktree({op:"merge",handle:r.handle,expectedCommit:head});`
  const result = await executeNativeWorkflowLaunch(f.context, "start", { script })
  await workflowRunManager.waitForRunLifecycle(f.context.threadId, String(result.runId))
  const first = await loadWorkflowRunAsync(f.root, f.context.threadId, String(result.runId))
  expect(first).toMatchObject({ status: "completed", result: { status: "merged" } })
  expect(checkouts).toHaveLength(2)
  expect(checkouts[0]).toBe(checkouts[1])
  expect(f.approve).toHaveBeenCalledTimes(2)
  await executeNativeWorkflowLaunch(f.context, "resume", { runId: result.runId })
  await workflowRunManager.waitForRunLifecycle(f.context.threadId, String(result.runId))
  expect(
    await loadWorkflowRunAsync(f.root, f.context.threadId, String(result.runId))
  ).toMatchObject({
    status: "completed",
    result: { status: "merged" }
  })
  expect(f.model).toHaveBeenCalledTimes(2)
  expect(f.approve).toHaveBeenCalledTimes(3)
}, 60_000)

it("uses retained file-only profiles and native checkpoint commits through the actual engine and manager", async () => {
  const resources = { profiles: [parseRetainedAgentProfile("implement.md", `---
name: implementation-files
description: File editor
tools: Read, Write, Edit, Glob, Grep
---
Edit files`)],
    workspaces: [], fingerprint: "d".repeat(64) }
  const f = await fixture(resources)
  const git = (...args: string[]) => execFileSync("git", ["-C", f.root, ...args], { encoding: "utf8" }).trim()
  git("init", "--initial-branch=main"); git("config", "user.name", "Native Checkpoint")
  git("config", "user.email", "checkpoint@example.test"); git("config", "core.autocrlf", "false")
  await writeFile(join(f.root, ".gitignore"), "data/\n")
  git("add", "."); git("commit", "-m", "initial")
  const before = git("rev-parse", "HEAD")
  f.model.mockImplementation(async options => {
    expect(options.shellAccess).toBe("none")
    expect(options.toolAllowlist).toEqual(resources.profiles[0].toolAllowlist)
    return { stream: async () => (async function* () {
      await writeFile(join(options.worktreeIsolation!.workspaceRoot, "file.txt"), "file-only model\n")
      yield ["values", { messages: [new AIMessage("Changed file")] }]
    })() }
  })
  const script = `export const meta={name:"file only",description:"Native commit"};
    const r=await worktree({op:"acquire",resourceId:"code"});
    const result=await agent("implement",{agentType:"implementation-files",resourceHandle:r.handle,commitChanges:true});
    await worktree({op:"seal",handle:r.handle,expectedCommit:result.commitSha});
    await worktree({op:"merge",handle:r.handle,expectedCommit:result.commitSha}); return result;`
  const launched = await executeNativeWorkflowLaunch(f.context, "start", { script })
  await workflowRunManager.waitForRunLifecycle(f.context.threadId, String(launched.runId))
  const run = await loadWorkflowRunAsync(f.root, f.context.threadId, String(launched.runId))
  expect(run?.status, run?.error).toBe("completed")
  expect(run?.result).toMatchObject({ output: "Changed file", commitSha: expect.stringMatching(/^[a-f0-9]{40}$/) })
  expect(git("show", String((run!.result as { commitSha: string }).commitSha) + ":file.txt")).toBe("file-only model")
  expect(git("rev-parse", "HEAD")).not.toBe(before)
  await executeNativeWorkflowLaunch(f.context, "resume", { runId: launched.runId })
  await workflowRunManager.waitForRunLifecycle(f.context.threadId, String(launched.runId))
  expect(f.model).toHaveBeenCalledOnce()
  expect((await loadWorkflowRunAsync(f.root, f.context.threadId, String(launched.runId)))?.result).toEqual(run?.result)
}, 60_000)

it("a native rejection launches no run and cannot be overridden by guest approval fields", async () => {
  const f = await fixture()
  f.approve.mockResolvedValue({ type: "reject", tool_call_id: "native-test" })
  expect(await executeNativeWorkflowLaunch(f.context, "start", { script: f.script })).toEqual({
    status: "rejected"
  })
  expect(workflowRunManager.isActive(f.context.threadId)).toBe(false)
  await expect(
    executeNativeWorkflowLaunch(f.context, "start", { script: f.script, approved: true })
  ).rejects.toThrow()
})

it("rechecks the original caller after approval and rejects another provider's resume", async () => {
  const f = await fixture()
  const result = await executeNativeWorkflowLaunch(f.context, "start", { script: f.script })
  await workflowRunManager.waitForRunLifecycle(f.context.threadId, String(result.runId))
  await expect(
    executeNativeWorkflowLaunch(
      { ...f.context, caller: { ...f.context.caller, name: "other" } },
      "resume",
      { runId: result.runId }
    )
  ).rejects.toThrow("PARENT_MISMATCH")
  f.approve.mockImplementation(async () => {
    f.stale()
    return { type: "approve", tool_call_id: "native-test" }
  })
  await expect(
    executeNativeWorkflowLaunch(f.context, "start", { script: f.script + "\n// changed" })
  ).rejects.toThrow("STALE_NATIVE_CALLER")
})

it("the workspace migration guard rejects a resource lifecycle that starts after its read", async () => {
  const f = await fixture()
  const guard = await workflowRunManager.assertWorkspaceResourcesSettled(f.root)
  const result = await executeNativeWorkflowLaunch(f.context, "start", { script: f.script })
  await workflowRunManager.waitForRunLifecycle(f.context.threadId, String(result.runId))
  expect(() => guard.assertCurrent()).toThrow("RESOURCES_CHANGED")
  const settled = await workflowRunManager.assertWorkspaceResourcesSettled(f.root)
  expect(() => settled.assertCurrent()).not.toThrow()
})

it("an unrelated workspace launch does not invalidate a settled workspace guard", async () => {
  const f = await fixture()
  const other = await mkdtemp(join(tmpdir(), "wf-unrelated-"))
  closes.push(() => rm(other, { recursive: true, force: true }))
  const guard = await workflowRunManager.assertWorkspaceResourcesSettled(other)
  const result = await executeNativeWorkflowLaunch(f.context, "start", { script: f.script })
  await workflowRunManager.waitForRunLifecycle(f.context.threadId, String(result.runId))
  expect(() => guard.assertCurrent()).not.toThrow()
})

it("cancels native admission while approval is pending and ignores its later approval", async () => {
  const f = await fixture(),
    controller = new AbortController()
  let finish!: (value: ApprovalDecision) => void, entered!: () => void
  const ready = new Promise<void>((done) => {
    entered = done
  })
  f.approve.mockImplementation(() => {
    entered()
    return new Promise((done) => {
      finish = done
    })
  })
  const pending = executeNativeWorkflowLaunch(
    { ...f.context, signal: controller.signal },
    "start",
    { script: f.script }
  )
  const rejected = expect(pending).rejects.toThrow("CANCELLED")
  await ready
  controller.abort(Error("NATIVE_CALL_CANCELLED"))
  await rejected
  finish({ type: "approve", tool_call_id: "late" })
  await new Promise<void>((done) => setImmediate(done))
  expect(workflowRunManager.activeRunId(f.context.threadId)).toBeUndefined()
})
