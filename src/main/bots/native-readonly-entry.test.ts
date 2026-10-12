import { afterEach, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { botShellTools } from "./shell-tools"
import { BotSkillHooks } from "./skill-hooks"
import { BotStore } from "./store"
import { BotWorkflowStore } from "./workflow-store"
import { BotArtifacts } from "./artifacts"
import { createTrustedBotShellTestRunner } from "./shell-owned-test-fixture"
import { BotShellJobs } from "./shell-jobs"
import type { BotRuntimeRequest } from "./host"
import type { BotModelSnapshot } from "./model-config"
import type { BotShellRequest } from "./shell-contract"
import type { BotRuntimeOwnedHook } from "./runtime-hooks"

const shared = vi.hoisted(() => ({ snapshot: undefined as BotModelSnapshot | undefined }))
vi.mock("./model-config", async (original) => ({
  ...(await original<typeof import("./model-config")>()),
  readBotModelSnapshot: async () => shared.snapshot
}))
const cleanup: Array<() => void | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
async function fixture(childReadOnly = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-readonly-entry-")))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const host = join(directory, "host"),
    workspace = join(directory, "project")
  await mkdir(host, { mode: 0o700 })
  await mkdir(workspace)
  const store = new BotStore(join(host, "bots.sqlite"))
  cleanup.push(() => store.close())
  const owner = store.createBot({ nonce: "owner", name: "ReadOnly", workspacePath: workspace })
  store.send({ nonce: "task", conversationId: owner.conversationId, text: "Inspect" })
  let claimed = store.claim("host")!
  if (childReadOnly) {
    const workflow = BotWorkflowStore.open(store, claimed.lease, "workflow", {
      script: 'export const meta={name:"Read",description:"Inspect"}; return await agent("task");',
      maxConcurrency: 1,
      defaultModelId: "test",
      agentProfiles: [],
      authority: { workspace }
    })
    const child = store.workflowChildren.claim(workflow, claimed.lease, {
      prompt: "Inspect",
      label: "Read only",
      phase: null,
      agentIndex: 0,
      toolStreamKey: `${"a".repeat(64)}_c0`,
      durableCallKey: `${"a".repeat(64)}_n0`,
      shellAccess: "read_only"
    })
    claimed = { run: child.run, lease: child.lease! }
  }
  const request: BotRuntimeRequest = {
    ...claimed,
    bot: owner.bot,
    store,
    messages: [],
    signal: new AbortController().signal
  }
  const snapshot: BotModelSnapshot = {
    version: 1,
    defaultRef: null,
    models: [],
    execution: { windowsSandbox: "readonly", resourceDirectory: directory }
  }
  shared.snapshot = snapshot
  const shell = await createTrustedBotShellTestRunner(cleanup)
  const calls: BotShellRequest[] = []
  vi.spyOn(shell, "execute").mockImplementation(async (input, _signal, _progress, guard) => {
    await guard?.(new AbortController().signal)
    calls.push(input)
    return {
      exitCode: 0,
      output: "inspected",
      truncated: false,
      ...(input.hook ? { hook: { stdout: "{}", stderr: "" } } : {})
    }
  })
  const check = () => store.assertLease(claimed.lease)
  const authorize = async (_id: string, action: unknown) => {
    const approval = store.requestInteraction(claimed.lease, {
      kind: "approval",
      prompt: "Inspect",
      action
    })
    store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    return approval.id
  }
  const approve = async (
    id: string,
    action: unknown,
    operation: () => Promise<string>,
    beforeStart?: () => Promise<void>
  ) => {
    const approvalId = await authorize(id, action)
    await beforeStart?.()
    store.beginEffect(claimed.lease, { id, action, approvalId })
    const output = await operation()
    store.settleEffect(claimed.lease, id, "succeeded", output)
    return output
  }
  const files = new BotArtifacts(join(host, "files"), store)
  cleanup.push(() => files.close())
  const jobs = new BotShellJobs(request, shell)
  cleanup.push(() => jobs.close())
  return {
    request,
    snapshot,
    shell,
    calls,
    check,
    approve,
    authorize,
    files,
    jobs,
    workspace,
    modelFile: join(host, "models.private")
  }
}

it.each([false, true])(
  "the real Windows %s-background shell tool keeps configured readonly in its dispatched request",
  async (background) => {
    const f = await fixture()
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { ...platform, value: "win32" })
    try {
      const tools = botShellTools(
        f.request,
        f.modelFile,
        f.snapshot.execution,
        f.files,
        f.check,
        f.approve,
        f.shell,
        { jobs: f.jobs, authorize: f.authorize }
      )
      await tools[0].invoke({
        type: "tool_call",
        id: "read-command",
        name: "execute",
        args: { command: "Get-ChildItem", timeout_seconds: 2, run_in_background: background }
      })
      if (background) {
        for (let attempt = 0; attempt < 100 && !f.calls.length; attempt++)
          await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(f.calls).toHaveLength(1)
      expect(f.calls[0]).toMatchObject({
        readOnly: true,
        execution: { windowsSandbox: "readonly" }
      })
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  }
)

it.each(["linux", "win32"] as const)(
  "a real read-only workflow child stays read-only on %s",
  async (os) => {
    const f = await fixture(true)
    f.snapshot.execution!.windowsSandbox = "elevated"
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { ...platform, value: os })
    try {
      const tools = botShellTools(
        f.request,
        f.modelFile,
        f.snapshot.execution,
        f.files,
        f.check,
        f.approve,
        f.shell
      )
      await tools[0].invoke({
        type: "tool_call",
        id: "read-command",
        name: "execute",
        args: { command: os === "win32" ? "Get-ChildItem" : "ls", timeout_seconds: 2 }
      })
      expect(f.calls).toHaveLength(1)
      expect(f.calls[0].readOnly).toBe(true)
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  }
)

it("a Windows workspace command Hook keeps configured readonly in its actual shell request", async () => {
  const f = await fixture()
  const hooks = new BotSkillHooks(f.request, f.modelFile, f.snapshot, f.shell, f.check, f.approve)
  const hook: BotRuntimeOwnedHook = {
    configured: true,
    owner: "workspace",
    ownerId: "workspace",
    ownerName: "Workspace",
    skillId: "configured:workspace",
    skillVersion: "a".repeat(64),
    skillName: "Workspace",
    id: "inspect",
    enabled: true,
    event: "PreToolUse",
    type: "command",
    command: "Get-ChildItem",
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
    hookSourceType: "workspace",
    hookSourceRoot: f.workspace
  }
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...platform, value: "win32" })
  try {
    await hooks["execute"]({
      hook,
      event: "PreToolUse",
      context: { toolCallId: "inspect-hook" },
      env: {},
      payload: "{}",
      timeoutMs: 2000
    })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({ readOnly: true, execution: { windowsSandbox: "readonly" } })
  } finally {
    Object.defineProperty(process, "platform", platform)
  }
})

it.each(["linux", "win32"] as const)(
  "a read-only workflow child cannot acquire a command Hook write scope on %s",
  async (os) => {
    const f = await fixture(true)
    f.snapshot.execution!.windowsSandbox = "elevated"
    const hooks = new BotSkillHooks(f.request, f.modelFile, f.snapshot, f.shell, f.check, f.approve)
    const hook: BotRuntimeOwnedHook = {
      configured: true,
      owner: "workspace",
      ownerId: "workspace",
      ownerName: "Workspace",
      skillId: "configured:workspace",
      skillVersion: "a".repeat(64),
      skillName: "Workspace",
      id: "inspect",
      enabled: true,
      event: "PreToolUse",
      type: "command",
      command: "echo mutate",
      createdAt: "2026-10-06T00:00:00.000Z",
      updatedAt: "2026-10-06T00:00:00.000Z",
      hookSourceType: "workspace",
      hookSourceRoot: f.workspace
    }
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { ...platform, value: os })
    try {
      await expect(
        hooks["execute"]({
          hook,
          event: "PreToolUse",
          context: { toolCallId: "inspect-hook" },
          env: {},
          payload: "{}",
          timeoutMs: 2000
        })
      ).rejects.toMatchObject({ code: "workflow_child_hook" })
      expect(f.calls).toHaveLength(0)
      expect(f.request.store.effects(f.request.run.id)).toEqual([])
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  }
)

it("the Windows-only setting does not impose a Linux host global read-only mode", async () => {
  const f = await fixture()
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { ...platform, value: "linux" })
  try {
    const tools = botShellTools(
      f.request,
      f.modelFile,
      f.snapshot.execution,
      f.files,
      f.check,
      f.approve,
      f.shell
    )
    await tools[0].invoke({
      type: "tool_call",
      id: "read-command",
      name: "execute",
      args: { command: "echo writable", timeout_seconds: 2 }
    })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].readOnly).toBe(false)
  } finally {
    Object.defineProperty(process, "platform", platform)
  }
})
