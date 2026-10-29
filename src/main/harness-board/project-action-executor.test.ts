import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import type { HostSkillExecutionContext } from "./project-runtime/host-service"
import type { HostProjectState } from "../../shared/project-runtime/host-types"
import type { FlowExecution } from "../mods/flows/contracts"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import { resolveClawActionInput } from "../../shared/mods/claw-actions"
import { hostProjectFixture } from "./project-runtime/host-fixtures.test-helper"
import { PROJECT_ACTION_LOCK_PATH } from "../../shared/project-runtime/action-bindings"
import { createProjectActionBinding, captureProjectActionInputs, readProjectActionLock } from "./project-runtime/action-input"
import { executeProjectActionPhase } from "./project-action-phase"
import { readHostActionCheckEvidence, readHistoricalHostCheckDiagnostics } from "./project-runtime/action-check-evidence"
import { publishOriginalFlowActionResult } from "../mods/flows/action-execution-facts"
import { wrapProjectRuntimeManifest, CONTEXT_HANDOFF_PROTOCOL, CONTEXT_MATERIALS_PROTOCOL } from "../../shared/project-runtime"
import { fingerprintHostStageInput, validateHostStage } from "./project-runtime/host-validators"
import { FlowManager } from "../mods/flows/manager"
import { FlowStore } from "../mods/flows/store"
import { isOrdinaryFlowMetadata } from "../../shared/mods/flows/scope"
import { projectActionFlowMetadata } from "./project-action-scope"
import { setProjectActionRuntime, getProjectActionRuntime } from "./project-action-runtime"
import { DECLARED_CONTEXT_FILES_PROTOCOL } from "../../shared/project-runtime"
import { readDeclaredContextFiles } from "./project-runtime/declared-context-files"
import { readPackageExtensionContract } from "../plugins/extension-contract"
import { FunctionModsManager } from "../mods/v2/manager"
import { readOriginalActionText } from "../mods/v2/action-result-text"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { ModControlStore } from "../mods/control-store"
import { captureProjectActionContentGuard, captureSettledProjectSkill } from "./project-action-scope"
import { HostProjectStore } from "./project-runtime/host-store"
import { HostProjectCoordinator } from "./project-runtime/host-coordinator"

const mock = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  snapshotRoot: "",
  provider: vi.fn(),
  skill: vi.fn()
}))
vi.mock("../db", () => ({
  createThread: (_id: string, metadata: Record<string, unknown>) => {
    mock.metadata = metadata
    return { created_at: 1, metadata: JSON.stringify(metadata) }
  },
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

it("exposes settled Skill proof to original post-Skill actions without early final success", async () => {
  let retained: ReturnType<typeof captureSettledProjectSkill>
  const f = fixture(async () => {
    retained = captureSettledProjectSkill({
      projectId: f.context.project.projectId, operationId: f.context.operation.operationId,
      stageId: f.context.operation.stageId, threadId: f.root,
      pluginDigest: f.context.project.pluginDigest, inputFingerprint: f.context.operation.inputFingerprint
    })
    expect(retained).toBeDefined()
    retained!.assertCurrent()
    expect(f.recordTerminal).not.toHaveBeenCalled()
    return { passed: true, source: "native-check", summary: "checked" }
  })
  await expect(f.start()).resolves.toBe("succeeded")
  expect(() => retained!.assertCurrent()).toThrow("PROJECT_SKILL_SETTLEMENT_SCOPE_CHANGED")
})

it("does not mint settled Skill proof or run post-actions from a success label without its terminal", async () => {
  const f = fixture()
  mock.skill.mockImplementationOnce(async (context: HostSkillExecutionContext) => {
    context.bindThread(f.root)
    return "succeeded"
  })
  await expect(f.start()).resolves.toBe("unknown")
  expect(f.calls).toEqual([])
  expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
    outcome: "unknown", code: "project_skill_terminal_unconfirmed"
  })
})

it.each(["succeeded", "failed"])("settles the complete %s operation before publishing its terminal", async outcome => {
  const f = fixture(async () => ({ passed: outcome === "succeeded", source: "native-check", summary: "checked" }))
  const gate = Promise.withResolvers<void>()
  const retire = vi.fn(async () => {
    expect(f.calls).toContain("disposed")
    expect(f.recordTerminal).not.toHaveBeenCalled()
    await gate.promise
  })
  setProjectActionRuntime({ ...getProjectActionRuntime(), captureOperationRetirement: () => ({
    resident: true, assertCurrent: () => {}, retire
  }) })
  const result = f.start()
  await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce())
  expect(f.recordTerminal).not.toHaveBeenCalled()
  gate.resolve()
  await expect(result).resolves.toBe(outcome)
  expect(f.recordTerminal).toHaveBeenCalledOnce()
})

it("keeps cleanup failure unknown and never publishes the preceding successful terminal", async () => {
  const f = fixture()
  setProjectActionRuntime({ ...getProjectActionRuntime(), captureOperationRetirement: () => ({
    resident: true, assertCurrent: () => {}, retire: async () => { throw Error("EXIT_UNCONFIRMED") }
  }) })
  await expect(f.start()).resolves.toBe("unknown")
  expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
    outcome: "unknown", code: "project_runtime_retirement_unconfirmed"
  })
})

it.each(["owner-before", "capture", "admission", "owner-before-retire", "retire", "owner-after"])(
  "logs only the exact retirement phase and safe code after %s fails", async phase => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const f = fixture(undefined, state => {
        state.manifest.stages[1].actionIds = []
        state.manifest.stages[1].checkIds = []
      })
      let ownerCalls = 0
      let modelSettled = false
      mock.skill.mockImplementationOnce(async (context: HostSkillExecutionContext) => {
        context.bindThread(f.root)
        context.recordTerminal({ outcome: "error", code: "MODEL_FAILURE" })
        modelSettled = true
        return "failed"
      })
      const fail = () => { throw Error("ORIGINAL_OWNER_REVOKED") }
      f.context.assertAuthorityCurrent = () => {
        if (!modelSettled) return
        ownerCalls++
        if ((phase === "owner-before" && ownerCalls === 1) ||
            (phase === "owner-before-retire" && ownerCalls === 2) ||
            (phase === "owner-after" && ownerCalls === 3)) fail()
      }
      const retire = vi.fn(async () => { if (phase === "retire") fail() })
      setProjectActionRuntime({ ...getProjectActionRuntime(), captureOperationRetirement: () => {
        if (phase === "capture") fail()
        return { resident: true, assertCurrent: () => { if (phase === "admission") fail() }, retire }
      } })
      await expect(f.start()).resolves.toBe("unknown")
      expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
        outcome: "unknown", code: "project_runtime_retirement_unconfirmed"
      })
      expect(log).toHaveBeenCalledExactlyOnceWith("[ProjectRuntime] Retirement failed",
        { phase, code: "ORIGINAL_OWNER_REVOKED" })
      expect(retire).toHaveBeenCalledTimes(["retire", "owner-after"].includes(phase) ? 1 : 0)
    } finally { log.mockRestore() }
  }
)

it.each([
  Error("private path /input/document and body"),
  Error("A".repeat(97)),
  Error("APPARENT_CODE\n"),
  { message: "NOT_AN_ERROR", privateBody: "must not be logged" },
  "PRIVATE_BODY"
])("does not disclose arbitrary retirement failure details (%#)", async error => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    const f = fixture()
    setProjectActionRuntime({ ...getProjectActionRuntime(), captureOperationRetirement: () => ({
      resident: true, assertCurrent: () => {}, retire: async () => { throw error }
    }) })
    await expect(f.start()).resolves.toBe("unknown")
    expect(log).toHaveBeenCalledExactlyOnceWith("[ProjectRuntime] Retirement failed",
      { phase: "retire", code: "UNKNOWN" })
    expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
      outcome: "unknown", code: "project_runtime_retirement_unconfirmed"
    })
  } finally { log.mockRestore() }
})

it("preserves the unconfirmed terminal even when the diagnostic logger throws", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => { throw Error("LOGGER_FAILED") })
  try {
    const f = fixture()
    setProjectActionRuntime({ ...getProjectActionRuntime(), captureOperationRetirement: () => ({
      resident: true, assertCurrent: () => {}, retire: async () => { throw Error("CLEANUP_FAILED") }
    }) })
    await expect(f.start()).resolves.toBe("unknown")
    expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
      outcome: "unknown", code: "project_runtime_retirement_unconfirmed"
    })
  } finally { log.mockRestore() }
})

it.each(["host_user_input_waiting", "unconfirmed"])("does not retire %s ownership", async code => {
  const f = fixture()
  const capture = vi.fn(() => ({ resident: true, assertCurrent: () => {}, retire: async () => {} }))
  setProjectActionRuntime({ ...getProjectActionRuntime(), captureOperationRetirement: capture })
  mock.skill.mockImplementationOnce(async (context: HostSkillExecutionContext) => {
    context.bindThread(f.root)
    context.recordTerminal({ outcome: "unknown", code })
    return "unknown"
  })
  await expect(f.start()).resolves.toBe("unknown")
  expect(capture).not.toHaveBeenCalled()
})

it("retires the original recovered input thread even when Skill does not bind it again", async () => {
  const f = fixture()
  const capture = vi.fn(() => ({ resident: true, assertCurrent: () => {}, retire: async () => {} }))
  setProjectActionRuntime({ ...getProjectActionRuntime(), captureOperationRetirement: capture })
  f.context.recoveryInput = { request: { threadId: f.root } } as NonNullable<HostSkillExecutionContext["recoveryInput"]>
  mock.skill.mockImplementationOnce(async (context: HostSkillExecutionContext) => {
    context.recordTerminal({ outcome: "success", code: "resumed" })
    return "succeeded"
  })
  await expect(f.start()).resolves.toBe("succeeded")
  expect(capture).toHaveBeenCalledExactlyOnceWith(f.root, f.root)
})

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

function contextDispatchFixture(materials = false, execute?: FlowExecution["execute"]) {
  const f = fixture(execute)
  const manifest = f.context.project.manifest
  manifest.stages[1].actionIds = []
  manifest.stages[1].checkIds = []
  writeFileSync(join(f.root, "devclaw.project-runtime.json"), JSON.stringify(
    wrapProjectRuntimeManifest(manifest, {
      apiVersion: "devclaw.extension-contract/v1",
      requires: [CONTEXT_HANDOFF_PROTOCOL, ...(materials ? [CONTEXT_MATERIALS_PROTOCOL] : [])],
      context: {
        sourceAccess: "read-only", mutableData: "host", configuration: "host-resolved",
        knowledge: { required: false },
        provider: {
          actionId: "first", operations: ["session-context"],
          ...(materials ? { materials: {
            roots: [{ id: "package", source: "package" as const }], configuration: []
          } } : {})
        }
      }
    })
  ))
  const retire = vi.fn(async () => {})
  const capture = vi.fn(() => ({ resident: true, assertCurrent: () => {}, retire }))
  setProjectActionRuntime({ ...getProjectActionRuntime(), captureOperationRetirement: capture })
  const startSaved = vi.spyOn(f.flows, "startSaved")
  return { ...f, retire, capture, startSaved }
}

it("notifies dispatch only after selection and definition capture, before the original start attempt", async () => {
  const f = fixture()
  const captured = captureProjectActionInputs(f.context.project,
    readProjectActionLock(f.root, f.context.project.manifest))
  const selection = Promise.withResolvers<void>()
  const prepare = vi.fn(async () => { await selection.promise })
  const beforeDispatch = vi.fn()
  const startSaved = vi.spyOn(f.flows, "startSaved").mockImplementationOnce(async () => {
    expect(beforeDispatch).toHaveBeenCalledOnce()
    throw Error("ORIGINAL_DISPATCH_REJECTED")
  })
  setProjectActionRuntime({ ...getProjectActionRuntime(), prepareSelection: prepare })
  const result = executeProjectActionPhase(f.context, f.root, captured, "context",
    () => {}, () => {}, beforeDispatch)
  const rejection = expect(result).rejects.toThrow("ORIGINAL_DISPATCH_REJECTED")
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
  expect(beforeDispatch).not.toHaveBeenCalled()
  expect(startSaved).not.toHaveBeenCalled()
  selection.resolve()
  await rejection
  expect(beforeDispatch).toHaveBeenCalledOnce()
  expect(startSaved).toHaveBeenCalledOnce()
})

it.each(["selection", "materials", "definition"])(
  "settles a context %s pre-dispatch failure before publishing failed", async failure => {
    const f = contextDispatchFixture(failure === "materials")
    const runtime = getProjectActionRuntime()
    setProjectActionRuntime({ ...runtime,
      prepareSelection: async () => {
        if (failure === "selection") throw Error("SELECTION_UNAVAILABLE")
        if (failure === "definition") f.context.ticket.operationId = ""
      },
      readContextMaterials: () => { throw Error("MATERIALS_UNAVAILABLE") }
    })
    const gate = Promise.withResolvers<void>()
    f.retire.mockImplementationOnce(async () => { await gate.promise })
    const result = f.start()
    await vi.waitFor(() => expect(f.retire).toHaveBeenCalledOnce())
    expect(f.recordTerminal).not.toHaveBeenCalled()
    expect(f.startSaved).not.toHaveBeenCalled()
    expect(f.flowStore.runs(f.root, f.root)).toEqual([])
    expect(f.calls).toEqual([])
    gate.resolve()
    await expect(result).resolves.toBe("failed")
    expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
      outcome: "error", code: "project_action_dependencies_unavailable"
    })
  }
)

it("keeps context pre-dispatch failure unknown when exact retirement fails", async () => {
  const f = contextDispatchFixture()
  setProjectActionRuntime({ ...getProjectActionRuntime(), prepareSelection: async () => {
    throw Error("SELECTION_UNAVAILABLE")
  } })
  f.retire.mockRejectedValueOnce(Error("EXIT_UNCONFIRMED"))
  await expect(f.start()).resolves.toBe("unknown")
  expect(f.startSaved).not.toHaveBeenCalled()
  expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
    outcome: "unknown", code: "project_runtime_retirement_unconfirmed"
  })
})

it.each(["revoked", "cancelled", "cancelled-settled"])(
  "preserves original owner settlement guards after pre-dispatch %s", async scenario => {
    const f = contextDispatchFixture()
    let revoked = false
    f.context.assertAuthorityCurrent = () => { if (revoked) throw Error("OWNER_REVOKED") }
    const settlement = vi.fn()
    if (scenario === "cancelled-settled") f.context.assertSettlementCurrent = settlement
    setProjectActionRuntime({ ...getProjectActionRuntime(), prepareSelection: async () => {
      if (scenario === "revoked") revoked = true
      else f.controller.abort()
    } })
    await expect(f.start()).resolves.toBe(scenario === "cancelled-settled" ? "failed" : "unknown")
    expect(f.startSaved).not.toHaveBeenCalled()
    expect(f.calls).toEqual([])
    if (scenario === "cancelled-settled") {
      expect(settlement).toHaveBeenCalled()
      expect(f.retire).toHaveBeenCalledOnce()
      expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
        outcome: "error", code: "project_action_dependencies_unavailable"
      })
    } else {
      expect(f.retire).not.toHaveBeenCalled()
      expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
        outcome: "unknown", code: "project_runtime_retirement_unconfirmed"
      })
    }
  }
)

it("keeps an attempted context start unknown even when startSaved itself rejects", async () => {
  const f = contextDispatchFixture()
  f.startSaved.mockRejectedValueOnce(Error("ORIGINAL_DISPATCH_REJECTED"))
  await expect(f.start()).resolves.toBe("unknown")
  expect(f.startSaved).toHaveBeenCalledOnce()
  expect(f.calls).toEqual([])
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
    outcome: "unknown", code: "project_context_provider_unverified"
  })
})

it("preserves original Flow failure facts and unknown after context dispatch", async () => {
  const f = contextDispatchFixture(false, async () => ({
    passed: false, source: "native-check", summary: "original provider failed"
  }))
  await expect(f.start()).resolves.toBe("unknown")
  expect(f.startSaved).toHaveBeenCalledOnce()
  expect(f.calls).toEqual(["first", "disposed"])
  const [run] = f.flowStore.runs(f.root, f.root)
  expect(run.status).toBe("failed")
  expect(run.attempts.some(attempt => attempt.stepId === "first" && attempt.status === "failed"))
    .toBe(true)
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
    outcome: "unknown", code: "project_context_provider_unverified"
  })
})

function checkPreparationFixture(execute?: FlowExecution["execute"]) {
  const f = fixture(execute, undefined, {
    pluginId: "installed", plugin: "formatter", digest: "a".repeat(64),
    actionId: "format", name: "Check", platform: { id: "check", version: "1.0.0", action: "check" },
    inputSchema: { type: "object" }, outputSchema: { type: "object" }
  })
  const manifest = f.context.project.manifest
  manifest.artifacts.push({ id: "output", path: "output.json", required: true })
  manifest.stages[1].artifactIds = ["output"]
  manifest.stages[1].actionIds = []
  manifest.stages[1].checkIds = ["output-check"]
  manifest.checks.push({ id: "output-check", kind: "action", sideEffect: "read",
    artifactId: "output", actionId: "first" })
  const lock = JSON.parse(readFileSync(join(f.root, PROJECT_ACTION_LOCK_PATH), "utf8"))
  lock.bindings[0].inputFrom = { kind: "artifact", artifactId: "output", pointer: "",
    format: "artifact-reference-v1", maxBytes: 28000 }
  writeFileSync(join(f.root, PROJECT_ACTION_LOCK_PATH), JSON.stringify(lock))
  writeFileSync(join(f.root, "output.json"), JSON.stringify({ text: "x".repeat(35898) }))
  let skillSettled = false
  const original = mock.skill.getMockImplementation()!
  mock.skill.mockImplementation(async (context: HostSkillExecutionContext) => {
    const result = await original(context)
    skillSettled = true
    return result
  })
  const retire = vi.fn(async () => {})
  const capture = vi.fn(() => ({ resident: true, assertCurrent: () => {}, retire }))
  setProjectActionRuntime({ ...getProjectActionRuntime(), captureOperationRetirement: capture })
  return { ...f, capture, retire, skillSettled: () => skillSettled }
}

it("runs checks with native selected configuration and recaptures it for original successful evidence", async () => {
  const f = checkPreparationFixture(async step => {
    expect(step).toMatchObject({ input: { configuration: { audience: "native UI", timeout: 1000 } } })
    return publishOriginalFlowActionResult({
      passed: true, source: "plugin-action", summary: "checked against native configuration",
      provider: step.kind === "plugin-action" ? {
        pluginId: step.pluginId, plugin: step.plugin, digest: step.digest, actionId: step.actionId
      } : undefined
    }, async result => result)
  })
  writeFileSync(join(f.root, "output.json"), '{"text":"real output"}')
  const lockPath = join(f.root, PROJECT_ACTION_LOCK_PATH)
  const lock = JSON.parse(readFileSync(lockPath, "utf8"))
  lock.bindings[0].configurationKeys = ["audience", "timeout"]
  writeFileSync(lockPath, JSON.stringify(lock))
  let audience = "native UI"
  const read = vi.fn<NonNullable<ReturnType<typeof getProjectActionRuntime>["readPublicConfiguration"]>>((_project, root, keys) => {
    expect(root).toBe(f.root)
    expect(keys).toEqual(["audience", "timeout"])
    return { audience, timeout: 1000 }
  })
  setProjectActionRuntime({ ...getProjectActionRuntime(), readPublicConfiguration: read })
  let loaded = ""
  const originalSkill = mock.skill.getMockImplementation()!
  mock.skill.mockImplementation(async (value: HostSkillExecutionContext) => {
    const prepare = value.prepareThread
    return originalSkill({ ...value, prepareThread: async (id: string) => {
      const result = await prepare?.(id)
      loaded = result?.requiredContextText ?? ""
      return result
    } })
  })
  f.publishRequiredContext.mockImplementation(async (_workspace, text) => text.replace("native UI", "published UI"))
  await expect(f.start()).resolves.toBe("succeeded")
  expect(loaded).toContain("Required stage configuration.")
  expect(loaded).toContain('"configuration":{"audience":"published UI","timeout":1000}')
  expect(loaded).not.toContain('"audience":"native UI"')
  expect(f.publishRequiredContext).toHaveBeenCalledWith(f.root,
    JSON.stringify({ stageId: "review", configuration: { audience: "native UI", timeout: 1000 } }),
    f.controller.signal)
  expect(f.calls).toEqual(["first", "disposed"])
  const operation = { ...f.context.operation, execution: { threadId: f.root,
    terminal: { outcome: "success" as const, code: "project_actions_complete", settledAt: 1 } } }
  const evidence = () => readHostActionCheckEvidence(f.context.project, f.context.ticket, operation, f.root)
  expect(evidence().get("output-check")?.result).toBe("passed")
  audience = "new native UI value"
  expect(() => evidence()).toThrow("PROJECT_ACTION_NATIVE_FACTS_SCOPE_CHANGED")
})

it("rejects a model supplied reserved configuration field before Skill or check execution", async () => {
  const f = checkPreparationFixture()
  const lockPath = join(f.root, PROJECT_ACTION_LOCK_PATH)
  const lock = JSON.parse(readFileSync(lockPath, "utf8"))
  lock.bindings[0].configurationKeys = ["audience"]
  lock.bindings[0].input.configuration = { audience: "model supplied" }
  writeFileSync(lockPath, JSON.stringify(lock))
  const read = vi.fn(() => ({ audience: "real UI" }))
  setProjectActionRuntime({ ...getProjectActionRuntime(), readPublicConfiguration: read })
  await expect(f.start()).rejects.toThrow("PROJECT_ACTION_CHECK_INPUT_INVALID")
  expect(mock.skill).not.toHaveBeenCalled()
  expect(f.calls).toEqual([])
  expect(read).not.toHaveBeenCalled()
})

it.each(["empty", "nul", "oversize", "combined-limit", "source-changed"])(
  "does not execute checks when selected stage configuration publication fails: %s", async scenario => {
    const f = checkPreparationFixture()
    const lockPath = join(f.root, PROJECT_ACTION_LOCK_PATH)
    const lock = JSON.parse(readFileSync(lockPath, "utf8"))
    lock.bindings[0].configurationKeys = ["audience"]
    writeFileSync(lockPath, JSON.stringify(lock))
    setProjectActionRuntime({ ...getProjectActionRuntime(), readPublicConfiguration: () => ({ audience: "native" }) })
    let changed = false
    f.context.assertInputsCurrent = () => { if (changed) throw Error("CONFIGURATION_CHANGED") }
    if (scenario === "combined-limit")
      f.context.prepareThread = async () => ({ requiredContextText: "x".repeat(31_950) })
    f.publishRequiredContext.mockImplementation(async (_workspace, text) => {
      if (scenario === "empty") return ""
      if (scenario === "nul") return "unsafe\0text"
      if (scenario === "oversize") return "x".repeat(28_001)
      if (scenario === "source-changed") changed = true
      return text
    })
    await expect(f.start()).resolves.toBe("failed")
    expect(f.calls).toEqual([])
    expect(f.recordTerminal).toHaveBeenCalledWith({ outcome: "error", code: "project_action_dependencies_unavailable" })
  }
)

it("fails an oversized current check input only after settled Skill and exact physical retirement", async () => {
  const f = checkPreparationFixture()
  const gate = Promise.withResolvers<void>()
  f.retire.mockImplementation(async () => { await gate.promise })
  const result = f.start()
  await vi.waitFor(() => expect(f.retire).toHaveBeenCalledOnce())
  expect(f.skillSettled()).toBe(true)
  expect(readFileSync(join(f.root, "output.json")).length).toBe(35909)
  expect(f.calls).toEqual([])
  expect(f.flowStore.runs(f.root, f.root)).toEqual([])
  expect(f.recordTerminal).not.toHaveBeenCalled()
  gate.resolve()
  await expect(result).resolves.toBe("failed")
  expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({ outcome: "error", code: "project_check_input_limit" })
  expect(f.retire).toHaveBeenCalledOnce()
})

it("persists native failed file receipts for a missing current check output without executing its action", async () => {
  const f = checkPreparationFixture()
  rmSync(join(f.root, "output.json"))
  const store = new HostProjectStore(join(f.root, "host.sqlite"))
  try {
    const input = hostProjectFixture(f.root)
    input.manifest = structuredClone(f.context.project.manifest)
    const state = store.create(input)
    const gate = Promise.withResolvers<void>()
    f.retire.mockImplementation(async () => { await gate.promise })
    const coordinator = new HostProjectCoordinator(store, {
      authorize: async () => {},
      fingerprint: async project => fingerprintHostStageInput(project, project.goal),
      execute: async (project, ticket, signal) => {
        if (project.stageIndex === 0) return "succeeded"
        mock.metadata.hostProjectRuntime = { projectId: project.projectId, operationId: ticket.operationId,
          stageId: ticket.stageId, pluginDigest: ticket.pluginDigest }
        return executeHostProjectStage({ ...f.context, project, ticket, signal,
          operation: store.getOperation(ticket.operationId)!,
          bindThread: id => store.bindExecutionThread(ticket, id),
          recordTerminal: value => store.recordExecutionTerminal(ticket, value)
        }, {} as BrowserWindow, () => {})
      },
      validate: async (project, ticket, signal) => validateHostStage(project, ticket, signal, Date.now,
        readHostActionCheckEvidence(project, ticket, store.getOperation(ticket.operationId)!, f.root))
    })
    const first = store.prepare({ projectId: state.projectId, stageId: "draft", expectedVersion: 1,
      idempotencyKey: "actual-draft", inputFingerprint: fingerprintHostStageInput(state, state.goal) })
    expect((await coordinator.executePrepared(first.operationId)).status).toBe("succeeded")
    const review = store.transition(first.operationId, first.inputFingerprint)
    const operation = store.prepare({ projectId: review.projectId, stageId: "review", expectedVersion: 2,
      idempotencyKey: "actual-missing-output", inputFingerprint: fingerprintHostStageInput(review, review.goal) })
    store.decideApproval(operation.operationId, { expectedVersion: 2, inputFingerprint: operation.inputFingerprint,
      decision: "approved", actorId: "native-user" })
    const pending = coordinator.executePrepared(operation.operationId)
    await vi.waitFor(() => expect(f.retire).toHaveBeenCalledOnce())
    expect(store.getOperation(operation.operationId)?.status).toBe("started")
    expect(store.getOperation(operation.operationId)?.execution?.terminal).toBeNull()
    gate.resolve()
    const result = await pending
    expect(result.status).toBe("failed")
    expect(result.execution?.terminal).toMatchObject({ outcome: "success", code: "project_check_input_missing" })
    expect(result.receipts).toEqual([expect.objectContaining({ checkId: "output-check", result: "failed",
      validatorVersion: "host-action/v1", operationId: operation.operationId,
      inputFingerprint: operation.inputFingerprint })])
    expect(f.calls).toEqual([])
    expect(f.flowStore.runs(f.root, f.root)).toEqual([])
    expect(() => store.transition(operation.operationId, operation.inputFingerprint)).toThrow("VALIDATION_REQUIRED")
    expect(store.get(state.projectId)?.stageIndex).toBe(1)
  } finally { store.close() }
})

it.each(["prior", "source", "unsafe-path", "execution-error", "execution-unknown", "cleanup"] as const)(
  "does not infer a missing-current validation result after %s uncertainty", async scenario => {
    const f = checkPreparationFixture()
    rmSync(join(f.root, "output.json"))
    if (scenario === "prior") {
      const original = mock.skill.getMockImplementation()!
      mock.skill.mockImplementation(async context => {
        const result = await original(context)
        rmSync(join(f.root, "input.json"))
        return result
      })
    }
    if (scenario === "source") f.context.assertInputsCurrent = () => {
      if (f.skillSettled()) throw Error("ORIGINAL_SOURCE_CHANGED")
    }
    if (scenario === "unsafe-path")
      f.context.project.manifest.artifacts.find(item => item.id === "output")!.path = ".env"
    if (scenario.startsWith("execution-")) mock.skill.mockImplementation(async context => {
      context.bindThread(f.root)
      const unknown = scenario === "execution-unknown"
      context.recordTerminal({ outcome: unknown ? "unknown" : "error", code: "original_failure" })
      return unknown ? "unknown" : "failed"
    })
    if (scenario === "cleanup") f.retire.mockRejectedValue(Error("PHYSICAL_CLEANUP_UNCONFIRMED"))
    await expect(f.start()).resolves.toBe(scenario === "execution-error" ? "failed" : "unknown")
    expect(f.calls).toEqual([])
    expect(f.recordTerminal).not.toHaveBeenCalledWith({ outcome: "success", code: "project_check_input_missing" })
  })

it("rejects an appeared output before standard missing-file validation can reuse empty action evidence", async () => {
  const f = checkPreparationFixture()
  rmSync(join(f.root, "output.json"))
  await expect(f.start()).resolves.toBe("succeeded")
  const operation = { ...f.context.operation, execution: { threadId: f.root,
    terminal: { ...f.recordTerminal.mock.calls[0][0], settledAt: Date.now() } } }
  expect(readHostActionCheckEvidence(f.context.project, f.context.ticket, operation, f.root).size).toBe(0)
  writeFileSync(join(f.root, "output.json"), "{}")
  expect(() => readHostActionCheckEvidence(f.context.project, f.context.ticket, operation, f.root))
    .toThrow("PROJECT_ACTION_INPUT_CHANGED")
})

it.each(["catalog", "source-before", "source-after", "cancelled", "prior-limit", "prior-limit-with-current-limit", "prior-missing", "malformed-current"])(
  "keeps %s check preparation unconfirmed rather than inferring an output-limit failure", async scenario => {
    const f = checkPreparationFixture()
    const log = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      if (scenario === "catalog") {
        const original = f.catalog.getMockImplementation()!
        f.catalog.mockImplementation(async () => {
          if (f.skillSettled()) throw Error("PROJECT_HOST_FILE_LIMIT")
          return original()
        })
      }
      if (scenario.startsWith("source-")) {
        let reads = 0
        f.context.assertInputsCurrent = () => {
          if (f.skillSettled() && ++reads === (scenario === "source-before" ? 1 : 3))
            throw Error("ORIGINAL_SOURCE_CHANGED")
        }
      }
      if (scenario === "cancelled") f.context.assertAuthorityCurrent = () => {
        if (f.skillSettled()) {
          f.controller.abort()
          f.controller.signal.throwIfAborted()
        }
      }
      if (scenario.startsWith("prior-")) {
        if (scenario !== "prior-limit-with-current-limit") writeFileSync(join(f.root, "output.json"), "{}")
        if (scenario.startsWith("prior-limit")) writeFileSync(join(f.root, "input.json"), "x".repeat(28001))
        else {
          const original = mock.skill.getMockImplementation()!
          mock.skill.mockImplementation(async (context: HostSkillExecutionContext) => {
            const result = await original(context)
            rmSync(join(f.root, "input.json"))
            return result
          })
        }
      }
      if (scenario === "malformed-current") {
        const lock = JSON.parse(readFileSync(join(f.root, PROJECT_ACTION_LOCK_PATH), "utf8"))
        lock.bindings[0].inputFrom = { kind: "artifact", artifactId: "output", pointer: "", format: "json" }
        writeFileSync(join(f.root, PROJECT_ACTION_LOCK_PATH), JSON.stringify(lock))
        writeFileSync(join(f.root, "output.json"), "not JSON")
      }
      await expect(f.start()).resolves.toBe("unknown")
      expect(f.calls).toEqual([])
      expect(f.capture).not.toHaveBeenCalled()
      expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
        outcome: "unknown", code: "project_phase_preparation_unconfirmed"
      })
      expect(log).toHaveBeenCalledWith("[ProjectRuntime] Phase preparation failed", {
        phase: scenario === "catalog" ? "catalog" : scenario === "cancelled" ? "owner" : "check-inputs",
        code: scenario === "malformed-current" ? "UNKNOWN" : expect.stringMatching(/^[A-Z][A-Z0-9_]{0,95}$/)
      })
    } finally { log.mockRestore() }
  }
)

it("does not turn a check-input limit into a retryable failure after an external action dispatched", async () => {
  const f = checkPreparationFixture(async () => ({ passed: true, source: "native-check", summary: "done" }))
  f.context.project.manifest.stages[1].actionIds = ["second"]
  await expect(f.start()).resolves.toBe("unknown")
  expect(f.calls).toEqual(["second", "disposed"])
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
    outcome: "unknown", code: "project_phase_preparation_unconfirmed"
  })
})

it("keeps oversized-output cleanup failure unknown and contains preparation logging failure", async () => {
  const f = checkPreparationFixture()
  f.retire.mockRejectedValue(Error("CLEANUP_UNCONFIRMED"))
  const log = vi.spyOn(console, "warn").mockImplementation(() => { throw Error("LOGGER_FAILED") })
  try {
    await expect(f.start()).resolves.toBe("unknown")
    expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
      outcome: "unknown", code: "project_runtime_retirement_unconfirmed"
    })
    expect(f.calls).toEqual([])
  } finally { log.mockRestore() }
})

it.each([Error("private /path and document body"), { message: "UNTRUSTED" }, Error("APPARENT_CODE\n")])(
  "does not disclose unknown preparation errors (%#)", async error => {
    const f = checkPreparationFixture()
    const original = f.catalog.getMockImplementation()!
    f.catalog.mockImplementation(async () => {
      if (f.skillSettled()) throw error
      return original()
    })
    const log = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      await expect(f.start()).resolves.toBe("unknown")
      expect(log).toHaveBeenCalledExactlyOnceWith("[ProjectRuntime] Phase preparation failed",
        { phase: "catalog", code: "UNKNOWN" })
      expect(f.capture).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  }
)

it("records preparation unknown even if its diagnostic logger throws", async () => {
  const f = checkPreparationFixture()
  const original = f.catalog.getMockImplementation()!
  f.catalog.mockImplementation(async () => {
    if (f.skillSettled()) throw Error("CATALOG_CHANGED")
    return original()
  })
  const log = vi.spyOn(console, "warn").mockImplementation(() => { throw Error("LOGGER_FAILED") })
  try {
    await expect(f.start()).resolves.toBe("unknown")
    expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
      outcome: "unknown", code: "project_phase_preparation_unconfirmed"
    })
    expect(f.capture).not.toHaveBeenCalled()
  } finally { log.mockRestore() }
})
it.each([
  { passed: true, importOverride: false }, { passed: false, importOverride: false },
  { passed: true, importOverride: true }, { passed: false, importOverride: true }
])(
  "runs imported artifact business checks through real Flow without invoking Skill ($passed, import policy=$importOverride)",
  async ({ passed, importOverride }) => {
    const descriptor: ClawActionDescriptor = {
      pluginId: "installed",
      plugin: "formatter",
      digest: "a".repeat(64),
      actionId: "format",
      name: "Check",
      platform: { id: "check", version: "1.0.0", action: "check" },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" }
    }
    const f = fixture(
      async (step) =>
        publishOriginalFlowActionResult(
          {
            passed,
            source: "plugin-action",
            summary: "actual check",
            provider:
              step.kind === "plugin-action"
                ? {
                    pluginId: step.pluginId,
                    plugin: step.plugin,
                    digest: step.digest,
                    actionId: step.actionId
                  }
                : undefined
          },
          async (result) => result
        ),
      undefined,
      descriptor
    )
    f.context.importedValidationOnly = true
    f.context.project.manifest.stages[1].actionIds = []
    f.context.project.manifest.stages[1].resultApproval = importOverride ? "none" : "human"
    if (importOverride) f.context.importedResultApprovalRequired = true
    f.context.project.manifest.checks[0] = {
      id: "document-exists",
      kind: "action",
      sideEffect: "read",
      artifactId: "document",
      actionId: "first"
    }
    const lock = JSON.parse(readFileSync(join(f.root, PROJECT_ACTION_LOCK_PATH), "utf8"))
    lock.bindings[0].inputFrom = {
      kind: "artifact",
      artifactId: "document",
      pointer: "",
      format: "json"
    }
    writeFileSync(join(f.root, PROJECT_ACTION_LOCK_PATH), JSON.stringify(lock))
    await expect(f.start()).resolves.toBe(passed ? "succeeded" : "failed")
    expect(mock.skill).not.toHaveBeenCalled()
    expect(f.calls).toEqual(["first", "disposed"])
    expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
      outcome: passed ? "success" : "error",
      code: passed ? "import_validation_complete" : "import_validation_check_failed",
      ...(passed ? {} : { checkDiagnostics: [expect.objectContaining({
        checkId: "document-exists", actionId: "first", summary: "actual check"
      })] })
    })
  }
)

it.each([false, true])("retains bounded original failed-check diagnostics and reads pre-upgrade failures without replay (redacted=%s)", async redacted => {
  const f = fixture(async step => publishOriginalFlowActionResult({
    passed: false, source: "plugin-action", summary: "Business rules rejected the artifact",
    provider: step.kind === "plugin-action" ? {
      pluginId: step.pluginId, plugin: step.plugin, digest: step.digest, actionId: step.actionId
    } : undefined,
    output: { errors: [{ code: "SOURCE_CONTEXT_INVALID", detail: "version must be 1" }],
      warnings: Array.from({ length: 12 }, () => "snapshot path is required"),
      privateStdin: "must never be projected" }
  }, async result => redacted ? { ...result, summary: "redacted", output: { errors: [] } } : result))
  f.context.project.manifest.stages[1].actionIds = []
  f.context.project.manifest.checks[0] = {
    id: "document-exists", kind: "action", sideEffect: "read", artifactId: "document", actionId: "first"
  }
  const lock = JSON.parse(readFileSync(join(f.root, PROJECT_ACTION_LOCK_PATH), "utf8"))
  lock.bindings[0].inputFrom = { kind: "artifact", artifactId: "document", pointer: "", format: "json" }
  writeFileSync(join(f.root, PROJECT_ACTION_LOCK_PATH), JSON.stringify(lock))
  await expect(f.start()).resolves.toBe("failed")
  const terminal = f.recordTerminal.mock.calls.at(-1)![0]
  expect(terminal.code).toBe("project_checks_failed")
  expect(terminal.checkDiagnostics).toHaveLength(1)
  const diagnostic = terminal.checkDiagnostics[0]
  expect(diagnostic).toMatchObject({ checkId: "document-exists", actionId: "first",
    inputFingerprint: f.context.ticket.inputFingerprint, truncated: true,
    errors: redacted ? [] : [{ code: "SOURCE_CONTEXT_INVALID", message: "version must be 1" }] })
  expect(diagnostic.warnings).toHaveLength(redacted ? 0 : 8)
  expect(JSON.stringify(diagnostic)).not.toContain("must never be projected")
  if (redacted) expect(JSON.stringify(diagnostic)).not.toContain("version must be 1")
  const historical = { ...f.context.operation, status: "failed" as const,
    execution: { threadId: f.root, terminal: { outcome: "error" as const,
      code: "project_checks_failed", settledAt: Date.now() } } }
  expect(readHistoricalHostCheckDiagnostics(f.context.project, historical, f.root)).toEqual([diagnostic])
  expect(historical.execution.terminal).not.toHaveProperty("checkDiagnostics")
  expect(f.calls).toEqual(["first", "disposed"])
  const runtime = getProjectActionRuntime()
  const original = runtime.readActionResult!
  runtime.readActionResult = (...args) => {
    const fact = original(...args)!
    return { ...fact, provider: { ...fact.provider, pluginId: "other-installation" } }
  }
  expect(() => readHistoricalHostCheckDiagnostics(f.context.project, historical, f.root))
    .toThrow("PROJECT_ACTION_NATIVE_FACTS_SCOPE_CHANGED")
  runtime.readActionResult = original
  writeFileSync(join(f.root, "input.json"), '{"text":"changed after the failed check"}')
  expect(() => readHistoricalHostCheckDiagnostics(f.context.project, historical, f.root))
    .toThrow("PROJECT_ACTION_NATIVE_FACTS_SCOPE_CHANGED")
})

it("injects declared file context through native publication before Skill and preserves following action execution", async () => {
  const f = fixture()
  writeFileSync(join(f.root, "rules.md"), "selected domain rules")
  writeFileSync(
    join(f.root, "devclaw.project-runtime.json"),
    JSON.stringify(
      wrapProjectRuntimeManifest(f.context.project.manifest, {
        apiVersion: "devclaw.extension-contract/v1",
        requires: [CONTEXT_HANDOFF_PROTOCOL, DECLARED_CONTEXT_FILES_PROTOCOL],
        context: {
          sourceAccess: "read-only",
          mutableData: "host",
          configuration: "host-resolved",
          knowledge: { required: false },
          provider: {
            operations: ["session-context"],
            files: [{ source: "package", path: "rules.md", stages: ["review"] }]
          }
        }
      })
    )
  )
  setProjectActionRuntime({
    ...getProjectActionRuntime(),
    readDeclaredContext: (_project, root, stageId) =>
      readDeclaredContextFiles({
        context: readPackageExtensionContract(root)!.context!,
        snapshotRoot: root,
        stageId,
        assertCurrent: () => {}
      })
  })
  f.publishRequiredContext.mockImplementation(async (_workspace, text) =>
    text.replace("selected", "published")
  )
  mock.skill.mockImplementation(async (value: HostSkillExecutionContext) => {
    value.bindThread(f.root)
    const prepared = await value.prepareThread?.(f.root)
    expect(prepared?.requiredContextText).toContain("published domain rules")
    expect(prepared?.requiredContextText).not.toContain("selected domain rules")
    value.recordTerminal({ outcome: "success", code: "skill_success" })
    return "succeeded"
  })
  await expect(f.start()).resolves.toBe("succeeded")
  expect(f.calls).toEqual(["first", "second", "disposed"])
})

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
  await expect(f.start()).resolves.toBe("unknown")
  expect(f.calls).toEqual([])
  expect(f.recordTerminal).toHaveBeenCalledExactlyOnceWith({
    outcome: "unknown", code: "project_phase_preparation_unconfirmed"
  })
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

it.each([
  "valid",
  "invalid",
  "context-nontext",
  "context-negative",
  "debug-valid",
  "debug-broad",
  "debug-nested"
])(
  "loads a generic real Guest context and checks actual artifacts through original Flow (%s)",
  async (scenario) => {
    const debug = scenario.startsWith("debug-")
    const valid = scenario === "valid" || debug
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
        requiredPermissions:${JSON.stringify(scenario === "debug-broad" ? ["fs.read"] : [])},cancellable:true,idempotency:"keyed"
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
        ${scenario === "debug-nested" ? 'await $.platform.read({provider:"native.project-context",id:"materials",version:"1.0.0"});' : ""}
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
      if (debug) {
        f.context.stageDebug = { workspace: f.root, baselineId: "captured-stage-input" }
        manifest.actions = manifest.actions.filter((action) => action.id !== contextBinding.id)
        writeFileSync(
          join(f.root, PROJECT_ACTION_LOCK_PATH),
          JSON.stringify({
            apiVersion: "devclaw.project-actions-lock/v1",
            bindings: [checkBinding, retainedBinding]
          })
        )
        writeFileSync(join(f.root, "devclaw.project-runtime.json"), JSON.stringify(manifest))
        setProjectActionRuntime({
          ...getProjectActionRuntime(),
          verifyReadOnlyCheckProvider: (...args) => functions.verifyReadOnlyCheckProvider(...args)
        })
      }
      let loaded: string | undefined
      mock.skill.mockImplementation(async (value: HostSkillExecutionContext) => {
        value.bindThread(f.root)
        const prepared = await value.prepareThread?.(f.root)
        loaded = prepared?.requiredContextText
        if (!debug) {
          expect(loaded).toContain("Required glossary")
          expect(loaded).toContain("invoice denotes")
          expect(loaded).not.toContain("invoice means")
        }
        writeFileSync(
          join(f.root, "input.json"),
          valid ? "Invoice: approved billing record" : "invented billing record"
        )
        value.recordTerminal({ outcome: "success", code: "real-skill-terminal" })
        return "succeeded"
      })
      if (scenario === "debug-broad") {
        await expect(f.start()).resolves.toBe("failed")
        expect(f.calls).toEqual([])
        expect(f.recordTerminal).toHaveBeenCalledWith({
          outcome: "error",
          code: "project_action_dependencies_unavailable"
        })
        return
      }
      if (scenario === "debug-nested") {
        await expect(f.start()).resolves.not.toBe("succeeded")
        expect(f.calls).toEqual(["verify-document", "disposed"])
        return
      }
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
        ...(!debug ? ["required-context", "disposed"] : []),
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

it.each(["valid", "text-changed", "fact-changed", "grant-revoked", "selected", "selected-text-changed", "selected-value-changed"])(
  "reuses a settled context phase only with retained text, original facts and fresh authority (%s)",
  async (scenario) => {
    const f = fixture(async (step) =>
      publishOriginalFlowActionResult(
        {
          passed: true,
          summary: "context",
          source: "plugin-action",
          provider:
            step.kind === "plugin-action"
              ? {
                  pluginId: step.pluginId,
                  plugin: step.plugin,
                  digest: step.digest,
                  actionId: step.actionId
                }
              : undefined
        },
        async (value) => value,
        "original context"
      )
    )
    const manifest = f.context.project.manifest
    manifest.stages[1].actionIds = []
    manifest.stages[1].checkIds = []
    const selected = scenario.startsWith("selected")
    if (selected) {
      const [original] = await f.catalog()
      const checkProvider: ClawActionDescriptor = {
        pluginId: original.pluginId, plugin: original.plugin, digest: original.digest,
        actionId: "validate", name: "Validate", inputSchema: { type: "object" },
        outputSchema: { type: "object" }, platform: { id: "validation", version: "1.0.0", action: "check" }
      }
      const lock = readProjectActionLock(f.root, manifest)
      lock.bindings[1] = createProjectActionBinding("second", checkProvider, {}, {}, {
        kind: "artifact", artifactId: "document", pointer: "", format: "artifact-reference-v1", maxBytes: 28000
      }, ["audience"])
      manifest.actions = lock.bindings.map(({ id, ref }) => ({ id, ref }))
      manifest.checks.push({ id: "selected-check", kind: "action", artifactId: "document",
        sideEffect: "read", actionId: "second" })
      manifest.stages[1].checkIds = ["selected-check"]
      writeFileSync(join(f.root, PROJECT_ACTION_LOCK_PATH), JSON.stringify(lock))
      f.catalog.mockResolvedValue([original, checkProvider])
      setProjectActionRuntime({ ...getProjectActionRuntime(), readPublicConfiguration: () => ({ audience: "native UI" }) })
    }
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
            provider: { actionId: "first", operations: ["session-context"] }
          }
        })
      )
    )
    let canonical = ""
    mock.skill.mockImplementationOnce(async (value: HostSkillExecutionContext) => {
      value.bindThread(f.root)
      canonical = (await value.prepareThread?.(f.root))?.requiredContextText ?? ""
      value.recordTerminal({ outcome: "unknown", code: "host_user_input_waiting" })
      return "unknown"
    })
    await expect(f.start()).resolves.toBe("unknown")
    expect(f.calls).toEqual(["first", "disposed"])
    if (selected) expect(canonical).toContain('"configuration":{"audience":"native UI"}')
    const [run] = f.flowStore.runs(f.root, f.root)
    const attempt = run.attempts.find((item) => item.stepId === "first")!
    const fact = f.flowStore.actionResult(f.root, f.root, run.id, attempt.executionId)!
    const assertCurrent = vi.fn()
    const verify = vi.fn(async () => {
      if (scenario === "grant-revoked") throw Error("GRANT_REVOKED")
      return assertCurrent
    })
    setProjectActionRuntime({ ...getProjectActionRuntime(), verifyReadOnlyContextProvider: verify })
    f.context.recoveryInput = {
      schemaVersion: 1,
      status: "answered",
      response: null,
      reason: null,
      binding: {
        projectId: f.context.project.projectId,
        operationId: "operation",
        stageId: "review",
        installedPluginId: "installed",
        expectedVersion: 2,
        pluginDigest: f.context.project.pluginDigest,
        inputFingerprint: f.context.ticket.inputFingerprint,
        incarnationKey: "test"
      },
      request: { requestId: "request", threadId: f.root, createdAt: "now", questions: [] },
      continuation: {
        protocol: "host-user-input-interrupt/v1",
        toolCallId: "input",
        claimed: false,
        priorToolsSettled: true,
        requiredContextText: scenario === "text-changed" ? "changed"
          : scenario === "selected-text-changed" ? canonical.replace("native UI", "forged") : canonical,
        contextResumeProof: {
          authority: {
            protocol: "devclaw.native-project-context-readonly/v1",
            workspace: f.root,
            threadId: f.root,
            operationId: "operation",
            inputIdentity: f.context.ticket.inputFingerprint,
            provider: fact.provider,
            policy: "native-materials-only/v1"
          },
          providerId: "first",
          runId: run.id,
          executionId: scenario === "fact-changed" ? "other" : fact.executionId,
          definitionDigest: fact.definitionDigest,
          canonicalContextDigest: createHash("sha256").update(canonical).digest("hex")
        }
      }
    }
    if (scenario === "selected-value-changed")
      f.context.assertInputsCurrent = () => { throw Error("CONFIGURATION_CHANGED") }
    f.recordTerminal.mockClear()
    mock.skill.mockImplementationOnce(async (value: HostSkillExecutionContext) => {
      // The real executor skips prepareThread on recovery; no provider replay is permitted.
      value.assertInputResumeResourcesCurrent?.()
      value.recordTerminal({ outcome: "success", code: "resumed" })
      return "succeeded"
    })
    if (scenario === "valid" || scenario === "selected") {
      await expect(f.start()).resolves.toBe("succeeded")
      if (!selected) expect(assertCurrent).toHaveBeenCalledTimes(2)
    } else
      await expect(f.start()).rejects.toThrow(
        scenario === "grant-revoked" ? "GRANT_REVOKED"
          : scenario === "selected-value-changed" ? "CONFIGURATION_CHANGED" : "PROJECT_INPUT_RESUME_CONTEXT_"
      )
    expect(f.calls).toEqual(["first", "disposed", ...(scenario === "selected" ? ["second", "disposed"] : [])])
  }
)
