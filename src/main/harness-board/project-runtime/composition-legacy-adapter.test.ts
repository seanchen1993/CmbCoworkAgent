import { executeProjectCheckpoint } from "./project-checkpoint"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"
import type { StageCheckReceipt } from "../../../shared/project-runtime/stage-check-receipt"
import { CompositionLegacyAdapter } from "./composition-legacy-adapter"
import { CompositionInternalProjects } from "./composition-internal-projects"
import type { CompositionExecutionContext } from "./composition-coordinator"
import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type {
  HarnessHumanGateSnapshot,
  HarnessProjectMetadata,
  HarnessRunDetailViewModel,
  ManagedRunSnapshot
} from "../../../shared/harness-board-types"
import type { PluginMetadata } from "../../types"
import type { HostProjectService } from "./host-service"
import { ProjectCompositionService } from "./composition-service"
import { RetainedPackageSnapshots } from "./package-snapshots"
import type { CompositionInternalProject } from "./composition-internal-projects"
import type { CompositionLegacyDependencies } from "./composition-legacy-adapter"
import { SOURCE_HANDOFF_DECLARATION } from "../../../shared/project-runtime/autobiz-handoff"
import { runtimeDigest } from "./safe-files"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close()
})
async function fixture(
  checkpointMode = false,
  configure?: (original: CompositionLegacyDependencies) => void,
  sourceHandoff = false
) {
  const root = mkdtempSync(join(tmpdir(), "composition-legacy-integration-"))
  cleanups.push(() => rmSync(root, { force: true, recursive: true }))
  const workspace = join(root, "parent")
  const installed = join(root, "installed")
  mkdirSync(workspace)
  mkdirSync(join(installed, "board_core"), { recursive: true })
  writeFileSync(join(installed, "board_core/board_config.json"), "{}")
  if (sourceHandoff)
    writeFileSync(
      join(installed, "devclaw.source-handoff.json"),
      JSON.stringify(SOURCE_HANDOFF_DECLARATION)
    )
  const snapshot = await new RetainedPackageSnapshots(join(root, "packages")).captureAsync(
    installed
  )
  const plugin = {
    id: "original",
    name: "original",
    version: "1",
    path: snapshot.root,
    enabled: true
  } as PluginMetadata
  const parent = {
    projectId: "parent",
    name: "Parent",
    description: "",
    workspacePath: root,
    projectDir: "parent",
    projectCode: "parent",
    systemId: "system",
    systemName: "system",
    "harness-adapter": { id: plugin.id, name: plugin.name, version: "1", type: "plugin" },
    lifecycle: { status: "active", createAt: "2026-10-14T00:00:00Z" }
  } as HarnessProjectMetadata
  let pending: HarnessHumanGateSnapshot | undefined
  let completed = false
  let active = true
  const initialized: string[] = []
  const created: string[] = []
  const original: CompositionLegacyDependencies = {
    resolveSource: async () => ({
      plugin,
      packageDigest: snapshot.digest,
      goal: "The real requested result",
      parent
    }),
    authorize: async () => undefined,
    authorizeCancellation: async () => undefined,
    initialize: vi.fn(async (record) => {
      initialized.push(record.unitId)
    }),
    createFeature: async (record) => {
      created.push(record.goal)
    },
    start: async (record) => {
      if (record.unitId === "first")
        pending = {
          gateId: "gate",
          projectId: record.projectId,
          featureId: record.featureId,
          sourceManagedRunId: "managed-first",
          sourceThreadId: "child",
          message: "Original approval",
          hookId: "check",
          createdAt: "now",
          status: "pending"
        }
      return `managed-${record.unitId}`
    },
    readStatus: (record) => ({
      runId: record.engineRunId!,
      status: record.unitId === "second" || completed ? "completed" : "running"
    }),
    observe: async (record: CompositionInternalProject) => ({
      projectId: record.projectId,
      featureId: record.featureId,
      journalHealthy: true,
      managed: {
        projectId: record.projectId,
        featureId: record.featureId,
        runId: record.engineRunId!,
        status: "completed"
      } as ManagedRunSnapshot,
      events: [
        {
          version: 2.5,
          eventId: "final",
          runId: record.engineRunId!,
          createTime: "now",
          type: "run_completed",
          scope: "global",
          summary: "original completed"
        }
      ],
      detail: {
        project: { projectId: record.projectId, projectRootPath: record.workspace },
        adapterSnapshot: { mock: false },
        workflow: { nodes: [{ id: "final", hookDefinitions: [], artifactDefinitions: [] }] },
        run: {
          slug: record.featureId,
          featureStatus: "done",
          currentNodeId: "final",
          nodes: [{ id: "final", nodeStatus: "done", hooks: [], artifacts: [] }]
        }
      } as unknown as HarnessRunDetailViewModel
    }),
    pendingGate: () => pending,
    decideGate: async (_record, gate, decision) => {
      if (gate !== pending?.gateId || decision !== "approve") return false
      pending = undefined
      completed = true
      return true
    },
    cancel: async () => !active
  }
  if (checkpointMode) {
    original.checkContracts = async () => [
      {
        nodeId: "final",
        checkId: "postcheck",
        contractDigest: "d".repeat(64),
        artifacts: [],
        checkOnly: true
      }
    ]
    original.stageCheckIdentity = (record) => ({ engineRunId: record.engineRunId! })
    original.transition = vi.fn(async (_record, input) => {
      const receipts: StageCheckReceipt[] = [
        {
          apiVersion: "devclaw.stage-check/v1",
          nodeId: "final",
          checkId: "postcheck",
          contractDigest: "d".repeat(64),
          outcome: "passed",
          artifacts: []
        }
      ]
      await input.validateReceipts(receipts)
      return { status: "committed" as const, stateDigest: "e".repeat(64), receipts }
    })
  }
  configure?.(original)
  const service = new ProjectCompositionService(
    join(root, "composition.sqlite"),
    {} as HostProjectService,
    {
      resolveSource: async () => ({
        installedPluginId: plugin.id,
        hostPackageDigest: snapshot.digest,
        goal: "The real requested result",
        runtimeMode: "legacy"
      }),
      authorizeDefinition: async () => undefined,
      authorizeParent: async () => undefined,
      authorize: async () => undefined,
      assertWorkspaceIdle: () => undefined,
      beforeStart: () => undefined,
      legacy: original
    }
  )
  cleanups.push(() => service.close())
  const definition = {
    apiVersion: "devclaw.project-composition/v1",
    parentProjectId: "parent",
    workspace,
    goal: "The real requested result",
    units: ["first", "second"].map((id) => ({
      id,
      kind: "flow",
      source: { pluginId: plugin.id, capabilityId: "flow", packageDigest: snapshot.digest },
      inputs: [],
      outputs: []
    }))
  }
  return {
    root,
    service,
    definition,
    initialized,
    created,
    original,
    deactivate: () => {
      active = false
    }
  }
}
it("freezes source hashes after original initialization but before the first model start", async () => {
  let observed = false
  const f = await fixture(
    true,
    (original) => {
      const create = original.createFeature,
        start = original.start
      original.createFeature = async (record) => {
        await create(record)
        mkdirSync(join(record.workspace, "src"))
        writeFileSync(join(record.workspace, "src/initial.ts"), "initial source")
      }
      original.start = async (record, context) => {
        const checks = (
          f.service as unknown as {
            stageChecks: import("./composition-stage-check-store").CompositionStageCheckStore
          }
        ).stageChecks
        expect(checks.sourceBaseline(record.compositionRunId, record.unitId)?.files).toEqual([
          { path: "src/initial.ts", digest: runtimeDigest("initial source") }
        ])
        writeFileSync(join(record.workspace, "src/initial.ts"), "model generated source")
        observed = true
        return start(record, context)
      }
    },
    true
  )
  const waiting = await f.service.start(f.definition, "source-before-start")
  expect(waiting.status).toBe("waiting-approval")
  expect(observed).toBe(true)
})

it("preserves the original gate, consumes approval CAS, and only then launches the next hidden unit", async () => {
  const f = await fixture()
  const waiting = await f.service.start(f.definition, "request")
  expect(waiting.status).toBe("waiting-approval")
  expect(f.initialized).toEqual(["first"])
  expect(f.created).toEqual(["The real requested result"])
  expect(f.service.waitingLegacyApproval(waiting.id, "first")).toMatchObject({
    kind: "legacy-human-gate",
    gateId: "gate",
    message: "Original approval"
  })
  await expect(
    f.service.approveLegacy(waiting.id, "first", "wrong", waiting.version, "approve")
  ).rejects.toThrow("APPROVAL_CHANGED")
  const approved = await f.service.approveLegacy(
    waiting.id,
    "first",
    "gate",
    waiting.version,
    "approve"
  )
  expect(approved.version).toBe(waiting.version + 1)
  await expect(f.service.resume(waiting.id, waiting.version)).rejects.toThrow("VERSION_CONFLICT")
  const finished = await f.service.resume(waiting.id, approved.version)
  expect(finished.status).toBe("succeeded")
  expect(f.initialized).toEqual(["first", "second"])
  expect(finished.units.every((unit) => unit.proof?.kind === "flow-completed")).toBe(true)
})
it("retains an unknown lease when stopping progression did not stop the original agent", async () => {
  const f = await fixture()
  const waiting = await f.service.start(f.definition, "request")
  const stopped = await f.service.cancel(waiting.id)
  expect(stopped.status).toBe("unknown")
  expect(f.initialized).toEqual(["first"])
  expect(() => f.service.guardWorkspaceMutation(f.definition.workspace, () => undefined)).toThrow(
    "BUSY"
  )
})
it("does not replay an initializer with persisted interrupted intent", async () => {
  const f = await fixture()
  vi.mocked(f.original.initialize).mockImplementationOnce(async () => {
    throw Error("interrupted initialize")
  })
  const failed = await f.service.start(f.definition, "request")
  expect(failed.status).toBe("unknown")
  const again = await f.service.start(f.definition, "request")
  expect(again.id).toBe(failed.id)
  expect(f.original.initialize).toHaveBeenCalledTimes(1)
  expect(f.created).toEqual([])
})

it("cold explicit observation re-admits retained content without replaying a still-running engine", async () => {
  const f = await fixture()
  const waiting = await f.service.start(f.definition, "request")
  const reopened = new CompositionInternalProjects(
    join(f.root, "internal-projects.sqlite"),
    () => undefined
  )
  cleanups.push(() => reopened.close())
  const adapter = new CompositionLegacyAdapter(reopened, f.original)
  const context: CompositionExecutionContext = {
    runId: waiting.id,
    parentProjectId: "parent",
    workspace: f.definition.workspace,
    executionWorkspace: f.service.store.unitWorkspace(waiting.id, "first"),
    unit: waiting.definition.units[0],
    inputs: [],
    engineRunId: waiting.units[0].engineRunId,
    attemptId: waiting.units[0].attemptId!,
    idempotencyKey: "first"
  }
  expect((await adapter.resume(context, new AbortController().signal)).status).toBe("unknown")
  expect(f.initialized).toEqual(["first"])
  await f.service.approveLegacy(waiting.id, "first", "gate", waiting.version, "approve")
  const completed = await adapter.resume(context, new AbortController().signal)
  expect(completed.status).toBe("completed")
  expect(f.initialized).toEqual(["first"])
})

it("unknown recovery only observes original status and a later confirmed cancellation releases the lease", async () => {
  const f = await fixture()
  const waiting = await f.service.start(f.definition, "request")
  const uncertain = await f.service.cancel(waiting.id)
  const observed = await f.service.resume(uncertain.id, uncertain.version)
  expect(observed.status).toBe("unknown")
  expect(f.initialized).toEqual(["first"])
  f.deactivate()
  expect((await f.service.cancel(waiting.id)).status).toBe("cancelled")
  expect(() =>
    f.service.guardWorkspaceMutation(f.definition.workspace, () => undefined)
  ).not.toThrow()
})

it("routes the checkpoint through the active internal source, validates ready receipts and prevents duplicate writes", async () => {
  const f = await fixture(true)
  const waiting = await f.service.start(f.definition, "checkpoint")
  const record = f.service.legacy!.projects.get(`composition-legacy:${waiting.id}:first`)!
  const token = issueRuntimePluginSourceToken({
    mode: "legacy",
    threadId: "child",
    incarnationKey: "incarnation",
    projectId: record.projectId,
    operationId: waiting.id,
    workspace: record.workspace,
    packageDigest: record.packageDigest,
    stageId: "final",
    plugin: record.plugin
  })
  await f.service.store.withWorkspaceOwner(waiting.id, () =>
    withRuntimePluginSource(token, async () => {
      const input = { checkpoint: "final_done", expectedStateDigest: "c".repeat(64) }
      expect((await executeProjectCheckpoint(input)).status).toBe("committed")
      expect((await executeProjectCheckpoint(input)).status).toBe("committed")
      expect(f.original.transition).toHaveBeenCalledTimes(1)
    })
  )
})
it("records unknown when a committed response differs from the host-acknowledged receipt set", async () => {
  const f = await fixture(true)
  vi.mocked(f.original.transition!).mockImplementationOnce(async (_record, input) => {
    await input.validateReceipts([])
    return {
      status: "committed" as const,
      stateDigest: "e".repeat(64),
      receipts: [
        {
          apiVersion: "devclaw.stage-check/v1",
          nodeId: "final",
          checkId: "postcheck",
          contractDigest: "d".repeat(64),
          outcome: "passed",
          artifacts: []
        }
      ]
    }
  })
  const waiting = await f.service.start(f.definition, "checkpoint-mismatch")
  const record = f.service.legacy!.projects.get(`composition-legacy:${waiting.id}:first`)!
  const token = issueRuntimePluginSourceToken({
    mode: "legacy",
    threadId: "child",
    incarnationKey: "incarnation",
    projectId: record.projectId,
    operationId: waiting.id,
    workspace: record.workspace,
    packageDigest: record.packageDigest,
    stageId: "final",
    plugin: record.plugin
  })
  await f.service.store.withWorkspaceOwner(waiting.id, () =>
    withRuntimePluginSource(token, async () => {
      const input = { checkpoint: "final_done", expectedStateDigest: "c".repeat(64) }
      await expect(executeProjectCheckpoint(input)).rejects.toThrow("ACK_MISMATCH")
      expect((await executeProjectCheckpoint(input)).status).toBe("unknown")
      expect(f.original.transition).toHaveBeenCalledTimes(1)
    })
  )
})

it("projects live execution threads under the retained workspace owner", async () => {
  const f = await fixture(false, (original) => {
    original.executionThreadIds = (record) =>
      service.store.guardWorkspaceMutation(record.workspace, () => ["child"])
  })
  const service = f.service
  const waiting = await f.service.start(f.definition, "thread-owner")
  expect(f.service.executionThreadIds(waiting.id, "first")).toEqual(["child"])
})

it("original Biz Retry consumes CAS and resumes observation without replaying initialization", async () => {
  let pending = true
  const decide = vi.fn(async () => {
    pending = false
    return { applied: true, message: "continued" }
  })
  const f = await fixture(false, (original) => {
    original.pendingGate = () => undefined
    original.waitingReason = () => (pending ? "original retry" : undefined)
    original.executionThreadIds = () => ["child"]
    original.pendingDecision = (record) =>
      pending
        ? {
            notificationId: "retry",
            message: "original retry",
            projectId: record.projectId,
            featureId: record.featureId,
            engineRunId: record.engineRunId!,
            threadId: "child"
          }
        : undefined
    original.decideDecision = decide
    original.readStatus = (record) => ({
      runId: record.engineRunId!,
      status: pending ? "running" : "completed"
    })
  })
  const waiting = await f.service.start(f.definition, "retry")
  expect(f.service.waitingLegacyDecision(waiting.id, "first")).toMatchObject({
    notificationId: "retry",
    humanGatePending: false
  })
  await expect(
    f.service.decideLegacy(waiting.id, "first", waiting.version - 1, {
      notificationId: "retry",
      action: "continue"
    })
  ).rejects.toThrow("VERSION_CONFLICT")
  await expect(
    f.service.decideLegacy(waiting.id, "first", waiting.version, {
      notificationId: "wrong",
      action: "continue"
    })
  ).rejects.toThrow("DECISION_CHANGED")
  await f.service.decideLegacy(waiting.id, "first", waiting.version, {
    notificationId: "retry",
    action: "continue"
  })
  const refreshed = f.service.get(waiting.id)!
  expect((await f.service.resume(waiting.id, refreshed.version)).status).toBe("succeeded")
  expect(f.initialized).toEqual(["first", "second"])
  expect(decide).toHaveBeenCalledTimes(1)
})
