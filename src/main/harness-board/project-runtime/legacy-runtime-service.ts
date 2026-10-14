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
import { registerFlowRuntimeAdmission, type FlowRuntimeAdmission } from "../../mods/flows/runtime-admission"
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
import { registerLegacyProjectEntryGate, LEGACY_PROJECT_SESSION_SCOPE } from "./legacy-entry-gate"
import { captureLegacyMods } from "./legacy-mods-runtime"
import { packageUsesSharedMods } from "./package-preflight"

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
}

/** Explicit opt-in only. Original Python/Hooks own all business state and human decisions. */
export class LegacyProjectRuntimeService {
  constructor(
    private readonly store: LegacyOperationStore,
    private readonly snapshots: HostPackageSnapshots,
    private readonly deps: LegacyRuntimeDependencies
  ) {}

  async enable(projectId: string, workspaceInput: string) {
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
    if (metadata.mcpServers || readRuntimeScopedFile(snapshot.root, ".mcp.json").present)
      hostStateError("LEGACY_MCP_RUNTIME_UNSUPPORTED")
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
  }
  get(projectId: string) {
    return this.store.getBinding(projectId)
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
      })
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
    const assertThread = () => {
      if (JSON.stringify(this.deps.resolveThread(request.threadId)) !== JSON.stringify(thread))
        hostStateError("LEGACY_THREAD_CHANGED")
    }
    const mods = packageUsesSharedMods(snapshot.root, metadata)
      ? await captureLegacyMods(installed, snapshot.root, binding.workspace)
      : undefined
    if (JSON.stringify(mods?.identity ?? null) !== JSON.stringify(binding.mods))
      hostStateError("LEGACY_MODS_BINDING_CHANGED")
    assertThread()
    incoming.signal?.throwIfAborted()
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
          managedExecution: request.managedExecution ?? false
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
      },
      mods?.assertCurrent
    )
    let terminal: AgentRunTerminal | undefined
    let cancelled = false
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
          terminal ??= value
          incoming.onRunTerminated?.(value)
        }
      },
      settle: () => {
        try {
          mods?.assertCurrent()
        } catch {
          this.store.settle(admitted.ticket, "unknown", "legacy_mods_fence_changed")
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
    }
  }
}
