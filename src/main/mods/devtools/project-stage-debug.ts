import { capturePackageMetadataGuard } from "../../harness-board/project-runtime/package-snapshots"
import { readBoundedProjectFiles } from "../../harness-board/project-runtime/bounded-project-files"
import { compareStageDebugFiles } from "../../harness-board/project-runtime/stage-debug-file-comparison"
import type { StageDebugFileComparison } from "../../../shared/project-runtime/stage-debug"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type {
  ProjectStageDebugApi,
  StageDebugBranchView,
  StageDebugPreparation
} from "../../../shared/project-runtime/stage-debug"
import type {
  HostProjectOperation,
  HostProjectState
} from "../../../shared/project-runtime/host-types"
import type { DevelopmentScope } from "../v2/development-session"
import type { AuthoringAtomicSettings } from "./authoring-config-snapshot"
import { ProjectStageSnapshots, type StageInputSnapshot } from "./project-stage-snapshots"
import type { ProjectAuthoringSessions } from "./project-authoring-session"
import type { ProjectPreviewRegistry } from "./project-preview-registry"
import type {
  HostProjectService,
  HostSkillExecutionContext,
  HostStageBranchAdmissionContext
} from "../../harness-board/project-runtime/host-service"
import { runtimeDigest } from "../../harness-board/project-runtime/safe-files"
import { assertStageDebugPackageSupported } from "./project-stage-debug-admission"
import { assertStageBranchSourceCompatible } from "../../harness-board/project-runtime/stage-branch-compatibility"
import { readProjectSource } from "./project-source"
import { withRuntimePluginSource } from "../../plugins/runtime-source-scope"
import { readStageRecoveryPolicy } from "../../harness-board/project-runtime/stage-recovery-policy"
import {
  configureStageRecoveryHookJournal,
  StageRecoveryHookJournal,
  type StageRecoveryHookIntent,
  type StageRecoveryHookInspection
} from "../../hooks/stage-recovery-journal"
import type { HookConfig } from "../../hooks/types"
import type { RuntimePluginSourceBinding } from "../../plugins/runtime-source-scope"
import type { StageRecoveryInputAdapter } from "./stage-recovery-inputs"
import { readProjectRecoveryContext } from "../../harness-board/project-runtime/recovery-context"
import type { StageRecoveryInputSnapshot } from "./stage-recovery-inputs"
import { readPackageExtensionContract } from "../../plugins/extension-contract"

function fail(code: string): never {
  throw Error(`PROJECT_STAGE_DEBUG_${code}`)
}
export const stageDebugScopeKey = (scope: DevelopmentScope) =>
  runtimeDigest(JSON.stringify([scope.threadId, scope.workspace, scope.incarnation]))
type Scope = { scope: DevelopmentScope; guard(): void }
interface BranchRecord extends Omit<
  StageDebugBranchView,
  "status" | "diagnostics" | "currentCandidateMatches"
> {
  scopeKey: string
  draftId: string
  candidateDigest: string
  sourceVersion: number
  workspace: string
  installedPluginId: string
  stageIndex: number
  /** Provenance only. Cold inspection must also verify the current native thread incarnation. */
  creatorScope?: DevelopmentScope
  /** Historical consent only; execution additionally requires this process's live branch. */
  recoveryPolicyDigest?: string
}
interface Preparation {
  view: StageDebugPreparation
  scopeKey: string
  draftId: string
  revision: number
  sourceVersion: number
  sourceIdentity: string
  createdAt: number
  creating: boolean
}
interface Dependencies {
  root: string
  settings: AuthoringAtomicSettings
  sessions: ProjectAuthoringSessions
  registry: ProjectPreviewRegistry
  platform(): HostProjectService
  retainedRoot(project: HostProjectState): string
  assertWorkspaceIdle(workspace: string): void
  assertInspectionScope?(scope: DevelopmentScope): void
  recoveryInputs?: StageRecoveryInputAdapter
  /** Registered native adapter reads exact side-effect evidence; never runs the original Hook. */
  inspectRecoveryHook?(input: {
    intent: StageRecoveryHookIntent
    project: HostProjectState
    sourceRoot: string
    guard(): void
  }): Promise<StageRecoveryHookInspection>
}

let resolver: (() => ProjectStageDebugSessions) | undefined
/** Native application registration only. No model/renderer supplied service or authority. */
export function configureProjectStageDebugResolver(value: () => ProjectStageDebugSessions) {
  resolver = value
  configureStageRecoveryHookJournal({
    begin: (source, hook) => value().beginHookExecution(source, hook),
    unresolved: (projectId, operationId) => value().hasUnresolvedHooks(projectId, operationId)
  })
}
export function getProjectStageDebugSessions(): ProjectStageDebugSessions {
  return resolver?.() ?? fail("UNAVAILABLE")
}

/** A native adapter around the original project owner. It never executes or advances a stage. */
export class ProjectStageDebugSessions {
  private hookJournalStore?: StageRecoveryHookJournal
  private get hookJournal(): StageRecoveryHookJournal {
    return (this.hookJournalStore ??= new StageRecoveryHookJournal(this.deps.settings))
  }
  private snapshotStore?: ProjectStageSnapshots
  private get snapshots(): ProjectStageSnapshots {
    return (this.snapshotStore ??= new ProjectStageSnapshots(join(this.deps.root, "inputs")))
  }
  private readonly comparing = new Set<string>()
  private readonly preparations = new Map<string, Preparation>()
  private readonly admissions = new Map<string, { record: BranchRecord; check(): void }>()
  private readonly live = new Set<string>()
  private readonly capturingDiagnostics = new Map<string, string>()
  private readonly providerInputSnapshots = new Map<string, StageRecoveryInputSnapshot>()
  constructor(private readonly deps: Dependencies) {}

  private records(scopeKey: string): BranchRecord[] {
    const raw = this.deps.settings.getSetting(`project-stage-debug:${scopeKey}`, "[]")
    if (Buffer.byteLength(raw) > 128 * 1024) fail("STORAGE_INVALID")
    const records = JSON.parse(raw) as BranchRecord[]
    if (
      !Array.isArray(records) ||
      records.length > 64 ||
      records.some(
        (record) =>
          record.scopeKey !== scopeKey ||
          !/^[a-f0-9-]{36}$/.test(record.id) ||
          record.projectId !== record.id ||
          !/^[a-f0-9]{64}$/.test(record.snapshotId) ||
          !/^[a-f0-9]{64}$/.test(record.candidateDigest) ||
          !["stage", "downstream"].includes(record.mode) ||
          !Number.isSafeInteger(record.stageIndex)
      )
    )
      fail("STORAGE_INVALID")
    return records
  }

  private append(scopeKey: string, record: BranchRecord, guard: () => void) {
    const key = `project-stage-debug:${scopeKey}`
    const absent = "\0stage-debug-absent"
    const before = this.deps.settings.getSetting(key, absent)
    const records = this.records(scopeKey)
    if (records.length >= 64 || records.some((value) => value.id === record.id)) fail("LIMIT")
    guard()
    if (
      !this.deps.settings.compareAndSetSetting(
        key,
        before === absent ? undefined : before,
        JSON.stringify([...records, record])
      )
    )
      fail("STORAGE_CHANGED")
  }

  private persistProject(record: BranchRecord, guard: () => void) {
    guard()
    if (
      !this.deps.settings.compareAndSetSetting(
        `project-stage-debug-project:${record.projectId}`,
        undefined,
        JSON.stringify(record)
      )
    )
      fail("STORAGE_CHANGED")
  }

  /** Capture only creator-owned trials; unavailable snapshots must not break ordinary execution. */
  async beforeExecute(context: HostSkillExecutionContext & { inputIdentity: string }) {
    // Iterative edits keep the original upstream baseline, rather than building a chain of
    // branches whose imported prefix could be mistaken for independently executed evidence.
    if (this.findRecord(context.project.projectId)) return
    const scope = this.deps.registry.scopeForProject(context.project)
    if (!scope) return
    const scopeKey = stageDebugScopeKey(scope)
    try {
      const recoveryInputs = await this.deps.recoveryInputs?.capture(context)
      await this.snapshots.capture({
        scopeKey,
        project: context.project,
        operation: context.operation,
        sourceRoot: context.snapshotRoot,
        inputIdentity: context.inputIdentity,
        ...(recoveryInputs ? { recoveryInputs } : {}),
        signal: context.signal,
        guard: () => {
          context.signal.throwIfAborted()
          context.assertInputsCurrent?.()
        }
      })
      if (recoveryInputs)
        this.providerInputSnapshots.set(context.operation.operationId, recoveryInputs)
      this.capturingDiagnostics.delete(scopeKey)
    } catch (error) {
      context.signal.throwIfAborted()
      context.assertInputsCurrent?.()
      this.capturingDiagnostics.set(
        scopeKey,
        error instanceof Error ? error.message : "PROJECT_STAGE_DEBUG_SNAPSHOT_UNAVAILABLE"
      )
    }
  }

  list({ scope, guard }: Scope): Awaited<ReturnType<ProjectStageDebugApi["list"]>> {
    guard()
    const scopeKey = stageDebugScopeKey(scope)
    const api = this.deps.platform()
    const snapshots = this.snapshots.list(scopeKey).map((snapshot) => ({
      id: snapshot.id,
      projectId: snapshot.project.projectId,
      stageId: snapshot.stageId,
      stageTitle: snapshot.project.manifest.stages[snapshot.project.stageIndex].title,
      sourceDigest: snapshot.sourceDigest,
      createdAt: snapshot.createdAt,
      fileCount: snapshot.files.length,
      totalBytes: snapshot.totalBytes
    }))
    const branches = this.records(scopeKey).map((record) => {
      const project = api.get(record.projectId)
      const operations = api.operations(record.projectId, 200)
      const diagnostics: string[] = []
      diagnostics.push(`此分支固定候选摘要：${record.candidateDigest}。`)
      let currentCandidateMatches = false
      try {
        currentCandidateMatches =
          this.deps.sessions.read(scope, record.draftId).source.digest === record.candidateDigest
        if (!currentCandidateMatches)
          diagnostics.push("当前候选已修改；此处只展示历史分支结果，不能作为新版的验收。")
      } catch {
        diagnostics.push("当前候选不可读取；仅保留历史分支记录。")
      }
      let status: StageDebugBranchView["status"] = "unknown"
      if (
        project &&
        project.workspace === record.workspace &&
        project.installedPluginId === record.installedPluginId &&
        operations.length < 200
      ) {
        const stages = project.manifest.stages.slice(
          record.stageIndex,
          record.mode === "stage" ? record.stageIndex + 1 : undefined
        )
        const latest = stages.map((stage) => operations.find((value) => value.stageId === stage.id))
        const passed = stages.every((stage, index) => {
          const operation = latest[index]
          return (
            operation &&
            (record.mode === "stage"
              ? ["succeeded", "transitioned"].includes(operation.status)
              : operation.status === "transitioned" && project.status === "completed") &&
            operation.execution?.terminal?.outcome === "success" &&
            stage.checkIds.every((id) =>
              operation.receipts.some(
                (receipt) =>
                  receipt.checkId === id &&
                  receipt.operationId === operation.operationId &&
                  receipt.projectId === project.projectId &&
                  receipt.stageId === stage.id &&
                  receipt.pluginDigest === project.pluginDigest &&
                  receipt.inputFingerprint === operation.inputFingerprint &&
                  receipt.result === "passed"
              )
            )
          )
        })
        status = operations.some((operation) =>
          ["started", "cancel_requested"].includes(operation.status)
        )
          ? "running"
          : operations.some((operation) => operation.status === "unknown")
            ? "unknown"
            : passed
              ? "passed"
              : latest.some(
                    (operation) =>
                      operation?.status === "failed" || operation?.status === "cancelled"
                  )
                ? "failed"
                : "ready"
      } else diagnostics.push("调试项目或完整执行凭据不可核对。")
      if (!this.live.has(record.projectId))
        diagnostics.push("当前进程没有此分支的运行授权；历史记录不会自动恢复执行。")
      if (this.hookJournal.hasUnresolved(record.projectId)) {
        status = "unknown"
        diagnostics.push(
          "恢复 Hooks 的外部执行结果尚未确认；进程结束不证明副作用已撤回。请先由插件恢复适配器核对原操作，不能自动重跑或以已有产物补成通过。"
        )
      }
      return {
        id: record.id,
        projectId: record.projectId,
        sourceProjectId: record.sourceProjectId,
        candidateDigest: record.candidateDigest,
        currentCandidateMatches,
        snapshotId: record.snapshotId,
        stageId: record.stageId,
        mode: record.mode,
        status,
        diagnostics
      }
    })
    guard()
    return {
      snapshots,
      branches,
      diagnostics: [
        "阶段调试仅恢复受控工作区文件，不恢复数据库、网络、发布或 Git 状态。动态提供器、外部动作及不可隔离 Hooks 须由适配器明确支持。",
        ...(this.capturingDiagnostics.has(scopeKey)
          ? [this.capturingDiagnostics.get(scopeKey)!]
          : [])
      ]
    }
  }

  /** Scope-bound observation works for retained/cold history without restoring live execution. */
  async compare(
    context: Scope,
    input: { threadId: string; projectId: string }
  ): Promise<StageDebugFileComparison> {
    context.guard()
    if (input.threadId !== context.scope.threadId) fail("COMPARISON_SCOPE_CHANGED")
    const record = this.findRecord(input.projectId)
    if (!record || record.scopeKey !== stageDebugScopeKey(context.scope))
      fail("COMPARISON_SCOPE_CHANGED")
    const api = this.deps.platform()
    const project = api.get(record.projectId)
    const snapshot = this.snapshots.read(record.snapshotId, record.scopeKey)
    const source = api.get(record.sourceProjectId)
    if (
      !source ||
      source.pluginDigest !== snapshot.project.pluginDigest ||
      source.workspace !== snapshot.project.workspace ||
      source.installedPluginId !== snapshot.project.installedPluginId ||
      source.goal !== snapshot.project.goal ||
      JSON.stringify(source.manifest) !== JSON.stringify(snapshot.project.manifest)
    )
      fail("COMPARISON_SCOPE_CHANGED")
    if (
      !project ||
      project.workspace !== record.workspace ||
      project.installedPluginId !== record.installedPluginId ||
      snapshot.project.projectId !== record.sourceProjectId ||
      snapshot.stageId !== record.stageId ||
      snapshot.project.stageIndex !== record.stageIndex ||
      project.goal !== snapshot.project.goal ||
      JSON.stringify(project.manifest) !== JSON.stringify(snapshot.project.manifest)
    )
      fail("COMPARISON_SCOPE_CHANGED")
    const operations = api.operations(project.projectId, 200)
    const base = {
      projectId: record.projectId,
      snapshotId: record.snapshotId,
      candidateDigest: record.candidateDigest,
      baselineSourceDigest: snapshot.sourceDigest,
      baselineCreatedAt: snapshot.createdAt,
      observedAt: Date.now(),
      counts: { added: 0, deleted: 0, modified: 0, unchanged: 0 },
      files: [],
      diagnostics: [
        "比较相对阶段起点的当前文件内容，不证明业务检查通过，也不证明改动归属。",
        "仅比较内容摘要；重命名显示为删除和新增，不比较权限或外部系统状态，不读取正文到界面。"
      ]
    }
    if (
      operations.length >= 200 ||
      operations.some((operation) =>
        ["started", "cancel_requested", "unknown"].includes(operation.status)
      )
    )
      return {
        ...base,
        status: "unavailable",
        diagnostics: [
          ...base.diagnostics,
          "分支仍在运行、结果未知或执行记录不完整，请先在原生入口停止并核对。"
        ]
      }
    if (this.comparing.has(record.projectId) || this.comparing.size >= 2)
      return {
        ...base,
        status: "unavailable",
        diagnostics: [...base.diagnostics, "已有文件比较正在进行，请稍后手动重试。"]
      }
    const expectedRecord = JSON.stringify(record),
      expectedProject = JSON.stringify(project),
      expectedSource = JSON.stringify(source),
      expectedOperations = JSON.stringify(operations)
    const current = () => {
      context.guard()
      if (
        JSON.stringify(this.findRecord(project.projectId)) !== expectedRecord ||
        JSON.stringify(api.get(project.projectId)) !== expectedProject ||
        JSON.stringify(api.get(source.projectId)) !== expectedSource ||
        JSON.stringify(api.operations(project.projectId, 200)) !== expectedOperations
      )
        fail("COMPARISON_SCOPE_CHANGED")
      this.deps.assertWorkspaceIdle(project.workspace)
    }
    this.comparing.add(record.projectId)
    try {
      current()
      const signal = AbortSignal.timeout(5000)
      // Native retainedRoot hashes the complete pinned package against project.pluginDigest.
      // Do not resolve a released preview or substitute the mutable current creator draft.
      const branchRoot = this.deps.retainedRoot(project)
      const assertBranchPackage = capturePackageMetadataGuard(branchRoot)
      const sourceRoot = this.deps.retainedRoot(source)
      const assertSourcePackage = capturePackageMetadataGuard(sourceRoot)
      if (sourceRoot !== snapshot.sourceRoot) fail("COMPARISON_SCOPE_CHANGED")
      const pinnedCurrent = () => {
        signal.throwIfAborted()
        current()
        assertBranchPackage()
        assertSourcePackage()
        current()
      }
      pinnedCurrent()
      const baseline = await this.snapshots.inspectFiles(
        record.snapshotId,
        record.scopeKey,
        current,
        signal
      )
      pinnedCurrent()
      const after = await readBoundedProjectFiles(project.workspace, { guard: current, signal })
      pinnedCurrent()
      // Reverify the baseline after the current tree has been read; mutable store bytes are never trusted.
      await this.snapshots.inspectFiles(record.snapshotId, record.scopeKey, current, signal)
      pinnedCurrent()
      if (
        this.deps.retainedRoot(project) !== branchRoot ||
        this.deps.retainedRoot(source) !== sourceRoot
      )
        fail("COMPARISON_SCOPE_CHANGED")
      pinnedCurrent()
      return {
        ...base,
        status: "available",
        observedAt: Date.now(),
        fingerprint: after.fingerprint,
        ...compareStageDebugFiles(baseline.inventory, after)
      }
    } catch {
      context.guard()
      return {
        ...base,
        status: "unavailable",
        diagnostics: [
          ...base.diagnostics,
          "无法取得完整稳定比较：文件、来源或权限可能已变化，包含敏感路径、链接或特殊文件，或超过读取上限。未返回部分比较；请在原生记录核对后手动重试。"
        ]
      }
    } finally {
      this.comparing.delete(record.projectId)
    }
  }

  private source(snapshot: StageInputSnapshot) {
    const api = this.deps.platform()
    const project = api.get(snapshot.project.projectId)
    if (
      !project ||
      project.pluginDigest !== snapshot.sourceDigest ||
      project.workspace !== snapshot.project.workspace ||
      project.goal !== snapshot.project.goal ||
      project.installedPluginId !== snapshot.project.installedPluginId
    )
      fail("SOURCE_CHANGED")
    const operations = api.operations(project.projectId, 200)
    if (
      operations.length >= 200 ||
      operations.some((operation) =>
        ["prepared", "started", "cancel_requested", "succeeded", "unknown"].includes(
          operation.status
        )
      )
    )
      fail("SOURCE_UNSETTLED")
    this.deps.assertWorkspaceIdle(project.workspace)
    return project
  }

  /** Reject unsupported semantics rather than silently omitting original context or checks. */
  private assertSupported(root: string, project: HostProjectState, frozenInputsBound = false) {
    assertStageDebugPackageSupported(root, project.manifest, { frozenInputsBound })
  }

  async prepare(context: Scope, input: Parameters<ProjectStageDebugApi["prepare"]>[0]) {
    const { scope, guard } = context
    guard()
    const scopeKey = stageDebugScopeKey(scope)
    const snapshot = this.snapshots.read(input.snapshotId, scopeKey)
    if (snapshot.recoveryInputs) {
      if (!this.deps.recoveryInputs) fail("RECOVERY_INPUTS_UNAVAILABLE")
      await this.deps.recoveryInputs.assertCurrent(snapshot.recoveryInputs, guard)
    }
    const project = this.source(snapshot)
    if (
      this.records(scopeKey).some(
        (branch) =>
          branch.sourceProjectId === project.projectId &&
          this.hookJournal.hasUnresolved(branch.projectId)
      )
    )
      fail("RECOVERY_HOOK_OUTCOME_UNCONFIRMED")
    if (!["stage", "downstream"].includes(input.mode)) fail("MODE_INVALID")
    const candidate = this.deps.sessions.read(scope, input.draftId)
    if (candidate.revision !== input.revision || candidate.source.digest !== input.expectedDigest)
      fail("CANDIDATE_CHANGED")
    const candidateCurrent = () => {
      guard()
      const current = this.deps.sessions.read(scope, input.draftId)
      if (current.revision !== input.revision || current.source.digest !== input.expectedDigest)
        fail("CANDIDATE_CHANGED")
    }
    await this.deps.sessions.inspect(
      scope,
      candidate.id,
      candidate.revision,
      "dev",
      candidateCurrent,
      []
    )
    candidateCurrent()
    const sourceIdentity = await this.deps.platform().readDebugInputIdentity(project.projectId)
    candidateCurrent()
    if (sourceIdentity !== snapshot.inputIdentity) fail("INPUTS_CHANGED")
    this.assertSupported(snapshot.sourceRoot, project, !!snapshot.recoveryInputs)
    this.assertSupported(candidate.directory, project, !!snapshot.recoveryInputs)
    assertStageBranchSourceCompatible(
      snapshot.sourceRoot,
      candidate.directory,
      project.manifest,
      project.manifest,
      snapshot.stageId
    )
    if (this.source(snapshot).version !== project.version) fail("SOURCE_CHANGED")
    if (this.preparations.size >= 64) {
      for (const [id, preparation] of this.preparations)
        if (!preparation.creating && Date.now() - preparation.createdAt > 15 * 60 * 1000)
          this.preparations.delete(id)
      if (this.preparations.size >= 64) fail("LIMIT")
    }
    const stages = project.manifest.stages.slice(
      snapshot.project.stageIndex,
      input.mode === "stage" ? snapshot.project.stageIndex + 1 : undefined
    )
    const recovery = readStageRecoveryPolicy(candidate.directory)
    if (recovery?.hookExecution === "windows-sandbox" && process.platform !== "win32")
      fail("COMMAND_SANDBOX_UNAVAILABLE")
    const view: StageDebugPreparation = {
      id: randomUUID(),
      snapshotId: snapshot.id,
      sourceProjectId: project.projectId,
      stageId: snapshot.stageId,
      mode: input.mode,
      candidateDigest: candidate.source.digest,
      affectedStageIds: stages.map((stage) => stage.id),
      canCreate: true,
      ...(recovery
        ? {
            recovery: {
              profile: recovery.hookExecution,
              policyDigest: runtimeDigest(JSON.stringify(recovery)),
              requiresNetworkApproval: recovery.externalEffects === "network-requires-confirmation"
            }
          }
        : {}),
      diagnostics: [
        "保留原运行；使用阶段进入前的全部受控文件创建独立工作区。",
        ...(recovery
          ? [
              recovery.hookExecution === "prompt-only"
                ? "保留包声明的同步模型判定 Hooks，并以原生 Hook 路径重新执行；模型请求会消耗用量。"
                : "命令 Hooks 将以 Windows 受限令牌重跑，原试用与保留包保持只读；这不是网络隔离。必须单独确认新执行可能访问网络，外部动作无法自动撤回，结果未知时须核对。"
            ]
          : []),
        "只有目标及后续阶段未共享的 Skill 正文允许改变；共享知识、配置、Hooks 和检查契约变化须重新选择更早起点。",
        "新分支不继承旧授权、批准或检查通过结果，仍需在原生项目入口明确启动。",
        input.mode === "stage"
          ? "只运行目标阶段；推进和后续执行会被原生入口阻止。"
          : "目标及全部后续阶段均须重新执行检查和原生推进；上游文件只作为输入来源。"
      ]
    }
    this.preparations.set(view.id, {
      view,
      scopeKey,
      draftId: candidate.id,
      revision: candidate.revision,
      sourceVersion: project.version,
      sourceIdentity,
      createdAt: Date.now(),
      creating: false
    })
    return structuredClone(view)
  }

  async create(context: Scope, input: Parameters<ProjectStageDebugApi["create"]>[0]) {
    const { scope, guard } = context
    guard()
    const scopeKey = stageDebugScopeKey(scope)
    const preparation = this.preparations.get(input.preparationId)
    if (
      !preparation ||
      preparation.scopeKey !== scopeKey ||
      preparation.creating ||
      preparation.view.candidateDigest !== input.expectedDigest ||
      Date.now() - preparation.createdAt > 15 * 60 * 1000
    )
      fail("PREPARATION_EXPIRED")
    if (
      preparation.view.recovery?.requiresNetworkApproval &&
      (input.recoveryApproval?.policyDigest !== preparation.view.recovery.policyDigest ||
        input.recoveryApproval.allowNetworkSideEffects !== true)
    )
      fail("RECOVERY_APPROVAL_REQUIRED")
    preparation.creating = true
    let registered: string | undefined
    let createdProjectId: string | undefined
    let release: (() => void) | undefined
    let created = false
    try {
      const snapshot = this.snapshots.read(preparation.view.snapshotId, scopeKey)
      const source = this.source(snapshot)
      const candidate = this.deps.sessions.read(scope, preparation.draftId)
      const check = () => {
        guard()
        const current = this.deps.sessions.read(scope, preparation.draftId)
        if (
          current.source.digest !== input.expectedDigest ||
          current.revision !== preparation.revision
        )
          fail("CANDIDATE_CHANGED")
        if (this.source(snapshot).version !== preparation.sourceVersion) fail("SOURCE_CHANGED")
        this.snapshots.read(snapshot.id, scopeKey)
      }
      check()
      if (snapshot.recoveryInputs) {
        if (!this.deps.recoveryInputs) fail("RECOVERY_INPUTS_UNAVAILABLE")
        await this.deps.recoveryInputs.assertCurrent(snapshot.recoveryInputs, check)
      }
      if (
        (await this.deps.platform().readDebugInputIdentity(source.projectId)) !==
        preparation.sourceIdentity
      )
        fail("INPUTS_CHANGED")
      check()
      // Retire only a physically settled old preview registration. Source state/files are retained.
      if (this.deps.registry.projectFor(scope, candidate.id) === source.projectId)
        this.deps.registry.finish(
          source,
          scope,
          this.deps.platform().operations(source.projectId, 200)
        )
      await this.deps.sessions.inspect(scope, candidate.id, candidate.revision, "dev", check, [])
      check()
      const lease = this.deps.sessions.acquireDevelopment(
        scope,
        candidate.id,
        candidate.revision,
        guard
      )
      release = lease.release
      await this.snapshots.materialize(snapshot.id, scopeKey, lease.snapshot.workspace, check)
      check()
      const projectId = randomUUID()
      const plugin = await this.deps.registry.register({
        projectId,
        scope,
        snapshot: lease.snapshot,
        // Only the captured native creator/window identity check runs outside the child source
        // scope. The caller's file-only policy resumes before any plugin or executor is entered.
        guard: () => withRuntimePluginSource(undefined, guard),
        release: lease.release,
        actions: []
      })
      registered = plugin.id
      if (snapshot.recoveryInputs) {
        if (!this.deps.recoveryInputs) fail("RECOVERY_INPUTS_UNAVAILABLE")
        await this.deps.recoveryInputs.bind(
          snapshot.recoveryInputs,
          {
            projectId,
            workspace: lease.snapshot.workspace,
            installedPluginId: plugin.id,
            packageRoot: lease.snapshot.packagePath
          },
          check
        )
      }
      const record: BranchRecord = {
        id: projectId,
        projectId,
        scopeKey,
        sourceProjectId: source.projectId,
        snapshotId: snapshot.id,
        stageId: snapshot.stageId,
        mode: preparation.view.mode,
        draftId: candidate.id,
        candidateDigest: candidate.source.digest,
        sourceVersion: source.version,
        workspace: lease.snapshot.workspace,
        installedPluginId: plugin.id,
        stageIndex: snapshot.project.stageIndex,
        creatorScope: structuredClone(scope),
        ...(preparation.view.recovery?.requiresNetworkApproval
          ? { recoveryPolicyDigest: preparation.view.recovery.policyDigest }
          : {})
      }
      // Durable deny-by-default lineage precedes project creation. A restart or failed bind
      // cannot make an orphaned branch look like an ordinary unrestricted project.
      this.persistProject(record, check)
      this.append(scopeKey, record, check)
      this.admissions.set(snapshot.id, { record, check })
      const project = await this.deps.platform().createBranchAtStage({
        baselineId: snapshot.id,
        sourceProjectId: source.projectId,
        expectedSourceVersion: source.version,
        stageId: snapshot.stageId,
        projectId,
        name: `${candidate.name} · 阶段调试`,
        workspace: lease.snapshot.workspace,
        installedPluginId: plugin.id,
        goal: source.goal
      })
      created = true
      createdProjectId = project.projectId
      check()
      await this.deps.registry.bind(project, this.deps.retainedRoot(project))
      this.live.add(projectId)
      release = undefined
      return { projectId }
    } catch (error) {
      if (registered) {
        if (created) {
          const project = createdProjectId && this.deps.platform().get(createdProjectId)
          if (project && this.deps.registry.scopeForProject(project))
            this.deps.registry.finish(
              project,
              scope,
              this.deps.platform().operations(project.projectId, 200)
            )
          else this.deps.registry.detach(registered)
        } else this.deps.registry.abandon(registered)
        release = undefined
      }
      throw error
    } finally {
      this.admissions.delete(preparation.view.snapshotId)
      this.preparations.delete(input.preparationId)
      release?.()
    }
  }

  authorizeBranch(context: HostStageBranchAdmissionContext) {
    const admission = this.admissions.get(context.input.baselineId)
    const record = admission?.record
    if (
      !admission ||
      !record ||
      record.projectId !== context.candidate.projectId ||
      record.sourceProjectId !== context.source.projectId ||
      record.sourceVersion !== context.source.version ||
      record.workspace !== context.candidate.workspace ||
      record.installedPluginId !== context.candidate.installedPluginId ||
      record.stageId !== context.input.stageId
    )
      fail("NATIVE_CONFIRMATION_REQUIRED")
    const snapshot = this.snapshots.read(record.snapshotId, record.scopeKey)
    if (snapshot.recoveryInputs) {
      if (!this.deps.recoveryInputs) fail("RECOVERY_INPUTS_UNAVAILABLE")
      this.deps.recoveryInputs.assertBranchCurrent(record.projectId)
    }
    this.assertSupported(
      context.candidateSnapshotRoot,
      context.candidate,
      !!snapshot.recoveryInputs
    )
    admission.check()
    return { assertCurrent: admission.check }
  }

  /** Inspect pinned evidence only. This neither registers a preview nor restores a live grant. */
  async authorizeInspection(project: HostProjectState, operation: HostProjectOperation) {
    const record = this.findRecord(project.projectId)
    if (!record) return false
    const scope = record.creatorScope
    const assertScope = this.deps.assertInspectionScope
    if (!scope || !assertScope || stageDebugScopeKey(scope) !== record.scopeKey)
      fail("INSPECTION_SCOPE_CHANGED")
    const saved = this.deps.registry.retained(scope, record.draftId)
    if (
      !saved ||
      saved.projectId !== project.projectId ||
      saved.id !== record.installedPluginId ||
      saved.id !== project.installedPluginId ||
      saved.pluginDigest !== project.pluginDigest ||
      saved.packageId !== project.packageId ||
      saved.packageVersion !== project.packageVersion ||
      saved.snapshot.workspace !== record.workspace ||
      project.workspace !== record.workspace ||
      saved.snapshot.digest !== record.candidateDigest ||
      operation.projectId !== project.projectId ||
      operation.pluginDigest !== project.pluginDigest ||
      operation.expectedVersion !== project.version ||
      operation.stageId !== project.manifest.stages[project.stageIndex]?.id ||
      project.stageIndex < record.stageIndex ||
      (record.mode === "stage" && project.stageIndex !== record.stageIndex)
    )
      fail("INSPECTION_SCOPE_CHANGED")
    const snapshot = this.snapshots.read(record.snapshotId, record.scopeKey)
    const source = this.deps.platform().get(record.sourceProjectId)
    if (
      !source ||
      snapshot.project.projectId !== record.sourceProjectId ||
      snapshot.stageId !== record.stageId ||
      snapshot.project.stageIndex !== record.stageIndex ||
      source.pluginDigest !== snapshot.project.pluginDigest ||
      source.workspace !== snapshot.project.workspace ||
      source.goal !== snapshot.project.goal ||
      source.installedPluginId !== snapshot.project.installedPluginId ||
      JSON.stringify(source.manifest) !== JSON.stringify(snapshot.project.manifest) ||
      project.goal !== source.goal ||
      JSON.stringify(project.manifest) !== JSON.stringify(source.manifest)
    )
      fail("INSPECTION_SOURCE_CHANGED")
    const current = () => {
      assertScope(scope)
      if (
        JSON.stringify(this.findRecord(project.projectId)) !== JSON.stringify(record) ||
        JSON.stringify(this.deps.registry.retained(scope, record.draftId)) !==
          JSON.stringify(saved) ||
        JSON.stringify(this.deps.platform().get(project.projectId)) !== JSON.stringify(project) ||
        JSON.stringify(this.deps.platform().get(source.projectId)) !== JSON.stringify(source) ||
        JSON.stringify(
          this.deps
            .platform()
            .operations(project.projectId, 200)
            .find((value) => value.operationId === operation.operationId)
        ) !== JSON.stringify(operation)
      )
        fail("INSPECTION_SCOPE_CHANGED")
      this.deps.assertWorkspaceIdle(project.workspace)
    }
    current()
    // Both the original native package digest and the creator bundle digest must match.
    // Never read the mutable current draft or mint a replacement preview registration.
    const root = this.deps.retainedRoot(project)
    this.assertSupported(root, project, !!snapshot.recoveryInputs && !!this.deps.recoveryInputs)
    if (snapshot.recoveryInputs) {
      if (!this.deps.recoveryInputs) fail("RECOVERY_INPUTS_UNAVAILABLE")
      this.deps.recoveryInputs.assertBranchCurrent(project.projectId)
    }
    assertStageBranchSourceCompatible(
      this.deps.retainedRoot(source),
      root,
      source.manifest,
      project.manifest,
      record.stageId
    )
    const pinned = await readProjectSource(root, saved.snapshot.resourcePaths)
    current()
    if (pinned.bundle.digest !== record.candidateDigest) fail("INSPECTION_SOURCE_CHANGED")
    return { assertCurrent: current }
  }

  /** Called at every original native command; persisted lineage does not revive live execution. */
  assertCommand(project: HostProjectState, kind: string) {
    const record = this.findRecord(project.projectId)
    if (kind === "cancel") return
    if (this.hookJournal.hasUnresolved(project.projectId)) fail("RECOVERY_HOOK_OUTCOME_UNCONFIRMED")
    if (!record) return
    if (kind === "reconcile") return
    if (!this.live.has(project.projectId)) fail("RECONFIRMATION_REQUIRED")
    if (
      project.workspace !== record.workspace ||
      project.installedPluginId !== record.installedPluginId
    )
      fail("SCOPE_CHANGED")
    if (record.mode === "stage" && (kind === "advance" || project.stageIndex !== record.stageIndex))
      fail("SINGLE_STAGE_ONLY")
  }

  private findRecord(projectId: string) {
    const raw = this.deps.settings.getSetting(`project-stage-debug-project:${projectId}`, "")
    if (!raw) return undefined
    if (Buffer.byteLength(raw) > 16 * 1024) fail("STORAGE_INVALID")
    const record = JSON.parse(raw) as BranchRecord
    if (
      record.projectId !== projectId ||
      !/^[a-f0-9]{64}$/.test(record.scopeKey) ||
      !this.records(record.scopeKey).some((value) => JSON.stringify(value) === raw)
    )
      fail("STORAGE_INVALID")
    return record
  }
  /** Called only by the original Hook dispatcher holding the native source token. */
  beginHookExecution(source: Readonly<RuntimePluginSourceBinding>, hook: HookConfig) {
    const project = this.deps.platform().get(source.projectId)
    const record = project && this.findRecord(project.projectId)
    if (
      !project ||
      !record ||
      !this.live.has(project.projectId) ||
      !source.stageDebug?.commandHooks ||
      source.operationId.length > 128 ||
      source.packageDigest !== project.pluginDigest ||
      source.plugin.id !== project.installedPluginId ||
      source.stageDebug.baselineId !== record.snapshotId ||
      source.workspace !== record.workspace ||
      source.stageId !== project.manifest.stages[project.stageIndex]?.id ||
      source.plugin.path !== this.deps.retainedRoot(project)
    )
      fail("HOOK_SCOPE_CHANGED")
    const operation = this.deps
      .platform()
      .operations(project.projectId, 200)
      .find((value) => value.operationId === source.operationId)
    if (
      !operation ||
      operation.status !== "started" ||
      operation.execution?.threadId !== source.threadId ||
      operation.pluginDigest !== source.packageDigest ||
      operation.stageId !== source.stageId
    )
      fail("HOOK_SCOPE_CHANGED")
    const policy = readStageRecoveryPolicy(source.plugin.path)
    if (!policy || record.recoveryPolicyDigest !== runtimeDigest(JSON.stringify(policy)))
      fail("RECOVERY_APPROVAL_REQUIRED")
    const fingerprint = runtimeDigest(JSON.stringify(hook))
    const check = () => {
      const current = this.deps.platform().get(project.projectId)
      const latest = this.deps
        .platform()
        .operations(project.projectId, 200)
        .find((value) => value.operationId === source.operationId)
      if (
        !this.live.has(project.projectId) ||
        JSON.stringify(current) !== JSON.stringify(project) ||
        JSON.stringify(latest) !== JSON.stringify(operation)
      )
        fail("HOOK_SCOPE_CHANGED")
    }
    return this.hookJournal.begin(
      {
        projectId: project.projectId,
        operationId: source.operationId,
        threadId: source.threadId,
        baselineId: record.snapshotId,
        packageDigest: project.pluginDigest,
        stageId: source.stageId,
        policyDigest: record.recoveryPolicyDigest!,
        hookDigest: fingerprint
      },
      check
    )
  }
  hasUnresolvedHooks(projectId: string, operationId?: string): boolean {
    return this.hookJournal.hasUnresolved(projectId, operationId)
  }
  /** Native stage approval, not a guest grant or a historical branch approval. */
  async contextProviderExecution(context: HostSkillExecutionContext, threadId: string) {
    const project = this.deps.platform().get(context.project.projectId)
    const operation =
      project &&
      this.deps
        .platform()
        .operations(project.projectId, 200)
        .find((item) => item.operationId === context.operation.operationId)
    const root = project && this.deps.retainedRoot(project)
    const policy = root && readStageRecoveryPolicy(root)
    const entry = root && readPackageExtensionContract(root)?.context?.provider?.entry
    const policyDigest =
      project && runtimeDigest(JSON.stringify([project.pluginDigest, entry, policy]))
    if (
      !project ||
      !operation ||
      !root ||
      root !== context.snapshotRoot ||
      !entry ||
      !policy ||
      policy.hookExecution !== "windows-sandbox" ||
      !policy.contextProvider ||
      operation.status !== "started" ||
      operation.execution?.threadId !== threadId ||
      operation.contextProvider?.policyDigest !== policyDigest ||
      operation.approval?.decision !== "approved" ||
      operation.approval.contextProviderApproval?.policyDigest !== policyDigest ||
      operation.approval.contextProviderApproval?.allowNetworkSideEffects !== true
    )
      fail("CONTEXT_PROVIDER_APPROVAL_REQUIRED")
    context.assertInputsCurrent?.()
    const packageCurrent = capturePackageMetadataGuard(root)
    const guard = () => {
      context.signal.throwIfAborted()
      context.assertAuthorityCurrent?.()
      packageCurrent()
      if (
        JSON.stringify(this.deps.platform().get(project.projectId)) !== JSON.stringify(project) ||
        JSON.stringify(
          this.deps
            .platform()
            .operations(project.projectId, 200)
            .find((item) => item.operationId === operation.operationId)
        ) !== JSON.stringify(operation)
      )
        fail("CONTEXT_PROVIDER_SCOPE_CHANGED")
    }
    guard()
    const record = this.findRecord(project.projectId)
    let bound = record
      ? readProjectRecoveryContext(project.workspace, {
          name: project.packageId,
          version: project.packageVersion
        })
      : undefined
    let baselineId = record?.snapshotId
    if (record) this.executionPolicy(project)
    else {
      const adapter = this.deps.recoveryInputs
      if (!adapter?.prepareProviderInputs) fail("RECOVERY_INPUTS_UNAVAILABLE")
      let pointer = this.providerInputSnapshots.get(operation.operationId)
      if (!pointer) {
        pointer = await adapter.capture({
          ...context,
          inputIdentity: await this.deps.platform().readDebugInputIdentity(project.projectId)
        })
        if (!pointer) fail("CONTEXT_PROVIDER_INPUTS_UNBOUND")
        this.providerInputSnapshots.set(operation.operationId, pointer)
      }
      bound = await adapter.prepareProviderInputs(pointer, guard)
      baselineId = pointer.id
    }
    guard()
    if (!bound || !baselineId) fail("CONTEXT_PROVIDER_INPUTS_UNBOUND")
    const roots = [
      root,
      bound.directory,
      ...(bound.knowledgeRoot ? [bound.knowledgeRoot] : []),
      ...(record ? this.executionPolicy(project)!.commandHooks!.readOnlyRoots : [])
    ]
    return {
      bound,
      guard,
      commandPolicy: {
        networkAccess: "explicitly-approved" as const,
        readOnlyRoots: [...new Set(roots)]
      },
      begin: (hook: HookConfig) =>
        this.hookJournal.begin(
          {
            projectId: project.projectId,
            operationId: operation.operationId,
            threadId,
            baselineId,
            packageDigest: project.pluginDigest,
            stageId: operation.stageId,
            policyDigest: policyDigest!,
            hookDigest: runtimeDigest(JSON.stringify(hook))
          },
          guard
        )
    }
  }
  async reconcileNativeHookFacts(project: HostProjectState): Promise<void> {
    const pending = this.hookJournal
      .list(project.projectId)
      .filter((intent) => ["started", "unknown"].includes(intent.phase))
    // This hook supplements ordinary Host reconciliation only when there is actual
    // recovery evidence to inspect. It must not introduce S6 admission for other projects.
    if (!pending.length) return
    const operations = this.deps.platform().operations(project.projectId, 200)
    const root = this.deps.retainedRoot(project)
    const assertPackage = capturePackageMetadataGuard(root)
    const guard = () => {
      if (
        JSON.stringify(this.deps.platform().get(project.projectId)) !== JSON.stringify(project) ||
        JSON.stringify(this.deps.platform().operations(project.projectId, 200)) !==
          JSON.stringify(operations) ||
        operations.length >= 200 ||
        operations.some(
          (operation) =>
            ["started", "cancel_requested"].includes(operation.status) ||
            (operation.startedAt !== null && !operation.execution?.terminal)
        )
      )
        fail("SOURCE_UNSETTLED")
      this.deps.assertWorkspaceIdle(project.workspace)
      assertPackage()
    }
    guard()
    for (const intent of pending) {
      const operation = operations.find(
        (value) => value.operationId === intent.identity.operationId
      )
      const record = this.findRecord(project.projectId)
      if (
        !operation ||
        intent.identity.packageDigest !== project.pluginDigest ||
        intent.identity.threadId !== operation.execution?.threadId ||
        intent.identity.stageId !== operation.stageId ||
        ![operation.contextProvider?.policyDigest, record?.recoveryPolicyDigest].includes(
          intent.identity.policyDigest
        )
      )
        fail("HOOK_SCOPE_CHANGED")
      await this.hookJournal.reconcile(
        project.projectId,
        intent.id,
        async (current) => this.hookJournal.inspectPhysical(current),
        guard
      )
    }
  }
  async reconcileHooks(
    context: Scope,
    input: {
      threadId: string
      projectId: string
      approveNetworkInspection?: true
    }
  ) {
    context.guard()
    const record = this.findRecord(input.projectId)
    const project = this.deps.platform().get(input.projectId)
    if (
      input.threadId !== context.scope.threadId ||
      !record ||
      !project ||
      record.scopeKey !== stageDebugScopeKey(context.scope) ||
      (input.approveNetworkInspection !== undefined && input.approveNetworkInspection !== true)
    )
      fail("HOOK_SCOPE_CHANGED")
    const operations = this.deps.platform().operations(project.projectId, 200)
    if (
      operations.length >= 200 ||
      operations.some(
        (operation) =>
          ["started", "cancel_requested"].includes(operation.status) ||
          (operation.startedAt !== null &&
            (!operation.execution?.terminal ||
              operation.execution.terminal.settledAt < operation.startedAt))
      )
    )
      fail("SOURCE_UNSETTLED")
    const root = this.deps.retainedRoot(project)
    const assertPackage = capturePackageMetadataGuard(root)
    const guard = () => {
      context.guard()
      this.deps.assertWorkspaceIdle(project.workspace)
      if (
        JSON.stringify(this.deps.platform().get(project.projectId)) !== JSON.stringify(project) ||
        JSON.stringify(this.deps.platform().operations(project.projectId, 200)) !==
          JSON.stringify(operations) ||
        JSON.stringify(this.findRecord(project.projectId)) !== JSON.stringify(record)
      )
        fail("HOOK_SCOPE_CHANGED")
      assertPackage()
    }
    guard()
    const pending = this.hookJournal
      .list(project.projectId)
      .filter((intent) => ["started", "unknown"].includes(intent.phase))
    const inspector = this.deps.inspectRecoveryHook
    {
      for (const intent of pending) {
        if (
          intent.identity.packageDigest !== project.pluginDigest ||
          ![
            record.recoveryPolicyDigest,
            operations.find((operation) => operation.operationId === intent.identity.operationId)
              ?.contextProvider?.policyDigest
          ].includes(intent.identity.policyDigest)
        )
          fail("HOOK_SCOPE_CHANGED")
        await this.hookJournal.reconcile(
          project.projectId,
          intent.id,
          async (current) => {
            const physical = this.hookJournal.inspectPhysical(current)
            if (physical.outcome !== "unknown") return physical
            return inspector && input.approveNetworkInspection === true
              ? inspector({
                  intent: current,
                  project: structuredClone(project),
                  sourceRoot: root,
                  guard
                })
              : { outcome: "unknown" }
          },
          guard
        )
      }
    }
    guard()
    const remaining = this.hookJournal
      .list(project.projectId)
      .filter((intent) => ["started", "unknown"].includes(intent.phase)).length
    return {
      remaining,
      ...(remaining && inspector ? { requiresNetworkInspection: true as const } : {}),
      diagnostics: [
        remaining
          ? inspector
            ? input.approveNetworkInspection
              ? "适配器尚不能核实所有原操作；保留未知状态，禁止自动重跑。"
              : "原生回执不足，尚未调用外部检查适配器。请单独批准只读核对可能使用的网络；未知状态继续保留。"
            : "原插件尚未提供可信结果检查适配器；保留未知状态，不能以已有产物或人工声明代替外部证据。"
          : "已核对原生命令完成回执或适配器证据，不表示外部效果已撤回。本轮阶段原生未知结果仍独立保留，不继承通过或执行批准；新分支需重新准备和确认。"
      ]
    }
  }
  executionPolicy(project: HostProjectState) {
    const record = this.findRecord(project.projectId)
    if (!record) return undefined
    this.assertCommand(project, "start")
    const root = this.deps.retainedRoot(project)
    const snapshot = this.snapshots.read(record.snapshotId, record.scopeKey)
    if (snapshot.recoveryInputs) {
      if (!this.deps.recoveryInputs) fail("RECOVERY_INPUTS_UNAVAILABLE")
      this.deps.recoveryInputs.assertBranchCurrent(project.projectId)
    }
    this.assertSupported(root, project, !!snapshot.recoveryInputs)
    const recovery = readStageRecoveryPolicy(root)
    if (recovery?.hookExecution === "windows-sandbox") {
      if (
        process.platform !== "win32" ||
        record.recoveryPolicyDigest !== runtimeDigest(JSON.stringify(recovery))
      )
        fail("RECOVERY_APPROVAL_REQUIRED")
      return {
        workspace: record.workspace,
        baselineId: record.snapshotId,
        allowPromptHooks: true,
        commandHooks: {
          readOnlyRoots: [
            snapshot.sourceRoot,
            snapshot.project.workspace,
            ...(snapshot.recoveryInputs
              ? this.deps.recoveryInputs!.branchReadOnlyRoots(project.projectId)
              : [])
          ],
          networkAccess: "explicitly-approved" as const
        }
      }
    }
    return {
      workspace: record.workspace,
      baselineId: record.snapshotId,
      ...(recovery ? { allowPromptHooks: true } : {})
    }
  }

  isBranch(project: HostProjectState): boolean {
    return Boolean(this.findRecord(project.projectId))
  }

  finishOptions(project: HostProjectState | undefined) {
    return { preserveSucceeded: !!project && this.findRecord(project.projectId)?.mode === "stage" }
  }

  end(project: HostProjectState | undefined) {
    if (project) this.live.delete(project.projectId)
  }
}
