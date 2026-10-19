import { managedBizRetryService } from "../biz-retry-service"
import { closeProjectCapabilityMcpService } from "../../mcp/capability-service"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import {
  readAutobizCompositionContracts,
  transitionAutobizComposition,
  validateAutobizCompositionAdapterDeclaration
} from "./composition-autobiz-bridge"
import { parsePluginHooks } from "../../storage"
import { preflightLegacyCompositionSource } from "./composition-legacy-preflight"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import type { AgentRunDelivery } from "../../agent/agent-run-service"
import { cancelActiveAgentRun, isAgentRunBusy } from "../../agent/agent-run-service"
import { registerInternalCompositionRunAdmission } from "../../agent/agent-run-admission"
import { getThreadCore } from "../../db"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation
} from "../../services/thread-incarnation"
import { issueRuntimePluginSourceToken } from "../../plugins/runtime-source-scope"
import { readRuntimeRequiredHooks } from "../../plugins/runtime-required-hooks"
import {
  readInternalHarnessProject,
  captureInternalHarnessProjectIdentityGuard,
  isInternalHarnessProjectId
} from "../internal-project-context"
import {
  initializeInternalHarnessProject,
  createHarnessFeature,
  getHarnessDynamicWorkflowConfig,
  getHarnessRunDetail
} from "../service"
import { startManagedRun, stopManagedRun } from "../auto-mode-controller"
import { managedRunStore } from "../managed-run-store"
import { harnessNotifications } from "../notifications"
import { projectHumanGate } from "../../../shared/harness-notifications"
import { approveHumanGate, rejectHumanGate } from "../human-gate-service"
import type { ManagedRunEvent, ManagedRunEventCursor } from "../../../shared/harness-board-types"
import type { CompositionExecutionContext } from "./composition-coordinator"
import type { CompositionLegacyDependencies } from "./composition-legacy-adapter"
import { RetainedPackageSnapshots } from "./package-snapshots"
import { readSourceHandoffContract } from "./composition-source-handoff"
import { captureLegacyCompositionInputs } from "./composition-legacy-inputs"
import { internalContextDeployUnitMappings } from "./composition-internal-projects"
import { projectRuntimeFunctionSource } from "../project-runtime-function-source"
import { readCompositionUnitContext, assertCompositionUnitContextSelection } from "./composition-unit-context"

export function createLegacyCompositionDependencies(
  input: Pick<
    CompositionLegacyDependencies,
    | "resolveSource"
    | "authorize"
    | "authorizeCancellation"
    | "assertCurrent"
    | "assertAuthorityCurrent"
    | "checkContracts"
    | "transition"
  > & {
    delivery(context: CompositionExecutionContext): AgentRunDelivery
  }
): CompositionLegacyDependencies {
  const pendingDecision: NonNullable<CompositionLegacyDependencies["pendingDecision"]> = (
    record
  ) => {
    if (!record.engineRunId) return undefined
    const observed = managedRunStore.getRun({
      projectId: record.projectId,
      featureId: record.featureId,
      runId: record.engineRunId
    })
    const snapshot = observed.snapshot
    const threadId = snapshot?.currentSession?.threadId
    if (
      observed.corrupt ||
      snapshot?.status !== "running" ||
      snapshot.runId !== record.engineRunId ||
      !threadId
    )
      return undefined
    const notification = harnessNotifications
      .pending()
      .find(
        (value) =>
          value.type === "biz_retry" &&
          value.projectId === record.projectId &&
          value.featureId === record.featureId &&
          value.runId === record.engineRunId &&
          value.sourceThreadId === threadId &&
          managedBizRetryService.isLiveDecision(value)
      )
    return notification
      ? {
          notificationId: notification.notificationId,
          message: notification.message,
          projectId: record.projectId,
          featureId: record.featureId,
          engineRunId: record.engineRunId,
          threadId
        }
      : undefined
  }
  const pendingGate: CompositionLegacyDependencies["pendingGate"] = (record) => {
    if (!record.engineRunId) return undefined
    const observed = managedRunStore.getRun({
      projectId: record.projectId,
      featureId: record.featureId,
      runId: record.engineRunId
    })
    if (
      observed.corrupt ||
      observed.snapshot?.runId !== record.engineRunId ||
      observed.snapshot.status !== "running"
    )
      return undefined
    const threadId = observed.snapshot.currentSession?.threadId
    if (!threadId) return undefined
    return harnessNotifications
      .pending()
      .map((value) => projectHumanGate(value))
      .find(
        (gate) =>
          gate?.projectId === record.projectId &&
          gate.featureId === record.featureId &&
          gate.sourceManagedRunId === record.engineRunId &&
          gate.sourceThreadId === threadId
      )
  }
  return {
    ...input,
    pendingDecision,
    decideDecision: async (record, context, decision) => {
      if (pendingDecision(record)?.notificationId !== decision.notificationId)
        throw Error("COMPOSITION_DECISION_CHANGED")
      return managedBizRetryService.resolveDecision({
        notificationId: decision.notificationId,
        choice: decision.action,
        message: decision.message,
        channel: "desktop",
        delivery: input.delivery(context)
      })
    },
    checkContracts: input.checkContracts ?? readAutobizCompositionContracts,
    transition: input.transition ?? transitionAutobizComposition,
    resolveSource: async (context) => {
      const source = await input.resolveSource(context)
      await preflightLegacyCompositionSource(source.plugin)
      await validateAutobizCompositionAdapterDeclaration(source.plugin)
      await input.authorize(context)
      const sourceContract = await readSourceHandoffContract(source.plugin.path)
      return sourceContract
        ? {
            ...source,
            goal:
              source.goal +
              `\n本版本显式声明源码交接范围：${sourceContract.scopes.join("、")}。请在这些路径中实现本次实际源码；宿主会对启动前基线与最终字节做有界比较。不要把计划、报告或模型说明当作代码，不要修改宿主交接文件。原阶段检查和人工批准仍须执行。`
          }
        : source
    },
    initialize: async (record) => {
      await initializeInternalHarnessProject(record.projectId)
    },
    createFeature: async (record) => {
      const current = () => {
        if (!readInternalHarnessProject(record.projectId)) throw Error("COMPOSITION_INTERNAL_SCOPE_CHANGED")
      }
      // New native selections are immutable. Old records without the optional field retain [] semantics.
      let selectionGuard: (() => void) | undefined
      if (record.contextSelection) {
        const source = projectRuntimeFunctionSource({ projectId: record.projectId,
          workspace: record.workspace, installedPluginId: record.plugin.id,
          packageId: record.plugin.name, pluginDigest: record.packageDigest }, record.plugin.path)
        const options = await readCompositionUnitContext({ plugin: record.plugin,
          packageDigest: record.packageDigest, workspace: record.workspace,
          configurationWorkspace: source.input.workspace, manager: source.manager,
          grantScope: source.input.scope, assertCurrent: current })
        assertCompositionUnitContextSelection(options.view, record.contextSelection)
        selectionGuard = options.assertCurrent
      }
      // Resolve config from the retained original adapter, never from renderer-supplied JSON.
      const workflowConfig = record.workflow
        ? await getHarnessDynamicWorkflowConfig(record.projectId)
        : undefined
      if (record.workflow && !workflowConfig) throw Error("COMPOSITION_WORKFLOW_UNAVAILABLE")
      await createHarnessFeature(
        {
          projectId: record.projectId,
          feature: record.featureId,
          sessionContextInjectionSource: "plugin",
          sessionWorkspace: { source: "directory", path: record.workspace },
          ...(record.contextSelection?.deployUnitIds.length ? {
            selectedDeployUnits: internalContextDeployUnitMappings(record)
          } : {}),
          ...(record.workflow ? {
            workflowTemplate: record.workflow.templateId,
            workflowNodes: record.workflow.nodeIds,
            workflowConfig: workflowConfig!
          } : {})
        },
        () => {
          current()
          selectionGuard?.()
        }
      )
      if (selectionGuard) {
        current()
        selectionGuard()
      }
    },
    start: async (record, context) => {
      const run = await startManagedRun({
        projectId: record.projectId,
        featureId: record.featureId,
        workspacePath: record.workspace,
        initialUserMessage:
          record.goal + "\n已由宿主校验的输入映射：" + JSON.stringify(context.inputs),
        delivery: input.delivery(context)
      })
      return run.runId
    },
    assertStageCheckHook: (record, hook) => {
      const original = parsePluginHooks(record.plugin).find((item) => item.id === hook.id)
      if (
        !original ||
        !original.enabled ||
        (original.type ?? "command") !== "command" ||
        original.command !== hook.command ||
        original.event !== hook.event ||
        original.shell !== hook.shell
      )
        throw Error("STAGE_CHECK_HOOK_UNVERIFIED")
    },
    stageCheckIdentity: (record, threadId) => {
      const observed = managedRunStore.findRunningRun(record.projectId, record.featureId)
      const snapshot = observed?.snapshot
      if (
        observed?.corrupt ||
        !snapshot ||
        snapshot.status !== "running" ||
        snapshot.projectId !== record.projectId ||
        snapshot.featureId !== record.featureId ||
        (snapshot.workspacePath !== undefined &&
          !isSameWorkspacePath(snapshot.workspacePath, record.workspace)) ||
        (snapshot.currentSession?.workspacePath !== undefined &&
          !isSameWorkspacePath(snapshot.currentSession.workspacePath, record.workspace)) ||
        snapshot.currentSession?.threadId !== threadId ||
        (record.engineRunId && snapshot.runId !== record.engineRunId)
      )
        return undefined
      return { engineRunId: snapshot.runId }
    },
    executionThreadIds: (record) => {
      const observed = record.engineRunId
        ? managedRunStore.getRun({
            projectId: record.projectId,
            featureId: record.featureId,
            runId: record.engineRunId
          })
        : record.phase === "starting"
          ? managedRunStore.findRunningRun(record.projectId, record.featureId)
          : undefined
      const snapshot = observed?.snapshot
      if (
        observed?.corrupt ||
        !snapshot ||
        snapshot.projectId !== record.projectId ||
        snapshot.featureId !== record.featureId ||
        snapshot.status !== "running" ||
        (snapshot.workspacePath !== undefined &&
          !isSameWorkspacePath(snapshot.workspacePath, record.workspace)) ||
        (snapshot.currentSession?.workspacePath !== undefined &&
          !isSameWorkspacePath(snapshot.currentSession.workspacePath, record.workspace))
      )
        return []
      return snapshot.currentSession?.threadId ? [snapshot.currentSession.threadId] : []
    },
    readStatus: (record) => {
      if (!record.engineRunId) throw Error("COMPOSITION_ENGINE_ID_REQUIRED")
      const observed = managedRunStore.getRun({
        projectId: record.projectId,
        featureId: record.featureId,
        runId: record.engineRunId
      })
      if (observed.corrupt || !observed.snapshot)
        throw Error("COMPOSITION_LEGACY_JOURNAL_UNHEALTHY")
      return observed.snapshot
    },
    observe: async (record) => {
      if (!record.engineRunId) throw Error("COMPOSITION_ENGINE_ID_REQUIRED")
      const identity = {
        projectId: record.projectId,
        featureId: record.featureId,
        runId: record.engineRunId
      }
      const observed = managedRunStore.getRun(identity)
      if (observed.corrupt || !observed.snapshot)
        throw Error("COMPOSITION_LEGACY_JOURNAL_UNHEALTHY")
      managedRunStore.validateRunEvents(identity)
      const events: ManagedRunEvent[] = []
      let cursor: ManagedRunEventCursor | undefined
      for (let page = 0; page < 20; page++) {
        const next = managedRunStore.listEvents(identity, cursor, 500)
        events.unshift(...next.events)
        if (!next.hasMore)
          return {
            projectId: record.projectId,
            featureId: record.featureId,
            managed: observed.snapshot,
            events,
            journalHealthy: true,
            detail: await getHarnessRunDetail(record.projectId, record.featureId, {
              scope: `composition:${record.compositionRunId}:${record.unitId}`
            })
          }
        if (!next.nextCursor || next.nextCursor === cursor) break
        cursor = next.nextCursor
      }
      throw Error("COMPOSITION_LEGACY_JOURNAL_LIMIT")
    },
    waitingReason: (record) =>
      pendingDecision(record)
        ? "原托管运行等待业务重试决策，请在此组合内处理原决策后核对恢复；这不是流程审批。"
        : undefined,
    pendingGate,
    decideGate: async (record, gateId, decision) => {
      if (pendingGate(record)?.gateId !== gateId) return false
      return (decision === "approve" ? approveHumanGate : rejectHumanGate)({
        projectId: record.projectId,
        featureId: record.featureId,
        gateId
      })
    },
    cancel: async (record) => {
      if (!record.engineRunId) return false
      const identity = {
        projectId: record.projectId,
        featureId: record.featureId,
        runId: record.engineRunId
      }
      const before = managedRunStore.getRun(identity)
      const threadId = before.snapshot?.currentSession?.threadId
      await stopManagedRun(identity)
      if (threadId) cancelActiveAgentRun(threadId)
      for (let count = 0; count < 100 && threadId && isAgentRunBusy(threadId); count++)
        await new Promise((resolve) => setTimeout(resolve, 100))
      const after = managedRunStore.getRun(identity)
      return (
        !after.corrupt &&
        after.snapshot?.status === "cancelled" &&
        (!threadId || !isAgentRunBusy(threadId))
      )
    }
  }
}

/** Original main-only internal source owner authorizes its own original managed threads. */
export function registerLegacyCompositionAdmission(): () => void {
  return registerInternalCompositionRunAdmission(async (request, incoming) => {
    const thread = getThreadCore(request.threadId)
    if (!thread) return undefined
    let metadata: Record<string, unknown>
    try {
      metadata = JSON.parse(thread.metadata ?? "{}")
    } catch {
      return undefined
    }
    if (!metadata || typeof metadata !== "object") return undefined
    const feature = metadata.harnessFeature as { projectId?: string; slug?: string } | undefined
    if (!feature?.projectId || !isInternalHarnessProjectId(feature.projectId)) return undefined
    const internal = readInternalHarnessProject(feature.projectId)
    if (
      !internal ||
      feature.slug !== internal.featureId ||
      internal.featureBinding.sessionWorkspace?.source !== "directory" ||
      metadata.workspacePath !== internal.featureBinding.sessionWorkspace.path
    )
      throw Error("COMPOSITION_INTERNAL_THREAD_CHANGED")
    const assertInternalIdentity = captureInternalHarnessProjectIdentityGuard(feature.projectId)
    const incarnation = captureThreadIncarnation(thread)
    const plugin = internal.context.plugin
    if (!plugin) throw Error("COMPOSITION_INTERNAL_SOURCE_REQUIRED")
    const digest = plugin.path.split(/[\\/]/).at(-2)!
    const snapshots = new RetainedPackageSnapshots(dirname(dirname(plugin.path)))
    const guard = await snapshots.captureGuardAsync(digest, incoming.signal)
    const inputs = await captureLegacyCompositionInputs(
      plugin, digest, String(metadata.workspacePath)
    )
    const assertOwner = () => {
      assertInternalIdentity()
      if (!matchesThreadIncarnation(getThreadCore(request.threadId), incarnation))
        throw Error("COMPOSITION_INTERNAL_THREAD_CHANGED")
      inputs?.assertAuthorityCurrent()
    }
    const assertRuntime = () => {
      incoming.signal?.throwIfAborted()
      assertOwner()
    }
    const token = issueRuntimePluginSourceToken(
      {
        mode: "legacy",
        capabilitySources: [],
        threadId: request.threadId,
        incarnationKey: JSON.stringify(incarnation),
        projectId: feature.projectId,
        featureId: internal.featureId,
        operationId: internal.ownerKind === "creator-business-trial"
          ? internal.trialId
          : internal.compositionRunId,
        stageId: "original-managed-stage",
        requiredHooks: readRuntimeRequiredHooks(plugin, { legacy: true }),
        ...(internal.ownerKind === "creator-business-trial" ? {} : {
          stagePrompt:
            "For this internal composition use project_checkpoint when available to advance original checkpoints. Supply the target checkpoint and current original state file SHA-256. Original checks and human gates remain mandatory. Do not replace this with direct state edits or a generic shell transition. Unknown transitions require user reconciliation, never replay."
        }),
        plugin,
        workspace: String(metadata.workspacePath),
        packageDigest: digest
      },
      () => {
        guard()
        inputs?.assertCurrent()
      },
      assertRuntime
    )
    const physical = { threadId: request.threadId,
      requestId: request.streamRequestId || request.userMessageId || randomUUID() }
    const creator = internal.ownerKind === "creator-business-trial" ? internal : undefined
    const finalize = async (workflowFailure?: unknown) => {
      // Close actual peers even when an owned workflow could not confirm its cleanup.
      await closeProjectCapabilityMcpService(token)
      if (workflowFailure) throw workflowFailure
      guard()
      inputs?.assertCurrent()
      // Cancellation revokes execution, while original cleanup still checks fresh owner and
      // complete contents. This read-only settlement fence never restores the runtime token.
      assertOwner()
    }
    assertRuntime()
    creator?.onPhysicalStarted?.(physical)
    return {
      context: { ...incoming, pluginSourceSnapshot: token },
      settle: async () => {
        try {
          const { deferOwnedRuntimeWorkflowSettlement } = await import("../../agent/workflow/run-manager")
          const completion = Promise.withResolvers<void>()
          const owned = deferOwnedRuntimeWorkflowSettlement(token, async failure => {
            try {
              await finalize(failure)
              completion.resolve()
            } catch (error) {
              completion.reject(error)
              throw error
            }
          })
          if (owned.deferred) {
            // An internal managed stage is a business operation, not a foreground chat turn.
            // Its original terminal receipt must include owned background cleanup.
            await completion.promise
          } else await finalize(owned.failure)
          creator?.onPhysicalSettlement?.({ ...physical, confirmed: true })
        } catch (error) {
          try { creator?.onPhysicalSettlement?.({ ...physical, confirmed: false }) }
          catch { /* Preserve the original failure; an unrecorded result cannot confirm cleanup. */ }
          throw error
        }
      }
    }
  })
}
