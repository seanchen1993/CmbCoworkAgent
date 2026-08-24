import { BrowserWindow } from "electron"
import { getAllThreads, getThread } from "../db"
import type { AgentRunDelivery } from "../agent/agent-run-service"
import { hasActiveTopLevelAgentRun } from "../agent/agent-run-service"
import { emitAppAttention } from "../app-attention-events"
import { AsyncKeyedLock } from "../ipc/async-keyed-lock"
import {
  getHarnessProjectConfiguredSessionWorkspacePath,
  readHarnessFeatureMetadata
} from "./service"
import { inspectHarnessManagedFeatureStatus } from "./managed-feature-status"
import {
  createAndStartManagedHarnessSession,
  ManagedActionValidationError,
  sendManagedBizRetryReuseThread,
  sendManagedProviderRetry,
  type CreateManagedHarnessSessionInput
} from "./auto-mode-action-executor"
import { formatManagedRunTimestamp, managedRunStore } from "./managed-run-store"
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
  ManagedRunSessionAction,
  ManagedRunSnapshot,
  ManagedRunStartInput,
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

function publishManagedRunChanged(run: ManagedRunSummary): void {
  const event: ManagedRunChangeEvent = {
    projectId: run.projectId,
    featureId: run.featureId,
    run
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send(MANAGED_RUN_CHANGED_CHANNEL, event)
  }
}

function publishManagedRunThreadCreated(event: ManagedRunThreadCreatedEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send(MANAGED_RUN_THREAD_CREATED_CHANNEL, event)
  }
}

function hasActiveFeatureThread(projectId: string, featureId: string): boolean {
  for (const thread of getAllThreads()) {
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

function readThreadWorkspacePath(threadId: string): string | null {
  const thread = getThread(threadId)
  if (!thread?.metadata) return null
  try {
    const metadata = JSON.parse(thread.metadata) as unknown
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null
    const workspacePath = (metadata as Record<string, unknown>).workspacePath
    return typeof workspacePath === "string" && workspacePath.trim()
      ? workspacePath.trim()
      : null
  } catch {
    return null
  }
}

function resolveManagedSessionWorkspacePath(
  projectId: string,
  featureId: string,
  currentThreadId?: string,
  persistedWorkspacePath?: string
): string | null {
  let currentWorkspacePath: string | null = null
  let currentIsManualFeatureSession = false
  if (currentThreadId) {
    currentWorkspacePath = readThreadWorkspacePath(currentThreadId)
    const currentThread = getThread(currentThreadId)
    if (currentThread?.metadata) {
      try {
        const currentFeature = readHarnessFeatureMetadata(
          JSON.parse(currentThread.metadata) as unknown
        )
        currentIsManualFeatureSession = Boolean(
          currentFeature?.projectId === projectId &&
            currentFeature.slug === featureId &&
            !currentFeature.runId
        )
      } catch {
        currentIsManualFeatureSession = false
      }
    }
  }
  if (currentIsManualFeatureSession && currentWorkspacePath) {
    return currentWorkspacePath
  }
  let manualFeatureWorkspacePath: string | null = null
  let managedFeatureWorkspacePath: string | null = null
  for (const thread of getAllThreads()) {
    if (thread.thread_id === currentThreadId || !thread.metadata) continue
    try {
      const feature = readHarnessFeatureMetadata(JSON.parse(thread.metadata) as unknown)
      if (feature?.projectId !== projectId || feature.slug !== featureId) continue
      const workspacePath = readThreadWorkspacePath(thread.thread_id)
      if (!workspacePath) continue
      if (feature.runId) managedFeatureWorkspacePath ||= workspacePath
      else manualFeatureWorkspacePath ||= workspacePath
    } catch {
      // Ignore malformed metadata while looking for another Feature session.
    }
  }
  if (manualFeatureWorkspacePath) return manualFeatureWorkspacePath
  if (currentWorkspacePath) return currentWorkspacePath
  if (persistedWorkspacePath?.trim()) return persistedWorkspacePath.trim()
  if (managedFeatureWorkspacePath) return managedFeatureWorkspacePath
  try {
    return getHarnessProjectConfiguredSessionWorkspacePath(projectId)
  } catch {
    return null
  }
}

function toManagedRunSessionAction(
  nextAction: NonNullable<Awaited<ReturnType<typeof inspectHarnessManagedFeatureStatus>>["nextAction"]>
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
    bizRetryCount: run.bizRetryCount,
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

function scheduleProviderRetry(run: ManagedRunSnapshot, delivery: AgentRunDelivery): void {
  if (isManagedRunStopRequested(run)) return
  const retryNumber = run.providerRetryCount + 1
  const retryPlan = resolveProviderRetryPlan(run.providerRetryCount)
  if (!retryPlan || !run.currentSession?.threadId || !run.decisionBaseline?.nodeId) {
    void markTerminal(run, "failed", "模型服务重试已达到上限", "run_failed")
    return
  }
  cancelProviderRetry(run.projectId, run.featureId)
  const delayMs = retryPlan.delayMs
  const nextRetryAt = formatManagedRunTimestamp(new Date(Date.now() + delayMs))
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
      source: "agent_end_reason",
      nodeId: run.decisionBaseline.nodeId,
      threadId: run.currentSession.threadId,
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
  await featureLocks.withKey(featureKey(scheduledRun.projectId, scheduledRun.featureId), async () => {
    const record = managedRunStore.getRun(scheduledRun)
    if (
      !record.snapshot ||
      record.corrupt ||
      record.snapshot.status !== "running" ||
      record.snapshot.nextRetryAt !== scheduledRun.nextRetryAt ||
      isManagedRunStopRequested(record.snapshot)
    ) return
    if (hasActiveFeatureThread(scheduledRun.projectId, scheduledRun.featureId)) {
      reschedulePendingProviderRetry(scheduledRun, delivery)
      return
    }

    let feature: Awaited<ReturnType<typeof inspectHarnessManagedFeatureStatus>>
    try {
      feature = await inspectHarnessManagedFeatureStatus(
        scheduledRun.projectId,
        scheduledRun.featureId
      )
    } catch (error) {
      await markTerminal(
        record.snapshot,
        "failed",
        error instanceof Error ? error.message : String(error),
        "run_failed"
      )
      return
    }
    managedRunStore.appendEvent(record.snapshot, {
      type: "feature_inspected",
      scope: "stage",
      source: "feature_status",
      nodeId: feature.currentNodeId,
      featureStatus: feature.featureStatus,
      nodeStatus: feature.currentNodeStatus,
      slashSkill: feature.nextAction?.slashSkill,
      summary: "发送模型服务重试前重新检查当前阶段状态"
    })
    if (isManagedRunStopRequested(record.snapshot)) return
    const inspectedDecision = resolveManagedRunDecision({
      run: record.snapshot,
      feature,
      terminal: {
        outcome: "error",
        endReason: { code: "provider_error" }
      }
    })
    if (inspectedDecision.decision !== "provider_retry") {
      const running = managedRunStore.updateSnapshot({
        ...record.snapshot,
        status: "running",
        nextRetryAt: undefined
      })
      await inspectAndLaunch(running, delivery)
      return
    }
    const currentThreadId = record.snapshot.currentSession?.threadId
    if (!currentThreadId) {
      await markTerminal(record.snapshot, "failed", "模型服务重试缺少来源会话", "run_failed")
      return
    }

    const running = managedRunStore.updateSnapshot(
      { ...record.snapshot, status: "running", nextRetryAt: undefined },
      {
        type: "provider_retry_sent",
        scope: "stage",
        source: "controller_policy",
        nodeId: feature.currentNodeId,
        threadId: currentThreadId,
        reasonCode: `provider_error_${record.snapshot.providerRetryCount}_of_3`,
        summary: "在原会话自动发送“继续当前任务”"
      }
    )
    if (isManagedRunStopRequested(running)) return
    try {
      await sendManagedProviderRetry(currentThreadId, delivery)
      const published = managedRunStore.updateSnapshot(running)
      publishManagedRunChanged(lastRunSummary(published))
    } catch (error) {
      await markTerminal(
        running,
        "failed",
        error instanceof Error ? error.message : String(error),
        "run_failed"
      )
    }
  })
}

async function markTerminal(
  run: ManagedRunSnapshot,
  status: "cancelled" | "failed" | "completed",
  reason: string,
  eventType: "run_cancelled" | "run_failed" | "run_completed",
  reasonCode?: string
): Promise<void> {
  cancelProviderRetry(run.projectId, run.featureId)
  const now = formatManagedRunTimestamp()
  const persistedReason = boundedManagedRunReason(reason)
  const next: ManagedRunSnapshot = {
    ...run,
    status,
    ...(status === "cancelled" ? { cancellationReason: persistedReason, nextRetryAt: undefined } : {}),
    ...(status === "failed" ? { failureReason: persistedReason, nextRetryAt: undefined } : {}),
    ...(status === "completed" ? { completedAt: now, nextRetryAt: undefined } : {})
  }
  const persisted = managedRunStore.updateSnapshot(next, {
    type: eventType,
    scope: "global",
    source: "managed_run",
    nodeId: next.decisionBaseline?.nodeId,
    threadId: next.currentSession?.threadId,
    ...(reasonCode ? { reasonCode } : {}),
    summary: persistedReason
  })
  stopRequestedRunIds.delete(next.runId)
  publishManagedRunChanged(lastRunSummary(persisted))
}

async function inspectAndLaunch(
  run: ManagedRunSnapshot,
  delivery: AgentRunDelivery,
  terminal?: Pick<AgentTurnEndEvent, "outcome" | "endReason" | "contextUsage">
): Promise<void> {
  if (isManagedRunStopRequested(run)) return
  const feature = await inspectHarnessManagedFeatureStatus(run.projectId, run.featureId)
  if (isManagedRunStopRequested(run)) return
  managedRunStore.appendEvent(run, {
    type: "feature_inspected",
    scope: "stage",
    source: "feature_status",
    nodeId: feature.currentNodeId,
    featureStatus: feature.featureStatus,
    nodeStatus: feature.currentNodeStatus,
    slashSkill: feature.nextAction?.slashSkill,
    summary: `特性=${feature.featureStatus}，节点=${feature.currentNodeStatus}${feature.nextAction?.slashSkill ? `，技能=${feature.nextAction.slashSkill}` : ""}`
  })

  const decision = resolveManagedRunDecision({
    run,
    feature,
    terminal
  })
  const decisionFacts = buildManagedRunDecisionFacts(run, feature, terminal)
  const decidedRun = managedRunStore.updateSnapshot(run, {
    type: "decision_made",
    scope: "stage",
    source: "controller_policy",
    nodeId: feature.currentNodeId,
    sourceThreadId: run.currentSession?.threadId,
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    decisionFacts,
    decisionRule: decision.rule,
    summary: decision.summary
  })

  if (decision.decision === "complete") {
    await markTerminal(decidedRun, "completed", decision.summary, "run_completed", decision.reasonCode)
    return
  }
  if (decision.decision === "fail") {
    await markTerminal(decidedRun, "failed", decision.summary, "run_failed", decision.reasonCode)
    return
  }
  if (decision.decision === "provider_retry") {
    if (!resolveProviderRetryPlan(decidedRun.providerRetryCount)) {
      await markTerminal(decidedRun, "failed", "模型服务重试已达到上限", "run_failed")
      return
    }
    scheduleProviderRetry(decidedRun, delivery)
    return
  }

  if (decision.decision === "biz_retry_reuse_thread") {
    const currentThreadId = decidedRun.currentSession?.threadId
    if (!currentThreadId) {
      await markTerminal(decidedRun, "failed", "业务重试缺少来源会话", "run_failed")
      return
    }
    const running = managedRunStore.updateSnapshot(
      {
        ...decidedRun,
        status: "running",
        decisionBaseline: {
          nodeId: feature.currentNodeId,
          featureStateHash: feature.featureStateHash,
          featureStatus: feature.featureStatus,
          nodeStatus: feature.currentNodeStatus,
          nextActionHash: feature.nextActionHash
        },
        bizRetryCount: decidedRun.bizRetryCount + 1,
        nextRetryAt: undefined
      },
      {
        type: "biz_retry_reuse_thread",
        scope: "stage",
        source: "controller_policy",
        nodeId: feature.currentNodeId,
        threadId: currentThreadId,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        summary: decision.summary
      }
    )
    if (isManagedRunStopRequested(running)) return
    try {
      await sendManagedBizRetryReuseThread(currentThreadId, delivery)
      publishManagedRunChanged(lastRunSummary(running))
    } catch (error) {
      await markTerminal(
        running,
        "failed",
        error instanceof Error ? error.message : String(error),
        "run_failed",
        "platform_action_failed"
      )
    }
    return
  }

  if (!feature.nextAction) {
    await markTerminal(decidedRun, "failed", "当前节点没有可执行的 nextAction", "run_failed")
    return
  }

  const nextAction = toManagedRunSessionAction(feature.nextAction)
  const workspacePath = resolveManagedSessionWorkspacePath(
    decidedRun.projectId,
    decidedRun.featureId,
    decidedRun.currentSession?.threadId,
    decidedRun.currentSession?.workspacePath
  )
  const sessionInput: CreateManagedHarnessSessionInput = {
    projectId: decidedRun.projectId,
    featureId: decidedRun.featureId,
    runId: decidedRun.runId,
    nodeId: feature.currentNodeId,
    nextAction,
    workspacePath,
    delivery
  }
  if (workspacePath === null) {
    await markTerminal(
      decidedRun,
      "failed",
      "当前特性没有可用的会话工作区，无法启动托管会话",
      "run_failed"
    )
    return
  }
  if (isManagedRunStopRequested(decidedRun)) return
  try {
    const created = await createAndStartManagedHarnessSession(sessionInput)
    const advancesStage = decision.decision === "advance"
    const persisted = managedRunStore.updateSnapshot(
      {
        ...decidedRun,
        status: "running",
        currentSession: {
          threadId: created.threadId,
          ...(workspacePath ? { workspacePath } : {})
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
        bizRetryCount:
          decision.decision === "biz_retry_new_thread" ? decidedRun.bizRetryCount + 1 : 0,
        nextRetryAt: undefined,
      },
      {
        type: "session_created",
        scope: "stage",
        source: "controller_policy",
        nodeId: feature.currentNodeId,
        targetThreadId: created.threadId,
        ...(workspacePath ? { workspacePath } : {}),
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        summary: decision.summary
      }
    )
    if (decision.decision === "biz_retry_new_thread") {
      managedRunStore.appendEvent(persisted, {
        type: "biz_retry_new_thread",
        scope: "stage",
        source: "controller_policy",
        nodeId: feature.currentNodeId,
        targetThreadId: created.threadId,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        summary: decision.summary
      })
    }
    managedRunStore.appendEvent(persisted, {
      type: "session_started",
      scope: "stage",
      source: "managed_run",
      nodeId: feature.currentNodeId,
      threadId: created.threadId,
      summary: "托管运行的普通项目会话已启动"
    })
    publishManagedRunThreadCreated({
      projectId: decidedRun.projectId,
      featureId: decidedRun.featureId,
      runId: decidedRun.runId,
      threadId: created.threadId
    })
    publishManagedRunChanged(lastRunSummary(persisted))
  } catch (error) {
    await markTerminal(
      decidedRun,
      "failed",
      error instanceof Error ? error.message : String(error),
      "run_failed",
      error instanceof ManagedActionValidationError ? error.reasonCode : "platform_action_failed"
    )
  }
}

export async function startManagedRun(input: ManagedRunStartRequest): Promise<ManagedRunSummary> {
  return featureLocks.withKey(featureKey(input.projectId, input.featureId), async () => {
    const existing = managedRunStore.findRunningRun(input.projectId, input.featureId)
    if (hasActiveFeatureThread(input.projectId, input.featureId)) {
      throw new Error("已有运行中的会话，无法开启托管")
    }
    if (existing?.snapshot?.status === "running") {
      throw new Error("已有运行中的托管 Run，无法开启新的托管")
    }

    const created = managedRunStore.createRun(input.projectId, input.featureId)
    publishManagedRunChanged(lastRunSummary(created))
    try {
      await inspectAndLaunch(created, input.delivery)
    } catch (error) {
      await markTerminal(
        created,
        "failed",
        error instanceof Error ? error.message : String(error),
        "run_failed"
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
    await markTerminal(
      current.snapshot,
      "cancelled",
      "用户停止托管模式，已有会话继续运行但不再自动推进",
      "run_cancelled"
    )
    return true
  })
}

export async function handleAutoModeAgentTurnEnd(input: AutoModeAgentTurnEndInput): Promise<void> {
  const feature = readHarnessFeatureContext(input.threadId)
  if (!feature?.runId) return
  if (input.outcome === "error") {
    emitAppAttention({
      kind: "task-error",
      threadId: input.threadId,
      key: `managed-mode:${feature.runId}:${input.threadId}`
    })
  }
  const runId = feature.runId
  await featureLocks.withKey(featureKey(feature.projectId, feature.featureId), async () => {
    const record = managedRunStore.getRun({
      projectId: feature.projectId,
      featureId: feature.featureId,
      runId
    })
    if (!record.snapshot || record.corrupt) return
    if (
      record.snapshot.status === "cancelled" &&
      record.snapshot.currentSession?.threadId === input.threadId
    ) {
      const persisted = managedRunStore.updateSnapshot(record.snapshot, {
        type: "session_completed",
        scope: "stage",
        source: "agent_end_reason",
        nodeId: record.snapshot.decisionBaseline?.nodeId,
        threadId: input.threadId,
        outcome: input.outcome,
        endReason: input.endReason,
        summary: `托管停止后会话结束：${input.outcome}/${input.endReason.code}`
      })
      publishManagedRunChanged(lastRunSummary(persisted))
      return
    }
    if (record.snapshot.status !== "running") return
    if (record.snapshot.currentSession?.threadId !== input.threadId) return
    managedRunStore.appendEvent(record.snapshot, {
      type: "session_completed",
      scope: "stage",
      source: "agent_end_reason",
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
      activeSnapshot = managedRunStore.updateSnapshot(
        {
          ...activeSnapshot,
          providerRetryCount: 0,
          nextRetryAt: undefined
        },
        {
          type: "provider_retry_reset",
          scope: "stage",
          source: "agent_end_reason",
          nodeId: activeSnapshot.decisionBaseline?.nodeId,
          threadId: input.threadId,
          reasonCode: "turn_succeeded",
          summary: "本轮执行成功，模型服务重试次数已清零"
        }
      )
    }
    try {
      await inspectAndLaunch(activeSnapshot, input.delivery, {
        outcome: input.outcome,
        endReason: input.endReason,
        ...(input.contextUsage ? { contextUsage: input.contextUsage } : {})
      })
    } catch (error) {
      await markTerminal(
        activeSnapshot,
        "failed",
        error instanceof Error ? error.message : String(error),
        "run_failed"
      )
    }
  })
}

export function handleAutoModeAgentCancelled(threadId: string): void {
  const feature = readHarnessFeatureContext(threadId)
  if (!feature?.runId) return
  void stopManagedRun({
    projectId: feature.projectId,
    featureId: feature.featureId,
    runId: feature.runId
  }).catch((error) => {
    console.warn("[ManagedRun] Failed to stop managed run after session cancellation:", error)
  })
}
