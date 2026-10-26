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
import { LegacyOperationStore } from "./legacy-operation-store"
import { HostPackageSnapshots } from "./package-snapshots"
import {
  readRuntimeScopedFile,
  runtimeDigest,
  runtimeDirectory,
  runtimeRelativePath
} from "./safe-files"
import { hostStateError } from "./host-state-protocol"
import { registerLegacyProjectEntryGate, LEGACY_PROJECT_SESSION_SCOPE,
  type LegacyBoundSkillSource } from "./legacy-entry-gate"
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

export interface LegacyResolvedThread {
  projectId: string
  featureId: string
  workspace: string
  incarnation: string
}
export interface LegacyRuntimeDependencies {
  /** Read the real durable thread binding; never accept project/feature identity from request text. */
  resolveThread(threadId: string): LegacyResolvedThread | undefined
  /** Validate project membership/workspace, then return the real currently installed enabled plugin. */
  resolvePlugin(projectId: string, workspace: string): Promise<PluginMetadata>
  /** Synchronous final fence: include original agent and Flow leases, not just this ledger. */
  assertProjectIdle(projectId: string, workspace: string): void
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
    return this.store.getBinding(projectId)
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
    work: (source: LegacyBoundSkillSource | undefined) => Promise<T>): Promise<T> {
    const binding = this.store.getBinding(projectId)
    if (!binding) return work(undefined)
    this.store.assertNotFrozen(projectId)
    const workspace = runtimeDirectory(workspaceInput)
    if (workspace !== binding.workspace) hostStateError("LEGACY_WORKSPACE_CHANGED")
    return withSnapshotRetention([this.snapshots.root], async () => {
      const assertBinding = () => {
        this.store.assertNotFrozen(projectId)
        if (JSON.stringify(this.store.getBinding(projectId)) !== JSON.stringify(binding))
          hostStateError("LEGACY_RUN_SCOPE_CHANGED")
        this.deps.assertInstalledSourceCurrent?.(projectId, workspace, binding.installedPluginId)
        this.deps.assertProjectBindingCurrent?.(projectId, workspace, binding.installedPluginId)
      }
      assertBinding()
      const installed = await this.deps.resolvePlugin(projectId, workspace)
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
        const latest = await this.deps.resolvePlugin(projectId, workspace)
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
    if (!binding) return
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
        if (!thread || !this.store.getBinding(thread.projectId)) return undefined
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
        const binding = this.store.getBinding(projectId)
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
          operation.threadId !== source.threadId ||
          operation.threadIncarnation !== source.incarnationKey
        )
          hostStateError("LEGACY_RUN_SCOPE_CHANGED")
      }, (projectId, workspace, work) => this.withBoundSkillSource(projectId, workspace, work))
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
    const binding = this.store.getBinding(thread.projectId)
    if (!binding) return undefined
    this.store.assertNotFrozen(thread.projectId)
    const featureId = thread.featureId || LEGACY_PROJECT_SESSION_SCOPE
    if (incoming.pluginSourceSnapshot) hostStateError("LEGACY_SOURCE_CONFLICT")
    if (runtimeDirectory(thread.workspace) !== binding.workspace)
      hostStateError("LEGACY_WORKSPACE_CHANGED")
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
    assertThread()
    incoming.signal?.throwIfAborted()
    const declaredContext = readPackageExtensionContract(snapshot.root)?.context
    if (declaredContext && !declaredContext.provider?.entry)
      hostStateError("LEGACY_CONTEXT_PROVIDER_REQUIRED")
    const contextInput = declaredContext
      ? {
          workspace: binding.workspace,
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
        workspace: binding.workspace,
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
              !isSameWorkspacePath(resolve(resolved.workspacePath), binding.workspace)
            )
              return "LEGACY_WORKSPACE_CHANGED"
            this.snapshots.read(binding.packageDigest)
            mods?.assertCurrent()
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
