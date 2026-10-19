import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join, dirname } from "node:path"
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
  foreignThread: false
}))
// Only orchestration seams are controlled here. Original SQLite CAS, retained package
// capture/content proof and main-only provider routing are real. Actual original Python,
// native configuration/approvals and managed agent execution have separate App acceptance.
vi.mock("../../harness-board/service", () => ({
  createHarnessProject: async (
    input: HarnessProjectCreateInput,
    source: {
      projectId: string
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
        name: "Candidate",
        version: "1.0.0",
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
vi.mock("../../harness-board/managed-run-controller", () => ({
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
vi.mock("../../harness-board/managed-run-store", () => ({
  managedRunStore: {
    listEvents: () => ({ events: [], hasMore: false }),
    getLatestRun: (id: string) => {
      readInternalHarnessProjectWorkspaceIndex(id)
      return boundary.run
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
      workspace: project.workspace,
      scope: { projectId: project.projectId, packageDigest: project.pluginDigest },
      plugin: { id: project.installedPluginId, name: project.packageId, path: root, enabled: true }
    },
    manager: {
      prepareRuntimeSourceFacts: boundary.prepareFacts,
      assertRuntimeSourceReady: () => {
        if (!boundary.ready) throw Error("PROJECT_MODS_APPROVAL_REQUIRED")
      }
    }
  })
}))
vi.mock("../../agent/agent-run-service", () => ({
  createBrowserWindowAgentRunDelivery: () => ({}),
  cancelActiveAgentRun: (id: string) => {
    boundary.cancel(id)
    boundary.onCancel?.(id)
    boundary.busy = false
    return true
  },
  isAgentRunBusy: () => boundary.busy
}))
vi.mock("../../db", () => ({
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
  workflowRunManager: {
    cancelAndWait: async (id: string) => {
      boundary.workflowCancel(id)
    }
  }
}))
vi.mock("../../harness-board/notifications", () => ({
  harnessNotifications: { pending: () => [] }
}))
vi.mock("../../services/notification-actions", () => ({ decideNotification: vi.fn() }))

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
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "business-trial-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "candidate")
  await mkdir(join(source, "board_core"), { recursive: true })
  const manifest = {
    ...hostProjectFixture(root).manifest,
    plugin: { id: "Candidate", version: "1.0.0" },
    mode: "legacy",
    stateOwner: "plugin"
  }
  await writeFile(
    join(source, "plugin.json"),
    JSON.stringify({ name: "Candidate", version: "1.0.0" })
  )
  await writeFile(join(source, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  await writeFile(join(source, "board_core/board_config.json"), "{}")
  const snapshot = await snapshotDerivationSource(source)
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
    name: "Candidate",
    version: "1.0.0",
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
    drafts: new AuthoringDraftStore(f.settings), historySettings: f.settings,
    runtime: { developmentRetention: () => ({ releasable: true, revisions: [] }), developmentStatus: () => [],
      stageDevelopment: vi.fn(), approveDevelopment: vi.fn(), stopDevelopment: vi.fn() },
    versionsRoot: join(f.root, "versions"), workerEntry: "unused", changed: vi.fn(),
    requestGroup: () => "goal:original", context: () => ({ scope: f.scope, assertCurrent: vi.fn() })
  })
  setModDevelopmentService(development)
  cleanup.push(() => setModDevelopmentService(undefined))
  await development.setMode(f.scope.threadId, f.scope.workspace, "creator")
  const parent = development.captureModelAccounting(f.scope.threadId, f.scope.workspace, "original-turn")!
  parent.claim().settle({ inputTokens: 10, outputTokens: 2 })
  await f.trial().request(f.scope, "plan", f.candidate, "Actual original trial", undefined, "original-turn")
  await f.trial().prepare(f.input())
  await f.start()
  const internal = readInternalHarnessProject(f.input().trialId)!
  if (internal.ownerKind !== "creator-business-trial") throw Error("wrong owner")
  expect(() => internal.captureCreatorAccounting!("foreign-thread")).toThrow("BUSINESS_TRIAL_PHYSICAL_SCOPE_CHANGED")
  internal.onPhysicalStarted!({ threadId: "original-managed-thread", requestId: "actual-request" })
  const trialReceipt = internal.captureCreatorAccounting!("original-managed-thread")!
  await development.setMode(f.scope.threadId, f.scope.workspace, "normal")
  trialReceipt.claim().settle({ inputTokens: 20, outputTokens: 3 })
  expect(development.status(f.scope.threadId).request).toMatchObject({ runId: "original-turn", groupId: "goal:original",
    model: { attempts: 2, inputTokens: 30, outputTokens: 5 } })
  internal.onPhysicalSettlement!({ threadId: "original-managed-thread", requestId: "actual-request", confirmed: true })
  expect(() => internal.captureCreatorAccounting!("original-managed-thread")).toThrow("BUSINESS_TRIAL_PHYSICAL_SCOPE_CHANGED")
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
  boundary.source = false
  f.reload()
  expect(f.trial().status(f.scope)).toMatchObject({ phase: "completed", canStart: false })
})

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
