import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { WorkflowWorktreeLedger } from "./worktree-lease"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { FunctionModsManager } from "../../mods/v2/manager"
import { FunctionGuestRuntime } from "../../mods/v2/guest-runtime"
import { ModControlStore } from "../../mods/control-store"
import { ModCommandQueue } from "../../mods/command-queue"
import { runPlatformUserAction } from "../../mods/v2/platform-user-action"
import {
  createWorkflowDeterministicActionRunner,
  verifyWorkflowDeadlineReceipt,
  type WorkflowActionParent,
  type WorkflowDeterministicActionDependencies
} from "./deterministic-action"
import type { ModObject } from "../../../shared/mods/types"
import {
  currentWorkflowWorktreeActionScope,
  withWorkflowWorktreeActionScope
} from "./worktree-action-scope"
import {
  configureWorkflowDeterministicActions,
  observeWorkflowDeterministicActions
} from "./deterministic-action-native"
import type { NativePlatformCallContext } from "../../mods/v2/platform-capabilities-types"

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closes.splice(0).reverse()) await close()
})
async function fixture(
  resourceProbe = false,
  afterProcessApproval?: () => Promise<void>,
  beforePublication?: () => Promise<void>
) {
  const incarnation = JSON.stringify({ token: null, legacyCreatedAt: 1 })
  const root = await mkdtemp(join(tmpdir(), "workflow-actions-"))
  closes.push(() => rm(root, { recursive: true, force: true }))
  const plugin = join(root, "provider")
  await mkdir(join(plugin, "hooks"), { recursive: true })
  await writeFile(
    join(plugin, "plugin.json"),
    JSON.stringify({
      name: "provider",
      version: "1.0.0",
      claw: {
        actions: [
          {
            id: "run",
            name: "Execute",
            platform: { id: "delivery", version: "1.0.0", action: "run" },
            inputSchema: {
              type: "object",
              additionalProperties: false,
              required: ["value"],
              properties: { value: { type: "string" } }
            },
            outputSchema: { type: "object" }
          }
        ]
      }
    })
  )
  await writeFile(join(plugin, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(
    join(plugin, "hooks/register.ts"),
    `export function register(on) {
    on.capability({apiVersion:"devclaw.capability/v1",id:"delivery",version:"1.0.0",title:"Delivery",
      scope:"conversation",stateSchema:{type:"object"},actions:[{id:"run",title:"Run",
      inputSchema:{type:"object"},outputSchema:{type:"object"},
      requiredPermissions:["store.get","store.set"${resourceProbe ? ',"session.cwd","fs.read","process.run"' : ""}],cancellable:true,idempotency:"keyed"}]}, {
      act: async ($,event) => { const count=Number(await $.store.get("count")||0)+1;
        await $.store.set("count",count);
        ${resourceProbe ? `const probe={cwd:await $.session.cwd(),file:await $.fs.read("probe.txt"),process:await $.process.run(${JSON.stringify([process.execPath, "-e", "require('fs').writeFileSync('verification-process-ran','build output');process.stdout.write(process.cwd())"])})};` : "const probe={};"}
        return {status:"succeeded",text:"actual native action",output:{count,...probe,
          received:event.input.input.value,executionId:event.input.executionId,parentRunId:event.input.runId}}; }
    });
  }`
  )
  const sources = [{ id: "provider-installation", name: "provider", path: plugin, enabled: true }]
  async function open() {
    const store = new ModControlStore(join(root, "state.sqlite"))
    const queue = new ModCommandQueue(store, () => {})
    const guests: FunctionGuestRuntime[] = []
    const manager = new FunctionModsManager(
      store,
      {
        plugins: () => sources,
        enabled: () => true,
        clawApplicable: () => true,
        changed: () => {},
        threadIncarnationKey: () => incarnation,
        ...(resourceProbe
          ? ({
              fileScope: (workspace: string, threadId: string) => {
                const scope = currentWorkflowWorktreeActionScope(workspace, threadId)
                return {
                  workspace: scope?.boundary.workspaceRoot ?? root,
                  assertLive: () => scope?.assertCurrent(),
                  queryTool: async () => ({ decision: "allow" as const })
                }
              },
              authorizeProcess: async (workspace: string, threadId: string) => {
                const scope = currentWorkflowWorktreeActionScope(workspace, threadId)
                if (!scope) throw Error("RESOURCE_SCOPE_MISSING")
                scope.assertCurrent()
                await afterProcessApproval?.()
              },
              runEffect: async (_workspace, _thread, _grant, _method, _input, _signal, run) => run()
            } satisfies Partial<ConstructorParameters<typeof FunctionModsManager>[1]>)
          : {}),
        publish: async (_workspace, value) => {
          await beforePublication?.()
          return value
        }
      },
      () => ({
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          return guest
        },
        stop() {
          guests.forEach((guest) => guest.dispose())
        },
        async stopAndDrain() {
          guests.forEach((guest) => guest.dispose())
        }
      })
    )
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      queue.close()
      manager.close()
      guests.forEach((guest) => guest.dispose())
      await new Promise<void>((done) => setImmediate(done))
      store.close()
    }
    closes.push(close)
    for (const source of await manager.status(root))
      if (source.state !== "ready") await manager.approve(root, source.pluginId, source.digest!)
    const descriptor = (await manager.actionCatalog(root, "thread"))[0]
    const provider = {
      pluginId: descriptor.pluginId,
      plugin: descriptor.plugin,
      digest: descriptor.digest,
      actionId: descriptor.actionId
    }
    const controller = new AbortController()
    const parent: WorkflowActionParent = {
      workspace: root,
      threadId: "thread",
      incarnation,
      runId: "wf_actions",
      scriptSha256: "a".repeat(64),
      args: { mode: "original" },
      signal: controller.signal,
      assertCurrent: vi.fn()
    }
    const dependencies: WorkflowDeterministicActionDependencies = {
      functions: manager,
      store: store.functionState,
      runOwned: (scope, work) =>
        runPlatformUserAction(
          queue,
          { functionUserScope: () => ({}) },
          scope.workspace,
          scope.threadId,
          scope.signal,
          scope.assertCurrent,
          work
        )
    }
    const input = { stepId: "deliver", provider, input: { value: "original" } }
    const runner = createWorkflowDeterministicActionRunner(dependencies, parent)
    const call = (value: unknown = input) => runner(value, undefined, controller.signal)
    return { store, manager, dependencies, parent, controller, input, runner, call, close }
  }
  return { root, sources, open }
}

it("calls the actual exported platform action and reuses its original durable result after restart", async () => {
  const fixtureValue = await fixture(),
    first = await fixtureValue.open()
  const result = await first.call()
  expect(result).toMatchObject({
    parentRunId: "wf_actions",
    stepId: "deliver",
    status: "succeeded",
    output: { count: 1, parentRunId: "wf_actions", received: "original" }
  })
  expect((result.output as ModObject).executionId).toBe(result.executionId)
  await first.close()
  const cold = await fixtureValue.open()
  expect(await cold.call()).toEqual(result)
  expect(await cold.call({ ...cold.input, stepId: "other" })).toMatchObject({
    output: { count: 2 }
  })
})

it("verifies deadline success only from the original resource, budget and platform receipt", async () => {
  const f = await (await fixture()).open()
  const handle = "11111111-1111-4111-8111-111111111111"
  f.parent.runResource = async (_handle, work, budgetId) => {
    expect(budgetId).toBe("batch-1")
    return work()
  }
  const result = await f.call({ ...f.input, resourceHandle: handle, deadlineBudgetId: "batch-1" })
  const verify = (budgetId: string, owner = f.parent, resource = handle) =>
    verifyWorkflowDeadlineReceipt(f.store.functionState, owner, resource, budgetId, String(result.executionId))
  expect(verify("batch-1")).toBe(true)
  expect(verify("batch-2")).toBe(false)
  expect(verify("batch-1", { ...f.parent, runId: "another-run" })).toBe(false)
  expect(verify("batch-1", f.parent, "22222222-2222-4222-8222-222222222222")).toBe(false)
})

it.each(["script", "args", "input", "provider"])(
  "refuses changing %s on a stable parent/step instead of issuing a fresh side effect",
  async (changed) => {
    const f = await (await fixture()).open()
    await f.call()
    const parent = {
      ...f.parent,
      ...(changed === "script" ? { scriptSha256: "b".repeat(64) } : {}),
      ...(changed === "args" ? { args: { mode: "changed" } } : {})
    }
    const runner = createWorkflowDeterministicActionRunner(f.dependencies, parent)
    const input = {
      ...f.input,
      ...(changed === "input" ? { input: { value: "different" } } : {}),
      ...(changed === "provider" ? { provider: { ...f.input.provider, actionId: "other" } } : {})
    }
    await expect(runner(input, undefined, f.controller.signal)).rejects.toThrow("IDENTITY_CONFLICT")
    expect(await f.call()).toMatchObject({ output: { count: 1 } })
  }
)

it("binds child operations to stable source identity and refuses changed child bytes", async () => {
  const f = await (await fixture()).open()
  const child = { identity: "child-source", scriptSha256: "c".repeat(64) }
  const result = await f.runner(f.input, child, f.controller.signal)
  expect(await f.runner(f.input, child, f.controller.signal)).toEqual(result)
  await expect(
    f.runner(f.input, { ...child, scriptSha256: "d".repeat(64) }, f.controller.signal)
  ).rejects.toThrow("IDENTITY_CONFLICT")
})

it("keeps a lost native settlement unknown across a cold restart and never reruns its effect", async () => {
  const fixtureValue = await fixture(),
    first = await fixtureValue.open()
  const write = first.store.functionState.set.bind(first.store.functionState)
  const lost = vi
    .spyOn(first.store.functionState, "set")
    .mockImplementation((namespace, key, value) => {
      if (
        key.startsWith("action:") &&
        (value as ModObject).result &&
        ((value as ModObject).result as ModObject).status !== "running"
      )
        throw Error("LOST_NATIVE_SETTLEMENT")
      write(namespace, key, value)
    })
  await expect(first.call()).rejects.toThrow("LOST_NATIVE_SETTLEMENT")
  lost.mockRestore()
  await first.close()
  const cold = await fixtureValue.open()
  await expect(cold.call()).rejects.toMatchObject({ code: "CLAW_ACTION_PLATFORM_UNSETTLED" })
  expect(await cold.call({ ...cold.input, stepId: "different-operation" })).toMatchObject({
    output: { count: 2 }
  })
})

it("never invokes a legacy command route without a durable platform receipt", async () => {
  const f = await (await fixture()).open()
  const prepared = await f.manager.prepareAction(
    f.parent.workspace,
    "thread",
    f.input.provider,
    f.controller.signal
  )
  vi.spyOn(f.manager, "prepareAction").mockResolvedValue({ ...prepared, route: "command" } as never)
  const execute = vi.spyOn(f.manager, "runAction")
  await expect(f.call()).rejects.toThrow("PLATFORM_ROUTE_REQUIRED")
  expect(execute).not.toHaveBeenCalled()
})

it("rejects invented parent IDs, authority and execution IDs before provider admission", async () => {
  const f = await (await fixture()).open()
  const prepare = vi.spyOn(f.manager, "prepareAction")
  for (const extra of [
    { runId: "foreign" },
    { executionId: "forged" },
    { approved: true },
    { threadId: "foreign" }
  ])
    await expect(f.call({ ...f.input, ...extra })).rejects.toThrow("INPUT_INVALID")
  expect(prepare).not.toHaveBeenCalled()
})

it("rechecks original provider grants on replay", async () => {
  const fixtureValue = await fixture(),
    f = await fixtureValue.open()
  await f.call()
  fixtureValue.sources[0].enabled = false
  await expect(f.call()).rejects.toThrow()
})

it("reads the original durable resource receipt after sealing without reacquiring a write lease", async () => {
  const f = await (await fixture()).open()
  const use = vi.fn(async (_handle: string, work: () => Promise<unknown>) => work())
  f.parent.runResource = use as NonNullable<WorkflowActionParent["runResource"]>
  const input = { ...f.input, resourceHandle: "12345678-1234-4234-8234-123456789abc" }
  const first = await f.call(input)
  use.mockRejectedValue(Error("SEALED_NOT_WRITABLE"))
  expect(await f.call(input)).toEqual(first)
  expect(use).toHaveBeenCalledTimes(1)
})

it("cannot replace a sealed resource receipt lost between replay admission and native dispatch", async () => {
  const f = await (await fixture()).open()
  f.parent.runResource = (_handle, work) => work()
  const input = { ...f.input, resourceHandle: "12345678-1234-4234-8234-123456789abc" }
  await f.call(input)
  const namespace = JSON.stringify([
    "native.platform/v1",
    f.parent.workspace,
    f.parent.threadId,
    f.parent.incarnation
  ])
  const prepare = f.manager.prepareAction.bind(f.manager)
  const spy = vi.spyOn(f.manager, "prepareAction").mockImplementationOnce(async (...args) => {
    for (const key of f.store.functionState.keys(namespace))
      if (key.startsWith("action:")) f.store.functionState.delete(namespace, key)
    return prepare(...args)
  })
  await expect(f.call(input)).rejects.toThrow("WORKFLOW_ACTION_RECEIPT_DISAPPEARED")
  spy.mockRestore()
  expect(await f.call({ ...f.input, stepId: "different-operation" })).toMatchObject({
    output: { count: 2 }
  })
})

it("projects original platform receipts and immutable provider identities without trusting workflow result JSON", async () => {
  const fixtureValue = await fixture(),
    f = await fixtureValue.open()
  const result = await f.call()
  const close = configureWorkflowDeterministicActions({
    ...f.dependencies,
    workspaceKey: (value) => value,
    thread: () => ({ created_at: 1, metadata: "{}" })
  })
  closes.push(async () => close())
  const context = {
    workspace: fixtureValue.root,
    threadId: "thread",
    incarnation: f.parent.incarnation,
    assertCurrent: () => {}
  } as NativePlatformCallContext
  expect(observeWorkflowDeterministicActions(context, f.parent.runId)).toMatchObject({
    actionCount: 1,
    deterministicActions: [
      {
        stepId: "deliver",
        executionId: result.executionId,
        provider: f.input.provider,
        status: "succeeded",
        output: { count: 1 }
      }
    ]
  })
})

it("keeps a native resource scope through the real queue, guest callbacks, files and actual process launch", async () => {
  const fixtureValue = await fixture(true),
    f = await fixtureValue.open()
  const directory = join(fixtureValue.root, "isolated")
  await mkdir(directory)
  await writeFile(join(directory, "probe.txt"), "resource-file")
  await writeFile(join(fixtureValue.root, "probe.txt"), "wrong-parent-file")
  f.parent.runResource = (_handle, work) =>
    withWorkflowWorktreeActionScope(
      {
        workspace: fixtureValue.root,
        threadId: "thread",
        runId: f.parent.runId,
        boundary: {
          workspaceRoot: directory,
          worktreeRoot: directory,
          commonDir: join(fixtureValue.root, ".git"),
          branch: "workflow/resource"
        },
        assertCurrent: () => f.controller.signal.throwIfAborted()
      },
      work
    )
  const result = await f.call({
    ...f.input,
    resourceHandle: "12345678-1234-4234-8234-123456789abc"
  })
  expect(result.output).toMatchObject({
    cwd: directory,
    file: "resource-file",
    process: { stdout: directory, exitCode: 0 }
  })
})

it("verifies promoted declared repositories through original Guest/process receipts and rejects changed authority or HEAD", async () => {
  let afterApproval: (() => Promise<void>) | undefined
  let beforePublication: (() => Promise<void>) | undefined
  const fixtureValue = await fixture(true, async () => afterApproval?.(),
    async () => beforePublication?.()), f = await fixtureValue.open()
  const other = await mkdtemp(join(tmpdir(), "workflow-verification-other-"))
  closes.push(() => rm(other, { recursive: true, force: true }))
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args],
    { encoding: "utf8", windowsHide: true }).trim()
  for (const directory of [fixtureValue.root, other]) {
    git(directory, "init", "--initial-branch=main")
    git(directory, "config", "user.name", "Verification Test")
    git(directory, "config", "user.email", "verify@example.test")
    git(directory, "config", "core.autocrlf", "false")
    await writeFile(join(directory, ".gitignore"), "*\n")
    await writeFile(join(directory, "probe.txt"), directory === other ? "secondary-base" : "primary-base")
    git(directory, "add", "-f", ".gitignore", "probe.txt")
    git(directory, "commit", "-m", "base")
  }
  const resources = { profiles: [], workspaces: [{ id: "secondary", path: other }], fingerprint: "b".repeat(64) }
  let authorized = true
  const guard = () => { f.controller.signal.throwIfAborted(); if (!authorized) throw Error("SOURCE_REVOKED") }
  const ledger = new WorkflowWorktreeLedger({ workspacePath: fixtureValue.root,
    executionResources: resources, runId: f.parent.runId, threadId: "thread", parentIdentity: "c".repeat(64),
    signal: f.controller.signal, appDataRoot: join(fixtureValue.root, "app"),
    integrate: async (_root, work) => work(), approveMerge: async () => true })
  closes.push(() => ledger.reclaimAll())
  f.parent.assertCurrent = guard
  f.parent.runVerificationResource = (request, work) => ledger.useVerificationResource(
    request.handle, request.expectedCommit, guard,
    scope => withWorkflowWorktreeActionScope({ ...scope, workspace: fixtureValue.root,
      threadId: "thread", runId: f.parent.runId }, work))
  const promoted: Array<{ handle: string; expectedCommit: string; workspace: string }> = []
  for (const [index, workspaceRef] of [undefined, "secondary"].entries()) {
    const resource = await ledger.acquireResource(String(index + 1).repeat(64), "d".repeat(64), workspaceRef)
    let commit = ""
    await ledger.useResource(resource.handle, async info => {
      await writeFile(join(info.workspaceDirectory, "probe.txt"), `promoted-${index}`)
      git(info.directory, "add", "-f", "probe.txt")
      git(info.directory, "commit", "-m", "deliver")
      commit = git(info.directory, "rev-parse", "HEAD")
    })
    await ledger.resourceCommand(resource.handle, "seal", commit)
    await expect(f.call({ ...f.input, stepId: `unpromoted-${index}`,
      verificationResource: { handle: resource.handle, expectedCommit: commit } })).rejects.toThrow("NOT_PROMOTED")
    const merged = await ledger.resourceCommand(resource.handle, "merge", commit)
    const target = { handle: resource.handle, expectedCommit: merged.integrationCommit!,
      workspace: workspaceRef ? other : fixtureValue.root }
    promoted.push(target)
    const input = { ...f.input, stepId: `verify-${index}`,
      verificationResource: { handle: target.handle, expectedCommit: target.expectedCommit } }
    const first = await f.call(input)
    expect(first.output).toMatchObject({ cwd: target.workspace, file: `promoted-${index}`,
      process: { stdout: target.workspace, exitCode: 0 } })
    expect(await f.call(input)).toEqual(first)
    await expect(ledger.useResource(target.handle, async () => {})).rejects.toThrow("NOT_WRITABLE")
  }
  const target = promoted[1], request = { handle: target.handle, expectedCommit: target.expectedCommit }
  const foreign = new WorkflowWorktreeLedger({ workspacePath: fixtureValue.root,
    executionResources: resources, runId: "wf_other", threadId: "thread", parentIdentity: "c".repeat(64) })
  await expect(foreign.useVerificationResource(request.handle, request.expectedCommit, guard,
    async () => {})).rejects.toThrow("HANDLE_INVALID")
  authorized = false
  await expect(f.call({ ...f.input, stepId: "revoked", verificationResource: request })).rejects.toThrow("SOURCE_REVOKED")
  authorized = true
  await rm(join(other, "verification-process-ran"))
  afterApproval = async () => { authorized = false }
  await expect(f.call({ ...f.input, stepId: "approval-revoked", verificationResource: request })).rejects.toThrow()
  afterApproval = undefined
  authorized = true
  await expect(readFile(join(other, "verification-process-ran"))).rejects.toMatchObject({ code: "ENOENT" })
  await writeFile(join(other, "probe.txt"), "uncommitted source edit")
  await expect(f.call({ ...f.input, stepId: "dirty-source", verificationResource: request })).rejects.toThrow("HEAD_CHANGED")
  await writeFile(join(other, "probe.txt"), "promoted-1")
  afterApproval = async () => { git(other, "commit", "--allow-empty", "-m", "changed-during-approval") }
  await expect(f.call({ ...f.input, stepId: "approval-head-change", verificationResource: request })).rejects.toThrow()
  afterApproval = undefined
  await expect(readFile(join(other, "verification-process-ran"))).rejects.toMatchObject({ code: "ENOENT" })
  await expect(f.call({ ...f.input, stepId: "changed-head", verificationResource: request })).rejects.toThrow("HEAD_CHANGED")
  const primary = promoted[0]
  beforePublication = async () => {
    beforePublication = undefined
    git(primary.workspace, "commit", "--allow-empty", "-m", "changed-before-publication")
  }
  await expect(f.call({ ...f.input, stepId: "publication-head-change",
    verificationResource: { handle: primary.handle, expectedCommit: primary.expectedCommit } })).rejects.toThrow()
  const close = configureWorkflowDeterministicActions({ ...f.dependencies, workspaceKey: value => value,
    thread: () => ({ created_at: 1, metadata: "{}" }) })
  closes.push(async () => close())
  const context = { workspace: fixtureValue.root, threadId: "thread",
    incarnation: f.parent.incarnation, assertCurrent: () => {} } as NativePlatformCallContext
  const rows: ModObject[] = []
  let offset = 0
  for (;;) {
    const page = observeWorkflowDeterministicActions(context, f.parent.runId, offset)
    rows.push(...page.deterministicActions as ModObject[])
    if (page.nextActionOffset === null) break
    expect(page.nextActionOffset).toBeGreaterThan(offset)
    offset = Number(page.nextActionOffset)
  }
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ stepId: "verify-1", status: "succeeded",
      verificationResource: expect.objectContaining({ workspaceRef: "secondary", expectedCommit: target.expectedCommit }) }),
    expect.objectContaining({ stepId: "approval-head-change", status: "unknown" }),
    expect.objectContaining({ stepId: "publication-head-change", status: "unknown" })
  ]))
}, 60000)

it("propagates parent cancellation and rejects an action result arriving after cancellation", async () => {
  const f = await (await fixture()).open()
  let finish!: () => void, entered!: () => void
  const ready = new Promise<void>((resolveReady) => {
    entered = resolveReady
  })
  vi.spyOn(f.manager, "runAction").mockImplementation(
    async (_workspace, _thread, _prepared, _envelope, signal) => {
      entered()
      await new Promise<void>((resolveResult) => {
        finish = resolveResult
      })
      expect(signal.aborted).toBe(true)
      return { passed: true, text: "late actual result" }
    }
  )
  const pending = f.call()
  await ready
  f.controller.abort()
  finish()
  await expect(pending).rejects.toThrow()
})
