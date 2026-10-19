import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import type { BrowserWindow } from "electron"
import type {
  DevelopmentBusinessTrialScope,
  DevelopmentBusinessTrialStatus
} from "../../../shared/mods/development"
import {
  parseCompositionUnitContext,
  type CompositionUnitContextSelection
} from "../../../shared/project-runtime/composition-api"
import type { DevelopmentScope } from "../v2/development-session"
import type { DevelopmentContext } from "./development-service"
import type { BusinessDraftSettings } from "./creator-business-draft"
import { businessCreatorScopeKey } from "./creator-business-draft"
import { projectCreatorBusinessTrialSessions } from "./creator-business-trial-sessions"
import { observeDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import {
  registerInternalHarnessProjectProvider,
  type InternalHarnessProjectContext
} from "../../harness-board/internal-project-context"
import { RetainedPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import {
  runtimeDirectoryIdentity,
  runtimeDigest
} from "../../harness-board/project-runtime/safe-files"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { readRuntimeScopedFile } from "../../harness-board/project-runtime/safe-files"
import { readPluginManifest } from "../../plugins/manifest"
import { preflightLegacyCompositionSource } from "../../harness-board/project-runtime/composition-legacy-preflight"
import { projectRuntimeFunctionSource } from "../../harness-board/project-runtime-function-source"
import {
  readCompositionUnitContext,
  assertCompositionUnitContextSelection
} from "../../harness-board/project-runtime/composition-unit-context"
import { createHarnessProject, createHarnessFeature } from "../../harness-board/service"
import { managedRunController } from "../../harness-board/managed-run-controller"
import { managedRunStore } from "../../harness-board/managed-run-store"
import { getModDevelopmentService } from "./development-service"
import {
  createBrowserWindowAgentRunDelivery,
  cancelActiveAgentRun,
  isAgentRunBusy
} from "../../agent/agent-run-service"
import type { NativeProjectSourceContext } from "../../ipc/native-project-source"
import { harnessNotifications } from "../../harness-board/notifications"
import { decideNotification } from "../../services/notification-actions"
import {
  derivationContentIdentity,
  snapshotDerivationSource
} from "../../plugins/derivation-source"
import { getThreadCore } from "../../db"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation
} from "../../services/thread-incarnation"

import {
  parseCreatorBusinessTrialRecord,
  assertCreatorBusinessTrialProofBinding,
  type BusinessTrialCandidate,
  type CreatorBusinessTrialRecord as TrialRecord,
  type CreatorBusinessTrialProofBinding
} from "./creator-business-trial-record"
export type { BusinessTrialCandidate } from "./creator-business-trial-record"
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const terminal = new Set(["completed", "failed", "cancelled"])
const namespace = "creator-business-trial:"

/** Persistent intent/observations in the original creator store. All business IO uses the
 * original Harness/Legacy/controller; this class is neither an engine nor an approval store. */
export class CreatorBusinessTrials {
  private readonly nonce = randomUUID()
  private readonly snapshots: RetainedPackageSnapshots
  private readonly originals = new WeakMap<TrialRecord, string>()
  private readonly proofs = new Map<
    string,
    CreatorBusinessTrialProofBinding & {
      board: Record<string, unknown>
      assertCurrent(): void
    }
  >()
  private readonly writing = new Set<string>()
  private readonly cancellation = new Map<string, AbortController>()
  private readonly stopProvider: () => void
  private readonly stopSettlement: () => void
  private closed = false
  constructor(
    private readonly deps: {
      root: string
      settings: BusinessDraftSettings
      context(threadId: string): DevelopmentContext
      busy(threadId: string): boolean
      changed(threadId: string): void
      candidate(
        scope: DevelopmentScope,
        candidate: BusinessTrialCandidate,
        guard: () => void
      ): Promise<{
        root: string
        contentIdentity: string
      }>
      assertSources(sources: BusinessTrialCandidate["sources"]): void
    }
  ) {
    this.snapshots = new RetainedPackageSnapshots(join(deps.root, "packages"))
    this.stopProvider = registerInternalHarnessProjectProvider(
      (id) => this.internal(id),
      (id) => this.captureIdentity(id),
      (id) => {
        const record = this.read(id)
        if (!record?.project || !record.workspace) return undefined
        this.assertOwner(record)
        return { projectId: id, featureId: record.featureId, workspace: record.workspace }
      },
      "creator-business-trial"
    )
    this.stopSettlement = observeDevelopmentTurnSettlement((event) => {
      try {
        const context = deps.context(event.threadId),
          record = this.current(context.scope)
        if (
          !record ||
          record.phase !== "needs-confirmation" ||
          record.turnId !== event.turnId ||
          !same(record.scope.incarnation, event.incarnation)
        )
          return
        record.settled = event.outcome === "completed"
        if (!record.settled) record.phase = "cancelled"
        this.persist(record)
      } catch {
        /* Original deleted/replaced conversations cannot inherit trial approval. */
      }
    })
  }
  private key(id: string) {
    return `mods-business-trial-v1:${id}`
  }
  private pointer(scope: DevelopmentScope) {
    return `mods-business-trial-current-v1:${businessCreatorScopeKey(scope)}`
  }
  private read(id: string): TrialRecord | undefined {
    if (!new RegExp(`^${namespace}[a-f0-9-]{36}$`).test(id)) return undefined
    const raw = this.deps.settings.getSetting(this.key(id), "")
    if (!raw) return undefined
    const record = parseCreatorBusinessTrialRecord(raw, id, {
      root: this.deps.root,
      packagesRoot: this.snapshots.root
    })
    this.originals.set(record, raw)
    return record
  }
  private current(scope: DevelopmentScope) {
    const id = this.deps.settings.getSetting(this.pointer(scope), "")
    const record = this.read(id)
    if (record && !same(record.scope, scope)) throw Error("BUSINESS_TRIAL_SCOPE_CHANGED")
    return record
  }
  private physical(
    id: string,
    input: { threadId: string; requestId: string; confirmed?: boolean }
  ) {
    const record = this.read(id)
    if (
      !record ||
      record.nonce !== this.nonce ||
      !record.project ||
      !["starting", "running", "unknown"].includes(record.phase) ||
      !input.threadId ||
      input.threadId.length > 256 ||
      !input.requestId ||
      input.requestId.length > 256
    )
      throw Error("BUSINESS_TRIAL_PHYSICAL_SCOPE_CHANGED")
    this.assertOwner(record)
    const facts = (record.physical ??= [])
    const fact = facts.find(
      (item) => item.threadId === input.threadId && item.requestId === input.requestId
    )
    if (input.confirmed === undefined) {
      if (record.stopRequested) throw Error("BUSINESS_TRIAL_CANCEL_REQUESTED")
      const run = managedRunStore.getLatestRun(id, record.featureId)
      // Original admission has already checked the real thread's project/feature metadata.
      // The controller publishes currentSession only after admission returns, so it cannot
      // be used as an earlier source-admission check here.
      if (!run || run.status !== "running" || (record.runId && record.runId !== run.runId))
        throw Error("BUSINESS_TRIAL_PHYSICAL_SCOPE_CHANGED")
      record.runId = run.runId
      if (!fact) {
        if (facts.length >= 64) throw Error("BUSINESS_TRIAL_OBSERVATION_LIMIT")
        facts.push({ threadId: input.threadId, requestId: input.requestId })
      }
    } else {
      if (!fact) throw Error("BUSINESS_TRIAL_PHYSICAL_REQUEST_MISSING")
      // Unknown cleanup is sticky, including a repeated callback after an apparent success.
      fact.confirmed = fact.confirmed === false ? false : input.confirmed
      if (!fact.confirmed) {
        record.phase = "unknown"
        record.error = "BUSINESS_TRIAL_PHYSICAL_SETTLEMENT_UNCONFIRMED"
      }
    }
    this.persist(record, true, input.confirmed === false)
  }
  private assertOwner(record: TrialRecord) {
    if (this.closed) throw Error("BUSINESS_TRIAL_CLOSED")
    const context = this.deps.context(record.scope.threadId)
    context.assertCurrent()
    if (!same(context.scope, record.scope)) throw Error("BUSINESS_TRIAL_SCOPE_CHANGED")
    if (record.workspace) {
      try {
        if (runtimeDirectoryIdentity(record.workspace) !== record.workspaceIdentity)
          throw Error("BUSINESS_TRIAL_WORKSPACE_CHANGED")
      } catch (cause) {
        throw Error("BUSINESS_TRIAL_WORKSPACE_CHANGED", { cause })
      }
    }
  }
  private authority(record: TrialRecord) {
    this.assertOwner(record)
    this.deps.assertSources(record.candidate.sources)
  }
  private operation(record: TrialRecord) {
    this.authority(record)
    const current = this.read(record.id)
    if (current?.stopRequested) throw Error("BUSINESS_TRIAL_CANCEL_REQUESTED")
    if (
      !current ||
      current.phase !== record.phase ||
      this.identity(current) !== this.identity(record)
    )
      throw Error("BUSINESS_TRIAL_RUNTIME_CHANGED")
  }
  private persist(record: TrialRecord, increment = true, cleanup = false) {
    if (cleanup) this.assertOwner(record)
    else this.authority(record)
    const before = this.originals.get(record)
    if (increment && before) record.version++
    const value = JSON.stringify(record)
    parseCreatorBusinessTrialRecord(value, record.id, {
      root: this.deps.root,
      packagesRoot: this.snapshots.root
    })
    if (!this.deps.settings.compareAndSetSetting(this.key(record.id), before, value))
      throw Error("BUSINESS_TRIAL_VERSION_CHANGED")
    this.originals.set(record, value)
    this.deps.changed(record.scope.threadId)
  }
  private trusted(input: DevelopmentBusinessTrialScope, readonly = false, cleanup = false) {
    const record = this.read(input.trialId)
    if (
      !record ||
      record.scope.threadId !== input.threadId ||
      record.scope.workspace !== input.expectedWorkspace ||
      record.candidate.digest !== input.digest ||
      (!readonly && record.version !== input.expectedVersion)
    )
      throw Error("BUSINESS_TRIAL_SCOPE_CHANGED")
    if (cleanup) this.assertOwner(record)
    else this.authority(record)
    return record
  }
  async request(
    scope: DevelopmentScope,
    planId: string,
    candidate: BusinessTrialCandidate,
    goal: string,
    turnId?: string,
    accountingTurnId = turnId
  ) {
    if (!goal.trim() || goal.length > 8000) throw Error("BUSINESS_TRIAL_GOAL_REQUIRED")
    const previous = this.current(scope)
    if (previous) {
      const phase = this.status(scope)!.phase
      if (!terminal.has(phase)) throw Error("BUSINESS_TRIAL_OUTCOME_UNCONFIRMED")
      if (previous.phase !== phase) {
        previous.phase = phase
        this.persist(previous, true, true)
      }
    }
    const record: TrialRecord = {
      schemaVersion: 1,
      version: 1,
      id: namespace + randomUUID(),
      scope,
      planId,
      candidate: structuredClone(candidate),
      goal: goal.trim(),
      phase: "needs-confirmation",
      turnId,
      accountingRunId: getModDevelopmentService()?.trialAccountingReference(
        scope,
        accountingTurnId
      ),
      settled: !turnId,
      nonce: this.nonce,
      featureId: "trial-" + randomUUID().slice(0, 8),
      feedback: []
    }
    this.persist(record, false)
    const key = this.pointer(scope),
      before = this.deps.settings.getSetting(key, "")
    if (!this.deps.settings.compareAndSetSetting(key, before || undefined, record.id))
      throw Error("BUSINESS_TRIAL_VERSION_CHANGED")
    return this.status(scope)
  }
  status(scope: DevelopmentScope): DevelopmentBusinessTrialStatus | undefined {
    const record = this.current(scope)
    if (!record) return undefined
    this.assertOwner(record)
    let invalidSource = false
    try {
      this.deps.assertSources(record.candidate.sources)
    } catch {
      invalidSource = true
    }
    const observed = record.project
      ? managedRunStore.getLatestRun(record.id, record.featureId)
      : null
    const changedRun = !!observed && !!record.runId && observed.runId !== record.runId
    const run = changedRun ? null : observed
    const physicalConfirmed =
      !!record.physical?.length && record.physical.every((fact) => fact.confirmed === true)
    const confirmedTerminal =
      terminal.has(record.phase) ||
      (physicalConfirmed && !!run && terminal.has(run.status)) ||
      (!record.physical?.length && (run?.status === "failed" || run?.status === "cancelled"))
    const restarted = record.nonce !== this.nonce && !confirmedTerminal
    const phase =
      restarted ||
      (invalidSource && !confirmedTerminal) ||
      changedRun ||
      record.phase === "unknown" ||
      run?.status === "corrupt"
        ? "unknown"
        : physicalConfirmed && run?.status === "completed"
          ? "completed"
          : (physicalConfirmed || !record.physical?.length) && run?.status === "failed"
            ? "failed"
            : (physicalConfirmed || !record.physical?.length) && run?.status === "cancelled"
              ? "cancelled"
              : record.phase
    const canPrepare =
      phase === "needs-confirmation" && record.settled && !this.deps.busy(scope.threadId)
    let canStart = false
    if (!restarted && !invalidSource && !record.stopRequested && phase === "ready") {
      try {
        const source = projectRuntimeFunctionSource(
          {
            projectId: record.id,
            workspace: record.workspace!,
            pluginDigest: record.packageDigest!,
            installedPluginId: record.plugin!.id,
            packageId: record.plugin!.name
          },
          record.plugin!.path
        )
        source.manager.assertRuntimeSourceReady(source.input)
        canStart = true
      } catch {
        /* Original source/configuration approval remains mandatory. */
      }
    }
    return {
      id: record.id,
      version: record.version,
      planId: record.planId,
      digest: record.candidate.digest,
      name: record.candidate.name,
      goal: record.goal,
      phase,
      ...(record.packageDigest ? { packageDigest: record.packageDigest } : {}),
      canPrepare,
      canStart,
      canStop:
        !terminal.has(phase) &&
        (!record.project || run?.status === "running" || this.writing.has(record.id)),
      canRefresh: true,
      diagnostics: [
        "候选试用不安装插件；每次使用独立目录和项目权限，原业务 Hooks、工具与人工确认继续生效。",
        ...(!record.accountingRunId
          ? [
              "此历史试用没有原创作请求的费用统计关联；用量覆盖不完整，不计为零，也不归入后来的需求。"
            ]
          : []),
        ...(invalidSource
          ? ["原来源已停用、卸载或变化；禁止继续执行，可停止原任务并核对结果。"]
          : []),
        ...(changedRun ? ["原执行引用已变化；未借用其他运行的结果，也未重放。"] : []),
        ...(record.stopRequested
          ? ["已记录停止请求；只有原执行与物理清理确认后才显示已停止。"]
          : []),
        ...(restarted ? ["应用已重启；仅可核对原运行结果，不恢复旧批准或自动重放。"] : [])
      ],
      ...(record.project
        ? {
            observation: {
              projectId: record.id,
              featureId: record.featureId,
              workspace: record.workspace,
              runId: record.runId,
              status: run?.status ?? record.phase,
              threadId: run?.currentSession?.threadId,
              ...(run && record.runId === run.runId
                ? projectCreatorBusinessTrialSessions(
                    { projectId: record.id, featureId: record.featureId,
                      runId: run.runId, workspacePath: record.workspace! },
                    managedRunStore.listEvents(run, undefined, 200), getThreadCore)
                : {}),
              stageId: run?.lastDecision?.policyResult.facts?.currentNodeId,
              ...(run?.lastDecision?.policyResult.facts
                ? {
                    stageAttribution: "decision-source" as const,
                    sourceNodeStatus: run.lastDecision.policyResult.facts.currentNodeStatus,
                    slashSkill: run.lastDecision.policyResult.facts.slashSkill
                  }
                : {}),
              reason: run?.failureReason ?? record.error
            }
          }
        : {}),
      ...(record.feedback.length ? { feedback: structuredClone(record.feedback) } : {}),
      ...(record.error ? { error: record.error } : {})
    }
  }
  async prepare(input: DevelopmentBusinessTrialScope) {
    const record = this.trusted(input)
    if (
      record.phase !== "needs-confirmation" ||
      !record.settled ||
      this.deps.busy(record.scope.threadId)
    )
      throw Error("BUSINESS_TRIAL_NOT_READY")
    if (this.writing.has(record.id)) throw Error("BUSINESS_TRIAL_BUSY")
    this.writing.add(record.id)
    const cancellation = new AbortController()
    this.cancellation.set(record.id, cancellation)
    try {
      record.phase = "preparing"
      this.persist(record)
      const guard = () => {
        cancellation.signal.throwIfAborted()
        this.operation(record)
      }
      const source = await this.deps.candidate(record.scope, record.candidate, guard)
      guard()
      await mkdir(this.deps.root, { recursive: true })
      guard()
      const directory = await mkdtemp(join(this.deps.root, "trial-"))
      guard()
      const workspace = join(directory, "workspace")
      await mkdir(workspace)
      guard()
      record.workspace = workspace
      record.workspaceIdentity = runtimeDirectoryIdentity(workspace)
      this.persist(record)
      const snapshot = await this.snapshots.captureAsync(source.root, cancellation.signal)
      guard()
      if (
        derivationContentIdentity((await snapshotDerivationSource(snapshot.root)).files) !==
        source.contentIdentity
      )
        throw Error("BUSINESS_TRIAL_CANDIDATE_CHANGED")
      guard()
      const manifestFile = readRuntimeScopedFile(
        snapshot.root,
        "devclaw.project-runtime.json",
        256 * 1024
      )
      if (!manifestFile.bytes) throw Error("BUSINESS_TRIAL_RUNTIME_REQUIRED")
      const manifest = parseProjectRuntimeManifest(JSON.parse(manifestFile.bytes.toString("utf8")))
      if (manifest.mode !== "legacy" || manifest.stateOwner !== "plugin")
        throw Error("BUSINESS_TRIAL_LEGACY_REQUIRED")
      const metadata = readPluginManifest(snapshot.root)?.manifest
      if (!metadata) throw Error("BUSINESS_TRIAL_SOURCE_INVALID")
      record.packageDigest = snapshot.digest
      record.plugin = {
        id: record.id,
        name: metadata.name,
        version: metadata.version ?? "0.0.0",
        path: snapshot.root,
        enabled: true,
        description: (metadata.description ?? "").slice(0, 8192),
        author: "",
        createdAt: "",
        updatedAt: "",
        skillCount: 0,
        hookCount: 0,
        mcpServerCount: 0
      }
      await preflightLegacyCompositionSource(record.plugin)
      // Immutable input is not yet published in the durable row; caller authority and stop
      // intent still bracket preflight. No candidate program has executed in this phase.
      cancellation.signal.throwIfAborted()
      this.authority(record)
      if (this.read(record.id)?.stopRequested) throw Error("BUSINESS_TRIAL_CANCEL_REQUESTED")
      const proof = await this.snapshots.captureGuardAsync(snapshot.digest)
      const boardFile = readRuntimeScopedFile(
        snapshot.root,
        "board_core/board_config.json",
        2 * 1024 * 1024
      )
      if (!boardFile.bytes) throw Error("BUSINESS_TRIAL_BOARD_REQUIRED")
      cancellation.signal.throwIfAborted()
      if (this.read(record.id)?.stopRequested) throw Error("BUSINESS_TRIAL_CANCEL_REQUESTED")
      this.proofs.set(record.id, {
        root: snapshot.root,
        packageDigest: snapshot.digest,
        candidate: structuredClone(record.candidate),
        plugin: structuredClone(record.plugin),
        workspace,
        workspaceIdentity: record.workspaceIdentity,
        featureId: record.featureId,
        scope: structuredClone(record.scope),
        planId: record.planId,
        goal: record.goal,
        accountingRunId: record.accountingRunId,
        board: JSON.parse(boardFile.bytes.toString("utf8")),
        assertCurrent: proof
      })
      record.phase = "needs-configuration"
      this.persist(record)
    } catch (error) {
      const current = this.read(record.id)!
      current.phase = current.stopRequested ? "cancelled" : "failed"
      current.error = current.stopRequested
        ? "BUSINESS_TRIAL_PREPARATION_CANCELLED"
        : error instanceof Error
          ? error.message.slice(0, 8192)
          : "BUSINESS_TRIAL_PREPARATION_FAILED"
      this.persist(current, true, true)
      if (!current.stopRequested) throw error
    } finally {
      this.writing.delete(record.id)
      this.cancellation.delete(record.id)
    }
  }
  source(id: string): NativeProjectSourceContext {
    const record = this.read(id)
    if (
      !record?.workspace ||
      !record.plugin ||
      !record.packageDigest ||
      record.nonce !== this.nonce ||
      !["needs-configuration", "ready"].includes(record.phase)
    )
      throw Error("BUSINESS_TRIAL_NOT_CONFIGURABLE")
    const authorityGuard = () => {
      this.authority(record)
      const current = this.read(id)
      if (!current || current.version !== record.version || current.phase !== record.phase)
        throw Error("BUSINESS_TRIAL_VERSION_CHANGED")
    }
    const guard = () => {
      authorityGuard()
      this.proof(record).assertCurrent()
      authorityGuard()
    }
    guard()
    return {
      project: { projectId: id, version: record.version, pluginDigest: record.packageDigest },
      ...projectRuntimeFunctionSource(
        {
          projectId: id,
          workspace: record.workspace,
          pluginDigest: record.packageDigest,
          installedPluginId: record.plugin.id,
          packageId: record.plugin.name
        },
        record.plugin.path
      ),
      guard,
      authorityGuard
    }
  }
  async context(input: DevelopmentBusinessTrialScope) {
    const record = this.trusted(input),
      source = this.source(record.id)
    await source.manager.prepareRuntimeSourceFacts(source.input)
    source.guard()
    source.manager.assertRuntimeSourceReady(source.input)
    const result = await readCompositionUnitContext({
      plugin: record.plugin!,
      packageDigest: record.packageDigest!,
      workspace: record.workspace!,
      configurationWorkspace: source.input.workspace,
      manager: source.manager,
      grantScope: source.input.scope,
      assertCurrent: source.guard,
      assertAuthorityCurrent: source.authorityGuard
    })
    result.assertCurrent()
    const selection = record.selection
    return {
      ...result.view,
      selected:
        selection && selection.contextFingerprint === result.view.contextFingerprint
          ? selection.deployUnitIds
          : []
    }
  }
  async selectContext(
    input: DevelopmentBusinessTrialScope & { selection: CompositionUnitContextSelection }
  ) {
    const record = this.trusted(input)
    if (this.writing.has(record.id)) throw Error("BUSINESS_TRIAL_BUSY")
    this.writing.add(record.id)
    try {
      const view = await this.context(input)
      this.operation(record)
      assertCompositionUnitContextSelection(view, input.selection)
      record.selection = parseCompositionUnitContext(input.selection)
      record.phase = "ready"
      this.persist(record)
    } finally {
      this.writing.delete(record.id)
    }
  }
  private mappings(record: TrialRecord) {
    return (
      record.selection?.deployUnitIds.map((id) => ({
        deployUnitIdMapping: "trial-" + runtimeDigest(id),
        deployUnitId: id,
        localRepoPath: record.workspace!
      })) ?? []
    )
  }
  private proof(record: TrialRecord) {
    const proof = this.proofs.get(record.id)
    if (!proof) throw Error("BUSINESS_TRIAL_RECONCILIATION_REQUIRED")
    assertCreatorBusinessTrialProofBinding(record, proof)
    return proof
  }
  private identity(record: TrialRecord) {
    return JSON.stringify([
      record.id,
      record.scope,
      record.nonce,
      record.candidate.digest,
      record.candidate.sources,
      record.workspace,
      record.workspaceIdentity,
      record.packageDigest,
      record.plugin,
      record.project,
      record.goal,
      record.featureId,
      record.selection,
      record.accountingRunId
    ])
  }
  private captureIdentity(id: string) {
    const record = this.read(id)
    if (!record?.project) throw Error("BUSINESS_TRIAL_PROJECT_REQUIRED")
    const identity = this.identity(record)
    return () => {
      const current = this.read(id)
      if (
        !current ||
        current.nonce !== this.nonce ||
        !["starting", "running"].includes(current.phase) ||
        this.identity(current) !== identity
      )
        throw Error("BUSINESS_TRIAL_RUNTIME_CHANGED")
      this.authority(current)
    }
  }
  private internal(id: string): InternalHarnessProjectContext | undefined {
    const record = this.read(id)
    if (!record?.project || !record.plugin || !record.workspace || !record.packageDigest)
      return undefined
    if (record.nonce !== this.nonce || !["starting", "running"].includes(record.phase))
      throw Error("BUSINESS_TRIAL_RECONCILIATION_REQUIRED")
    this.authority(record)
    const proof = this.proof(record)
    proof.assertCurrent()
    return {
      ownerKind: "creator-business-trial",
      trialId: id,
      creatorScope: record.scope,
      captureCreatorAccounting: (threadId) => {
        this.authority(record)
        this.proof(record).assertCurrent()
        const current = this.read(record.id)!
        if (
          !current.physical?.some(
            (fact) => fact.threadId === threadId && fact.confirmed === undefined
          )
        )
          throw Error("BUSINESS_TRIAL_PHYSICAL_SCOPE_CHANGED")
        // Historical records without an original request association remain unmeasured.
        if (!record.accountingRunId) return undefined
        const development = getModDevelopmentService()
        if (!development) throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
        return development.captureOwnedTrialAccounting(record.scope, record.accountingRunId, {
          workspace: record.workspace!,
          threadId
        })
      },
      onPhysicalStarted: (input) => this.physical(id, input),
      onPhysicalSettlement: (input) => this.physical(id, input),
      featureId: record.featureId,
      goal: record.goal,
      context: {
        project: record.project,
        plugin: record.plugin,
        configSnapshot: { value: structuredClone(proof.board), error: null },
        projectDirectoryExists: true,
        selectedDeployUnits: this.mappings(record),
        sessionContextInjectionSource: "plugin",
        leanToken: ""
      },
      featureBinding: {
        projectId: id,
        featureId: record.featureId,
        selectedDeployUnitMappings: this.mappings(record),
        sessionWorkspace: { source: "directory", path: record.workspace },
        sessionContextInjectionSource: "plugin",
        createdAt: record.project.lifecycle.createAt
      }
    }
  }
  async start(input: DevelopmentBusinessTrialScope, window: BrowserWindow) {
    const record = this.trusted(input)
    if (record.phase !== "ready" || record.stopRequested) throw Error("BUSINESS_TRIAL_NOT_READY")
    if (this.writing.has(record.id)) throw Error("BUSINESS_TRIAL_BUSY")
    this.writing.add(record.id)
    const cancellation = new AbortController()
    this.cancellation.set(record.id, cancellation)
    try {
      const source = this.source(record.id)
      const guard = () => {
        cancellation.signal.throwIfAborted()
        this.operation(record)
        this.proof(record).assertCurrent()
        source.manager.assertRuntimeSourceReady(source.input)
        this.operation(record)
      }
      await source.manager.prepareRuntimeSourceFacts(source.input)
      guard()
      const context = await this.context(input)
      assertCompositionUnitContextSelection(context, record.selection)
      guard()
      record.phase = "starting"
      this.persist(record)
      const workspace = record.workspace!,
        projectDir = basename(workspace)
      await createHarnessProject(
        {
          adapterId: record.plugin!.id,
          adapterType: "plugin",
          name: record.candidate.name,
          description: record.goal,
          projectCode: "TRIAL" + record.featureId.replaceAll("-", ""),
          projectDir,
          projectFromLean: false,
          systemId: "CREATOR-TRIAL",
          systemName: "隔离候选试用",
          workspacePath: dirname(workspace)
        },
        {
          projectId: record.id,
          plugin: record.plugin!,
          guard,
          signal: cancellation.signal,
          bindProject: (project) => {
            this.operation(record)
            record.project = project
            this.persist(record)
          }
        }
      )
      guard()
      await createHarnessFeature(
        {
          projectId: record.id,
          feature: record.featureId,
          ...(this.mappings(record).length ? { selectedDeployUnits: this.mappings(record) } : {}),
          sessionContextInjectionSource: "plugin",
          sessionWorkspace: { source: "directory", path: workspace }
        },
        guard,
        cancellation.signal
      )
      guard()
      record.phase = "running"
      this.persist(record)
      const run = await managedRunController.start({
        projectId: record.id,
        featureId: record.featureId,
        workspacePath: workspace,
        initialUserMessage: record.goal,
        delivery: createBrowserWindowAgentRunDelivery(window)
      })
      const current = this.read(record.id)!
      if (current.runId && current.runId !== run.runId) throw Error("BUSINESS_TRIAL_RUN_CHANGED")
      current.runId = run.runId
      this.persist(current, true, current.stopRequested)
      if (current.stopRequested) await this.cancelRun(current)
    } catch (error) {
      // Once the original initializer was entered, returned errors cannot prove that all
      // effects were rolled back. Cancellation never silently repeats initialization.
      const current = this.read(record.id)!
      current.phase = current.stopRequested && !current.project ? "cancelled" : "unknown"
      current.error = current.stopRequested
        ? "BUSINESS_TRIAL_STOP_UNCONFIRMED"
        : error instanceof Error
          ? error.message.slice(0, 8192)
          : "BUSINESS_TRIAL_START_UNCONFIRMED"
      this.persist(current, true, true)
      if (!current.stopRequested) throw error
    } finally {
      this.writing.delete(record.id)
      this.cancellation.delete(record.id)
    }
  }
  async refresh(input: DevelopmentBusinessTrialScope) {
    const record = this.trusted(input, true, true)
    if (this.writing.has(record.id)) return
    const status = this.status(record.scope)!
    if (record.nonce === this.nonce && ["needs-configuration", "ready"].includes(status.phase)) {
      this.writing.add(record.id)
      try {
        const options = await this.context({ ...input, expectedVersion: record.version })
        this.operation(record)
        assertCompositionUnitContextSelection(options, record.selection)
        if (record.phase !== "ready") {
          record.phase = "ready"
          this.persist(record)
        }
      } catch (error) {
        // Readiness is not execution. Missing native parameters/consent/context stays visible.
        if (record.phase === "ready") {
          record.phase = "needs-configuration"
          this.persist(record)
        }
        if (
          error instanceof Error &&
          /(?:SOURCE_CHANGED|PACKAGE_CHANGED|SCOPE_CHANGED)/.test(error.message)
        )
          throw error
      } finally {
        this.writing.delete(record.id)
      }
      return
    }
    // Readback never resurrects process-local approval or restarts an unknown operation.
    if (record.phase !== status.phase) {
      record.phase = status.phase
      this.persist(record, true, true)
    }
  }
  async stop(input: DevelopmentBusinessTrialScope) {
    const record = this.trusted(input, false, true)
    record.stopRequested = true
    this.persist(record, true, true)
    if (this.writing.has(record.id)) {
      this.cancellation.get(record.id)?.abort(Error("BUSINESS_TRIAL_CANCEL_REQUESTED"))
      return
    }
    if (!record.project) {
      record.phase = "cancelled"
      this.persist(record, true, true)
      return
    }
    try {
      await this.cancelRun(record)
      await this.refresh({ ...input, expectedVersion: this.read(record.id)!.version })
    } catch (error) {
      const current = this.read(record.id)!
      current.phase = "unknown"
      current.error = "BUSINESS_TRIAL_STOP_UNCONFIRMED"
      this.persist(current, true, true)
      throw error
    }
  }
  private async cancelRun(record: TrialRecord) {
    const run = managedRunStore.getLatestRun(record.id, record.featureId)
    if (!run || !record.runId || run.runId !== record.runId)
      throw Error("BUSINESS_TRIAL_RUN_CHANGED")
    // Admission is published before currentSession. Capture both original host facts so a
    // just-admitted next session is not missed, without accepting a renderer thread ID.
    const threadIds = [
      ...new Set([
        ...(run.currentSession?.threadId ? [run.currentSession.threadId] : []),
        ...(record.physical ?? [])
          .filter((fact) => fact.confirmed !== true)
          .map((fact) => fact.threadId)
      ])
    ]
    const owners = threadIds.map((threadId) => {
      const thread = getThreadCore(threadId)
      if (!thread) throw Error("BUSINESS_TRIAL_STOP_UNCONFIRMED")
      const incarnation = captureThreadIncarnation(thread)
      const check = () => {
        this.assertOwner(record)
        const current = getThreadCore(threadId)
        if (!current || !matchesThreadIncarnation(current, incarnation))
          throw Error("BUSINESS_TRIAL_STOP_UNCONFIRMED")
        let metadata: unknown
        try {
          metadata = JSON.parse(current.metadata ?? "null")
        } catch {
          throw Error("BUSINESS_TRIAL_STOP_UNCONFIRMED")
        }
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
          throw Error("BUSINESS_TRIAL_STOP_UNCONFIRMED")
        const value = metadata as {
          workspacePath?: unknown
          harnessFeature?: {
            projectId?: unknown
            slug?: unknown
            runId?: unknown
          }
        }
        if (
          typeof value.workspacePath !== "string" ||
          !isSameWorkspacePath(value.workspacePath, record.workspace!) ||
          value.harnessFeature?.projectId !== record.id ||
          value.harnessFeature.slug !== record.featureId ||
          value.harnessFeature.runId !== record.runId
        )
          throw Error("BUSINESS_TRIAL_STOP_UNCONFIRMED")
      }
      check()
      return { threadId, check }
    })
    await managedRunController.stop({
      projectId: record.id,
      featureId: record.featureId,
      runId: record.runId
    })
    const { workflowRunManager } = await import("../../agent/workflow/run-manager")
    for (const owner of owners) {
      owner.check()
      cancelActiveAgentRun(owner.threadId)
      owner.check()
      await workflowRunManager.cancelAndWait(owner.threadId)
      owner.check()
    }
    for (
      let count = 0;
      count < 100 && owners.some((owner) => isAgentRunBusy(owner.threadId));
      count++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      owners.forEach((owner) => owner.check())
    }
    const current = this.read(record.id)!
    if (owners.some((owner) => isAgentRunBusy(owner.threadId))) {
      current.phase = "unknown"
      current.error = "BUSINESS_TRIAL_STOP_UNCONFIRMED"
      this.persist(current, true, true)
      throw Error("BUSINESS_TRIAL_STOP_UNCONFIRMED")
    }
    if (current.phase !== "unknown")
      current.error = "BUSINESS_TRIAL_STOP_AWAITING_PHYSICAL_SETTLEMENT"
    this.persist(current, true, true)
  }
  gates(input: DevelopmentBusinessTrialScope) {
    const record = this.trusted(input, true)
    if (!record.runId) return []
    return harnessNotifications
      .pending()
      .filter(
        (notification) =>
          notification.type === "human_gate" &&
          notification.projectId === record.id &&
          notification.featureId === record.featureId &&
          notification.runId === record.runId
      )
      .map((notification) => ({
        id: notification.notificationId,
        title: notification.title,
        message: notification.message,
        status: notification.status
      }))
  }
  async decideGate(
    input: DevelopmentBusinessTrialScope & {
      notificationId: string
      action: "approve" | "reject"
      message?: string
    },
    window: BrowserWindow
  ) {
    const record = this.trusted(input)
    if (
      record.phase !== "running" ||
      !this.gates(input).some((gate) => gate.id === input.notificationId)
    )
      throw Error("BUSINESS_TRIAL_GATE_CHANGED")
    const result = await decideNotification(
      {
        notificationId: input.notificationId,
        action: input.action,
        ...(input.message ? { message: input.message } : {})
      },
      { channel: "desktop", context: { delivery: createBrowserWindowAgentRunDelivery(window) } }
    )
    if (!result.applied) throw Error("BUSINESS_TRIAL_GATE_CHANGED")
    this.authority(record)
  }
  feedback(input: DevelopmentBusinessTrialScope & { message: string }) {
    const record = this.trusted(input, false, true)
    if (this.writing.has(record.id)) throw Error("BUSINESS_TRIAL_BUSY")
    if (!input.message.trim() || input.message.length > 4000 || record.feedback.length >= 8)
      throw Error("BUSINESS_TRIAL_FEEDBACK_INVALID")
    record.feedback.push({ id: randomUUID(), at: Date.now(), message: input.message.trim() })
    this.persist(record, true, true)
  }
  close() {
    for (const controller of this.cancellation.values())
      controller.abort(Error("BUSINESS_TRIAL_CLOSED"))
    this.closed = true
    this.stopSettlement()
    this.stopProvider()
    this.proofs.clear()
  }
}
