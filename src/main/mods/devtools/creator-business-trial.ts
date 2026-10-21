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
import { prepareAutobizBusinessTrial } from "./adapters/autobiz-business-trial"
import {
  autobizTrialEvidenceOwner,
  readAutobizTrialEvidenceContracts
} from "./adapters/autobiz-trial-evidence"
import { CreatorLegacyTrialEvidence } from "./creator-trial-legacy-evidence"
import type { RuntimePluginSourceBinding } from "../../plugins/runtime-source-scope"
import { projectCreatorLegacyTrialJourney } from "./creator-trial-legacy-journey"
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
import type { PluginStageRecoveryOwner, PluginStageRecoveryReceipt } from "./plugin-stage-recovery"
import { prepareStageRecoveryReadOnlyRoots } from "../../hooks/stage-recovery-command"
import {
  PluginStageRecoveryInputs,
  type PluginRecoveryInputHandle
} from "./plugin-stage-recovery-inputs"
import { getOpenworkDir } from "../../storage"
import { readBoundedProjectFiles } from "../../harness-board/project-runtime/bounded-project-files"
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
      adapterContext: Record<string, unknown>
      assertCurrent(): void
    }
  >()
  private readonly writing = new Set<string>()
  private readonly cancellation = new Map<string, AbortController>()
  private readonly stopProvider: () => void
  private readonly stopSettlement: () => void
  private readonly evidence: CreatorLegacyTrialEvidence
  private closed = false
  private readonly recoveryOwnerCache = new Map<string, PluginStageRecoveryOwner>()
  private recoveryInputs?: PluginStageRecoveryInputs
  private readonly recoveryOwners = new WeakMap<
    PluginStageRecoveryOwner,
    {
      record: TrialRecord
      inputs?: PluginRecoveryInputHandle
    }
  >()
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
    this.evidence = new CreatorLegacyTrialEvidence(deps.root, {
      settings: deps.settings,
      owner: (binding) => this.evidenceOwner(binding),
      canDescribe: (binding) => this.evidenceDescriptionAvailable(binding),
      changed: (id) => {
        const record = this.read(id)
        if (record) deps.changed(record.scope.threadId)
      }
    })
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
  private evidenceBinding(binding: Readonly<RuntimePluginSourceBinding>) {
    if (binding.mode !== "legacy") return undefined
    const record = this.read(binding.projectId)
    if (
      !record ||
      !record.plugin ||
      !record.workspace ||
      !record.project ||
      !record.packageDigest ||
      record.nonce !== this.nonce ||
      record.phase !== "running" ||
      record.stopRequested ||
      binding.operationId !== record.id ||
      binding.featureId !== record.featureId ||
      binding.packageDigest !== record.packageDigest ||
      binding.plugin.id !== record.plugin.id ||
      !isSameWorkspacePath(binding.plugin.path, record.plugin.path) ||
      !isSameWorkspacePath(binding.workspace, record.workspace)
    )
      return undefined
    const native = managedRunStore.getLatestRun(record.id, record.featureId)
    const thread = getThreadCore(binding.threadId)
    if (
      !native ||
      native.status !== "running" ||
      (record.runId && native.runId !== record.runId) ||
      !thread ||
      JSON.stringify(captureThreadIncarnation(thread)) !== binding.incarnationKey
    )
      return undefined
    let metadata: Record<string, unknown>
    try {
      metadata = JSON.parse(thread.metadata ?? "null")
    } catch {
      return undefined
    }
    const feature = metadata?.harnessFeature as Record<string, unknown> | undefined
    if (
      feature?.projectId !== record.id ||
      feature.slug !== record.featureId ||
      feature.runId !== native.runId ||
      typeof metadata.workspacePath !== "string" ||
      !isSameWorkspacePath(metadata.workspacePath, record.workspace)
    )
      return undefined
    return { record, native, thread }
  }
  private evidenceDescriptionAvailable(binding: Readonly<RuntimePluginSourceBinding>) {
    const admitted = this.evidenceBinding(binding)
    if (!admitted) return false
    this.authority(admitted.record)
    this.proof(admitted.record).assertCurrent()
    const current = this.evidenceBinding(binding)
    return (
      !!current &&
      current.native.runId === admitted.native.runId &&
      current.thread.metadata === admitted.thread.metadata
    )
  }
  private evidenceOwner(binding: Readonly<RuntimePluginSourceBinding>) {
    const admitted = this.evidenceBinding(binding)
    if (!admitted || admitted.native.currentSession?.threadId !== binding.threadId) return undefined
    const { record, native, thread } = admitted
    const guard = () => {
      this.authority(record)
      this.proof(record).assertCurrent()
      const current = this.read(record.id)
      const run = managedRunStore.getLatestRun(record.id, record.featureId)
      if (
        !current ||
        current.stopRequested ||
        current.phase !== "running" ||
        current.nonce !== this.nonce ||
        (current.runId && current.runId !== native.runId) ||
        run?.runId !== native.runId ||
        run.status !== "running" ||
        run.currentSession?.threadId !== binding.threadId ||
        getThreadCore(binding.threadId)?.metadata !== thread.metadata ||
        !matchesThreadIncarnation(getThreadCore(binding.threadId), captureThreadIncarnation(thread))
      )
        throw Error("BUSINESS_TRIAL_EVIDENCE_SCOPE_CHANGED")
    }
    return autobizTrialEvidenceOwner(record, native.runId, guard)
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
    if (!record.recovery) this.deps.assertSources(record.candidate.sources)
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
  status(
    scope: DevelopmentScope,
    currentCandidate?: { planId: string; digest: string } | null
  ): DevelopmentBusinessTrialStatus | undefined {
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
    const sessionFacts =
      run && record.runId === run.runId && record.workspace
        ? projectCreatorBusinessTrialSessions(
            {
              projectId: record.id,
              featureId: record.featureId,
              runId: run.runId,
              workspacePath: record.workspace
            },
            managedRunStore.listEvents(run, undefined, 200),
            getThreadCore
          )
        : undefined
    let journey: DevelopmentBusinessTrialStatus["journey"]
    if (record.project && record.plugin && record.packageDigest && record.workspace) {
      try {
        const manifest = this.evidence.source(record.id, record.featureId, record.packageDigest)
        if (manifest)
          journey = projectCreatorLegacyTrialJourney({
            projectId: record.id,
            creatorThreadId: scope.threadId,
            candidateDigest: record.candidate.digest,
            packageDigest: record.packageDigest,
            candidateCurrent:
              !invalidSource &&
              (currentCandidate === undefined ||
                (currentCandidate !== null &&
                  currentCandidate.planId === record.planId &&
                  currentCandidate.digest === record.candidate.digest)),
            workspace: record.workspace,
            featureId: record.featureId,
            runId: run?.runId,
            phase,
            currentStageId: run?.lastDecision?.policyResult.facts?.currentNodeId,
            manifest,
            ...this.evidence.read(record.id, record.featureId),
            sessions: sessionFacts?.sessions ?? [],
            sessionsTruncated: sessionFacts?.sessionsTruncated,
            sessionsUnavailable: !sessionFacts || sessionFacts.sessionsUnavailable
          })
      } catch {
        // Missing source/journal remains an evidence gap. Status readback cannot execute
        // a validator, repair a business state file or silently manufacture a PASS.
      }
    }
    return {
      id: record.id,
      ...(record.recovery
        ? {
            stageRecovery: {
              sourceTrialId: record.recovery.sourceId,
              preparationId: record.recovery.preparationId,
              started:
                !!record.runId ||
                !!record.physical?.length ||
                ["starting", "running"].includes(record.phase)
            }
          }
        : {}),
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
      ...(journey ? { journey } : {}),
      ...(record.project
        ? {
            observation: {
              projectId: record.id,
              featureId: record.featureId,
              workspace: record.workspace,
              runId: record.runId,
              status: run?.status ?? record.phase,
              threadId: run?.currentSession?.threadId,
              ...(sessionFacts ?? {}),
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
      this.evidence.freezeSource(record.id, record.featureId, snapshot.digest, manifest)
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
      const adapterContext = await prepareAutobizBusinessTrial(record.plugin, manifest)
      // Immutable input is not yet published in the durable row; caller authority and stop
      // intent still bracket preflight. No candidate program has executed in this phase.
      cancellation.signal.throwIfAborted()
      this.authority(record)
      if (this.read(record.id)?.stopRequested) throw Error("BUSINESS_TRIAL_CANCEL_REQUESTED")
      const proof = await this.snapshots.captureGuardAsync(snapshot.digest)
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
        adapterContext,
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
  /** Main-only ended-owner readback. It neither revives a run nor inherits its old approval. */
  private recoveryInputService(record: TrialRecord) {
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
    return (this.recoveryInputs ??= new PluginStageRecoveryInputs({
      root: join(this.deps.root, "recovery-inputs"),
      contextDataRoot: join(getOpenworkDir(), "plugin-data"),
      normalizeConfigurationWorkspace: (workspace) =>
        projectRuntimeFunctionSource(
          {
            projectId: record.id,
            workspace,
            pluginDigest: record.packageDigest!,
            installedPluginId: record.plugin!.id,
            packageId: record.plugin!.name
          },
          record.plugin!.path
        ).input.workspace,
      manager: source.manager
    }))
  }
  /** Historical ownership readback: it grants neither a fresh proof nor permission to reset. */
  adoptedRecoveryStatus(
    scope: DevelopmentScope,
    preparationId: string,
    targetId: string,
    evidenceDigest: string
  ) {
    const target = this.read(targetId)
    if (
      !target?.recovery ||
      !target.workspace ||
      !target.plugin ||
      !target.packageDigest ||
      !same(target.scope, scope) ||
      target.recovery.preparationId !== preparationId ||
      target.recovery.evidenceDigest !== evidenceDigest ||
      this.deps.settings.getSetting(
        `mods-business-trial-recovery-adoption-v1:${preparationId}`,
        ""
      ) !== targetId
    )
      throw Error("BUSINESS_TRIAL_RECOVERY_ADOPTION_CHANGED")
    const binding = JSON.stringify([
      target.scope,
      target.workspace,
      target.workspaceIdentity,
      target.packageDigest,
      target.plugin,
      target.recovery
    ])
    const guard = () => {
      const current = this.read(targetId)
      if (
        !current ||
        JSON.stringify([
          current.scope,
          current.workspace,
          current.workspaceIdentity,
          current.packageDigest,
          current.plugin,
          current.recovery
        ]) !== binding
      )
        throw Error("BUSINESS_TRIAL_RECOVERY_ADOPTION_CHANGED")
      this.authority(current)
      if (
        this.deps.settings.getSetting(
          `mods-business-trial-recovery-adoption-v1:${preparationId}`,
          ""
        ) !== targetId
      )
        throw Error("BUSINESS_TRIAL_RECOVERY_ADOPTION_CHANGED")
    }
    guard()
    return {
      guard,
      canResume:
        ["needs-configuration", "ready"].includes(target.phase) &&
        !target.runId &&
        !target.physical?.length &&
        !this.writing.has(targetId)
    }
  }
  async adoptedRecoveryOwner(
    scope: DevelopmentScope,
    preparationId: string,
    targetId: string,
    evidenceDigest: string
  ): Promise<PluginStageRecoveryOwner> {
    const target = this.read(targetId)
    if (
      !target?.recovery ||
      !target.workspace ||
      !target.plugin ||
      !target.packageDigest ||
      !same(target.scope, scope) ||
      target.recovery.preparationId !== preparationId ||
      target.recovery.evidenceDigest !== evidenceDigest ||
      this.deps.settings.getSetting(
        `mods-business-trial-recovery-adoption-v1:${preparationId}`,
        ""
      ) !== targetId
    )
      throw Error("BUSINESS_TRIAL_RECOVERY_ADOPTION_CHANGED")
    const identity = this.identity(target)
    const available = () => {
      const current = this.read(targetId)
      if (
        !current ||
        ![target.nonce, this.nonce].includes(current.nonce) ||
        this.identity({ ...current, nonce: target.nonce }) !== identity ||
        !["needs-configuration", "ready"].includes(current.phase) ||
        current.runId ||
        current.physical?.length ||
        this.writing.has(targetId)
      )
        throw Error("BUSINESS_TRIAL_RECOVERY_ALREADY_STARTED")
      this.authority(current)
    }
    available()
    await this.snapshots.readAsync(target.packageDigest)
    if (process.platform === "win32")
      await prepareStageRecoveryReadOnlyRoots([target.plugin.path], available)
    await this.snapshots.readAsync(target.packageDigest)
    const packageGuard = await this.snapshots.captureGuardAsync(target.packageDigest)
    const inputs = this.recoveryInputService(target)
    const guard = () => {
      available()
      packageGuard()
      inputs.assertTargetCurrent(targetId)
      available()
    }
    const binding = await inputs.targetInputs(targetId, { guard: available })
    if (process.platform === "win32" && binding.readOnlyRoots.length)
      await prepareStageRecoveryReadOnlyRoots(binding.readOnlyRoots, available)
    guard()
    const owner: PluginStageRecoveryOwner = {
      id: target.recovery.sourceId,
      scope: structuredClone(scope),
      workspace: target.workspace,
      packageRoot: target.plugin.path,
      packageDigest: target.packageDigest,
      featureId: target.featureId,
      inputsDigest: binding.inputsDigest,
      readOnlyRoots: binding.readOnlyRoots,
      ...(binding.providerInput ? { providerInput: binding.providerInput } : {}),
      guard,
      assertInputsCurrent: async () => {
        guard()
        binding.providerInput?.assertCurrent()
        guard()
      },
      assertAdoptionAvailable: (id, evidence) => {
        if (id !== preparationId || evidence !== evidenceDigest)
          throw Error("BUSINESS_TRIAL_RECOVERY_ADOPTION_CHANGED")
        guard()
      }
    }
    this.recoveryOwners.set(owner, { record: target })
    return owner
  }
  async endedRecoveryOwner(scope: DevelopmentScope, id: string): Promise<PluginStageRecoveryOwner> {
    const cached = this.recoveryOwnerCache.get(id)
    if (cached && same(cached.scope, scope)) {
      try {
        cached.guard()
        await cached.assertInputsCurrent?.()
        cached.guard()
        return cached
      } catch {
        this.recoveryOwnerCache.delete(id)
      }
    }
    const record = this.read(id)
    if (
      !record?.project ||
      !record.plugin ||
      !record.packageDigest ||
      !record.workspace ||
      !same(record.scope, scope) ||
      this.writing.has(id)
    )
      throw Error("BUSINESS_TRIAL_RECOVERY_OWNER_REQUIRED")
    const original = this.identity(record)
    const assertEnded = () => {
      const current = this.read(id)
      if (
        !current ||
        this.identity(current) !== original ||
        current.runId !== record.runId ||
        !same(current.physical, record.physical) ||
        this.writing.has(id)
      )
        throw Error("BUSINESS_TRIAL_RECOVERY_OWNER_CHANGED")
      this.authority(current)
      const run = managedRunStore.getLatestRun(id, record.featureId)
      if (
        !run ||
        !record.runId ||
        run.runId !== record.runId ||
        !terminal.has(run.status) ||
        current.phase === "unknown" ||
        record.physical?.some((fact) => fact.confirmed !== true) ||
        !record.physical?.length ||
        (run.currentSession?.threadId && isAgentRunBusy(run.currentSession.threadId)) ||
        record.physical.some((fact) => isAgentRunBusy(fact.threadId))
      )
        throw Error("BUSINESS_TRIAL_RECOVERY_REQUIRES_PHYSICAL_SETTLEMENT")
    }
    assertEnded()
    // Hardening changes Windows ctime. Verify exact retained bytes on both sides, then adopt
    // metadata guards; never ignore a changed guard or grant broad access to a user directory.
    await this.snapshots.readAsync(record.packageDigest)
    const beforeProtection = await readBoundedProjectFiles(record.workspace, { guard: assertEnded })
    assertEnded()
    if (process.platform === "win32")
      await prepareStageRecoveryReadOnlyRoots([record.plugin.path, record.workspace], assertEnded)
    await this.snapshots.readAsync(record.packageDigest)
    await readBoundedProjectFiles(record.workspace, {
      guard: assertEnded,
      expected: beforeProtection
    })
    assertEnded()
    const packageGuard = await this.snapshots.captureGuardAsync(record.packageDigest)
    const guard = () => {
      assertEnded()
      packageGuard()
      assertEnded()
    }
    const inputs = this.recoveryInputService(record)
    const inputHandle = await inputs.capture({
      sourceId: record.id,
      workspace: record.workspace,
      packageRoot: record.plugin.path,
      packageId: record.plugin.name,
      packageVersion: record.plugin.version,
      packageDigest: record.packageDigest,
      guard: assertEnded
    })
    guard()
    const provider = await inputs.prepareProviderInputs(inputHandle, assertEnded)
    const readOnlyRoots = await inputs.readOnlyRoots(inputHandle, assertEnded)
    if (process.platform === "win32" && readOnlyRoots.length)
      await prepareStageRecoveryReadOnlyRoots(readOnlyRoots, guard)
    await inputs.assertCurrent(inputHandle, assertEnded)
    guard()
    guard()
    const owner: PluginStageRecoveryOwner = {
      id,
      scope: structuredClone(scope),
      workspace: record.workspace,
      packageRoot: record.plugin.path,
      packageDigest: record.packageDigest,
      featureId: record.featureId,
      stages: parseProjectRuntimeManifest(
        JSON.parse(
          readRuntimeScopedFile(
            record.plugin.path,
            "devclaw.project-runtime.json",
            256 * 1024
          ).bytes!.toString("utf8")
        )
      ).stages.map((stage) => ({
        id: stage.id,
        title: stage.title
      })),
      inputsDigest: inputs.identity(inputHandle),
      readOnlyRoots,
      ...(provider
        ? {
            providerInput: {
              directory: provider.directory,
              ...(provider.knowledgeRoot ? { knowledgeRoot: provider.knowledgeRoot } : {}),
              ...(provider.configuration ? { configuration: provider.configuration } : {})
            }
          }
        : {}),
      guard: () => {
        // The retained package and native inputs are fully fenced before/after each command.
        // File-by-file copy checks only need live scope/physical ownership: rewalking every
        // package/knowledge file for each copied artifact creates multiplicative IO.
        assertEnded()
      },
      assertInputsCurrent: async () => {
        guard()
        await inputs.assertCurrent(inputHandle, assertEnded)
        guard()
      },
      assertAdoptionAvailable: (preparationId, evidenceDigest) => {
        guard()
        const targetId = this.deps.settings.getSetting(
          `mods-business-trial-recovery-adoption-v1:${preparationId}`,
          ""
        )
        const target = targetId && this.read(targetId)
        if (
          !target ||
          !target.recovery ||
          target.recovery.sourceId !== record.id ||
          target.recovery.preparationId !== preparationId ||
          target.recovery.evidenceDigest !== evidenceDigest ||
          !["needs-configuration", "ready"].includes(target.phase) ||
          target.runId ||
          target.physical?.length
        )
          throw Error("BUSINESS_TRIAL_RECOVERY_ALREADY_STARTED")
        this.authority(target)
        guard()
      }
    }
    owner.guard()
    this.recoveryOwners.set(owner, { record, inputs: inputHandle })
    if (this.recoveryOwnerCache.size >= 32)
      this.recoveryOwnerCache.delete(this.recoveryOwnerCache.keys().next().value!)
    this.recoveryOwnerCache.set(id, owner)
    return owner
  }
  async adoptRecoveredTrial(
    owner: PluginStageRecoveryOwner,
    receipt: PluginStageRecoveryReceipt,
    assertNativeReceipt: () => void
  ): Promise<{ trialId: string; projectId: string }> {
    const original = this.recoveryOwners.get(owner)
    if (!original) throw Error("BUSINESS_TRIAL_RECOVERY_NATIVE_OWNER_REQUIRED")
    const guard = () => {
      owner.guard()
      assertNativeReceipt()
      owner.guard()
    }
    guard()
    if (
      receipt.sourceId !== owner.id ||
      receipt.packageRoot !== owner.packageRoot ||
      receipt.packageDigest !== owner.packageDigest ||
      receipt.featureId !== owner.featureId
    )
      throw Error("BUSINESS_TRIAL_RECOVERY_RECEIPT_CHANGED")
    const indexKey = `mods-business-trial-recovery-adoption-v1:${receipt.preparationId}`
    const previous = this.deps.settings.getSetting(indexKey, "")
    const adoptedId = previous || namespace + randomUUID()
    if (!/^creator-business-trial:[a-f0-9-]{36}$/.test(adoptedId))
      throw Error("BUSINESS_TRIAL_RECOVERY_ADOPTION_CHANGED")
    if (previous) {
      const adopted = this.read(previous)
      if (
        adopted &&
        (!adopted.recovery ||
          adopted.recovery.evidenceDigest !== receipt.evidenceDigest ||
          adopted.workspace !== receipt.workspace ||
          !same(adopted.scope, owner.scope))
      )
        throw Error("BUSINESS_TRIAL_RECOVERY_ADOPTION_CHANGED")
      // A reserved ID without a row is a resumable native intent, not a second new project.
      if (adopted) {
        if (adopted.nonce !== this.nonce) {
          if (
            !["needs-configuration", "ready"].includes(adopted.phase) ||
            adopted.runId ||
            adopted.physical?.length
          )
            throw Error("BUSINESS_TRIAL_RECOVERY_ALREADY_STARTED")
          const file = readRuntimeScopedFile(
            owner.packageRoot,
            "devclaw.project-runtime.json",
            256 * 1024
          )
          if (!file.bytes) throw Error("BUSINESS_TRIAL_RUNTIME_REQUIRED")
          const manifest = parseProjectRuntimeManifest(JSON.parse(file.bytes.toString("utf8")))
          const adapterContext = await prepareAutobizBusinessTrial(adopted.plugin!, manifest)
          const packageGuard = await this.snapshots.captureGuardAsync(owner.packageDigest)
          guard()
          adopted.nonce = this.nonce
          adopted.phase = "needs-configuration"
          this.proofs.set(adopted.id, {
            root: owner.packageRoot,
            packageDigest: owner.packageDigest,
            candidate: structuredClone(adopted.candidate),
            plugin: structuredClone(adopted.plugin!),
            workspace: adopted.workspace!,
            workspaceIdentity: adopted.workspaceIdentity!,
            featureId: adopted.featureId,
            scope: structuredClone(adopted.scope),
            planId: adopted.planId,
            goal: adopted.goal,
            recovery: structuredClone(adopted.recovery),
            adapterContext,
            assertCurrent: () => {
              packageGuard()
              this.recoveryInputs!.assertTargetCurrent(adopted.id)
            }
          })
          this.persist(adopted)
        }
        const pointer = this.pointer(adopted.scope),
          before = this.deps.settings.getSetting(pointer, "")
        if (
          before !== adopted.id &&
          !this.deps.settings.compareAndSetSetting(pointer, before || undefined, adopted.id)
        )
          throw Error("BUSINESS_TRIAL_VERSION_CHANGED")
        return { trialId: adopted.id, projectId: adopted.id }
      }
    } else if (!this.deps.settings.compareAndSetSetting(indexKey, undefined, adoptedId)) {
      throw Error("BUSINESS_TRIAL_RECOVERY_ADOPTION_CHANGED")
    }
    const sourceRecord = original.record
    if (!original.inputs) throw Error("BUSINESS_TRIAL_RECOVERY_NATIVE_INPUTS_REQUIRED")
    const workspaceIdentity = runtimeDirectoryIdentity(receipt.workspace)
    const record: TrialRecord = {
      schemaVersion: 1,
      version: 1,
      id: adoptedId,
      scope: structuredClone(owner.scope),
      planId: sourceRecord.planId,
      candidate: structuredClone(sourceRecord.candidate),
      goal: sourceRecord.goal,
      phase: "needs-configuration",
      settled: true,
      nonce: this.nonce,
      workspace: receipt.workspace,
      workspaceIdentity,
      packageDigest: owner.packageDigest,
      plugin: { ...sourceRecord.plugin!, id: "" },
      featureId: owner.featureId,
      feedback: [],
      recovery: {
        sourceId: owner.id,
        preparationId: receipt.preparationId,
        evidenceDigest: receipt.evidenceDigest
      }
    }
    record.plugin!.id = record.id
    record.project = {
      ...structuredClone(sourceRecord.project!),
      projectId: record.id,
      workspacePath: dirname(record.workspace!),
      projectDir: basename(record.workspace!),
      "harness-adapter": { ...sourceRecord.project!["harness-adapter"], id: record.id },
      lifecycle: { status: "active", createAt: new Date().toISOString() }
    }
    const manifestFile = readRuntimeScopedFile(
      owner.packageRoot,
      "devclaw.project-runtime.json",
      256 * 1024
    )
    if (!manifestFile.bytes) throw Error("BUSINESS_TRIAL_RUNTIME_REQUIRED")
    const manifest = parseProjectRuntimeManifest(JSON.parse(manifestFile.bytes.toString("utf8")))
    const adapterContext = await prepareAutobizBusinessTrial(record.plugin!, manifest)
    guard()
    const packageGuard = await this.snapshots.captureGuardAsync(owner.packageDigest)
    guard()
    await this.recoveryInputs!.bind(
      original.inputs,
      {
        projectId: record.id,
        workspace: record.workspace!,
        packageRoot: owner.packageRoot,
        installedPluginId: record.id
      },
      guard
    )
    guard()
    this.proofs.set(record.id, {
      root: owner.packageRoot,
      packageDigest: owner.packageDigest,
      candidate: structuredClone(record.candidate),
      plugin: structuredClone(record.plugin!),
      workspace: record.workspace!,
      workspaceIdentity,
      featureId: record.featureId,
      scope: structuredClone(record.scope),
      planId: record.planId,
      goal: record.goal,
      recovery: structuredClone(record.recovery),
      adapterContext,
      assertCurrent: () => {
        packageGuard()
        this.recoveryInputs!.assertTargetCurrent(record.id)
      }
    })
    this.evidence.freezeSource(record.id, record.featureId, owner.packageDigest, manifest)
    guard()
    this.persist(record, false)
    guard()
    if (this.deps.settings.getSetting(indexKey, "") !== record.id)
      throw Error("BUSINESS_TRIAL_RECOVERY_ADOPTION_CHANGED")
    const pointer = this.pointer(record.scope),
      before = this.deps.settings.getSetting(pointer, "")
    if (!this.deps.settings.compareAndSetSetting(pointer, before || undefined, record.id))
      throw Error("BUSINESS_TRIAL_VERSION_CHANGED")
    this.deps.changed(record.scope.threadId)
    return { trialId: record.id, projectId: record.id }
  }
  private proof(record: TrialRecord) {
    if (record.recovery) {
      let native: Record<string, unknown>
      try {
        native = JSON.parse(
          this.deps.settings.getSetting(
            `plugin-stage-recovery-v1:${record.recovery.preparationId}`,
            "null"
          )
        )
      } catch {
        throw Error("BUSINESS_TRIAL_RECOVERY_NOT_CONFIRMED")
      }
      if (
        !native ||
        native.phase !== "adopted" ||
        native.recoveredTrialId !== record.id ||
        native.recoveredProjectId !== record.id ||
        native.workspace !== record.workspace ||
        native.packageDigest !== record.packageDigest ||
        native.sourceId !== record.recovery.sourceId ||
        native.evidenceDigest !== record.recovery.evidenceDigest
      )
        throw Error("BUSINESS_TRIAL_RECOVERY_NOT_CONFIRMED")
    }
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
      record.accountingRunId,
      record.recovery
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
        configSnapshot: { value: structuredClone(proof.adapterContext), error: null },
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
      if (!record.recovery)
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
      if (!record.recovery)
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
      const contracts = await readAutobizTrialEvidenceContracts(record)
      guard()
      if (contracts) this.evidence.freeze(record.id, record.featureId, contracts)
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
    if (this.closed) return
    for (const controller of this.cancellation.values())
      controller.abort(Error("BUSINESS_TRIAL_CLOSED"))
    this.closed = true
    this.stopSettlement()
    this.stopProvider()
    this.evidence.close()
    this.recoveryInputs?.close()
    this.recoveryOwnerCache.clear()
    this.proofs.clear()
  }
}
