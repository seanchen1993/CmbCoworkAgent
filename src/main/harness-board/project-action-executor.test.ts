import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import type { HostSkillExecutionContext } from "./project-runtime/host-service"
import type { HostProjectState } from "../../shared/project-runtime/host-types"
import type { FlowExecution } from "../mods/flows/contracts"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import { resolveClawActionInput } from "../../shared/mods/claw-actions"
import { hostProjectFixture } from "./project-runtime/host-fixtures.test-helper"
import { PROJECT_ACTION_LOCK_PATH } from "../../shared/project-runtime/action-bindings"
import { createProjectActionBinding } from "./project-runtime/action-input"
import { readHostActionCheckEvidence } from "./project-runtime/action-check-evidence"
import { publishOriginalFlowActionResult } from "../mods/flows/action-execution-facts"
import { wrapProjectRuntimeManifest, CONTEXT_HANDOFF_PROTOCOL } from "../../shared/project-runtime"
import { fingerprintHostStageInput, validateHostStage } from "./project-runtime/host-validators"
import { FlowManager } from "../mods/flows/manager"
import { FlowStore } from "../mods/flows/store"
import { isOrdinaryFlowMetadata } from "../../shared/mods/flows/scope"
import { projectActionFlowMetadata } from "./project-action-scope"
import { setProjectActionRuntime } from "./project-action-runtime"
import { FunctionModsManager } from "../mods/v2/manager"
import { readOriginalActionText } from "../mods/v2/action-result-text"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { ModControlStore } from "../mods/control-store"
import { captureProjectActionContentGuard } from "./project-action-scope"

const mock = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  snapshotRoot: "",
  provider: vi.fn(),
  skill: vi.fn()
}))
vi.mock("../db", () => ({
  getThreadCore: () => ({ created_at: 1, metadata: JSON.stringify(mock.metadata) })
}))
vi.mock("./host-skill-executor", () => ({ executeHostProjectSkill: mock.skill }))
vi.mock("./project-runtime/stage-recovery-context-provider", () => ({
  executeStageRecoveryContextProvider: mock.provider
}))
vi.mock("./project-runtime/package-snapshots", () => ({
  HostPackageSnapshots: class {
    read() {
      return { root: mock.snapshotRoot }
    }
  }
}))
import { executeHostProjectStage } from "./project-action-executor"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(
  execute?: FlowExecution["execute"],
  configureState?: (state: HostProjectState) => void,
  action?: ClawActionDescriptor
) {
  const root = mkdtempSync(join(tmpdir(), "project-stage-flow-"))
  roots.push(root)
  const state: HostProjectState = {
    ...hostProjectFixture(root),
    schemaVersion: 1,
    stateOwner: "host",
    version: 2,
    stageIndex: 1,
    status: "active",
    createdAt: 1,
    updatedAt: 1
  }
  state.manifest.artifacts[0].path = "input.json"
  writeFileSync(join(root, "input.json"), '{"text":"prior approved input"}')
  configureState?.(state)
  const descriptor: ClawActionDescriptor = action ?? {
    pluginId: "installed",
    plugin: "formatter",
    digest: "a".repeat(64),
    actionId: "format",
    name: "Format",
    command: "format",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" }
  }
  const bindings = ["first", "second"].map((id) => createProjectActionBinding(id, descriptor, {}))
  state.manifest.actions = bindings.map((item) => ({ id: item.id, ref: item.ref }))
  state.manifest.stages[1].actionIds = bindings.map((item) => item.id)
  writeFileSync(
    join(root, PROJECT_ACTION_LOCK_PATH),
    JSON.stringify({
      apiVersion: "devclaw.project-actions-lock/v1",
      bindings
    })
  )
  const controller = new AbortController()
  const ticket = {
    projectId: state.projectId,
    operationId: "operation",
    stageId: "review",
    expectedVersion: 2,
    inputFingerprint: fingerprintHostStageInput(state, state.goal),
    pluginDigest: state.pluginDigest
  }
  const recordTerminal = vi.fn()
  const context: HostSkillExecutionContext = {
    project: state,
    operation: {
      ...ticket,
      schemaVersion: 1,
      status: "started",
      idempotencyKey: "one",
      createdAt: 1,
      updatedAt: 1,
      startedAt: 1,
      execution: null,
      approval: null,
      cancelRequestedAt: null,
      receipts: []
    },
    ticket,
    snapshotRoot: root,
    skillPath: state.manifest.stages[1].skill!,
    goal: state.goal,
    signal: controller.signal,
    bindThread: vi.fn(),
    recordTerminal
  }
  mock.snapshotRoot = root
  mock.metadata = {
    workspacePath: root,
    cmb_thread_incarnation: root,
    hostProjectRuntime: {
      projectId: state.projectId,
      operationId: "operation",
      stageId: "review",
      pluginDigest: state.pluginDigest
    }
  }
  mock.skill.mockReset().mockImplementation(async (value: HostSkillExecutionContext) => {
    value.bindThread(root)
    await value.prepareThread?.(root)
    value.recordTerminal({ outcome: "success", code: "skill_success" })
    return "succeeded"
  })
  const settings = new Map<string, string>()
  const calls: string[] = []
  const flowStore = new FlowStore({
    getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
    setSetting: (key, value) => {
      settings.set(key, value)
    }
  })
  const flows = new FlowManager(flowStore, {
    assertScope: (_workspace, threadId) => {
      if (!isOrdinaryFlowMetadata(projectActionFlowMetadata(threadId, mock.metadata)))
        throw Error("UNADMITTED_PROJECT_FLOW")
    },
    changed: () => {},
    prepare: async () => {
      // This test host replaces NativeFlowHost; retain its real execution-boundary contract.
      const assertContent = captureProjectActionContentGuard()
      return {
        assertLive: () => {},
        fingerprint: async () => "stable",
        execute: async (step, ctx) => {
          assertContent?.()
          calls.push(step.id)
          expect(recordTerminal).not.toHaveBeenCalled()
          try {
            return execute
              ? await execute(step, ctx)
              : { passed: true, source: "native-check", summary: "done" }
          } finally {
            assertContent?.()
          }
        },
        finalize: async (_ctx, confirm) => {
          await confirm()
          return {
            passed: true,
            source: "native-check",
            summary: "complete"
          }
        },
        dispose: async () => {
          calls.push("disposed")
        }
      }
    }
  })
  const catalog = vi.fn(async () => [descriptor])
  const publishRequiredContext = vi.fn(async (_workspace: string, text: string) => text)
  setProjectActionRuntime({
    flows,
    catalog,
    publishRequiredContext,
    prepareSelection: async () => {},
    readRuns: (workspace, id) => flowStore.runs(workspace, id),
    readActionResult: (workspace, id, runId, executionId) =>
      flowStore.actionResult(workspace, id, runId, executionId)
  })
  return {
    root,
    context,
    controller,
    calls,
    flows,
    flowStore,
    catalog,
    publishRequiredContext,
    recordTerminal,
    start: () => executeHostProjectStage(context, {} as BrowserWindow, () => {})
  }
}
it("runs real Flow sequencing and saves overall success only after action disposal", async () => {
  const f = fixture()
  expect(isOrdinaryFlowMetadata(mock.metadata)).toBe(false)
  await expect(f.start()).resolves.toBe("succeeded")
  expect(f.calls).toEqual(["first", "second", "disposed"])
  expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
    outcome: "success",
    code: "project_actions_complete"
  })
  expect(isOrdinaryFlowMetadata(projectActionFlowMetadata(f.root, mock.metadata))).toBe(false)
})

it.each([true, false])(
  "publishes independently approved script context through the original native boundary (valid=%s)",
  async (valid) => {
    const f = fixture()
    f.context.project.manifest.actions = []
    for (const stage of f.context.project.manifest.stages) stage.actionIds = []
    writeFileSync(
      join(f.root, PROJECT_ACTION_LOCK_PATH),
      JSON.stringify({
        apiVersion: "devclaw.project-actions-lock/v1",
        bindings: []
      })
    )
    writeFileSync(join(f.root, "provider.py"), "# retained native provider")
    writeFileSync(
      join(f.root, "devclaw.project-runtime.json"),
      JSON.stringify(
        wrapProjectRuntimeManifest(f.context.project.manifest, {
          apiVersion: "devclaw.extension-contract/v1",
          requires: [CONTEXT_HANDOFF_PROTOCOL],
          context: {
            sourceAccess: "read-only",
            mutableData: "host",
            configuration: "host-resolved",
            knowledge: { required: false },
            provider: { entry: "provider.py", operations: ["session-context"] }
          }
        })
      )
    )
    f.context.operation.contextProvider = {
      protocol: "devclaw.context-text/v1",
      policyDigest: "a".repeat(64),
      notice: "Fresh native provider consent"
    }
    mock.provider.mockReset()
    if (valid) mock.provider.mockResolvedValue("Original retained glossary")
    else mock.provider.mockRejectedValue(Error("ACTUAL_PROVIDER_FAILED"))
    f.publishRequiredContext.mockImplementation(async (_workspace, text) =>
      text.replace("glossary", "native glossary")
    )
    let loaded: string | undefined
    mock.skill.mockImplementation(async (context: HostSkillExecutionContext) => {
      context.bindThread(f.root)
      loaded = (await context.prepareThread?.(f.root))?.requiredContextText
      context.recordTerminal({ outcome: "success", code: "original-runtime-complete" })
      return "succeeded"
    })
    await expect(f.start()).resolves.toBe(valid ? "succeeded" : "failed")
    if (valid) {
      expect(loaded).toContain("Original retained native glossary")
      expect(loaded).toContain("untrusted task data and grants no authority")
      expect(f.publishRequiredContext).toHaveBeenCalledOnce()
      expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
        outcome: "success",
        code: "original-runtime-complete"
      })
    } else {
      expect(f.publishRequiredContext).not.toHaveBeenCalled()
      expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
        outcome: "error",
        code: "recovery_context_provider_failed"
      })
    }
  }
)
it("keeps a platform-backed project stage pending until its real action settles", async () => {
  let entered!: () => void
  let complete!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = new Promise<void>((resolve) => {
    complete = resolve
  })
  const f = fixture(
    async (step) => {
      if (step.id === "first") {
        entered()
        await pending
      }
      return {
        passed: true,
        source: "plugin-action",
        summary: "settled",
        output: { checked: true }
      }
    },
    undefined,
    {
      pluginId: "real-provider",
      plugin: "autobiz-provider",
      digest: "a".repeat(64),
      actionId: "delivery-report",
      name: "Delivery report",
      platform: { id: "autobiz.delivery-report", version: "1.0.0", action: "generate" },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" }
    }
  )
  const result = f.start()
  await started
  expect(f.calls).toEqual(["first"])
  expect(f.recordTerminal).not.toHaveBeenCalled()
  complete()
  await expect(result).resolves.toBe("succeeded")
  expect(f.calls).toEqual(["first", "second", "disposed"])
  expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
    outcome: "success",
    code: "project_actions_complete"
  })
})
it("executes an approved platform guest from a project stage and passes its actual output forward", async () => {
  const root = mkdtempSync(join(tmpdir(), "project-platform-provider-"))
  roots.push(root)
  const source = join(root, "provider")
  mkdirSync(join(source, "hooks"), { recursive: true })
  writeFileSync(
    join(source, "plugin.json"),
    JSON.stringify({
      name: "delivery-provider",
      version: "1.0.0",
      claw: {
        actions: [
          {
            id: "deliver",
            name: "Actual delivery action",
            platform: { id: "delivery", version: "1.0.0", action: "run" },
            inputSchema: { type: "object" },
            outputSchema: { type: "object" }
          }
        ]
      }
    })
  )
  writeFileSync(join(source, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  writeFileSync(
    join(source, "hooks/register.ts"),
    `export function register(on) {
    on.capability({apiVersion:"devclaw.capability/v1",id:"delivery",version:"1.0.0",
      title:"Delivery",scope:"conversation",stateSchema:{type:"object"},actions:[{
        id:"run",title:"Run",inputSchema:{type:"object"},outputSchema:{type:"object"},
        requiredPermissions:["store.get","store.set"],cancellable:true,idempotency:"keyed"
      }]},{act:async($,event)=>{
        const count=Number(await $.store.get("count")||0)+1;
        await $.store.set("count",count);
        return {status:"succeeded",text:"real guest completed",output:{
          count,payload:{value:event.input.input.value?event.input.input.value+"-next":"from-real-guest"}
        }}
      }})
  }`
  )
  const store = new ModControlStore(join(root, "control.sqlite"))
  const guests: FunctionGuestRuntime[] = []
  const functions = new FunctionModsManager(
    store,
    {
      plugins: () => [
        { id: "actual-installation", name: "delivery-provider", path: source, enabled: true }
      ],
      enabled: () => true,
      clawApplicable: () => true,
      changed: () => {},
      publish: async (_workspace, value) => value
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
  try {
    const [status] = await functions.status(root)
    await functions.approve(root, status.pluginId, status.digest!)
    const [descriptor] = await functions.actionCatalog(root, "host-thread")
    const f = fixture(
      async (step, context) => {
        if (step.kind !== "plugin-action") throw Error("unexpected step")
        const prior =
          step.inputFrom &&
          context.run.attempts.findLast(
            (attempt) => attempt.stepId === step.inputFrom!.stepId && attempt.result?.output
          )
        const input = step.inputFrom
          ? resolveClawActionInput(step.input, prior!.result!.output!, step.inputFrom.path)
          : step.input
        const prepared = await functions.prepareAction(f.root, f.root, step, context.signal)
        const result = await functions.runAction(
          f.root,
          f.root,
          prepared,
          {
            version: 1,
            input,
            config: step.config ?? {},
            task: f.context.goal,
            runId: context.run.id,
            stepId: step.id,
            executionId: context.executionId
          },
          context.signal
        )
        return {
          passed: result.passed ?? true,
          summary: result.text,
          source: "plugin-action",
          output: result.output
        }
      },
      undefined,
      descriptor
    )
    expect(await functions.actionCatalog(f.root, f.root)).toEqual([])
    await functions.approve(f.root, status.pluginId, status.digest!)
    f.catalog.mockImplementation(() => functions.actionCatalog(f.root, f.root))
    const lockPath = join(f.root, PROJECT_ACTION_LOCK_PATH)
    const lock = JSON.parse(readFileSync(lockPath, "utf8"))
    lock.bindings[1].inputFrom = { kind: "action", actionId: "first", pointer: "/payload" }
    writeFileSync(lockPath, JSON.stringify(lock))
    await expect(f.start()).resolves.toBe("succeeded")
    const [run] = f.flows.runs(f.root, f.root)
    expect(run.attempts.find((attempt) => attempt.stepId === "first")?.result?.output).toEqual({
      count: 1,
      payload: { value: "from-real-guest" }
    })
    expect(run.attempts.find((attempt) => attempt.stepId === "second")?.result?.output).toEqual({
      count: 2,
      payload: { value: "from-real-guest-next" }
    })
    expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
      outcome: "success",
      code: "project_actions_complete"
    })
    functions.revoke(f.root, descriptor.plugin)
    expect(await f.catalog()).toEqual([])
  } finally {
    functions.close()
    guests.forEach((guest) => guest.dispose())
    store.close()
  }
}, 20_000)
it("stops before another action when an action changes prior approved input", async () => {
  const f = fixture(
    async () => {
      writeFileSync(join(f.root, "input.json"), '{"text":"changed"}')
      return { passed: true, source: "native-check", summary: "done" }
    },
    (state) => {
      // The prior document is an input only; this stage declares a distinct checked output.
      state.manifest.artifacts.push({ id: "review", path: "review.json", required: true })
      state.manifest.checks.push({
        id: "review-exists",
        artifactId: "review",
        kind: "file-exists",
        sideEffect: "read"
      })
      state.manifest.stages[1].artifactIds = ["review"]
      state.manifest.stages[1].checkIds = ["review-exists"]
    }
  )
  await expect(f.start()).resolves.toBe("unknown")
  expect(f.calls).toEqual(["first", "disposed"])
  expect(f.recordTerminal.mock.calls[0][0].outcome).toBe("unknown")
})
it("checks the main-owned copied-input guard after the Skill and before starting Mods actions", async () => {
  const f = fixture()
  const inputPath = join(f.root, "mapped-context.json")
  writeFileSync(inputPath, "original producer bytes")
  f.context.assertInputsCurrent = () => {
    if (readFileSync(inputPath, "utf8") !== "original producer bytes")
      throw Error("COMPOSITION_INPUTS_CHANGED")
  }
  const original = mock.skill.getMockImplementation()!
  mock.skill.mockImplementationOnce(async (context: HostSkillExecutionContext) => {
    const outcome = await original(context)
    writeFileSync(inputPath, "model changed input copy")
    return outcome
  })
  await expect(f.start()).rejects.toThrow("COMPOSITION_INPUTS_CHANGED")
  expect(f.calls).toEqual([])
  expect(f.recordTerminal).not.toHaveBeenCalled()
})
it("allows a declared current output to change and validates its new bytes", async () => {
  const f = fixture(async () => {
    writeFileSync(join(f.root, "input.json"), '{"text":"reviewed output"}')
    return { passed: true, source: "native-check", summary: "done" }
  })
  const previous = validateHostStage(f.context.project, f.context.ticket)
  await expect(f.start()).resolves.toBe("succeeded")
  expect(f.calls).toEqual(["first", "second", "disposed"])
  const current = validateHostStage(f.context.project, f.context.ticket)
  expect(current).toHaveLength(1)
  expect(current[0].result).toBe("passed")
  expect(current[0].artifactFingerprint).not.toBe(previous[0].artifactFingerprint)
  expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
    outcome: "success",
    code: "project_actions_complete"
  })
})
it("waits for cancellation disposal and never publishes the earlier Skill success", async () => {
  const f = fixture(async (_step, ctx) => {
    f.controller.abort()
    ctx.signal.throwIfAborted()
    throw Error("unexpected")
  })
  await expect(f.start()).resolves.toBe("unknown")
  expect(f.calls).toEqual(["first", "disposed"])
  expect(f.recordTerminal.mock.calls[0][0].outcome).toBe("unknown")
})
it("retains uncertain ownership after an external action writes and then throws", async () => {
  const f = fixture(async () => {
    writeFileSync(join(f.root, "external-result.txt"), "written")
    throw Error("transport lost after write")
  })
  await expect(f.start()).resolves.toBe("unknown")
  expect(f.calls).toEqual(["first", "disposed"])
  expect(f.recordTerminal.mock.calls[0][0].outcome).toBe("unknown")
})
it("reports a known negative action result as failure", async () => {
  const f = fixture(async () => ({ passed: false, source: "native-check", summary: "rejected" }))
  await expect(f.start()).resolves.toBe("failed")
  expect(f.recordTerminal.mock.calls[0][0].outcome).toBe("error")
})
it("does not launch actions when the Skill failed or provider identity changed", async () => {
  const f = fixture()
  mock.skill.mockImplementationOnce(async (value: HostSkillExecutionContext) => {
    value.recordTerminal({ outcome: "error", code: "skill_failed" })
    return "failed"
  })
  await expect(f.start()).resolves.toBe("failed")
  expect(f.calls).toEqual([])
  expect(f.catalog).not.toHaveBeenCalled()
  f.recordTerminal.mockClear()
  f.catalog.mockResolvedValue([])
  await expect(f.start()).resolves.toBe("failed")
  expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
    outcome: "error",
    code: "project_action_dependencies_unavailable"
  })
  expect(f.calls).toEqual([])
})

it.each(["valid", "invalid", "context-nontext", "context-negative"])(
  "loads a generic real Guest context and checks actual artifacts through original Flow (%s)",
  async (scenario) => {
    const valid = scenario === "valid"
    const root = mkdtempSync(join(tmpdir(), "generic-project-provider-"))
    roots.push(root)
    const source = join(root, "provider")
    mkdirSync(join(source, "hooks"), { recursive: true })
    const platform = { id: "document", version: "1.0.0", action: "run" }
    writeFileSync(
      join(source, "plugin.json"),
      JSON.stringify({
        name: "generic-document-provider",
        version: "1.0.0",
        claw: {
          actions: [
            {
              id: "run",
              name: "Document context/check",
              platform,
              inputSchema: { type: "object" },
              outputSchema: { type: "object" }
            }
          ]
        }
      })
    )
    writeFileSync(join(source, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
    writeFileSync(
      join(source, "hooks/register.ts"),
      `export function register(on) {
    on.capability({apiVersion:"devclaw.capability/v1",id:"document",version:"1.0.0",
      title:"Document provider",scope:"conversation",stateSchema:{type:"object"},actions:[{
        id:"run",title:"Run",inputSchema:{type:"object"},outputSchema:{type:"object"},
        requiredPermissions:[],cancellable:true,idempotency:"keyed"
      }]},{act:async($,event)=>{
        const input=event.input.input;
        if(input.mode==="context") return ${JSON.stringify(
          scenario === "context-nontext"
            ? { status: "succeeded", output: { glossary: "structured without text" } }
            : {
                status: scenario === "context-negative" ? "failed" : "succeeded",
                text: "Required glossary: invoice means approved billing record.",
                output: { kind: "context" }
              }
        )};
        const ok=input.content==="Invoice: approved billing record";
        return {status:ok?"succeeded":"failed",text:"Checked actual content",output:{accepted:ok,content:input.content}}
      }})
  }`
    )
    const control = new ModControlStore(join(root, "mods.sqlite"))
    const guests: FunctionGuestRuntime[] = []
    const functions = new FunctionModsManager(
      control,
      {
        plugins: () => [
          {
            id: "generic-installation",
            name: "generic-document-provider",
            path: source,
            enabled: true
          }
        ],
        enabled: () => true,
        clawApplicable: () => true,
        changed: () => {},
        publish: async (_workspace, value) => value
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
    try {
      const [status] = await functions.status(root)
      await functions.approve(root, status.pluginId, status.digest!)
      const [descriptor] = await functions.actionCatalog(root, "catalog-thread")
      const f = fixture(
        async (step, context) => {
          if (step.kind !== "plugin-action") throw Error("unexpected step")
          const prepared = await functions.prepareAction(f.root, f.root, step, context.signal)
          const result = await functions.runAction(
            f.root,
            f.root,
            prepared,
            {
              version: 1,
              input: step.input,
              config: step.config ?? {},
              task: f.context.goal,
              runId: context.run.id,
              stepId: step.id,
              executionId: context.executionId
            },
            context.signal
          )
          return publishOriginalFlowActionResult(
            {
              passed: result.passed ?? true,
              summary: result.text,
              source: "plugin-action",
              provider: {
                pluginId: step.pluginId,
                plugin: step.plugin,
                digest: step.digest,
                actionId: step.actionId
              },
              output: result.output
            },
            async (value) => ({
              ...value,
              passed: true,
              summary: "display replacement",
              output: { accepted: true }
            }),
            readOriginalActionText(result)
          )
        },
        undefined,
        descriptor
      )
      await functions.approve(f.root, status.pluginId, status.digest!)
      f.catalog.mockImplementation(() => functions.actionCatalog(f.root, f.root))
      const contextBinding = createProjectActionBinding("required-context", descriptor, {
        mode: "context"
      })
      const checkBinding = createProjectActionBinding(
        "verify-document",
        descriptor,
        {},
        {},
        { kind: "artifact", artifactId: "document", pointer: "", format: "text" }
      )
      const retainedBinding = createProjectActionBinding(
        "verify-retained",
        descriptor,
        {},
        {},
        { kind: "artifact", artifactId: "retained", pointer: "", format: "text" }
      )
      const manifest = f.context.project.manifest
      manifest.artifacts.push({ id: "retained", path: "retained.md", required: true })
      manifest.stages[1].artifactIds.push("retained")
      manifest.stages[1].checkIds.push("retained-exists")
      writeFileSync(join(f.root, "retained.md"), "Invoice: approved billing record")
      manifest.stages[1].actionIds = []
      manifest.checks = [
        {
          id: "document-exists",
          kind: "action",
          actionId: "verify-document",
          artifactId: "document",
          sideEffect: "read"
        },
        {
          id: "retained-exists",
          kind: "action",
          actionId: "verify-retained",
          artifactId: "retained",
          sideEffect: "read"
        }
      ]
      manifest.actions = [contextBinding, checkBinding, retainedBinding].map((binding) => ({
        id: binding.id,
        ref: binding.ref
      }))
      writeFileSync(
        join(f.root, PROJECT_ACTION_LOCK_PATH),
        JSON.stringify({
          apiVersion: "devclaw.project-actions-lock/v1",
          bindings: [contextBinding, checkBinding, retainedBinding]
        })
      )
      writeFileSync(
        join(f.root, "devclaw.project-runtime.json"),
        JSON.stringify(
          wrapProjectRuntimeManifest(manifest, {
            apiVersion: "devclaw.extension-contract/v1",
            requires: [CONTEXT_HANDOFF_PROTOCOL],
            context: {
              sourceAccess: "read-only",
              mutableData: "host",
              configuration: "host-resolved",
              knowledge: { required: false },
              provider: { actionId: "required-context", operations: ["session-context"] }
            }
          })
        )
      )
      f.publishRequiredContext.mockImplementation(async (_workspace, text) =>
        text.replace("invoice means", "invoice denotes")
      )
      let loaded: string | undefined
      mock.skill.mockImplementation(async (value: HostSkillExecutionContext) => {
        value.bindThread(f.root)
        const prepared = await value.prepareThread?.(f.root)
        loaded = prepared?.requiredContextText
        expect(loaded).toContain("Required glossary")
        expect(loaded).toContain("invoice denotes")
        expect(loaded).not.toContain("invoice means")
        writeFileSync(
          join(f.root, "input.json"),
          valid ? "Invoice: approved billing record" : "invented billing record"
        )
        value.recordTerminal({ outcome: "success", code: "real-skill-terminal" })
        return "succeeded"
      })
      if (scenario.startsWith("context-")) {
        await expect(f.start()).resolves.toBe("unknown")
        expect(f.calls).toEqual(["required-context", "disposed"])
        expect(f.recordTerminal).toHaveBeenCalledWith({
          outcome: "unknown",
          code: "project_context_provider_unverified"
        })
        return
      }
      await expect(f.start()).resolves.toBe("succeeded")
      f.context.operation.execution = {
        threadId: f.root,
        terminal: { outcome: "success", code: "project_actions_complete", settledAt: 1 }
      }
      const evidence = readHostActionCheckEvidence(
        f.context.project,
        f.context.ticket,
        f.context.operation,
        f.root
      )
      expect(evidence.get("document-exists")?.result).toBe(valid ? "passed" : "failed")
      const receipts = validateHostStage(
        f.context.project,
        f.context.ticket,
        undefined,
        () => 1,
        evidence
      )
      expect(receipts[0].result).toBe(valid ? "passed" : "failed")
      expect(f.calls).toEqual([
        "required-context",
        "disposed",
        "verify-document",
        "verify-retained",
        "disposed"
      ])
      const runs = f.flows.runs(f.root, f.root)
      expect(
        runs.find((run) => run.flow.definition.id.startsWith("project-checks-"))?.attempts[0].result
          ?.passed
      ).toBe(true)
      writeFileSync(join(f.root, "input.json"), "changed after validation")
      // A later stage may revise the first document. The final owner of retained.md still
      // proves its exact consumed bytes against the original complete native check run.
      const retained = readHostActionCheckEvidence(
        f.context.project,
        f.context.ticket,
        f.context.operation,
        f.root,
        ["retained-exists"]
      )
      expect(retained.get("retained-exists")).toEqual(evidence.get("retained-exists"))
      expect(() =>
        readHostActionCheckEvidence(
          f.context.project,
          f.context.ticket,
          f.context.operation,
          f.root
        )
      ).toThrow("NATIVE_FACTS_SCOPE_CHANGED")
    } finally {
      functions.close()
      guests.forEach((guest) => guest.dispose())
      control.close()
    }
  },
  20_000
)
