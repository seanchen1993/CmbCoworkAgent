import type { ManagedBizRetryDecisionInput, ManagedHumanGateDecisionInput, ManagedHumanGateConflictInput } from "./notification-operation-types"
import { harnessNotifications } from "./notifications"
import { BrowserWindow } from "electron"
import { existsSync, statSync } from "fs"
import { getAllThreadSummaries, getThread } from "../db"
import type { AgentRunDelivery } from "../agent/agent-run-service"
import type { AppDecisionResult } from "../../shared/app-notifications"
import { hasActiveTopLevelAgentRun } from "../agent/agent-run-service"
import { emitAppAttention } from "../app-attention-events"
import { AsyncKeyedLock } from "../ipc/async-keyed-lock"
import { managedBizRetryService } from "./biz-retry-service"
import { readHarnessFeatureMetadata } from "./service"
import { hasPendingHumanGateForThread, interruptHumanGatesForRun } from "./human-gate-service"
import { inspectHarnessManagedFeatureStatus } from "./managed-feature-status"
import {
  createAndStartManagedHarnessSession,
  createManagedHarnessSession,
  ManagedActionValidationError,
  prepareManagedBizRetryRun,
  prepareManagedHarnessSession,
  sendManagedProviderRetry,
  startManagedHarnessSession,
  startPreparedManagedAgentRun,
  type CreateManagedHarnessSessionInput
} from "./auto-mode-action-executor"
import { managedRunStore } from "./managed-run-store"
import { formatGmt8Timestamp } from "../../shared/gmt8-time"
import {
  DEFAULT_MANAGED_RUN_POLICY,
  resolveContextUsageRatio,
  resolveManagedRunDecision,
  resolveProviderRetryPlan
} from "./managed-run-policy"
import type {
  AgentTurnEndEvent,
  ManagedRunChangeEvent,
  ManagedRunDecisionChangedField,
  ManagedRunDecisionFacts,
  ManagedRunDecisionAction,
  ManagedRunEvent,
  ManagedRunPolicyResult,
  ManagedRunSessionAction,
  ManagedRunSnapshot,
  ManagedRunStartInput,
  ManagedRunStartValidationInput,
  ManagedRunStopInput,
  ManagedRunSummary,
  ManagedRunThreadCreatedEvent
} from "../../shared/harness-board-types"

export const MANAGED_RUN_CHANGED_CHANNEL = "harnessBoard:managedRunChanged"
export const MANAGED_RUN_THREAD_CREATED_CHANNEL = "harnessBoard:managedRunThreadCreated"

export interface AutoModeAgentTurnEndInput {
  threadId: string
  outcome: AgentTurnEndEvent["outcome"]
  endReason: AgentTurnEndEvent["endReason"]
  contextUsage?: AgentTurnEndEvent["contextUsage"]
  executionFacts?: AgentTurnEndEvent["executionFacts"]
  delivery: AgentRunDelivery
}

export interface ManagedRunStartRequest extends ManagedRunStartInput {
  delivery: AgentRunDelivery
}

interface HarnessFeatureContext {
  projectId: string
  featureId: string
  runId?: string
  nodeId?: string
}

const featureLocks = new AsyncKeyedLock()
const providerRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const stopRequestedRunIds = new Set<string>()
const MANAGED_RUN_REASON_MAX_LENGTH = 1024

function featureKey(projectId: string, featureId: string): string {
  return `${projectId}\u0000${featureId}`
}

function readHarnessFeatureContext(threadId: string): HarnessFeatureContext | null {
  const thread = getThread(threadId)
  if (!thread?.metadata) return null
  try {
    const feature = readHarnessFeatureMetadata(JSON.parse(thread.metadata) as unknown)
    return feature
      ? {
          projectId: feature.projectId,
          featureId: feature.slug,
          ...(feature.runId ? { runId: feature.runId } : {}),
          ...(feature.nodeId ? { nodeId: feature.nodeId } : {})
        }
      : null
  } catch {
    return null
  }
}

export function isActiveManagedRunSession(threadId: string): boolean {
  const feature = readHarnessFeatureContext(threadId)
  if (!feature?.runId) return false
  try {
    const record = managedRunStore.getRun({
      projectId: feature.projectId,
      featureId: feature.featureId,
      runId: feature.runId
    })
    return Boolean(
      record.snapshot &&
      !record.corrupt &&
      record.snapshot.status === "running" &&
      record.snapshot.currentSession?.threadId === threadId
    )
  } catch (error) {
    console.warn("[ManagedRun] Failed to inspect active session:", { threadId, error })
    return false
  }
}

function publishManagedRunChanged(run: ManagedRunSummary): void {
  const event: ManagedRunChangeEvent = {
    projectId: run.projectId,
    featureId: run.featureId,
    run
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    try {
      window.webContents.send(MANAGED_RUN_CHANGED_CHANNEL, event)
    } catch (error) {
      console.warn("[ManagedRun] Window update failed:", error)
    }
  }
}

function publishManagedRunThreadCreated(event: ManagedRunThreadCreatedEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    try {
      window.webContents.send(MANAGED_RUN_THREAD_CREATED_CHANNEL, event)
    } catch (error) {
      console.warn("[ManagedRun] Window update failed:", error)
    }
  }
}

function hasActiveFeatureThread(projectId: string, featureId: string): boolean {
  for (const thread of getAllThreadSummaries()) {
    if (!thread.metadata) continue
    try {
      const feature = readHarnessFeatureMetadata(JSON.parse(thread.metadata) as unknown)
      if (
        feature?.projectId === projectId &&
        feature.slug === featureId &&
        hasActiveTopLevelAgentRun(thread.thread_id)
      ) {
        return true
      }
    } catch {
      // Ignore malformed metadata; it cannot be a valid V2 session.
    }
  }
  return false
}

function assertManagedRunCanStart(projectId: string, featureId: string): void {
  const existing = managedRunStore.findRunningRun(projectId, featureId)
  if (hasActiveFeatureThread(projectId, featureId)) {
    throw new Error("已有运行中的会话，无法开启托管")
  }
  if (existing?.snapshot?.status === "running") {
    throw new Error("已有运行中的托管 Run，无法开启新的托管")
  }
}

export function validateManagedRunStart(input: ManagedRunStartValidationInput): void {
  assertManagedRunCanStart(input.projectId, input.featureId)
}

function toManagedRunSessionAction(
  nextAction: NonNullable<
    Awaited<ReturnType<typeof inspectHarnessManagedFeatureStatus>>["nextAction"]
  >
): ManagedRunSessionAction {
  const slashSkill = nextAction.slashSkill?.trim() ?? ""
  const userMessage = nextAction.userMessage?.trim() ?? ""
  if (!slashSkill) {
    throw new ManagedActionValidationError(
      "next_action_missing_slash_skill",
      "当前节点的 nextAction 缺少 slashSkill"
    )
  }
  if (!userMessage) {
    throw new ManagedActionValidationError(
      "next_action_missing_user_message",
      "当前节点的 nextAction 缺少 userMessage"
    )
  }
  return { slashSkill, userMessage }
}

function lastRunSummary(run: ManagedRunSnapshot): ManagedRunSummary {
  return managedRunStore.getLatestRun(run.projectId, run.featureId) ?? run
}

function cancelProviderRetry(projectId: string, featureId: string): void {
  const key = featureKey(projectId, featureId)
  const timer = providerRetryTimers.get(key)
  if (timer) clearTimeout(timer)
  providerRetryTimers.delete(key)
}

function isManagedRunStopRequested(run: Pick<ManagedRunSnapshot, "runId">): boolean {
  return stopRequestedRunIds.has(run.runId)
}

function boundedManagedRunReason(reason: string): string {
  const normalized = reason.trim()
  return normalized.length > MANAGED_RUN_REASON_MAX_LENGTH
    ? `${normalized.slice(0, MANAGED_RUN_REASON_MAX_LENGTH - 1)}…`
    : normalized
}

type ManagedRunSourceRef = Pick<ManagedRunEvent, "eventId" | "type">

function recordManagedRunDecision(input: {
  run: ManagedRunSnapshot
  sourceEvent: ManagedRunSourceRef
  policyResult: ManagedRunPolicyResult
  decisionAction: ManagedRunDecisionAction
  summary: string
  decisionActor?: "controller" | "user" | "system"
  decisionChannel?: "system" | "desktop" | "im"
  sourceThreadId?: string
  gateId?: string
  notificationId?: string
  scope?: "global" | "stage"
}): { run: ManagedRunSnapshot; event: ManagedRunEvent } {
  const event = managedRunStore.appendEvent(input.run, {
    type: "managed_run_decision",
    scope: input.scope ?? (input.run.decisionBaseline?.nodeId ? "stage" : "global"),
    nodeId: input.run.decisionBaseline?.nodeId,
    sourceEventId: input.sourceEvent.eventId,
    sourceEventType: input.sourceEvent.type,
    policyResult: input.policyResult,
    decisionActor: input.decisionActor ?? "controller",
    decisionChannel: input.decisionChannel ?? "system",
    decisionAction: input.decisionAction,
    sourceThreadId: input.sourceThreadId,
    gateId: input.gateId,
    notificationId: input.notificationId,
    summary: input.summary
  })
  const run = managedRunStore.updateSnapshot({
    ...input.run,
    lastDecision: {
      policyResult: input.policyResult,
      decisionActor: input.decisionActor ?? "controller",
      decisionChannel: input.decisionChannel ?? "system",
      decisionAction: input.decisionAction,
      summary: input.summary,
      createTime: event.createTime
    }
  })
  return { run, event }
}

function buildManagedRunDecisionFacts(
  run: ManagedRunSnapshot,
  feature: Awaited<ReturnType<typeof inspectHarnessManagedFeatureStatus>>,
  terminal?: Pick<AgentTurnEndEvent, "outcome" | "endReason" | "contextUsage">
): ManagedRunDecisionFacts {
  const changedFields: ManagedRunDecisionChangedField[] = []
  if (run.decisionBaseline) {
    if (run.decisionBaseline.nodeId !== feature.currentNodeId) changedFields.push("currentNode")
    if (run.decisionBaseline.featureStatus !== feature.featureStatus) {
      changedFields.push("featureStatus")
    }
    if (run.decisionBaseline.nodeStatus !== feature.currentNodeStatus) {
      changedFields.push("currentNodeStatus")
    }
    if (run.decisionBaseline.nextActionHash !== feature.nextActionHash) {
      changedFields.push("nextAction")
    }
  }
  const terminalReason = terminal?.endReason.message?.trim()
  const contextUsageRatio = resolveContextUsageRatio(terminal?.contextUsage)
  return {
    currentNodeId: feature.currentNodeId,
    featureStatus: feature.featureStatus,
    currentNodeStatus: feature.currentNodeStatus,
    ...(feature.nextAction?.slashSkill
      ? { slashSkill: feature.nextAction.slashSkill.slice(0, 256) }
      : {}),
    changedFields,
    initialInspection: !run.decisionBaseline,
    ...(run.decisionBaseline?.nodeId ? { previousNodeId: run.decisionBaseline.nodeId } : {}),
    providerRetryCount: run.providerRetryCount,
    ...(terminal?.contextUsage
      ? {
          contextInputTokens: terminal.contextUsage.inputTokens,
          contextMaxTokens: terminal.contextUsage.maxTokens
        }
      : {}),
    ...(contextUsageRatio !== undefined
      ? {
          contextUsageRatio,
          contextReuseThreshold: DEFAULT_MANAGED_RUN_POLICY.maxContextReuseRatio,
          contextReusable: contextUsageRatio <= DEFAULT_MANAGED_RUN_POLICY.maxContextReuseRatio
        }
      : {}),
    ...(terminal ? { terminalOutcome: terminal.outcome } : {}),
    ...(terminalReason ? { terminalReason: boundedManagedRunReason(terminalReason) } : {})
  }
}

function scheduleProviderRetry(
  run: ManagedRunSnapshot,
  delivery: AgentRunDelivery,
  decisionEventId: string
): void {
  if (isManagedRunStopRequested(run)) return
  const retryNumber = run.providerRetryCount + 1
  const retryPlan = resolveProviderRetryPlan(run.providerRetryCount)
  if (!retryPlan || !run.currentSession?.threadId || !run.decisionBaseline?.nodeId) {
    void markTerminal(
      run,
      "failed",
      "模型服务重试已达到上限",
      "run_failed",
      decisionEventId,
      "provider_retry_limit_exceeded"
    )
    return
  }
  cancelProviderRetry(run.projectId, run.featureId)
  const delayMs = retryPlan.delayMs
  const nextRetryAt = formatGmt8Timestamp(new Date(Date.now() + delayMs))
  const persisted = managedRunStore.updateSnapshot(
    {
      ...run,
      status: "running",
      providerRetryCount: retryNumber,
      nextRetryAt
    },
    {
      type: "provider_retry_scheduled",
      scope: "stage",
      nodeId: run.decisionBaseline.nodeId,
      threadId: run.currentSession.threadId,
      decisionEventId,
      retryNumber,
      retryAt: nextRetryAt,
      delayMs,
      reasonCode: `provider_error_${retryNumber}_of_3`,
      summary: `${delayMs / 1000} 秒后在原会话自动发送“继续当前任务”`
    }
  )
  publishManagedRunChanged(lastRunSummary(persisted))
  const key = featureKey(run.projectId, run.featureId)
  providerRetryTimers.set(
    key,
    setTimeout(() => {
      providerRetryTimers.delete(key)
      void processProviderRetry(persisted, delivery).catch((error) => {
        console.warn("[ManagedRun] Provider retry failed:", error)
      })
    }, delayMs)
  )
}

function reschedulePendingProviderRetry(
  scheduledRun: ManagedRunSnapshot,
  delivery: AgentRunDelivery
): void {
  const key = featureKey(scheduledRun.projectId, scheduledRun.featureId)
  cancelProviderRetry(scheduledRun.projectId, scheduledRun.featureId)
  providerRetryTimers.set(
    key,
    setTimeout(() => {
      providerRetryTimers.delete(key)
      void processProviderRetry(scheduledRun, delivery).catch((error) => {
        console.warn("[ManagedRun] Provider retry reschedule failed:", error)
      })
    }, 1_000)
  )
}

async function processProviderRetry(
  scheduledRun: ManagedRunSnapshot,
  delivery: AgentRunDelivery
): Promise<void> {
  await featureLocks.withKey(
    featureKey(scheduledRun.projectId, scheduledRun.featureId),
    async () => {
      const record = managedRunStore.getRun(scheduledRun)
      if (
        !record.snapshot ||
        record.corrupt ||
        record.snapshot.status !== "running" ||
        record.snapshot.nextRetryAt !== scheduledRun.nextRetryAt ||
        isManagedRunStopRequested(record.snapshot)
      )
        return
      if (hasActiveFeatureThread(scheduledRun.projectId, scheduledRun.featureId)) {
        reschedulePendingProviderRetry(scheduledRun, delivery)
        return
      }

      let feature: Awaited<ReturnType<typeof inspectHarnessManagedFeatureStatus>>
      const sourceEvent = managedRunStore.appendEvent(record.snapshot, {
        type: "provider_retry_timer_elapsed",
        scope: "stage",
        nodeId: record.snapshot.decisionBaseline?.nodeId,
        threadId: record.snapshot.currentSession?.threadId,
        retryNumber: record.snapshot.providerRetryCount,
        summary: "模型服务重试等待时间已到"
      })
      try {
        feature = await inspectHarnessManagedFeatureStatus(
          scheduledRun.projectId,
          scheduledRun.featureId
        )
      } catch (error) {
        const failure = recordManagedRunDecision({
          run: record.snapshot,
          sourceEvent,
          policyResult: {
            type: "provider_retry",
            proposedAction: "fail_managed_run",
            reasonCode: "feature_inspection_failed"
          },
          decisionAction: "fail_managed_run",
          summary: "模型服务重试前无法检查 Feature 状态"
        })
        await markTerminal(
          failure.run,
          "failed",
          error instanceof Error ? error.message : String(error),
          "run_failed",
          failure.event.eventId,
          "feature_inspection_failed"
        )
        return
      }
      if (isManagedRunStopRequested(record.snapshot)) return
      const inspectedDecision = resolveManagedRunDecision({
        run: record.snapshot,
        feature,
        terminal: {
          outcome: "error",
          endReason: { code: "provider_error" }
        }
      })
      if (inspectedDecision.policyResult.type !== "provider_retry") {
        const running = managedRunStore.updateSnapshot({
          ...record.snapshot,
          status: "running",
          nextRetryAt: undefined
        })
        await inspectAndLaunch(running, delivery, sourceEvent)
        return
      }
      const currentThreadId = record.snapshot.currentSession?.threadId
      if (!currentThreadId) {
        const missing = recordManagedRunDecision({
          run: record.snapshot,
          sourceEvent,
          policyResult: {
            type: "provider_retry",
            proposedAction: "fail_managed_run",
            reasonCode: "missing_current_thread"
          },
          decisionAction: "fail_managed_run",
          summary: "模型服务重试缺少来源会话"
        })
        await markTerminal(
          missing.run,
          "failed",
          "模型服务重试缺少来源会话",
          "run_failed",
          missing.event.eventId,
          "missing_current_thread"
        )
        return
      }

      const retryDecision = recordManagedRunDecision({
        run: { ...record.snapshot, status: "running", nextRetryAt: undefined },
        sourceEvent,
        policyResult: {
          type: "provider_retry",
          proposedAction: "continue_current_thread",
          reasonCode: `provider_error_${record.snapshot.providerRetryCount}_of_3`,
          facts: buildManagedRunDecisionFacts(record.snapshot, feature)
        },
        decisionAction: "continue_current_thread",
        summary: "在原会话继续模型服务重试",
        sourceThreadId: currentThreadId
      })
      const running = retryDecision.run
      if (isManagedRunStopRequested(running)) return
      try {
        await sendManagedProviderRetry(currentThreadId, delivery)
        const published = managedRunStore.updateSnapshot(running, {
          type: "session_continued",
          scope: "stage",
          nodeId: feature.currentNodeId,
          targetThreadId: currentThreadId,
          decisionEventId: retryDecision.event.eventId,
          summary: "已在原会话发送模型服务重试消息"
        })
        publishManagedRunChanged(lastRunSummary(published))
      } catch (error) {
        await markTerminal(
          running,
          "failed",
          error instanceof Error ? error.message : String(error),
          "run_failed",
          retryDecision.event.eventId,
          "provider_retry_action_failed"
        )
      }
    }
  )
}

async function markTerminal(
  run: ManagedRunSnapshot,
  status: "cancelled" | "failed" | "completed",
  reason: string,
  eventType: "run_cancelled" | "run_failed" | "run_completed",
  decisionEventId: string | undefined,
  reasonCode?: string,
  decisionNotificationId?: string
): Promise<void> {
  cancelProviderRetry(run.projectId, run.featureId)
  const now = formatGmt8Timestamp()
  const persistedReason = boundedManagedRunReason(reason)
  const next: ManagedRunSnapshot = {
    ...run,
    status,
    ...(status === "cancelled"
      ? { cancellationReason: persistedReason, nextRetryAt: undefined }
      : {}),
    ...(status === "failed" ? { failureReason: persistedReason, nextRetryAt: undefined } : {}),
    ...(status === "completed" ? { completedAt: now, nextRetryAt: undefined } : {})
  }
  const persisted = managedRunStore.updateSnapshot(next)
  // Release stale input guards even if subsequent notification persistence fails.
  managedBizRetryService.removeRunNotifications(run.runId, decisionNotificationId)
  try {
    if (decisionEventId) {
      managedRunStore.appendEvent(persisted, {
        type: eventType,
        scope: "global",
        nodeId: next.decisionBaseline?.nodeId,
        decisionEventId,
        ...(reasonCode ? { reasonCode } : {}),
        summary: persistedReason
      })
    }
  } catch (error) {
    console.warn("[ManagedRun] Terminal state saved but journal write failed:", error)
  }
  interruptHumanGatesForRun(run.runId)
  harnessNotifications.invalidateRun(run.runId, decisionNotificationId)
  stopRequestedRunIds.delete(next.runId)
  publishManagedRunChanged(lastRunSummary(persisted))
}

async function inspectAndLaunch(
  run: ManagedRunSnapshot,
  delivery: AgentRunDelivery,
  sourceEvent: ManagedRunSourceRef,
  terminal?: Pick<AgentTurnEndEvent, "outcome" | "endReason" | "contextUsage">,
  initialUserMessage?: string
): Promise<void> {
  if (isManagedRunStopRequested(run)) return
  const feature = await inspectHarnessManagedFeatureStatus(run.projectId, run.featureId)
  if (isManagedRunStopRequested(run)) return
  const evaluation = resolveManagedRunDecision({
    run,
    feature,
    terminal
  })
  const decisionFacts = buildManagedRunDecisionFacts(run, feature, terminal)
  const policyResult: ManagedRunPolicyResult = {
    ...evaluation.policyResult,
    facts: decisionFacts
  }
  if (
    policyResult.type === "biz_retry" &&
    (policyResult.proposedAction === "continue_current_thread" ||
      policyResult.proposedAction === "start_new_thread")
  ) {
    const waitingForDecision = await managedBizRetryService.request({
      run,
      sourceEvent,
      policyResult,
      summary: evaluation.summary,
      delivery,
      stageName: feature.currentNodeId,
      nextAction: feature.nextAction ? toManagedRunSessionAction(feature.nextAction) : undefined
    })
    if (waitingForDecision) return
    throw new Error("托管运行缺少当前会话，无法创建人工决策")
  }
  const decision = recordManagedRunDecision({
    run,
    sourceEvent,
    policyResult,
    decisionAction: policyResult.proposedAction as ManagedRunDecisionAction,
    summary: evaluation.summary,
    sourceThreadId: run.currentSession?.threadId
  })
  const decidedRun = decision.run

  if (policyResult.proposedAction === "complete_managed_run") {
    await markTerminal(
      decidedRun,
      "completed",
      evaluation.summary,
      "run_completed",
      decision.event.eventId,
      policyResult.reasonCode
    )
    return
  }
  if (policyResult.proposedAction === "fail_managed_run") {
    await markTerminal(
      decidedRun,
      "failed",
      evaluation.summary,
      "run_failed",
      decision.event.eventId,
      policyResult.reasonCode
    )
    return
  }
  if (policyResult.proposedAction === "schedule_provider_retry") {
    if (!resolveProviderRetryPlan(decidedRun.providerRetryCount)) {
      await markTerminal(
        decidedRun,
        "failed",
        "模型服务重试已达到上限",
        "run_failed",
        decision.event.eventId,
        "provider_retry_limit_exceeded"
      )
      return
    }
    scheduleProviderRetry(decidedRun, delivery, decision.event.eventId)
    return
  }

  if (!feature.nextAction) {
    await markTerminal(
      decidedRun,
      "failed",
      "当前节点没有可执行的 nextAction",
      "run_failed",
      decision.event.eventId
    )
    return
  }

  const nextAction = toManagedRunSessionAction(feature.nextAction)
  if (initialUserMessage?.trim()) {
    nextAction.userMessage = initialUserMessage.trim()
  }
  const workspacePath = decidedRun.workspacePath?.trim()
  if (!workspacePath) {
    await markTerminal(
      decidedRun,
      "failed",
      "当前托管 Run 没有已确认的会话工作区",
      "run_failed",
      decision.event.eventId
    )
    return
  }
  const sessionInput: CreateManagedHarnessSessionInput = {
    projectId: decidedRun.projectId,
    featureId: decidedRun.featureId,
    runId: decidedRun.runId,
    nodeId: feature.currentNodeId,
    nextAction,
    workspacePath,
    delivery
  }
  if (isManagedRunStopRequested(decidedRun)) return
  try {
    const created = await createAndStartManagedHarnessSession(sessionInput)
    const advancesStage = policyResult.type === "biz_progress"
    const persisted = managedRunStore.updateSnapshot(
      {
        ...decidedRun,
        status: "running",
        currentSession: {
          threadId: created.threadId
        },
        decisionBaseline: {
          nodeId: feature.currentNodeId,
          featureStateHash: feature.featureStateHash,
          featureStatus: feature.featureStatus,
          nodeStatus: feature.currentNodeStatus,
          nextActionHash: feature.nextActionHash
        },
        providerRetryCount:
          terminal?.outcome === "success" || advancesStage ? 0 : decidedRun.providerRetryCount,
        nextRetryAt: undefined
      },
      {
        type: "session_created",
        scope: "stage",
        nodeId: feature.currentNodeId,
        targetThreadId: created.threadId,
        decisionEventId: decision.event.eventId,
        summary: evaluation.summary
      }
    )
    managedRunStore.appendEvent(persisted, {
      type: "session_started",
      scope: "stage",
      nodeId: feature.currentNodeId,
      targetThreadId: created.threadId,
      decisionEventId: decision.event.eventId,
      summary: "托管运行的普通项目会话已启动"
    })
    publishManagedRunThreadCreated({
      projectId: decidedRun.projectId,
      featureId: decidedRun.featureId,
      runId: decidedRun.runId,
      threadId: created.threadId,
      thread: created.thread
    })
    publishManagedRunChanged(lastRunSummary(persisted))
  } catch (error) {
    await markTerminal(
      decidedRun,
      "failed",
      error instanceof Error ? error.message : String(error),
      "run_failed",
      decision.event.eventId,
      error instanceof ManagedActionValidationError ? error.reasonCode : "platform_action_failed"
    )
  }
}

export async function startManagedRun(input: ManagedRunStartRequest): Promise<ManagedRunSummary> {
  return featureLocks.withKey(featureKey(input.projectId, input.featureId), async () => {
    const workspacePath = typeof input.workspacePath === "string" ? input.workspacePath.trim() : ""
    if (!workspacePath) {
      throw new Error("请选择本次托管使用的会话工作区")
    }
    let workspaceDirectoryExists = false
    try {
      workspaceDirectoryExists = existsSync(workspacePath) && statSync(workspacePath).isDirectory()
    } catch {
      workspaceDirectoryExists = false
    }
    if (!workspaceDirectoryExists) {
      throw new Error("所选会话工作区不存在或不是文件夹")
    }
    assertManagedRunCanStart(input.projectId, input.featureId)

    const created = managedRunStore.createRun(input.projectId, input.featureId, workspacePath)
    const sourceEvent = managedRunStore.appendEvent(created, {
      type: "run_started",
      scope: "global",
      summary: "用户确认开启托管运行"
    })
    publishManagedRunChanged(lastRunSummary(created))
    try {
      await inspectAndLaunch(
        created,
        input.delivery,
        sourceEvent,
        undefined,
        input.initialUserMessage
      )
    } catch (error) {
      const failed = recordManagedRunDecision({
        run: created,
        sourceEvent,
        policyResult: {
          type: "run_termination",
          proposedAction: "fail_managed_run",
          reasonCode: "managed_run_start_failed"
        },
        decisionAction: "fail_managed_run",
        summary: "托管运行启动失败"
      })
      await markTerminal(
        failed.run,
        "failed",
        error instanceof Error ? error.message : String(error),
        "run_failed",
        failed.event.eventId,
        "managed_run_start_failed"
      )
    }
    return lastRunSummary(created)
  })
}

export async function stopManagedRun(input: ManagedRunStopInput): Promise<boolean> {
  const active = managedRunStore.findRunningRun(input.projectId, input.featureId)
  if (active?.snapshot?.status !== "running" || active.snapshot.runId !== input.runId) {
    return false
  }
  stopRequestedRunIds.add(input.runId)
  cancelProviderRetry(input.projectId, input.featureId)

  return featureLocks.withKey(featureKey(input.projectId, input.featureId), async () => {
    const current = managedRunStore.findRunningRun(input.projectId, input.featureId)
    if (current?.snapshot?.status !== "running" || current.snapshot.runId !== input.runId) {
      stopRequestedRunIds.delete(input.runId)
      return false
    }
    const sourceEvent = managedRunStore.appendEvent(current.snapshot, {
      type: "run_stop_requested",
      scope: "global",
      summary: "用户请求停止托管运行"
    })
    const stopped = recordManagedRunDecision({
      run: current.snapshot,
      sourceEvent,
      policyResult: {
        type: "run_termination",
        proposedAction: "stop_managed_run",
        reasonCode: "user_stop_requested"
      },
      decisionActor: "user",
      decisionChannel: "desktop",
      decisionAction: "stop_managed_run",
      summary: "用户停止托管运行",
      scope: "global"
    })
    await markTerminal(
      stopped.run,
      "cancelled",
      "用户停止托管模式，已有会话继续运行但不再自动推进",
      "run_cancelled",
      stopped.event.eventId,
      "user_stop_requested"
    )
    return true
  })
}

function finishManagedBizRetryDecision(input: ManagedBizRetryDecisionInput): boolean {
  return harnessNotifications.finish(input.decisionId, {
    status: "resolved",
    action: input.choice,
    channel: input.channel,
    reasonCode: "user_decision",
    result:
      input.choice === "stop"
        ? "已退出托管"
        : input.choice === "continue"
          ? "已在当前会话继续"
          : "已在新会话继续"
  })
}

/** The action already succeeded: notification or journal failures must never trigger a retry. */
function reportManagedBizRetryCompletionFailure(
  input: ManagedBizRetryDecisionInput,
  error: unknown
): AppDecisionResult {
  managedBizRetryService.removeNotification(input.decisionId)
  console.warn("[ManagedRun] Biz Retry completion failed:", error)
  try {
    if (!finishManagedBizRetryDecision(input)) {
      console.warn("[ManagedRun] Biz Retry notification already ended:", input.decisionId)
      return {
        applied: true,
        message: "本次操作已执行，但决策通知已由其他路径结束，请查看托管状态，不要重复执行。"
      }
    }
  } catch (notificationError) {
    console.warn("[ManagedRun] Failed to finish Biz Retry notification:", notificationError)
  }
  return {
    applied: true,
    message: "操作已执行，但后续记录或通知更新失败，请查看托管状态，不要重复执行。"
  }
}

/** Called only after thread creation or message submission has begun. */
async function failManagedBizRetryDecision(
  input: ManagedBizRetryDecisionInput,
  run: ManagedRunSnapshot,
  error: unknown
): Promise<AppDecisionResult> {
  managedBizRetryService.removeNotification(input.decisionId)
  stopRequestedRunIds.add(run.runId)
  console.warn("[ManagedRun] Biz Retry action failed:", error)
  const reason = `人工决策执行中断，已停止自动推进，请检查已有会话：${error instanceof Error ? error.message : String(error)}`
  let failedRun = run
  let decisionEventId: string | undefined
  try {
    const failed = recordManagedRunDecision({
      run,
      sourceEvent: input.sourceEvent,
      policyResult: {
        type: "run_termination",
        proposedAction: "fail_managed_run",
        reasonCode: "biz_retry_action_failed"
      },
      decisionAction: "fail_managed_run",
      notificationId: input.decisionId,
      sourceThreadId: input.originThreadId,
      summary: reason
    })
    failedRun = failed.run
    decisionEventId = failed.event.eventId
  } catch (journalError) {
    console.warn("[ManagedRun] Failed to record interrupted Biz Retry:", journalError)
  }
  let failureSaved = false
  try {
    await markTerminal(
      failedRun,
      "failed",
      reason,
      "run_failed",
      decisionEventId,
      "biz_retry_action_failed",
      input.decisionId
    )
    failureSaved = true
  } catch (failureError) {
    console.warn("[ManagedRun] Failed to save interrupted Biz Retry:", failureError)
  }
  try {
    if (
      !harnessNotifications.finish(input.decisionId, {
        status: "invalidated",
        channel: "system",
        reasonCode: "biz_retry_action_failed",
        result: "决策执行中断，已有会话保留，请检查后重新开始托管。"
      })
    ) {
      console.warn(
        "[ManagedRun] Interrupted Biz Retry notification already ended:",
        input.decisionId
      )
    }
  } catch (notificationError) {
    console.warn("[ManagedRun] Failed to finish Biz Retry notification:", notificationError)
  }
  return {
    applied: false,
    message: failureSaved
      ? "决策执行中断，本次托管已停止；已有会话保留，请检查后重新开始托管。"
      : "决策执行中断，自动推进已暂停，但状态保存失败；请检查已有会话和存储状态，不要重复执行。"
  }
}

export async function resolveManagedBizRetryDecision(
  input: ManagedBizRetryDecisionInput
): Promise<{ applied: boolean; message: string }> {
  return featureLocks.withKey(featureKey(input.projectId, input.featureId), async () => {
    const notification = harnessNotifications.get(input.decisionId)
    if (
      !notification ||
      notification.status !== "pending" ||
      (input.channel === "im" && notification.disabledTargets?.im)
    ) {
      return { applied: false, message: "该决策已处理或已失效。" }
    }
    const record = managedRunStore.getRun(input)
    if (!record.snapshot || record.corrupt || record.snapshot.status !== "running") {
      void harnessNotifications.finish(input.decisionId, {
        status: "invalidated",
        channel: "system",
        reasonCode: "managed_run_ended",
        result: "托管运行已结束"
      })
      return { applied: false, message: "该托管运行已结束，操作未执行。" }
    }
    const run = record.snapshot
    if (input.choice !== "stop" && isManagedRunStopRequested(run)) {
      return { applied: false, message: "托管运行正在停止，请等待结束。" }
    }
    const channelLabel = input.channel === "im" ? "招乎" : "APP"
    if (
      input.choice !== "stop" &&
      harnessNotifications
        .pending()
        .some(
          (item) =>
            item.type === "human_gate" &&
            item.projectId === input.projectId &&
            item.featureId === input.featureId
        )
    )
      return { applied: false, message: "请先处理 Human Gate，再继续托管。" }
    if (input.choice !== "stop" && hasActiveFeatureThread(input.projectId, input.featureId)) {
      return { applied: false, message: "该特性仍有会话正在执行，请等待结束后再决策。" }
    }
    if (input.choice === "stop") {
      const decision = recordManagedRunDecision({
        run,
        sourceEvent: input.sourceEvent,
        policyResult: input.policyResult,
        decisionActor: "user",
        decisionChannel: input.channel,
        notificationId: input.decisionId,
        decisionAction: "stop_managed_run",
        summary: `用户通过${channelLabel}停止托管运行`,
        sourceThreadId: input.originThreadId,
        scope: "global"
      })
      try {
        await markTerminal(
          decision.run,
          "cancelled",
          `用户通过${channelLabel}停止托管运行`,
          "run_cancelled",
          decision.event.eventId,
          input.policyResult.reasonCode,
          input.decisionId
        )
      } catch (error) {
        // Cancellation may be durable even if its notification cleanup failed.
        try {
          if (managedRunStore.getRun(input).snapshot?.status === "cancelled") {
            return reportManagedBizRetryCompletionFailure(input, error)
          }
        } catch (readError) {
          console.warn("[ManagedRun] Failed to read Biz Retry cancellation:", readError)
        }
        return failManagedBizRetryDecision(input, decision.run, error)
      }
      try {
        if (!finishManagedBizRetryDecision(input)) {
          throw new Error("托管已停止，但决策通知已被其他路径结束")
        }
      } catch (error) {
        return reportManagedBizRetryCompletionFailure(input, error)
      }
      return { applied: true, message: "托管运行已停止" }
    }

    if (input.choice === "continue") {
      if (
        run.currentSession?.threadId !== input.originThreadId ||
        !getThread(input.originThreadId)
      ) {
        return {
          applied: false,
          message: "来源会话已删除或不再是当前托管会话；可选择开启新会话或停止托管。"
        }
      }
      const prepared = prepareManagedBizRetryRun(
        input.originThreadId,
        input.delivery,
        input.message?.trim() || "继续当前任务"
      )
      try {
        await startPreparedManagedAgentRun(prepared)
      } catch (error) {
        return failManagedBizRetryDecision(input, run, error)
      }
      try {
        if (!finishManagedBizRetryDecision(input)) {
          throw new Error("消息已提交，但决策通知已被其他路径结束")
        }
        const decision = recordManagedRunDecision({
          run,
          sourceEvent: input.sourceEvent,
          policyResult: input.policyResult,
          decisionActor: "user",
          decisionChannel: input.channel,
          notificationId: input.decisionId,
          decisionAction: "continue_current_thread",
          summary: input.summary,
          sourceThreadId: input.originThreadId
        })
        const continued = managedRunStore.updateSnapshot(decision.run, {
          type: "session_continued",
          scope: "stage",
          nodeId: decision.run.decisionBaseline?.nodeId,
          targetThreadId: input.originThreadId,
          decisionEventId: decision.event.eventId,
          summary: `已按${channelLabel}决策在原会话继续托管任务`
        })
        publishManagedRunChanged(lastRunSummary(continued))
      } catch (error) {
        return reportManagedBizRetryCompletionFailure(input, error)
      }
      return { applied: true, message: "已在当前托管会话继续执行。" }
    }

    let feature: Awaited<ReturnType<typeof inspectHarnessManagedFeatureStatus>>
    let nextAction: ManagedRunSessionAction
    try {
      feature = await inspectHarnessManagedFeatureStatus(input.projectId, input.featureId)
      if (!feature.nextAction) {
        return { applied: false, message: "最新 Feature 状态没有可执行的 nextAction，短码仍有效。" }
      }
      nextAction = toManagedRunSessionAction(feature.nextAction)
    } catch (error) {
      if (error instanceof ManagedActionValidationError) {
        return {
          applied: false,
          message: `最新 nextAction 不可执行：${error.message}。短码仍有效。`
        }
      }
      throw error
    }
    const workspacePath = run.workspacePath?.trim()
    if (!workspacePath) {
      return { applied: false, message: "托管运行缺少会话工作区，短码仍有效。" }
    }
    const sessionInput: CreateManagedHarnessSessionInput = {
      projectId: input.projectId,
      featureId: input.featureId,
      runId: input.runId,
      nodeId: feature.currentNodeId,
      nextAction,
      workspacePath,
      delivery: input.delivery,
      imRoute: input.channel === "im" ? input.route : undefined
    }
    const prepared = await prepareManagedHarnessSession(sessionInput)
    const created = await createManagedHarnessSession(sessionInput)
    const executionRun: ManagedRunSnapshot = {
      ...run,
      currentSession: { threadId: created.threadId },
      decisionBaseline: {
        nodeId: feature.currentNodeId,
        featureStateHash: feature.featureStateHash,
        featureStatus: feature.featureStatus,
        nodeStatus: feature.currentNodeStatus,
        nextActionHash: feature.nextActionHash
      },
      nextRetryAt: undefined
    }
    try {
      try {
        // Ownership must be durable before grants or Agent startup can fail.
        managedRunStore.updateSnapshot(executionRun)
        await startManagedHarnessSession(sessionInput, created.threadId, prepared)
      } catch (error) {
        return await failManagedBizRetryDecision(input, executionRun, error)
      }
      try {
        if (!finishManagedBizRetryDecision(input)) {
          throw new Error("新会话已启动，但决策通知已被其他路径结束")
        }
        const decision = recordManagedRunDecision({
          run: executionRun,
          sourceEvent: input.sourceEvent,
          policyResult: input.policyResult,
          decisionActor: "user",
          decisionChannel: input.channel,
          notificationId: input.decisionId,
          decisionAction: "start_new_thread",
          summary: input.summary,
          sourceThreadId: input.originThreadId
        })
        const persisted = managedRunStore.updateSnapshot(decision.run, {
          type: "session_created",
          scope: "stage",
          nodeId: feature.currentNodeId,
          targetThreadId: created.threadId,
          decisionEventId: decision.event.eventId,
          summary: `已按${channelLabel}决策创建新的托管会话`
        })
        managedRunStore.appendEvent(persisted, {
          type: "session_started",
          scope: "stage",
          nodeId: feature.currentNodeId,
          targetThreadId: created.threadId,
          decisionEventId: decision.event.eventId,
          summary: "新的托管会话已启动"
        })
        publishManagedRunChanged(lastRunSummary(persisted))
      } catch (error) {
        return reportManagedBizRetryCompletionFailure(input, error)
      }
      return { applied: true, message: "已创建并启动新的托管会话。" }
    } finally {
      publishManagedRunThreadCreated({
        projectId: input.projectId,
        featureId: input.featureId,
        runId: input.runId,
        threadId: created.threadId,
        thread: created.thread
      })
    }
  })
}

export async function recordManagedHumanGateDecision(input: ManagedHumanGateDecisionInput): Promise<boolean> {
  return featureLocks.withKey(featureKey(input.projectId, input.featureId), async () => {
    const record = managedRunStore.getRun(input)
    if (!record.snapshot || record.corrupt || record.snapshot.status !== "running") return false
    const gateSourceEvent = managedRunStore
      .listEvents(record.snapshot, undefined, 500)
      .events.find((event) => event.type === "human_gate_invoked" && event.gateId === input.gateId)
    if (!gateSourceEvent) return false
    const action = input.decision === "approve" ? "approve_human_gate" : "reject_human_gate"
    const summary = input.decision === "approve" ? "Human Gate 已批准" : "Human Gate 已拒绝"
    const decided = recordManagedRunDecision({
      run: record.snapshot,
      sourceEvent: gateSourceEvent,
      policyResult: {
        type: "human_gate",
        reasonCode: input.reasonCode ?? `human_gate_${input.decision}`
      },
      decisionActor: input.channel === "system" ? "controller" : "user",
      decisionChannel: input.channel === "system" ? "system" : input.channel,
      decisionAction: action,
      summary,
      sourceThreadId: input.threadId,
      notificationId: input.gateId,
      gateId: input.gateId
    })
    managedRunStore.appendEvent(decided.run, {
      type: input.decision === "approve" ? "human_gate_approved" : "human_gate_rejected",
      scope: "stage",
      nodeId: decided.run.decisionBaseline?.nodeId,
      decisionEventId: decided.event.eventId,
      gateId: input.gateId,
      sourceThreadId: input.threadId,
      summary
    })
    if (input.decision === "reject") {
      await markTerminal(
        decided.run,
        "cancelled",
        summary,
        "run_cancelled",
        decided.event.eventId,
        input.reasonCode ?? "human_gate_rejected"
      )
    } else {
      publishManagedRunChanged(lastRunSummary(decided.run))
    }
    return true
  })
}

export async function failManagedRunForHumanGateConflict(input: ManagedHumanGateConflictInput): Promise<boolean> {
  return featureLocks.withKey(featureKey(input.projectId, input.featureId), async () => {
    const record = managedRunStore.getRun(input)
    if (!record.snapshot || record.corrupt || record.snapshot.status !== "running") return false
    const sourceEvent = managedRunStore.appendEvent(record.snapshot, {
      type: "human_gate_invoked",
      scope: "stage",
      nodeId: record.snapshot.decisionBaseline?.nodeId,
      gateId: input.gateId,
      sourceThreadId: input.threadId,
      summary: "Human Gate 与已有等待发生冲突"
    })
    const decided = recordManagedRunDecision({
      run: record.snapshot,
      sourceEvent,
      policyResult: {
        type: "human_gate",
        proposedAction: "fail_managed_run",
        reasonCode: "human_gate_conflict"
      },
      decisionAction: "fail_managed_run",
      summary: "同 Feature 已存在待确认 Human Gate",
      sourceThreadId: input.threadId,
      notificationId: input.gateId,
      gateId: input.gateId
    })
    managedRunStore.appendEvent(decided.run, {
      type: "human_gate_conflict",
      scope: "stage",
      nodeId: decided.run.decisionBaseline?.nodeId,
      decisionEventId: decided.event.eventId,
      gateId: input.gateId,
      sourceThreadId: input.threadId,
      summary: "Human Gate 冲突请求已拒绝"
    })
    await markTerminal(
      decided.run,
      "failed",
      "同 Feature 已存在待确认 Human Gate",
      "run_failed",
      decided.event.eventId,
      "human_gate_conflict"
    )
    return true
  })
}

export async function handleAutoModeAgentTurnEnd(input: AutoModeAgentTurnEndInput): Promise<void> {
  const feature = readHarnessFeatureContext(input.threadId)
  if (!feature?.runId) return
  const runId = feature.runId
  await featureLocks.withKey(featureKey(feature.projectId, feature.featureId), async () => {
    const record = managedRunStore.getRun({
      projectId: feature.projectId,
      featureId: feature.featureId,
      runId
    })
    if (!record.snapshot || record.corrupt) return
    if (record.snapshot.currentSession?.threadId !== input.threadId) return
    if ((input.executionFacts?.workflowLaunchedRunIds?.length ?? 0) > 0) {
      console.info("[ManagedRun] Agent turn launched a detached workflow; deferring evaluation:", {
        threadId: input.threadId,
        runId,
        workflowRunIds: input.executionFacts?.workflowLaunchedRunIds
      })
      return
    }
    if (input.outcome === "error") {
      emitAppAttention({
        kind: "task-error",
        threadId: input.threadId,
        key: `managed-mode:${feature.runId}:${input.threadId}`
      })
    }
    if (record.snapshot.status === "cancelled") return
    if (record.snapshot.status !== "running") return
    const sourceEvent = managedRunStore.appendEvent(record.snapshot, {
      type: "managed_agent_turn_ended",
      scope: "stage",
      nodeId: record.snapshot.decisionBaseline?.nodeId,
      threadId: input.threadId,
      outcome: input.outcome,
      endReason: input.endReason,
      summary: `会话结束：${input.outcome}/${input.endReason.code}`
    })
    if (isManagedRunStopRequested(record.snapshot)) return
    let activeSnapshot = record.snapshot
    if (
      input.outcome === "success" &&
      (activeSnapshot.providerRetryCount > 0 || activeSnapshot.nextRetryAt)
    ) {
      cancelProviderRetry(activeSnapshot.projectId, activeSnapshot.featureId)
      activeSnapshot = managedRunStore.updateSnapshot({
        ...activeSnapshot,
        providerRetryCount: 0,
        nextRetryAt: undefined
      })
    }
    try {
      await inspectAndLaunch(activeSnapshot, input.delivery, sourceEvent, {
        outcome: input.outcome,
        endReason: input.endReason,
        ...(input.contextUsage ? { contextUsage: input.contextUsage } : {})
      })
    } catch (error) {
      const failed = recordManagedRunDecision({
        run: activeSnapshot,
        sourceEvent,
        policyResult: {
          type: "run_termination",
          proposedAction: "fail_managed_run",
          reasonCode: "controller_processing_failed"
        },
        decisionAction: "fail_managed_run",
        summary: "托管控制器处理失败"
      })
      await markTerminal(
        failed.run,
        "failed",
        error instanceof Error ? error.message : String(error),
        "run_failed",
        failed.event.eventId,
        "controller_processing_failed"
      )
    }
  })
}

export function handleAutoModeAgentCancelled(threadId: string): void {
  if (hasPendingHumanGateForThread(threadId)) return
  const feature = readHarnessFeatureContext(threadId)
  if (!feature?.runId) return
  void featureLocks
    .withKey(featureKey(feature.projectId, feature.featureId), async () => {
      const record = managedRunStore.getRun({
        projectId: feature.projectId,
        featureId: feature.featureId,
        runId: feature.runId!
      })
      if (!record.snapshot || record.corrupt || record.snapshot.status !== "running") return
      const sourceEvent = managedRunStore.appendEvent(record.snapshot, {
        type: "session_run_aborted",
        scope: "stage",
        nodeId: record.snapshot.decisionBaseline?.nodeId,
        threadId,
        reasonCode: "user_aborted_agent_run",
        summary: "用户终止当前托管会话的 Agent Run"
      })
      const decision = recordManagedRunDecision({
        run: record.snapshot,
        sourceEvent,
        policyResult: {
          type: "run_termination",
          proposedAction: "stop_managed_run",
          reasonCode: "session_run_aborted"
        },
        decisionAction: "stop_managed_run",
        summary: "当前托管会话已终止，停止托管运行",
        sourceThreadId: threadId
      })
      await markTerminal(
        decision.run,
        "cancelled",
        "当前托管会话已被用户终止",
        "run_cancelled",
        decision.event.eventId,
        "session_run_aborted"
      )
    })
    .catch((error) => {
      console.warn("[ManagedRun] Failed to stop managed run after session cancellation:", error)
    })
}
