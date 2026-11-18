import { isSameWorkspacePath } from "../../../shared/workspace-path"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { PluginMetadata } from "../../types"
import type {
  AgentRunExecutionContext,
  AgentRunRequest,
  AgentRunTerminal
} from "../../agent/agent-run-service"
import { registerAgentRunAdmission, type AgentRunAdmission } from "../../agent/agent-run-admission"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"
import {
  registerFlowRuntimeAdmission,
  type FlowRuntimeAdmission
} from "../../mods/flows/runtime-admission"
import { DEFAULT_PLUGIN_HOOKS_PATH, readPluginManifest } from "../../plugins/manifest"
import {
  LegacyOperationStore,
  LegacyBindingGenerationError,
  legacyOperationOwner,
  legacyRecoveryRevision,
  readLegacyRecoveryInput
} from "./legacy-operation-store"
import type { LegacyProjectOperation } from "../../../shared/project-runtime/legacy-operations"
import { HostPackageSnapshots } from "./package-snapshots"
import {
  readRuntimeScopedFile,
  runtimeDigest,
  runtimeDirectory,
  runtimeDirectoryIdentity,
  runtimeRelativePath
} from "./safe-files"
import { hostStateError } from "./host-state-protocol"
import { registerLegacyProjectEntryGate, LEGACY_PROJECT_SESSION_SCOPE,
  type LegacyBoundSkillSource, type LegacyProjectWorkspaceScope } from "./legacy-entry-gate"
import { captureLegacyMods } from "./legacy-mods-runtime"
import { readRuntimeRequiredHooks } from "../../plugins/runtime-required-hooks"
import { packageUsesSharedMods } from "./package-preflight"
import { assertProjectPackageExtensions } from "../../mods/devtools/project-package-extensions"
import { closeProjectCapabilityMcpService } from "../../mcp/capability-service"
import { withSnapshotRetention } from "./snapshot-retention"
import { readPackageExtensionContract } from "../../plugins/extension-contract"
import {
  prepareProjectRuntimeInputIdentity,
  projectRuntimeInputIdentity
} from "../project-action-runtime"

export interface LegacyResolvedThread extends LegacyProjectWorkspaceScope {
  projectId: string
  workspace: string
  incarnation: string
}
export interface LegacyRuntimeDependencies {
  /** Read the real durable thread binding; never accept project/feature identity from request text. */
  resolveThread(threadId: string): LegacyResolvedThread | undefined
  /** A trusted negative index can preserve original admission when the optional ledger fails. */
  isKnownUnbound?(projectId: string): boolean
  /** Distinguish deleted history from a reused or unbound live thread during manual recovery. */
  threadExists?(threadId: string): boolean
  captureExecutionWorkspace?(
    threadId: string | undefined,
    scope: LegacyProjectWorkspaceScope & { projectId: string },
    workspace: string,
    managed: AgentRunExecutionContext["legacyManagedWorkspace"]
  ): Promise<() => void>
  /** Validate project membership/workspace, then return the real currently installed enabled plugin. */
  resolvePlugin(projectId: string, workspace: string): Promise<PluginMetadata>
  /** Synchronous final fence: include original agent and Flow leases, not just this ledger. */
  assertProjectIdle(projectId: string, workspace: string): void
  authorizeRecovery?(
    operation: LegacyProjectOperation,
    workspaces: readonly string[]
  ): Promise<{ assertCurrent(): void }>
  /** Original main-process project/installed UUID authority. Snapshot bytes remain independently pinned. */
  assertInstalledSourceCurrent?(
    projectId: string,
    workspace: string,
    installedPluginId: string
  ): void
  /** Full execution boundary: re-read the existing durable project-to-adapter binding. */
  assertProjectBindingCurrent?(
    projectId: string,
    workspace: string,
    installedPluginId: string
  ): void
}

function assertExtensions(root: string, metadata: Record<string, unknown>): boolean {
  assertProjectPackageExtensions(metadata, (path) => {
    const file = readRuntimeScopedFile(root, runtimeRelativePath(path), 256 * 1024)
    return file.bytes ? new TextDecoder("utf-8", { fatal: true }).decode(file.bytes) : undefined
  })
  return metadata.mcpServers !== undefined || readRuntimeScopedFile(root, ".mcp.json").present
}

/** Explicit opt-in only. Original Python/Hooks own all business state and human decisions. */
export class LegacyProjectRuntimeService {
  constructor(
    private readonly store: LegacyOperationStore,
    private readonly snapshots: HostPackageSnapshots,
    private readonly deps: LegacyRuntimeDependencies
  ) {}

  private getAdmissionBinding(projectId: string) {
    try {
      const binding = this.store.getBinding(projectId)
      if (!binding && this.store.protectsProject(projectId)) throw Error("PROJECT_LEGACY_BINDING_MISSING")
      return binding
    } catch (cause) {
      if (cause instanceof LegacyBindingGenerationError) throw cause
      if (!this.store.protectsProject(projectId) && this.deps.isKnownUnbound?.(projectId))
        return undefined
      throw Error("PROJECT_LEGACY_RUNTIME_UNAVAILABLE", { cause })
    }
  }

  async enable(projectId: string, workspaceInput: string) {
    return withSnapshotRetention([this.snapshots.root], async () => {
      const workspace = runtimeDirectory(workspaceInput)
      const plugin = await this.deps.resolvePlugin(projectId, workspace)
      if (!plugin.enabled) hostStateError("PLUGIN_UNAVAILABLE")
      const snapshot = this.snapshots.capture(plugin.path)
      if (snapshot.manifest.mode !== "legacy" || snapshot.manifest.stateOwner !== "plugin")
        hostStateError("OWNER_MISMATCH")
      const metadata = readPluginManifest(snapshot.root)?.manifest
      if (
        !metadata ||
        metadata.name !== snapshot.manifest.plugin.id ||
        metadata.version !== snapshot.manifest.plugin.version
      )
        hostStateError("PACKAGE_IDENTITY_MISMATCH")
      const hasMcp = assertExtensions(snapshot.root, { ...metadata })
      if (
        hasMcp &&
        (!this.deps.assertInstalledSourceCurrent || !this.deps.assertProjectBindingCurrent)
      )
        hostStateError("LEGACY_MCP_SOURCE_AUTHORITY_REQUIRED")
      this.deps.assertInstalledSourceCurrent?.(projectId, workspace, plugin.id)
      const mods = packageUsesSharedMods(snapshot.root, metadata)
        ? await captureLegacyMods(plugin, snapshot.root, workspace)
        : undefined
      const latest = await this.deps.resolvePlugin(projectId, workspace)
      if (
        !latest.enabled ||
        latest.id !== plugin.id ||
        latest.path !== plugin.path ||
        latest.version !== plugin.version
      )
        hostStateError("PACKAGE_IDENTITY_MISMATCH")
      this.deps.assertProjectIdle(projectId, workspace)
      this.deps.assertInstalledSourceCurrent?.(projectId, workspace, plugin.id)
      this.deps.assertProjectBindingCurrent?.(projectId, workspace, plugin.id)
      mods?.assertCurrent()
      return this.store.enable({
        projectId,
        workspace,
        installedPluginId: plugin.id,
        packageId: metadata.name,
        packageVersion: metadata.version!,
        packageDigest: snapshot.digest,
        mods: mods?.identity ?? null
      })
    })
  }
  get(projectId: string) {
    return this.getAdmissionBinding(projectId)
  }
  listImportSources() {
    return this.store.listBindings().map(source => ({ projectId: source.projectId,
      packageId: source.packageId, workspace: source.workspace,
      frozen: !!this.store.importFreeze(source.projectId) }))
  }
  async reviewImportSource(projectId: string) {
    if (!this.deps.assertInstalledSourceCurrent || !this.deps.assertProjectBindingCurrent)
      hostStateError("LEGACY_IMPORT_SOURCE_AUTHORITY_REQUIRED")
    const source = this.store.getBinding(projectId) ?? hostStateError("LEGACY_BINDING_MISSING")
    const installed = await this.deps.resolvePlugin(projectId, source.workspace)
    if (!installed.enabled || installed.id !== source.installedPluginId) hostStateError("PLUGIN_UNAVAILABLE")
    const snapshot = this.snapshots.read(source.packageDigest)
    const history = this.store.list(projectId, 200)
    if (history.length === 200 || history.some(operation => ["started", "unknown"].includes(operation.status)))
      hostStateError("LEGACY_OPERATION_ACTIVE")
    const historyDigest = runtimeDigest(JSON.stringify(history))
    const assertCurrent = () => {
      this.deps.assertProjectIdle(projectId, source.workspace)
      this.deps.assertInstalledSourceCurrent?.(projectId, source.workspace, source.installedPluginId)
      this.deps.assertProjectBindingCurrent?.(projectId, source.workspace, source.installedPluginId)
      this.snapshots.read(source.packageDigest)
      if (JSON.stringify(this.store.getBinding(projectId)) !== JSON.stringify(source) ||
        runtimeDigest(JSON.stringify(this.store.list(projectId, 200))) !== historyDigest)
        hostStateError("LEGACY_IMPORT_SOURCE_CHANGED")
    }
    assertCurrent()
    return { source, snapshotRoot: snapshot.root, historyDigest, assertCurrent }
  }
  importFreeze(projectId: string) { return this.store.importFreeze(projectId) }
  freezeForImport(projectId: string, reviewDigest: string, assertCurrent: () => void,
    review?: import("../../../shared/project-runtime/host-types").HostLegacyImportReview) {
    return this.store.freezeForImport(projectId, reviewDigest, assertCurrent, review)
  }
  /** Prepare exact native Skill paths before an Agent exists, without admitting a run. */
  async withBoundSkillSource<T>(projectId: string, workspaceInput: string,
    work: (source: LegacyBoundSkillSource | undefined) => Promise<T>,
    scope?: LegacyProjectWorkspaceScope): Promise<T> {
    const binding = this.getAdmissionBinding(projectId)
    if (!binding) return work(undefined)
    this.store.assertNotFrozen(projectId)
    const separateWorkspace = !isSameWorkspacePath(resolve(workspaceInput), binding.workspace)
    if (separateWorkspace && !scope) hostStateError("LEGACY_WORKSPACE_CHANGED")
    const workspace = runtimeDirectory(workspaceInput)
    const workspaceIdentity = runtimeDirectoryIdentity(workspace)
    const assertWorkspaceAuthority = separateWorkspace && scope
      ? await this.deps.captureExecutionWorkspace?.(undefined, { ...scope, projectId }, workspace, undefined)
      : undefined
    if (separateWorkspace && !assertWorkspaceAuthority) hostStateError("LEGACY_WORKSPACE_CHANGED")
    return withSnapshotRetention([this.snapshots.root], async () => {
      const assertBinding = () => {
        this.store.assertNotFrozen(projectId)
        if (JSON.stringify(this.store.getBinding(projectId)) !== JSON.stringify(binding))
          hostStateError("LEGACY_RUN_SCOPE_CHANGED")
        if (runtimeDirectoryIdentity(workspace) !== workspaceIdentity)
          hostStateError("LEGACY_WORKSPACE_CHANGED")
        assertWorkspaceAuthority?.()
        this.deps.assertInstalledSourceCurrent?.(projectId, binding.workspace, binding.installedPluginId)
        this.deps.assertProjectBindingCurrent?.(projectId, binding.workspace, binding.installedPluginId)
      }
      assertBinding()
      const installed = await this.deps.resolvePlugin(projectId, binding.workspace)
      assertBinding()
      if (!installed.enabled || installed.id !== binding.installedPluginId)
        hostStateError("PLUGIN_UNAVAILABLE")
      const installedIdentity = JSON.stringify([installed.id, installed.path, installed.name,
        installed.version, installed.enabled])
      const readSnapshot = () => {
        const snapshot = this.snapshots.read(binding.packageDigest)
        const manifest = readPluginManifest(snapshot.root)?.manifest
        if (manifest?.name !== binding.packageId || manifest?.version !== binding.packageVersion)
          hostStateError("PACKAGE_IDENTITY_MISMATCH")
        return snapshot
      }
      const snapshot = readSnapshot()
      const assertCurrent = async () => {
        assertBinding()
        const latest = await this.deps.resolvePlugin(projectId, binding.workspace)
        assertBinding()
        if (JSON.stringify([latest.id, latest.path, latest.name, latest.version, latest.enabled]) !== installedIdentity)
          hostStateError("PACKAGE_IDENTITY_MISMATCH")
        readSnapshot()
      }
      await assertCurrent()
      const result = await work({ plugin: Object.freeze({ ...installed, path: snapshot.root,
        name: binding.packageId, version: binding.packageVersion, enabled: true }), assertCurrent })
      await assertCurrent()
      return result
    })
  }
  disable(projectId: string): void {
    const binding = this.store.getBinding(projectId)
    if (!binding) {
      this.store.refreshOptInIndex()
      return
    }
    this.deps.assertProjectIdle(projectId, binding.workspace)
    this.store.disable(projectId)
  }
  operations(projectId: string, limit = 50) {
    return this.store.list(projectId, limit)
  }
  /** Pure observation. In particular, a finished managed wrapper is not a business result proof. */
  inspect(operationId: string) {
    return this.store.get(operationId)
  }
  async reconcile(raw: unknown, assertApprovalCurrent: () => void) {
    const input = readLegacyRecoveryInput(raw)
    const operation = this.store.get(input.operationId)
    if (!operation || operation.projectId !== input.projectId)
      hostStateError("LEGACY_RECOVERY_REVIEW_CHANGED")
    if (operation.reconciliation?.reviewedRevision === input.expectedRevision) return operation
    if (operation.status !== "unknown" || legacyRecoveryRevision(operation) !== input.expectedRevision)
      hostStateError("LEGACY_RECOVERY_REVIEW_CHANGED")
    if (!this.deps.authorizeRecovery || !this.deps.assertProjectBindingCurrent)
      hostStateError("LEGACY_RECOVERY_AUTHORITY_REQUIRED")
    const workspace = operation.executionWorkspace ?? operation.workspace
    const workspaceIdentity = runtimeDirectoryIdentity(workspace)
    const projectIdentity = workspace === operation.workspace
      ? workspaceIdentity : runtimeDirectoryIdentity(operation.workspace)
    const resources = await this.deps.authorizeRecovery(operation, [...new Set([operation.workspace, workspace])])
    return this.store.reconcile(input, () => {
      assertApprovalCurrent()
      this.deps.assertProjectBindingCurrent!(operation.projectId, operation.workspace, operation.installedPluginId)
      const thread = this.deps.resolveThread(operation.threadId)
      if (
        (thread && (thread.incarnation !== operation.threadIncarnation ||
          thread.projectId !== operation.projectId ||
          (thread.featureId || LEGACY_PROJECT_SESSION_SCOPE) !== operation.featureId ||
          !isSameWorkspacePath(thread.workspace, workspace))) ||
        (!thread && this.deps.threadExists?.(operation.threadId) !== false)
      ) hostStateError("LEGACY_RECOVERY_THREAD_CHANGED")
      if (
        runtimeDirectoryIdentity(workspace) !== workspaceIdentity ||
        runtimeDirectoryIdentity(operation.workspace) !== projectIdentity ||
        (operation.executionWorkspaceIdentity && operation.executionWorkspaceIdentity !== workspaceIdentity)
      ) hostStateError("LEGACY_WORKSPACE_CHANGED")
      this.deps.assertProjectIdle(operation.projectId, workspace)
      resources.assertCurrent()
    })
  }
  recoverInterrupted() {
    return this.store.recoverInterrupted()
  }

  register(): () => void {
    const stopAdmission = registerAgentRunAdmission((request, context) =>
      this.admit(request, context)
    )
    let stopGate: () => void
    let stopFlow = () => {}
    try {
      stopFlow = registerFlowRuntimeAdmission((request) => {
        const thread = this.deps.resolveThread(request.threadId)
        if (!thread || !this.getAdmissionBinding(thread.projectId)) return undefined
        if (!isSameWorkspacePath(resolve(request.workspace), runtimeDirectory(thread.workspace)))
          hostStateError("LEGACY_WORKSPACE_CHANGED")
        return this.admit(
          {
            threadId: request.threadId,
            streamRequestId: request.requestId,
            message: request.input,
            managedExecution: true
          },
          { source: "desktop" }
        ).then<FlowRuntimeAdmission | undefined>((admission) => {
          if (!admission) return undefined
          return {
            run: (work) => withRuntimePluginSource(admission.context.pluginSourceSnapshot, work),
            settle: async (run, notStarted) => {
              const unknown =
                !run ||
                run.status === "interrupted" ||
                run.attempts.some((attempt) =>
                  ["unknown", "running", "waiting"].includes(attempt.status)
                ) ||
                run.attempts.some((attempt) => attempt.status !== "skipped" && !attempt.result) ||
                ["queued", "running", "waiting"].includes(run.status)
              if (run?.status === "cancelled") admission.context.onRunCancelled?.()
              admission.context.onRunTerminated?.({
                outcome: notStarted
                  ? "error"
                  : unknown
                    ? "unknown"
                    : run?.status === "complete"
                      ? "success"
                      : "error",
                code: notStarted ? "flow_not_started" : `flow_${run?.status ?? "missing"}`
              })
              await admission.settle()
            }
          }
        })
      })
      stopGate = registerLegacyProjectEntryGate((projectId, featureId, workspace, source) => {
        const binding = this.getAdmissionBinding(projectId)
        if (!binding) return
        this.store.assertNotFrozen(projectId)
        if (
          !source ||
          source.mode !== "legacy" ||
          source.projectId !== projectId ||
          source.featureId !== featureId ||
          !isSameWorkspacePath(resolve(source.workspace), resolve(workspace)) ||
          source.packageDigest !== binding.packageDigest ||
          source.plugin.id !== binding.installedPluginId
        )
          hostStateError("LEGACY_RUN_ENTRY_REQUIRED")
        const operation = this.store.get(source.operationId)
        if (
          !operation ||
          operation.status !== "started" ||
          operation.projectId !== projectId ||
          operation.featureId !== featureId ||
          !isSameWorkspacePath(operation.executionWorkspace ?? operation.workspace, source.workspace) ||
          operation.threadId !== source.threadId ||
          operation.threadIncarnation !== source.incarnationKey
        )
          hostStateError("LEGACY_RUN_SCOPE_CHANGED")
      }, (projectId, workspace, work, scope) => this.withBoundSkillSource(projectId, workspace, work, scope))
    } catch (error) {
      stopAdmission()
      stopFlow()
      throw error
    }
    return () => {
      stopAdmission()
      stopGate()
      stopFlow()
    }
  }

  private async admit(
    request: AgentRunRequest,
    incoming: AgentRunExecutionContext
  ): Promise<AgentRunAdmission | undefined> {
    const thread = this.deps.resolveThread(request.threadId)
    if (!thread) return undefined
    const binding = this.getAdmissionBinding(thread.projectId)
    if (!binding) return undefined
    this.store.assertNotFrozen(thread.projectId)
    const featureId = thread.featureId || LEGACY_PROJECT_SESSION_SCOPE
    if (incoming.pluginSourceSnapshot) hostStateError("LEGACY_SOURCE_CONFLICT")
    const workspace = runtimeDirectory(thread.workspace)
    const workspaceIdentity = runtimeDirectoryIdentity(workspace)
    const independentWorkspace = !isSameWorkspacePath(workspace, binding.workspace)
    const assertWorkspaceAuthority = independentWorkspace
      ? await this.deps.captureExecutionWorkspace?.(request.threadId, thread, workspace,
        incoming.legacyManagedWorkspace)
      : undefined
    if (independentWorkspace && !assertWorkspaceAuthority)
      hostStateError("LEGACY_EXECUTION_WORKSPACE_NOT_REGISTERED")
    const installed = await this.deps.resolvePlugin(thread.projectId, binding.workspace)
    if (!installed.enabled || installed.id !== binding.installedPluginId)
      hostStateError("PLUGIN_UNAVAILABLE")
    const snapshot = this.snapshots.read(binding.packageDigest)
    const metadata = readPluginManifest(snapshot.root)?.manifest
    if (
      !metadata ||
      metadata.name !== binding.packageId ||
      metadata.version !== binding.packageVersion
    )
      hostStateError("PACKAGE_IDENTITY_MISMATCH")
    const hasMcp = assertExtensions(snapshot.root, { ...metadata })
    if (
      hasMcp &&
      (!this.deps.assertInstalledSourceCurrent || !this.deps.assertProjectBindingCurrent)
    )
      hostStateError("LEGACY_MCP_SOURCE_AUTHORITY_REQUIRED")
    const assertThread = () => {
      this.store.assertNotFrozen(thread.projectId)
      incoming.signal?.throwIfAborted()
      if (JSON.stringify(this.deps.resolveThread(request.threadId)) !== JSON.stringify(thread))
        hostStateError("LEGACY_THREAD_CHANGED")
      if (runtimeDirectoryIdentity(workspace) !== workspaceIdentity)
        hostStateError("LEGACY_WORKSPACE_CHANGED")
      assertWorkspaceAuthority?.()
      this.deps.assertInstalledSourceCurrent?.(
        binding.projectId,
        binding.workspace,
        binding.installedPluginId
      )
      if (JSON.stringify(this.store.getBinding(binding.projectId)) !== JSON.stringify(binding))
        hostStateError("LEGACY_RUN_SCOPE_CHANGED")
    }
    const mods = packageUsesSharedMods(snapshot.root, metadata)
      ? await captureLegacyMods(installed, snapshot.root, binding.workspace)
      : undefined
    if (JSON.stringify(mods?.identity ?? null) !== JSON.stringify(binding.mods))
      hostStateError("LEGACY_MODS_BINDING_CHANGED")
    const executionMods = mods && workspace !== binding.workspace
      ? await captureLegacyMods(installed, snapshot.root, workspace) : undefined
    if (executionMods && mods && (executionMods.identity.modId !== mods.identity.modId ||
        executionMods.identity.digest !== mods.identity.digest))
      hostStateError("LEGACY_MODS_BINDING_CHANGED")
    assertThread()
    incoming.signal?.throwIfAborted()
    const declaredContext = readPackageExtensionContract(snapshot.root)?.context
    if (declaredContext && !declaredContext.provider?.entry)
      hostStateError("LEGACY_CONTEXT_PROVIDER_REQUIRED")
    const contextInput = declaredContext
      ? {
          workspace,
          installedPluginId: binding.installedPluginId,
          packageId: binding.packageId,
          pluginDigest: binding.packageDigest,
          manifest: snapshot.manifest
        }
      : undefined
    if (contextInput) await prepareProjectRuntimeInputIdentity(contextInput, snapshot.root)
    const contextIdentity = contextInput && projectRuntimeInputIdentity(contextInput, snapshot.root)
    if (contextInput && contextIdentity === undefined) hostStateError("INPUT_IDENTITY_UNAVAILABLE")
    const assertContextCurrent = () => {
      if (
        contextInput &&
        projectRuntimeInputIdentity(contextInput, snapshot.root) !== contextIdentity
      )
        hostStateError("LEGACY_CONTEXT_INPUT_CHANGED")
    }
    assertContextCurrent()
    const hookPath = runtimeRelativePath(metadata.hooks ?? DEFAULT_PLUGIN_HOOKS_PATH)
    const admitted = this.store.admit({
      projectId: binding.projectId,
      featureId,
      workspace: binding.workspace,
      ...(independentWorkspace ? { executionWorkspace: workspace } : {}),
      executionWorkspaceIdentity: workspaceIdentity,
      owner: legacyOperationOwner,
      installedPluginId: binding.installedPluginId,
      packageDigest: binding.packageDigest,
      threadId: request.threadId,
      threadIncarnation: thread.incarnation,
      requestId: request.streamRequestId || request.userMessageId || randomUUID(),
      inputDigest: runtimeDigest(
        JSON.stringify({
          message: request.message,
          modelId: request.modelId ?? null,
          agentMode: request.agentMode ?? null,
          managedExecution: request.managedExecution ?? false,
          ...(contextIdentity === undefined ? {} : { contextIdentity })
        })
      )
    })
    const token = issueRuntimePluginSourceToken(
      {
        mode: "legacy",
        threadId: request.threadId,
        incarnationKey: thread.incarnation,
        projectId: thread.projectId,
        featureId,
        operationId: admitted.operation.operationId,
        workspace,
        packageDigest: binding.packageDigest,
        stageId: "legacy-owned",
        requiredHooks: readRuntimeRequiredHooks(
          { ...installed, path: snapshot.root, hookPath },
          { legacy: true }
        ),
        plugin: {
          ...installed,
          path: snapshot.root,
          name: binding.packageId,
          version: binding.packageVersion,
          hookPath,
          hookCount: 1,
          enabled: true
        }
      },
      () => {
        this.snapshots.read(binding.packageDigest)
        mods?.assertCurrent()
        executionMods?.assertCurrent()
        this.deps.assertProjectBindingCurrent?.(
          binding.projectId,
          binding.workspace,
          binding.installedPluginId
        )
        assertContextCurrent()
      },
      () => {
        assertThread()
        mods?.assertAuthorityCurrent()
        executionMods?.assertAuthorityCurrent()
        if (hasMcp) {
          const operation = this.store.get(admitted.operation.operationId)
          if (
            !operation ||
            operation.status !== "started" ||
            operation.threadId !== request.threadId ||
            operation.threadIncarnation !== thread.incarnation
          )
            hostStateError("LEGACY_RUN_SCOPE_CHANGED")
        }
      }
    )
    let terminal: AgentRunTerminal | undefined
    let cancelled = false
    const finalize = async (workflowFailure?: unknown) => {
      try {
        await closeProjectCapabilityMcpService(token)
      } catch {
        this.store.settle(admitted.ticket, "unknown", "legacy_mcp_cleanup_unconfirmed")
        return
      }
      if (workflowFailure) {
        this.store.settle(admitted.ticket, "unknown", "legacy_workflow_cleanup_unconfirmed")
        return
      }
      try {
        assertThread()
        this.deps.assertProjectBindingCurrent?.(
          binding.projectId,
          binding.workspace,
          binding.installedPluginId
        )
        mods?.assertCurrent()
        executionMods?.assertCurrent()
        assertContextCurrent()
      } catch {
        this.store.settle(admitted.ticket, "unknown", "legacy_runtime_inputs_changed")
        return
      }
      const outcome = terminal?.outcome
      this.store.settle(
        admitted.ticket,
        outcome === "unknown" || !terminal
          ? "unknown"
          : cancelled
            ? "cancelled"
            : outcome === "success"
              ? "succeeded"
              : "failed",
        terminal?.code ?? "original_terminal_missing"
      )
    }
    return {
      context: {
        ...incoming,
        pluginSourceSnapshot: token,
        verifyResolvedThread: (resolved) => {
          try {
            assertThread()
            if (
              !resolved.workspacePath ||
              !isSameWorkspacePath(resolve(resolved.workspacePath), workspace)
            )
              return "LEGACY_WORKSPACE_CHANGED"
            this.snapshots.read(binding.packageDigest)
            mods?.assertCurrent()
            executionMods?.assertCurrent()
            assertContextCurrent()
            return incoming.verifyResolvedThread?.(resolved) ?? null
          } catch {
            return "LEGACY_RUN_SCOPE_CHANGED"
          }
        },
        onRunCancelled: () => {
          cancelled = true
          incoming.onRunCancelled?.()
        },
        onRunTerminated: (value) => {
          if (!terminal || value.outcome === "unknown") terminal = value
          incoming.onRunTerminated?.(value)
        }
      },
      settle: async () => {
        if (hasMcp) {
          const { deferOwnedRuntimeWorkflowSettlement } = await import("../../agent/workflow/run-manager")
          const owned = deferOwnedRuntimeWorkflowSettlement(token, finalize)
          if (owned.deferred) return
          await finalize(owned.failure)
          return
        }
        await finalize()
      }
    }
  }
}
