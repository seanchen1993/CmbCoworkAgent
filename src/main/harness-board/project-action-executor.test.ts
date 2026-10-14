import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { BrowserWindow } from "electron"
import type { HostSkillExecutionContext } from "./project-runtime/host-service"
import type { HostProjectState } from "../../shared/project-runtime/host-types"
import type { FlowExecution } from "../mods/flows/contracts"
import { hostProjectFixture } from "./project-runtime/host-fixtures.test-helper"
import { PROJECT_ACTION_LOCK_PATH } from "../../shared/project-runtime/action-bindings"
import { createProjectActionBinding } from "./project-runtime/action-input"
import { fingerprintHostStageInput, validateHostStage } from "./project-runtime/host-validators"
import { FlowManager } from "../mods/flows/manager"
import { FlowStore } from "../mods/flows/store"
import { isOrdinaryFlowMetadata } from "../../shared/mods/flows/scope"
import { projectActionFlowMetadata } from "./project-action-scope"
import { setProjectActionRuntime } from "./project-action-runtime"

const mock = vi.hoisted(() => ({
  metadata: {} as Record<string, unknown>,
  snapshotRoot: "",
  skill: vi.fn()
}))
vi.mock("../db", () => ({
  getThreadCore: () => ({ created_at: 1, metadata: JSON.stringify(mock.metadata) })
}))
vi.mock("./host-skill-executor", () => ({ executeHostProjectSkill: mock.skill }))
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
  configureState?: (state: HostProjectState) => void
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
  const descriptor = {
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
  const flows = new FlowManager(
    new FlowStore({
      getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
      setSetting: (key, value) => {
        settings.set(key, value)
      }
    }),
    {
      assertScope: (_workspace, threadId) => {
        if (!isOrdinaryFlowMetadata(projectActionFlowMetadata(threadId, mock.metadata)))
          throw Error("UNADMITTED_PROJECT_FLOW")
      },
      changed: () => {},
      prepare: async () => ({
        assertLive: () => {},
        fingerprint: async () => "stable",
        execute: async (step, ctx) => {
          calls.push(step.id)
          expect(recordTerminal).not.toHaveBeenCalled()
          return execute
            ? execute(step, ctx)
            : { passed: true, source: "native-check", summary: "done" }
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
      })
    }
  )
  const catalog = vi.fn(async () => [descriptor])
  setProjectActionRuntime({ flows, catalog, prepareSelection: async () => {} })
  return {
    root,
    context,
    controller,
    calls,
    flows,
    catalog,
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
        id: "review-exists", artifactId: "review", kind: "file-exists", sideEffect: "read"
      })
      state.manifest.stages[1].artifactIds = ["review"]
      state.manifest.stages[1].checkIds = ["review-exists"]
    }
  )
  await expect(f.start()).resolves.toBe("unknown")
  expect(f.calls).toEqual(["first", "disposed"])
  expect(f.recordTerminal.mock.calls[0][0].outcome).toBe("unknown")
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
    outcome: "success", code: "project_actions_complete"
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
