import { afterEach, expect, it, vi } from "vitest"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promisify } from "node:util"
import AdmZip from "adm-zip"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { join, dirname, resolve } from "node:path"
import { tmpdir } from "node:os"
import type { BrowserWindow } from "electron"
import type {
  HarnessProjectMetadata,
  ManagedRunSummary,
  HarnessProjectCreateInput
} from "../../../shared/harness-board-types"
import { ModControlStore } from "../control-store"
import { CreatorBusinessTrials } from "./creator-business-trial"
import type { DevelopmentScope } from "../v2/development-session"
import {
  snapshotDerivationSource,
  derivationContentIdentity
} from "../../plugins/derivation-source"
import { writeDerivationFiles, type DerivationFile } from "../../plugins/derivation-source"
import { businessModCatalog } from "../../plugins/business-mod-manifest"
import { assembleBusinessMods } from "../../plugins/business-mod-assembler"
import { prepareAutobizStageRecoverySource } from "../../../../scripts/prepare-autobiz-stage-recovery-source"
import { preflightAutobizCompositionSource } from "../../plugins/business-adapters/autobiz-composition-preflight"
import { runtimeDigest } from "../../harness-board/project-runtime/safe-files"
import {
  readInternalHarnessProject,
  readInternalHarnessProjectWorkspaceIndex,
  captureInternalHarnessProjectIdentityGuard
} from "../../harness-board/internal-project-context"
import { hostProjectFixture } from "../../harness-board/project-runtime/host-fixtures.test-helper"
import { publishDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import { businessCreatorScopeKey } from "./creator-business-draft"
import { ModDevelopmentService, setModDevelopmentService } from "./development-service"
import { AuthoringDraftStore } from "./authoring-store"
import { PluginStageRecoverySessions } from "./plugin-stage-recovery"
import { FunctionModsManager } from "../v2/manager"
import { FunctionGuestRuntime } from "../v2/guest-runtime"
import { FunctionUserConfigValues } from "../v2/user-config-values"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { testSecretProtector } from "../../../../tests/support/mods-secret-protector"
import { readProjectRecoveryContext } from "../../harness-board/project-runtime/recovery-context"
import {
  wrapProjectRuntimeManifest,
  CONTEXT_HANDOFF_PROTOCOL
} from "../../../shared/project-runtime"
import * as trialEvidenceAdapter from "./adapters/autobiz-trial-evidence"
import { registerLegacyCompositionAdmission } from "../../harness-board/project-runtime/composition-legacy-production"
import { prepareAgentRunAdmission } from "../../agent/agent-run-admission"
import {
  currentRuntimePluginSource,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"
import {
  executeProjectCheckpoint,
  projectCheckpointAvailable
} from "../../harness-board/project-runtime/project-checkpoint"

const boundary = vi.hoisted(() => ({
  ready: false,
  source: true,
  run: null as ManagedRunSummary | null,
  initialize: vi.fn(),
  feature: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  prepareFacts: vi.fn(async () => {}),
  failInitialize: false,
  initializeGate: undefined as Promise<void> | undefined,
  candidateGate: undefined as Promise<void> | undefined,
  busy: false,
  cancel: vi.fn(),
  workflowCancel: vi.fn(),
  onCancel: undefined as ((threadId: string) => void) | undefined,
  foreignThread: false,
  manager: undefined as FunctionModsManager | undefined
}))
// Only orchestration seams are controlled here. Original SQLite CAS, retained package
// capture/content proof and main-only provider routing are real. Actual original Python,
// Managed model execution remains controlled. The cold recovery case explicitly substitutes a
// genuine FunctionModsManager to join native configuration/secrets/knowledge and the real sandbox.
vi.mock("../../harness-board/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../harness-board/service")>()),
  createHarnessProject: async (
    input: HarnessProjectCreateInput,
    source: {
      projectId: string
      plugin: { name: string; version: string }
      bindProject(project: HarnessProjectMetadata): void
      guard(): void
    }
  ) => {
    boundary.initialize(input, source)
    source.guard()
    const project: HarnessProjectMetadata = {
      name: input.name,
      description: input.description,
      projectCode: input.projectCode,
      projectDir: input.projectDir,
      projectFromLean: false,
      systemId: input.systemId,
      systemName: input.systemName,
      workspacePath: input.workspacePath,
      projectId: source.projectId,
      "harness-adapter": {
        id: input.adapterId,
        name: source.plugin.name,
        version: source.plugin.version,
        type: "plugin"
      },
      lifecycle: { status: "active", createAt: "2026-10-17T00:00:00Z" }
    }
    source.bindProject(project)
    await boundary.initializeGate
    if (boundary.failInitialize) throw Error("INITIALIZATION_EFFECT_UNCONFIRMED")
    source.guard()
    return project
  },
  createHarnessFeature: async (input: unknown, guard: () => void) => {
    guard()
    boundary.feature(input)
  }
}))
vi.mock("../../harness-board/managed-run-controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../harness-board/managed-run-controller")>()),
  managedRunController: {
    start: async (input: { projectId: string; featureId: string; workspacePath: string }) => {
      boundary.start(input)
      boundary.busy = true
      boundary.run = {
        ...input,
        runId: "original-managed-run",
        version: 2.5,
        status: "running",
        providerRetryCount: 0,
        startedAt: "2026-10-17 00:00:00",
        updatedAt: "2026-10-17 00:00:00",
        currentSession: { threadId: "original-managed-thread" }
      }
      return boundary.run
    },
    stop: async (input: unknown) => {
      boundary.stop(input)
      if (boundary.run) boundary.run.status = "cancelled"
      return true
    }
  }
}))
vi.mock("../../harness-board/managed-run-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../harness-board/managed-run-store")>()),
  managedRunStore: {
    listEvents: () => ({ events: [], hasMore: false }),
    getLatestRun: (id: string) => {
      readInternalHarnessProjectWorkspaceIndex(id)
      return boundary.run?.projectId === id ? boundary.run : null
    }
  }
}))
vi.mock("../../harness-board/project-runtime/composition-legacy-preflight", () => ({
  preflightLegacyCompositionSource: async () => {}
}))
vi.mock("../../harness-board/project-runtime/composition-unit-context", async () => {
  const original = await vi.importActual<
    typeof import("../../harness-board/project-runtime/composition-unit-context")
  >("../../harness-board/project-runtime/composition-unit-context")
  return {
    ...original,
    readCompositionUnitContext: async () => ({
      view: { supported: false, required: false, candidates: [], selected: [] },
      assertCurrent() {
        /* Controlled provider read seam; real source proof is outside it. */
      }
    })
  }
})
vi.mock("../../harness-board/project-runtime-function-source", () => ({
  projectRuntimeFunctionSource: (
    project: {
      projectId: string
      workspace: string
      pluginDigest: string
      installedPluginId: string
      packageId: string
    },
    root: string
  ) => ({
    input: {
      workspace: boundary.manager ? project.workspace.toLowerCase() : project.workspace,
      scope: { projectId: project.projectId, packageDigest: project.pluginDigest },
      plugin: { id: project.installedPluginId, name: project.packageId, path: root, enabled: true }
    },
    manager: boundary.manager ?? {
      prepareRuntimeSourceFacts: boundary.prepareFacts,
      captureStageRecoveryConfiguration: async () => undefined,
      assertRuntimeSourceReady: () => {
        if (!boundary.ready) throw Error("PROJECT_MODS_APPROVAL_REQUIRED")
      }
    }
  })
}))
vi.mock("../../agent/agent-run-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent/agent-run-service")>()),
  createBrowserWindowAgentRunDelivery: () => ({}),
  cancelActiveAgentRun: (id: string) => {
    boundary.cancel(id)
    boundary.onCancel?.(id)
    boundary.busy = false
    return true
  },
  isAgentRunBusy: () => boundary.busy
}))
vi.mock("../../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db")>()),
  getThreadCore: () => ({
    created_at: 1,
    metadata: JSON.stringify({
      workspacePath: boundary.run?.workspacePath,
      harnessFeature: {
        projectId: boundary.foreignThread ? "foreign-project" : boundary.run?.projectId,
        slug: boundary.run?.featureId,
        runId: boundary.run?.runId
      }
    })
  })
}))
vi.mock("../../agent/workflow/run-manager", () => ({
  deferOwnedRuntimeWorkflowSettlement: () => ({ deferred: false }),
  workflowRunManager: {
    cancelAndWait: async (id: string) => {
      boundary.workflowCancel(id)
    }
  }
}))
vi.mock("../../mcp/capability-service", () => ({
  closeProjectCapabilityMcpService: vi.fn(async () => {})
}))
vi.mock("../../harness-board/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../harness-board/notifications")>()),
  harnessNotifications: { pending: () => [] }
}))
vi.mock("../../services/notification-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/notification-actions")>()),
  decideNotification: vi.fn()
}))

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.clearAllMocks()
  boundary.ready = false
  boundary.source = true
  boundary.run = null
  boundary.failInitialize = false
  boundary.initializeGate = undefined
  boundary.busy = false
  boundary.onCancel = undefined
  boundary.foreignThread = false
  boundary.candidateGate = undefined
  boundary.manager = undefined
})
async function fixture(
  recoveryAdapter = false,
  actualSource?: DerivationFile[],
  nativeConfiguration = false
) {
  const root = await mkdtemp(join(tmpdir(), "business-trial-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "candidate")
  await mkdir(join(source, "board_core"), { recursive: true })
  const manifest = {
    ...hostProjectFixture(root).manifest,
    plugin: { id: "Candidate", version: "1.0.0" },
    mode: "legacy" as const,
    stateOwner: "plugin" as const
  }
  if (!actualSource)
    await writeFile(
      join(source, "plugin.json"),
      JSON.stringify({ name: "Candidate", version: "1.0.0" })
    )
  if (!actualSource)
    await writeFile(join(source, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  if (!actualSource) await writeFile(join(source, "board_core/board_config.json"), "{}")
  if (actualSource) await writeDerivationFiles(source, actualSource)
  if (nativeConfiguration) {
    await writeFile(
      join(source, "plugin.json"),
      JSON.stringify({
        name: "Candidate",
        version: "1.0.0",
        userConfig: {
          knowledgeRoot: { type: "directory", title: "Knowledge", description: "", required: true },
          audience: { type: "string", title: "Audience", description: "", default: "authors" },
          token: {
            type: "string",
            title: "Token",
            description: "",
            sensitive: true,
            required: true
          }
        }
      })
    )
    await writeFile(
      join(source, "devclaw.project-runtime.json"),
      JSON.stringify(
        wrapProjectRuntimeManifest(manifest, {
          apiVersion: "devclaw.extension-contract/v1",
          requires: [CONTEXT_HANDOFF_PROTOCOL],
          context: {
            sourceAccess: "read-only",
            mutableData: "host",
            configuration: "host-resolved",
            knowledge: { required: true, binding: "knowledgeRoot" },
            provider: { entry: "provider.py", operations: ["session-context"] }
          }
        })
      )
    )
    await writeFile(join(source, "provider.py"), "# Original plugin-owned context provider\n")
  }
  if (recoveryAdapter) {
    await writeFile(
      join(source, "devclaw.stage-recovery-adapter.json"),
      JSON.stringify({
        apiVersion: "devclaw.plugin-stage-recovery/v1",
        entry: "adapter.py",
        runtime: "python",
        isolation: "private-output-copy",
        codeSource: "keep",
        externalEffects: "network-requires-confirmation"
      })
    )
    await writeFile(
      join(source, "adapter.py"),
      `import json,sys
from pathlib import Path
r=json.load(sys.stdin)
p=Path(r['workspace'])/'physical-stage.txt'
if r['operation']=='apply': p.write_text('restored-by-owned-adapter',encoding='utf-8')
if r['operation']=='verify': assert p.read_text(encoding='utf-8')=='restored-by-owned-adapter'
print(json.dumps({'apiVersion':'devclaw.plugin-stage-recovery-result/v1','ok':True,'summary':'Physical native owner recovery','affectedArtifacts':['physical-stage.txt'],'diagnostics':[],'evidence':{'stage':'draft'}}))
`
    )
  }
  const snapshot = await snapshotDerivationSource(source)
  const packageIdentity = JSON.parse(
    snapshot.files.find((file) => file.path === "plugin.json")!.bytes.toString("utf8")
  ) as { name: string; version: string }
  const settings = new ModControlStore(join(root, "control.sqlite"))
  cleanup.push(() => settings.close())
  const scope: DevelopmentScope = {
    threadId: "creator",
    workspace: root,
    incarnation: { token: "original-creator-incarnation", legacyCreatedAt: 1 }
  }
  let incarnation = scope.incarnation.token
  const deps = {
    root: join(root, "trials"),
    settings,
    context: () => ({
      scope: { ...scope, incarnation: { ...scope.incarnation, token: incarnation } },
      assertCurrent() {
        /* Immutable creator scope supplied by this controlled test owner. */
      }
    }),
    busy: () => false,
    changed: vi.fn(),
    candidate: async () => {
      await boundary.candidateGate
      return { root: source, contentIdentity: derivationContentIdentity(snapshot.files) }
    },
    assertSources: () => {
      if (!boundary.source) throw Error("BUSINESS_CREATOR_SOURCE_CHANGED")
    }
  }
  let trials = new CreatorBusinessTrials(deps)
  cleanup.push(() => trials.close())
  const candidate = {
    copyId: "checked-copy",
    digest: snapshot.digest,
    name: packageIdentity.name,
    version: packageIdentity.version,
    sources: []
  }
  const input = () => {
    const status = trials.status(scope)!
    return {
      threadId: scope.threadId,
      expectedWorkspace: scope.workspace,
      trialId: status.id,
      digest: status.digest,
      expectedVersion: status.version
    }
  }
  const prepare = async (turnId?: string) => {
    await trials.request(scope, "plan", candidate, "Produce a checked artifact", turnId)
    if (!turnId) await trials.prepare(input())
  }
  const ready = async () => {
    boundary.ready = true
    await trials.refresh(input())
  }
  const start = async () => {
    await ready()
    await trials.start(input(), {} as BrowserWindow)
  }
  const reload = () => {
    trials.close()
    trials = new CreatorBusinessTrials(deps)
  }
  return {
    root,
    scope,
    settings,
    candidate,
    input,
    prepare,
    ready,
    start,
    reload,
    trial: () => trials,
    replaceCreator: () => {
      incarnation = "recreated"
    }
  }
}

it("binds actual trial-owner accounting to the captured original request without borrowing its lease or a new goal", async () => {
  const f = await fixture()
  const development = new ModDevelopmentService({
    drafts: new AuthoringDraftStore(f.settings),
    historySettings: f.settings,
    runtime: {
      developmentRetention: () => ({ releasable: true, revisions: [] }),
      developmentStatus: () => [],
      stageDevelopment: vi.fn(),
      approveDevelopment: vi.fn(),
      stopDevelopment: vi.fn()
    },
    versionsRoot: join(f.root, "versions"),
    workerEntry: "unused",
    changed: vi.fn(),
    requestGroup: () => "goal:original",
    context: () => ({ scope: f.scope, assertCurrent: vi.fn() })
  })
  setModDevelopmentService(development)
  cleanup.push(() => setModDevelopmentService(undefined))
  await development.setMode(f.scope.threadId, f.scope.workspace, "creator")
  const parent = development.captureModelAccounting(
    f.scope.threadId,
    f.scope.workspace,
    "original-turn"
  )!
  parent.claim().settle({ inputTokens: 10, outputTokens: 2 })
  await f
    .trial()
    .request(f.scope, "plan", f.candidate, "Actual original trial", undefined, "original-turn")
  await f.trial().prepare(f.input())
  await f.start()
  const internal = readInternalHarnessProject(f.input().trialId)!
  if (internal.ownerKind !== "creator-business-trial") throw Error("wrong owner")
  expect(() => internal.captureCreatorAccounting!("foreign-thread")).toThrow(
    "BUSINESS_TRIAL_PHYSICAL_SCOPE_CHANGED"
  )
  internal.onPhysicalStarted!({ threadId: "original-managed-thread", requestId: "actual-request" })
  const trialReceipt = internal.captureCreatorAccounting!("original-managed-thread")!
  await development.setMode(f.scope.threadId, f.scope.workspace, "normal")
  trialReceipt.claim().settle({ inputTokens: 20, outputTokens: 3 })
  expect(development.status(f.scope.threadId).request).toMatchObject({
    runId: "original-turn",
    groupId: "goal:original",
    model: { attempts: 2, inputTokens: 30, outputTokens: 5 }
  })
  internal.onPhysicalSettlement!({
    threadId: "original-managed-thread",
    requestId: "actual-request",
    confirmed: true
  })
  expect(() => internal.captureCreatorAccounting!("original-managed-thread")).toThrow(
    "BUSINESS_TRIAL_PHYSICAL_SCOPE_CHANGED"
  )
})

it("requires settled creator intent, then native consent before any original business execution", async () => {
  const f = await fixture()
  await f.prepare("creator-turn")
  expect(f.trial().status(f.scope)?.canPrepare).toBe(false)
  await expect(f.trial().prepare(f.input())).rejects.toThrow("NOT_READY")
  publishDevelopmentTurnSettlement({
    threadId: f.scope.threadId,
    incarnation: f.scope.incarnation,
    turnId: "creator-turn",
    outcome: "completed"
  })
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await f.trial().prepare(f.input())
  expect(boundary.initialize).not.toHaveBeenCalled()
  expect(f.trial().status(f.scope)).toMatchObject({ phase: "needs-configuration", canStart: false })
  await expect(f.trial().start(f.input(), {} as BrowserWindow)).rejects.toThrow()
  expect(boundary.initialize).not.toHaveBeenCalled()
  await f.start()
  expect(boundary.prepareFacts).toHaveBeenCalled()
  expect(boundary.initialize).toHaveBeenCalledTimes(1)
  expect(boundary.feature).toHaveBeenCalledTimes(1)
  expect(boundary.start).toHaveBeenCalledTimes(1)
})

it("separates observation CAS from execution identity and requires physical settlement for business success", async () => {
  const f = await fixture()
  await f.prepare()
  await f.start()
  const id = f.input().trialId,
    internal = readInternalHarnessProject(id)!
  if (internal.ownerKind !== "creator-business-trial") throw Error("wrong owner")
  const guard = captureInternalHarnessProjectIdentityGuard(id)
  internal.onPhysicalStarted!({ threadId: "original-managed-thread", requestId: "actual-request" })
  f.trial().feedback({ ...f.input(), message: "Refine the display" })
  expect(guard).not.toThrow()
  boundary.run!.status = "completed"
  expect(f.trial().status(f.scope)?.phase).toBe("running")
  internal.onPhysicalSettlement!({
    threadId: "original-managed-thread",
    requestId: "actual-request",
    confirmed: true
  })
  expect(f.trial().status(f.scope)?.phase).toBe("completed")
  const before = boundary.initialize.mock.calls[0][0] as HarnessProjectCreateInput
  await f.trial().request(f.scope, "second-plan", f.candidate, "Try a new version")
  await f.trial().prepare(f.input())
  await f.ready()
  const next = f.trial().source(f.input().trialId)
  expect(next.input.workspace).not.toBe(join(before.workspacePath, before.projectDir))
  expect(f.input().trialId).not.toBe(id)
  expect(guard).toThrow("RUNTIME_CHANGED")
})

it("keeps unknown sticky and never replays initialization, even after restart", async () => {
  const f = await fixture()
  await f.prepare()
  await f.ready()
  boundary.failInitialize = true
  await expect(f.trial().start(f.input(), {} as BrowserWindow)).rejects.toThrow("UNCONFIRMED")
  expect(f.trial().status(f.scope)?.phase).toBe("unknown")
  f.reload()
  expect(f.trial().status(f.scope)?.phase).toBe("unknown")
  await expect(f.trial().start(f.input(), {} as BrowserWindow)).rejects.toThrow()
  await expect(f.trial().request(f.scope, "another", f.candidate, "retry")).rejects.toThrow(
    "UNCONFIRMED"
  )
  expect(boundary.initialize).toHaveBeenCalledTimes(1)
})

it("observes an original failed run with zero admissions accurately without inventing physical success", async () => {
  const f = await fixture()
  await f.prepare()
  await f.start()
  boundary.run!.status = "failed"
  expect(f.trial().status(f.scope)?.phase).toBe("failed")
})

it("records unconfirmed cleanup, rejects stale/foreign scope and keeps cancellation available after source revocation", async () => {
  const f = await fixture()
  await f.prepare()
  await f.start()
  const internal = readInternalHarnessProject(f.input().trialId)!
  if (internal.ownerKind !== "creator-business-trial") throw Error("wrong owner")
  const physical = { threadId: "original-managed-thread", requestId: "request" }
  internal.onPhysicalStarted!(physical)
  internal.onPhysicalSettlement!({ ...physical, confirmed: false })
  internal.onPhysicalSettlement!({ ...physical, confirmed: true })
  expect(f.trial().status(f.scope)?.phase).toBe("unknown")
  await expect(
    f.trial().stop({ ...f.input(), expectedWorkspace: dirname(f.root) })
  ).rejects.toThrow("SCOPE_CHANGED")
  boundary.source = false
  await f.trial().stop(f.input())
  expect(boundary.stop).toHaveBeenCalledTimes(1)
  expect(f.trial().status(f.scope)?.phase).toBe("unknown")
  f.replaceCreator()
  expect(() => f.trial().status(f.scope)).toThrow("SCOPE_CHANGED")
})

it("blocks source edits during native consent and does not restore old source authority on restart", async () => {
  const f = await fixture()
  await f.prepare()
  const source = f.trial().source(f.input().trialId)
  await writeFile(
    join(source.input.plugin.path, "board_core/board_config.json"),
    '{"changed":true}'
  )
  expect(source.guard).toThrow()
  await expect(f.start()).rejects.toThrow()
  expect(boundary.initialize).not.toHaveBeenCalled()
  f.reload()
  expect(f.trial().status(f.scope)?.phase).toBe("unknown")
  expect(() => f.trial().source(f.input().trialId)).toThrow("NOT_CONFIGURABLE")
})

it("uses original settings CAS and does not overwrite a changed native review", async () => {
  const f = await fixture()
  await f.prepare()
  const old = f.input()
  f.trial().feedback({ ...old, message: "First observation" })
  await expect(f.trial().prepare(old)).rejects.toThrow("SCOPE_CHANGED")
  const id = f.settings.getSetting(
    `mods-business-trial-current-v1:${businessCreatorScopeKey(f.scope)}`
  )
  expect(id).toBe(old.trialId)
  expect(f.trial().status(f.scope)?.feedback).toHaveLength(1)
})

it("does not let concurrent feedback change an in-flight initialization or continue later effects", async () => {
  const f = await fixture()
  await f.prepare()
  await f.ready()
  const pending = Promise.withResolvers<void>()
  boundary.initializeGate = pending.promise
  const start = f.trial().start(f.input(), {} as BrowserWindow)
  const outcome = start.catch((error) => error)
  try {
    await vi.waitFor(() => expect(boundary.initialize).toHaveBeenCalledOnce())
    const version = f.input().expectedVersion
    await f.trial().refresh(f.input())
    expect(f.input().expectedVersion).toBe(version)
    expect(() => f.trial().feedback({ ...f.input(), message: "while initializing" })).toThrow(
      "BUSY"
    )
  } finally {
    pending.resolve()
    await outcome
  }
})

it("stops the actual original agent and drains its workflows before accepting cancellation", async () => {
  const f = await fixture()
  await f.prepare()
  await f.start()
  const internal = readInternalHarnessProject(f.input().trialId)!
  if (internal.ownerKind !== "creator-business-trial") throw Error("wrong owner")
  const physical = { threadId: "original-managed-thread", requestId: "actual-request" }
  internal.onPhysicalStarted!(physical)
  boundary.onCancel = () => internal.onPhysicalSettlement!({ ...physical, confirmed: true })
  await f.trial().stop(f.input())
  expect(boundary.cancel).toHaveBeenCalledWith(physical.threadId)
  expect(boundary.workflowCancel).toHaveBeenCalledWith(physical.threadId)
  expect(f.trial().status(f.scope)?.phase).toBe("cancelled")
})

it("offers explicit cancellation of a restarted, revoked intent that has never executed business IO", async () => {
  const f = await fixture()
  await f.prepare()
  f.reload()
  boundary.source = false
  expect(f.trial().status(f.scope)).toMatchObject({ phase: "unknown", canStop: true })
  await f.trial().stop(f.input())
  expect(f.trial().status(f.scope)?.phase).toBe("cancelled")
  expect(boundary.initialize).not.toHaveBeenCalled()
})

it("honors a durable stop during preparation without entering an original business effect", async () => {
  const f = await fixture(),
    pending = Promise.withResolvers<void>()
  boundary.candidateGate = pending.promise
  await f.trial().request(f.scope, "plan", f.candidate, "Prepare only")
  const prepare = f.trial().prepare(f.input())
  await vi.waitFor(() => expect(f.trial().status(f.scope)?.phase).toBe("preparing"))
  await f.trial().stop(f.input())
  pending.resolve()
  await prepare
  expect(f.trial().status(f.scope)?.phase).toBe("cancelled")
  expect(boundary.initialize).not.toHaveBeenCalled()
})

it("passes cancellation into the original initializer and cannot continue feature/start after stop", async () => {
  const f = await fixture()
  await f.prepare()
  await f.ready()
  const pending = Promise.withResolvers<void>()
  boundary.initializeGate = pending.promise
  const start = f.trial().start(f.input(), {} as BrowserWindow)
  const outcome = start.catch((error) => error)
  try {
    await vi.waitFor(() => expect(boundary.initialize).toHaveBeenCalledOnce())
    await f.trial().stop(f.input())
    const source = boundary.initialize.mock.calls[0][1] as { signal: AbortSignal }
    expect(source.signal.aborted).toBe(true)
  } finally {
    pending.resolve()
    await outcome
  }
  expect(boundary.feature).not.toHaveBeenCalled()
  expect(boundary.start).not.toHaveBeenCalled()
  // Initializer was entered: an abort cannot manufacture rollback/cleanup evidence.
  expect(f.trial().status(f.scope)?.phase).toBe("unknown")
})

it("retains already confirmed terminal history when its original source is later unavailable", async () => {
  const f = await fixture()
  await f.prepare()
  await f.start()
  const internal = readInternalHarnessProject(f.input().trialId)!
  if (internal.ownerKind !== "creator-business-trial") throw Error("wrong owner")
  const physical = { threadId: "original-managed-thread", requestId: "request" }
  internal.onPhysicalStarted!(physical)
  internal.onPhysicalSettlement!({ ...physical, confirmed: true })
  boundary.run!.status = "completed"
  await f.trial().refresh(f.input())
  expect(f.trial().status(f.scope)?.journey?.candidateCurrent).toBe(true)
  expect(
    f.trial().status(f.scope, { planId: "changed-plan", digest: "c".repeat(64) })?.journey
  ).toMatchObject({ candidateCurrent: false, canDeliver: false })
  expect(f.trial().status(f.scope, null)?.journey).toMatchObject({
    candidateCurrent: false,
    canDeliver: false
  })
  boundary.source = false
  expect(f.trial().status(f.scope)?.journey).toMatchObject({
    candidateCurrent: false,
    canDeliver: false
  })
  f.reload()
  expect(f.trial().status(f.scope)).toMatchObject({ phase: "completed", canStart: false })
  expect(f.trial().status(f.scope)?.journey).toMatchObject({
    candidateCurrent: false,
    canDeliver: false
  })
  expect(boundary.start).toHaveBeenCalledTimes(1)
})

it.each([false, true])(
  "describes only the opted-in pending creator admission (%s), without admitting checkpoint execution before publication",
  async (optIn) => {
    // Only the adapter's Python contract-discovery seam is controlled. The creator's
    // scoped registration, frozen store, nonce/source proof and original admission are real.
    const contracts = vi
      .spyOn(trialEvidenceAdapter, "readAutobizTrialEvidenceContracts")
      .mockResolvedValue(
        optIn
          ? [
              {
                nodeId: "draft",
                checkId: "postcheck",
                contractDigest: "a".repeat(64),
                artifacts: [{ id: "report", path: "report.md" }]
              }
            ]
          : undefined
      )
    cleanup.push(() => contracts.mockRestore())
    const f = await fixture()
    await f.prepare()
    await f.start()
    boundary.run!.currentSession = undefined
    cleanup.push(registerLegacyCompositionAdmission())
    const admission = await prepareAgentRunAdmission(
      {
        threadId: "original-managed-thread",
        message: "Run the genuine pending original stage",
        streamRequestId: "pending-request"
      },
      { source: "desktop" }
    )
    expect(admission).toBeDefined()
    await withRuntimePluginSource(admission!.context.pluginSourceSnapshot, async () => {
      const source = currentRuntimePluginSource()!
      if (optIn) expect(source.stagePrompt).toContain("project_checkpoint")
      else expect(source.stagePrompt).toBeUndefined()
      expect(projectCheckpointAvailable()).toBe(false)
      await expect(
        executeProjectCheckpoint({ checkpoint: "draft_done", expectedStateDigest: "b".repeat(64) })
      ).rejects.toThrow("UNAVAILABLE")
    })
    boundary.run!.currentSession = { threadId: "original-managed-thread" }
    withRuntimePluginSource(admission!.context.pluginSourceSnapshot, () => {
      expect(projectCheckpointAvailable()).toBe(optIn)
    })
    await admission!.settle()
    expect(boundary.start).toHaveBeenCalledTimes(1)
  }
)

it("cancels a just-admitted original session before the controller publishes currentSession", async () => {
  const f = await fixture()
  await f.prepare()
  await f.start()
  const internal = readInternalHarnessProject(f.input().trialId)!
  if (internal.ownerKind !== "creator-business-trial") throw Error("wrong owner")
  const physical = { threadId: "just-admitted-thread", requestId: "next-original-request" }
  internal.onPhysicalStarted!(physical)
  boundary.run!.currentSession = { threadId: "previous-managed-thread" }
  boundary.onCancel = (id) => {
    if (id === physical.threadId) internal.onPhysicalSettlement!({ ...physical, confirmed: true })
  }
  await f.trial().stop(f.input())
  expect(boundary.cancel.mock.calls.map(([id]) => id)).toEqual([
    "previous-managed-thread",
    "just-admitted-thread"
  ])
  expect(boundary.workflowCancel).toHaveBeenCalledTimes(2)
  expect(f.trial().status(f.scope)?.phase).toBe("cancelled")
})

it("does not cancel a foreign thread merely because a saved observation names it", async () => {
  const f = await fixture()
  await f.prepare()
  await f.start()
  boundary.foreignThread = true
  await expect(f.trial().stop(f.input())).rejects.toThrow("STOP_UNCONFIRMED")
  expect(boundary.cancel).not.toHaveBeenCalled()
  expect(boundary.workflowCancel).not.toHaveBeenCalled()
  expect(f.trial().status(f.scope)?.phase).toBe("unknown")
})

it("adopts a verified ended plugin output as a real fresh trial owner without resetting its recovered stage", async () => {
  const f = await fixture()
  await f.prepare()
  await f.start()
  const sourceId = f.input().trialId
  await expect(f.trial().endedRecoveryOwner(f.scope, sourceId)).rejects.toThrow(
    "PHYSICAL_SETTLEMENT"
  )
  const internal = readInternalHarnessProject(sourceId)!
  if (internal.ownerKind !== "creator-business-trial") throw Error("wrong owner")
  const physical = { threadId: "original-managed-thread", requestId: "ended-request" }
  internal.onPhysicalStarted!(physical)
  internal.onPhysicalSettlement!({ ...physical, confirmed: true })
  boundary.run!.status = "completed"
  boundary.busy = false
  const owner = await f.trial().endedRecoveryOwner(f.scope, sourceId)
  f.trial().feedback({ ...f.input(), message: "Observation-only note for the ended trial" })
  expect(owner.guard).not.toThrow()
  expect(await f.trial().endedRecoveryOwner(f.scope, sourceId)).toBe(owner)
  const directory = await mkdtemp(join(f.root, "trials/trial-"))
  const workspace = join(directory, "workspace")
  await mkdir(workspace)
  await writeFile(join(workspace, "actual-recovered-stage.txt"), "native adapter verified copy")
  const receipt = {
    preparationId: "12345678-1234-1234-1234-123456789012",
    digest: "a".repeat(64),
    sourceId,
    workspace,
    packageRoot: owner.packageRoot,
    packageDigest: owner.packageDigest,
    featureId: owner.featureId,
    stageId: "stage-a",
    stateMode: "target_in_progress" as const,
    evidenceDigest: "b".repeat(64)
  }
  const assertNative = vi.fn()
  const adopted = await f.trial().adoptRecoveredTrial(owner, receipt, assertNative)
  expect(assertNative).toHaveBeenCalled()
  expect(adopted.trialId).not.toBe(sourceId)
  expect(f.trial().status(f.scope)).toMatchObject({
    id: adopted.trialId,
    phase: "needs-configuration"
  })
  expect((await f.trial().adoptRecoveredTrial(owner, receipt, assertNative)).trialId).toBe(
    adopted.trialId
  )
  expect(() => f.trial().source(adopted.trialId)).toThrow("RECOVERY_NOT_CONFIRMED")
  // This owner-only unit controls the native publication seam. The real controller/SQLite
  // publication and lost-reply paths run without this seam in the following sandbox tests.
  f.settings.setSetting(
    `plugin-stage-recovery-v1:${receipt.preparationId}`,
    JSON.stringify({
      phase: "adopted",
      recoveredTrialId: adopted.trialId,
      recoveredProjectId: adopted.projectId,
      workspace,
      packageDigest: receipt.packageDigest,
      sourceId,
      evidenceDigest: receipt.evidenceDigest
    })
  )
  boundary.ready = false
  await expect(f.trial().start(f.input(), {} as BrowserWindow)).rejects.toThrow("NOT_READY")
  // Fresh native readiness remains required; old source consent does not start this project.
  await f.ready()
  await f.trial().start(f.input(), {} as BrowserWindow)
  expect(boundary.initialize).toHaveBeenCalledTimes(1)
  expect(boundary.feature).toHaveBeenCalledTimes(1)
  expect(boundary.start).toHaveBeenCalledTimes(2)
  expect(await readFile(join(workspace, "actual-recovered-stage.txt"), "utf8")).toBe(
    "native adapter verified copy"
  )
  const history = f
    .trial()
    .adoptedRecoveryStatus(f.scope, receipt.preparationId, adopted.trialId, receipt.evidenceDigest)
  expect(history.canResume).toBe(false)
  expect(history.guard).not.toThrow()
  expect(f.trial().status(f.scope)?.stageRecovery?.started).toBe(true)
  await expect(
    f
      .trial()
      .adoptedRecoveryOwner(f.scope, receipt.preparationId, adopted.trialId, receipt.evidenceDigest)
  ).rejects.toThrow("RECOVERY_ALREADY_STARTED")
  const branch = readInternalHarnessProject(adopted.projectId)!
  expect(branch).toMatchObject({
    ownerKind: "creator-business-trial",
    trialId: adopted.trialId,
    context: { project: { projectId: adopted.projectId, workspacePath: dirname(workspace) } }
  })
})

it.skipIf(process.platform !== "win32")(
  "joins the real ended owner, first-use retained ACL fence, restricted sandbox and native adoption",
  async () => {
    const f = await fixture(true)
    await f.prepare()
    await f.start()
    const id = f.input().trialId
    const internal = readInternalHarnessProject(id)!
    if (internal.ownerKind !== "creator-business-trial") throw Error("wrong owner")
    const physical = { threadId: "original-managed-thread", requestId: "physical-ended" }
    internal.onPhysicalStarted!(physical)
    internal.onPhysicalSettlement!({ ...physical, confirmed: true })
    boundary.run!.status = "completed"
    boundary.busy = false
    const service = new PluginStageRecoverySessions({
      root: join(f.root, "trials"),
      settings: f.settings,
      owner: (scope, sourceId) => f.trial().endedRecoveryOwner(scope, sourceId),
      adopt: (owner, receipt) =>
        f.trial().adoptRecoveredTrial(owner, receipt, () => service.assertReceipt(receipt))
    })
    const inspected = await service.inspect(f.scope, id)
    const prepared = await service.prepare({
      scope: f.scope,
      trialId: id,
      stageId: "draft",
      stateMode: "target_in_progress",
      expectedPackageDigest: inspected.packageDigest,
      expectedAdapterDigest: inspected.adapterDigest,
      expectedInputsDigest: inspected.inputsDigest,
      allowNetworkSideEffects: true
    })
    const applied = await service.apply({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
    expect(applied.preparation.phase).toBe("adopted")
    expect(applied.trialId).not.toBe(id)
    const native = f.trial().status(f.scope)!
    expect(native.phase).toBe("needs-configuration")
    const source = f.trial().source(applied.trialId)
    expect(await readFile(join(source.input.workspace, "physical-stage.txt"), "utf8")).toBe(
      "restored-by-owned-adapter"
    )
    source.guard()
    await f.ready()
    await f.trial().start(f.input(), {} as BrowserWindow)
    expect(boundary.initialize).toHaveBeenCalledTimes(1)
    expect(boundary.feature).toHaveBeenCalledTimes(1)
    expect(boundary.start).toHaveBeenCalledTimes(2)
  },
  120_000
)

it.skipIf(process.platform !== "win32")(
  "cold-reconciles a lost real native adoption without a second apply or inherited execution grant",
  async () => {
    const f = await fixture(true, undefined, true)
    const protector = testSecretProtector()
    const manager = new FunctionModsManager(f.settings, {
      plugins: () => [],
      enabled: () => false,
      secretProtector: protector,
      publish: async (_workspace, value) => value,
      changed: () => {}
    })
    boundary.manager = manager
    cleanup.push(() => manager.close())
    await f.prepare()
    const configuration = parseFunctionUserConfig(
      JSON.parse(await readFile(join(f.root, "candidate/plugin.json"), "utf8")).userConfig
    )!
    const values = new FunctionUserConfigValues(f.settings, protector)
    const configuredWorkspace = f.trial().source(f.input().trialId).input.workspace
    const knowledge = join(f.root, "external-knowledge")
    await mkdir(knowledge)
    await writeFile(join(knowledge, "rules.md"), "native original external knowledge")
    values.saveSensitive(
      configuredWorkspace,
      "Candidate",
      configuration,
      "token",
      { operation: "set", value: "native-private-value" },
      0,
      () => {}
    )
    values.save(
      configuredWorkspace,
      "Candidate",
      configuration,
      "knowledgeRoot",
      knowledge,
      1,
      () => {}
    )
    values.save(
      configuredWorkspace,
      "Candidate",
      configuration,
      "audience",
      "native reviewers",
      2,
      () => {}
    )
    await f.start()
    const id = f.input().trialId
    const internal = readInternalHarnessProject(id)!
    if (internal.ownerKind !== "creator-business-trial") throw Error("wrong owner")
    const physical = { threadId: "original-managed-thread", requestId: "physical-ended-cold" }
    internal.onPhysicalStarted!(physical)
    internal.onPhysicalSettlement!({ ...physical, confirmed: true })
    boundary.run!.status = "completed"
    boundary.busy = false
    let loseReply = true
    const createService = (): PluginStageRecoverySessions =>
      new PluginStageRecoverySessions({
        root: join(f.root, "trials"),
        settings: f.settings,
        owner: (scope, sourceId) => f.trial().endedRecoveryOwner(scope, sourceId),
        adoptedOwner: (scope, preparationId, targetId, evidenceDigest) =>
          f.trial().adoptedRecoveryOwner(scope, preparationId, targetId, evidenceDigest),
        adopt: async (owner, receipt) => {
          const adopted = await f
            .trial()
            .adoptRecoveredTrial(owner, receipt, () => service.assertReceipt(receipt))
          if (loseReply) {
            loseReply = false
            throw Error("LOST_REAL_ADOPTION_REPLY")
          }
          return adopted
        }
      })
    let service = createService()
    const inspected = await service.inspect(f.scope, id)
    const prepared = await service.prepare({
      scope: f.scope,
      trialId: id,
      stageId: "draft",
      stateMode: "target_in_progress",
      expectedPackageDigest: inspected.packageDigest,
      expectedAdapterDigest: inspected.adapterDigest,
      expectedInputsDigest: inspected.inputsDigest,
      allowNetworkSideEffects: true
    })
    await expect(
      service.apply({
        scope: f.scope,
        preparationId: prepared.id,
        expectedDigest: prepared.digest,
        allowNetworkSideEffects: true
      })
    ).rejects.toThrow("LOST_REAL_ADOPTION_REPLY")
    const nativeId = f.input().trialId
    f.reload()
    service = createService()
    const result = await service.reconcile({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
    expect(result).toMatchObject({ phase: "adopted", recoveredTrialId: nativeId })
    expect(f.trial().status(f.scope)).toMatchObject({ id: nativeId, phase: "needs-configuration" })
    const journal = JSON.parse(
      f.settings.getSetting(`project-stage-recovery-hooks-v1:${prepared.id}`, "[]")
    )
    expect(
      journal.filter((row: { identity: { operationId: string } }) =>
        row.identity.operationId.startsWith("apply:")
      )
    ).toHaveLength(1)
    const source = f.trial().source(nativeId)
    source.guard()
    const bound = readProjectRecoveryContext(source.input.workspace, {
      name: "Candidate",
      version: "1.0.0"
    })!
    expect(bound.configuration?.audience).toBe("native reviewers")
    expect(JSON.stringify(bound.configuration)).not.toContain("native-private-value")
    expect(bound.knowledgeRoot).not.toBe(knowledge)
    expect(await readFile(join(bound.knowledgeRoot!, "rules.md"), "utf8")).toBe(
      "native original external knowledge"
    )
    const targetKey = source.input.workspace.toLowerCase()
    expect(values.resolve(targetKey, "Candidate", configuration).token).toBe("native-private-value")
    expect(values.read(targetKey, "Candidate").sealed?.token).not.toBe(
      values.read(configuredWorkspace, "Candidate").sealed?.token
    )
    expect(f.settings.getGrant(targetKey, "function:Candidate")).toBeNull()
    expect(await readFile(join(source.input.workspace, "physical-stage.txt"), "utf8")).toBe(
      "restored-by-owned-adapter"
    )
    // A completed but never-started branch also needs a new native review after the app restarts.
    f.reload()
    service = createService()
    // An adopted private branch has its own inputs. Later ordinary source edits/revocation
    // must not destroy its cold continuation; unknown adoption above remains source-fenced.
    await writeFile(join(configuredWorkspace, "later-source.txt"), "new source output")
    await writeFile(join(knowledge, "rules.md"), "source knowledge later changed")
    values.save(
      configuredWorkspace,
      "Candidate",
      configuration,
      "audience",
      "source changed",
      3,
      () => {}
    )
    boundary.source = false
    expect(await service.latest(f.scope, id)).toMatchObject({
      phase: "adopted",
      canReconcile: true
    })
    await service.reconcile({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
    expect(f.trial().source(nativeId).guard).not.toThrow()
  },
  120_000
)

const originalAutoBiz = resolve(process.env.AUTOBIZ_BUSINESS_SOURCE ?? "C:/ai/autobiz_kanban")
const observerArchive = resolve(
  "output/deliveries/mods-creator-accepted-20261017/04-来源-Worktree进度Mod.zip"
)
const acceptedRecoverySource = process.env.AUTOBIZ_RECOVERY_PACKAGE
it.skipIf(
  process.platform !== "win32" ||
    (acceptedRecoverySource
      ? !existsSync(acceptedRecoverySource)
      : !existsSync(originalAutoBiz) || !existsSync(observerArchive))
)(
  "joins actual admitted AutoBiz bytes, native ended owner, original rollback CLI and restricted sandbox in one recovery",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "actual-ab-recovery-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const observer = join(root, "observer"),
      base = join(root, "base"),
      recovered = join(root, "recovered")
    if (!acceptedRecoverySource) {
      const entries = new AdmZip(observerArchive).getEntries().filter((entry) => !entry.isDirectory)
      const identity = entries.find((entry) => /(?:^|\/)plugin\.json$/.test(entry.entryName))!
      const prefix = identity.entryName.slice(0, -"plugin.json".length)
      await mkdir(observer)
      await writeDerivationFiles(
        observer,
        entries.map((entry) => {
          expect(entry.entryName.startsWith(prefix)).toBe(true)
          const bytes = entry.getData()
          return {
            path: entry.entryName.slice(prefix.length),
            bytes,
            mode: 0o644,
            digest: runtimeDigest(bytes)
          }
        })
      )
      const main = await snapshotDerivationSource(originalAutoBiz),
        catalog = businessModCatalog(main)
      // This pure observer declares no Python kernel behavior. The fixture author explicitly
      // selects the reviewed original kernel version rather than bypassing version checks.
      const observerCatalog = businessModCatalog(await snapshotDerivationSource(observer))
      observerCatalog.kernelRef = { id: catalog.kernel!.id, version: catalog.kernel!.version }
      await writeFile(
        join(observer, "mods/business/manifest.json"),
        JSON.stringify(observerCatalog)
      )
      const extra = await snapshotDerivationSource(observer),
        extension = businessModCatalog(extra)
      const assembled = assembleBusinessMods(
        [
          { snapshot: main, catalog, modIds: catalog.modules.map((mod) => mod.id) },
          {
            snapshot: extra,
            catalog: extension,
            modIds: extension.extensions!.map((mod) => mod.id)
          }
        ],
        { name: "actual-recovery-base", version: "1.0.0", sources: [], acceptFixedWorkflow: true }
      )
      await mkdir(base)
      await writeDerivationFiles(base, assembled.files)
      await prepareAutobizStageRecoverySource(base, recovered, {
        extensionId: extension.extensions![0].id,
        name: "Candidate",
        version: "1.0.0"
      })
    }
    const f = await fixture(
      false,
      (await snapshotDerivationSource(acceptedRecoverySource ?? recovered)).files
    )
    const protector = testSecretProtector()
    const manager = new FunctionModsManager(
      f.settings,
      {
        plugins: () => [],
        enabled: () => true,
        secretProtector: protector,
        publish: async (_workspace, value) => value,
        changed: () => {}
      },
      () => {
        const guests = new Set<FunctionGuestRuntime>()
        return {
          async load(code, options) {
            const guest = await FunctionGuestRuntime.create(code, options)
            guests.add(guest)
            return guest
          },
          stop() {
            for (const guest of guests) guest.dispose()
          }
        }
      }
    )
    boundary.manager = manager
    cleanup.push(() => manager.close())
    await f.prepare()
    const id = f.input().trialId,
      source = f.trial().source(id)
    const packagePath = source.input.plugin.path,
      workspace = source.input.workspace
    const metadata = JSON.parse(await readFile(join(packagePath, "plugin.json"), "utf8"))
    const config = parseFunctionUserConfig(metadata.userConfig)
    if (config?.knowledgeRoot) {
      const knowledge = join(root, "actual-external-knowledge")
      await mkdir(knowledge)
      await writeFile(join(knowledge, "rules.md"), "Exact actual package recovery knowledge")
      new FunctionUserConfigValues(f.settings, protector).save(
        workspace,
        metadata.name,
        config,
        "knowledgeRoot",
        knowledge,
        0,
        () => {}
      )
    }
    const approve = async (runtimeSource: ReturnType<CreatorBusinessTrials["source"]>) => {
      const facts = await manager.prepareRuntimeSourceFacts(runtimeSource.input)
      if (facts && !facts.configurationOnly)
        await manager.approveRuntimeSource(
          { ...runtimeSource.input, digest: facts.digest },
          runtimeSource.guard
        )
    }
    await approve(source)
    const featureId = JSON.parse(f.settings.getSetting(`mods-business-trial-v1:${id}`, "null"))
      .featureId as string
    const execute = promisify(execFile)
    for (const [mode, extra] of [
      ["createProject", []],
      ["createFeature", ["--feature", featureId]]
    ] as const)
      await execute(
        "python",
        [
          "-I",
          "-B",
          "-X",
          "utf8",
          join(packagePath, "hooks/init_workspace.py"),
          "--mode",
          mode,
          "--workspace",
          dirname(workspace),
          "--project",
          "workspace",
          ...extra
        ],
        {
          timeout: 30_000,
          windowsHide: true,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
        }
      )
    const fixtureScript = join(root, "set-up-ended-fixture.py")
    await writeFile(
      fixtureScript,
      `import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from board_core.state_store import load_state_json_records,write_state_records
w=Path(sys.argv[2]);feature=sys.argv[3]
r,errors,exists=load_state_json_records(w);assert exists and not errors
r[feature]['checkpoint']='plan_done';r[feature]['stage']='plan_done';write_state_records(w,r)
d=w/'.autobizdevops/features'/feature
(d/'proposal.md').write_text('actual original specs artifact',encoding='utf-8')
(d/'PRD.md').write_text('actual upstream prd',encoding='utf-8')
`
    )
    await execute(
      "python",
      ["-I", "-B", "-X", "utf8", fixtureScript, packagePath, workspace, featureId],
      {
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
      }
    )
    await f.start()
    const internal = readInternalHarnessProject(id)!
    if (internal.ownerKind !== "creator-business-trial") throw Error("wrong owner")
    // Outer model/controller seams are controlled. Native admission and all business Python,
    // including the initializers above and the following original rollback/sandbox, are real.
    await preflightAutobizCompositionSource(internal.context.plugin!)
    const physical = { threadId: "original-managed-thread", requestId: "actual-autobiz-ended" }
    internal.onPhysicalStarted!(physical)
    internal.onPhysicalSettlement!({ ...physical, confirmed: true })
    // Incomplete authored artifacts describe an ended failed run, never business acceptance.
    boundary.run!.status = "failed"
    boundary.busy = false
    const originalState = await readFile(join(workspace, ".autobizdevops/state.json"), "utf8")
    const service = new PluginStageRecoverySessions({
      root: join(f.root, "trials"),
      settings: f.settings,
      owner: (scope, sourceId) => f.trial().endedRecoveryOwner(scope, sourceId),
      adopt: (owner, receipt) =>
        f.trial().adoptRecoveredTrial(owner, receipt, () => service.assertReceipt(receipt))
    })
    const inspected = await service.inspect(f.scope, id)
    const prepared = await service.prepare({
      scope: f.scope,
      trialId: id,
      stageId: "dev.specs",
      stateMode: "target_in_progress",
      expectedPackageDigest: inspected.packageDigest,
      expectedAdapterDigest: inspected.adapterDigest,
      expectedInputsDigest: inspected.inputsDigest,
      allowNetworkSideEffects: true
    })
    const result = await service.apply({
      scope: f.scope,
      preparationId: prepared.id,
      expectedDigest: prepared.digest,
      allowNetworkSideEffects: true
    })
    expect(result.preparation.phase).toBe("adopted")
    const branch = f.trial().source(result.trialId)
    expect(
      await readFile(join(branch.input.workspace, ".autobizdevops/state.json"), "utf8")
    ).toContain("specs_in_progress")
    expect(
      existsSync(
        join(branch.input.workspace, ".autobizdevops/features", internal.featureId, "proposal.md")
      )
    ).toBe(false)
    expect(await readFile(join(workspace, ".autobizdevops/state.json"), "utf8")).toBe(originalState)
    expect(
      await readFile(
        join(workspace, ".autobizdevops/features", internal.featureId, "proposal.md"),
        "utf8"
      )
    ).toBe("actual original specs artifact")
    const validation = await execute(
      "python",
      [
        "-I",
        "-B",
        "-X",
        "utf8",
        join(packagePath, "hooks/stage_gate.py"),
        "validate",
        "--stage",
        "dev.specs",
        "--workspace",
        branch.input.workspace,
        "--feature",
        featureId
      ],
      {
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
      }
    ).then(
      (result) => result,
      (error) => error as { code: number; stdout: string }
    )
    expect("code" in validation && validation.code !== 0).toBe(true)
    expect(JSON.parse(validation.stdout).ok).toBe(false)
    expect(validation.stdout).toContain("proposal.md")
    await approve(branch)
    await f.ready()
    await f.trial().start(f.input(), {} as BrowserWindow)
    expect(boundary.initialize).toHaveBeenCalledTimes(1)
    expect(boundary.feature).toHaveBeenCalledTimes(1)
    expect(boundary.start).toHaveBeenCalledTimes(2)
  },
  120_000
)
