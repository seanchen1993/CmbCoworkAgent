import type { ManagedHumanGateDecisionInput, ManagedHumanGateConflictInput } from "./notification-operation-types"
import { registerNotificationActions } from "../services/notification-actions"
import { harnessNotifications } from "./notifications"
import { randomUUID } from "crypto"
import { AsyncKeyedLock } from "../ipc/async-keyed-lock"
import { HookHaltError } from "../hooks/halt"
import { trackEvent } from "../services/event-reporter"
import { projectHumanGate } from "../../shared/harness-notifications"
import type {
  HarnessHumanGateDecisionInput,
  HarnessHumanGateSnapshot
} from "../../shared/harness-board-types"
import { managedRunStore } from "./managed-run-store"
import { getHarnessFeatureBinding } from "./service"
import { formatGmt8Timestamp } from "../../shared/gmt8-time"

interface HumanGateOperations {
  recordDecision: (input: ManagedHumanGateDecisionInput) => Promise<boolean>
  failConflict: (input: ManagedHumanGateConflictInput) => Promise<boolean>
}
let operations: HumanGateOperations | undefined
function getOperations(): HumanGateOperations {
  if (!operations) throw new Error("Human Gate source is not initialized")
  return operations
}

const HUMAN_GATE_CONFLICT_MESSAGE = "该 Feature 已有待确认操作，不允许并行推进状态"
const MESSAGE_MAX_LENGTH = 2_000

export interface HumanGateLease {
  release: () => void
}

export interface HumanGateRequestInput {
  projectId: string
  featureId: string
  threadId: string
  runtimeThreadId: string
  hookId: string
  hookPluginId?: string
  harnessPluginId?: string
  message: string
  abortSignal?: AbortSignal
}

interface ActiveGate {
  gate: HarnessHumanGateSnapshot
  state: "pending" | "approved"
  decision: Promise<"approve" | "reject">
  resolve: (decision: "approve" | "reject") => void
  runtimeThreadId: string
}

const featureLocks = new AsyncKeyedLock()
const activeGates = new Map<string, ActiveGate>()

function featureKey(projectId: string, featureId: string): string {
  return `${projectId}\u0000${featureId}`
}

function recordHumanGateEvent(
  type:
    | "human_gate_requested"
    | "human_gate_approved"
    | "human_gate_rejected"
    | "human_gate_conflict",
  gate: HarnessHumanGateSnapshot,
  reasonCode?: string,
  includeManagedRun = true
): void {
  try {
    trackEvent(type, "hook", {
      gateId: gate.gateId,
      projectId: gate.projectId,
      featureId: gate.featureId,
      threadId: gate.sourceThreadId,
      managedRunId: gate.sourceManagedRunId,
      hookId: gate.hookId,
      reasonCode
    })
  } catch (error) {
    console.warn(`[HumanGate] Failed to record ${type}:`, error)
  }
  if (includeManagedRun && gate.sourceManagedRunId && type === "human_gate_requested") {
    const record = managedRunStore.getRun({
      projectId: gate.projectId,
      featureId: gate.featureId,
      runId: gate.sourceManagedRunId
    })
    if (!record.snapshot || record.corrupt) return
    try {
      managedRunStore.appendEvent(record.snapshot, {
        type: "human_gate_invoked",
        scope: "stage",
        nodeId: record.snapshot.decisionBaseline?.nodeId,
        sourceThreadId: gate.sourceThreadId,
        gateId: gate.gateId,
        summary: reasonCode ?? gate.message
      })
    } catch (error) {
      console.warn(`[HumanGate] Failed to append ManagedRun event ${type}:`, error)
    }
  }
}

function halt(reason: string): HookHaltError {
  return new HookHaltError({
    hookEvent: "PreToolUse",
    result: {
      exitCode: 0,
      stdout: reason,
      stderr: "",
      blocked: true,
      continue: false,
      stopReason: reason
    },
    fallbackReason: reason
  })
}

function findManagedRunId(
  projectId: string,
  featureId: string,
  threadId: string
): string | undefined {
  const record = managedRunStore.findRunningRun(projectId, featureId)
  return record?.snapshot?.currentSession?.threadId === threadId ? record.snapshot.runId : undefined
}

async function validateRequest(input: HumanGateRequestInput): Promise<string> {
  const message = input.message.trim()
  if (!message || message.length > MESSAGE_MAX_LENGTH) {
    throw halt(`decision=human_gate 的 systemMessage 必须是 1-${MESSAGE_MAX_LENGTH} 字符的纯文本`)
  }
  if (!input.projectId.trim() || !input.featureId.trim() || !input.threadId.trim()) {
    throw halt("humanGate 仅支持带合法 Feature 绑定的项目模式会话")
  }
  if (!input.hookId.trim()) throw halt("humanGate 缺少 Hook 标识")
  if (!input.harnessPluginId || input.hookPluginId !== input.harnessPluginId) {
    throw halt("humanGate 只能由当前项目绑定的 Harness 插件请求")
  }
  const binding = await getHarnessFeatureBinding(input.projectId, input.featureId)
  if (!binding) throw halt("humanGate 对应的 Feature 绑定不存在")
  return message
}

export async function requestHumanGate(input: HumanGateRequestInput): Promise<HumanGateLease> {
  const message = await validateRequest(input)
  const key = featureKey(input.projectId, input.featureId)
  let active!: ActiveGate
  await featureLocks.withKey(key, async () => {
    const existing =
      activeGates.get(key) ??
      projectHumanGate(harnessNotifications.pending().find(
        (value) => value.type === "human_gate" &&
          value.projectId === input.projectId && value.featureId === input.featureId
      ))
    if (existing) {
      const conflictGate = "gate" in existing ? existing.gate : existing
      const conflict = {
        ...conflictGate,
        gateId: `hg_${randomUUID().replace(/-/gu, "")}`,
        sourceThreadId: input.threadId,
        sourceManagedRunId: findManagedRunId(input.projectId, input.featureId, input.threadId),
        hookId: input.hookId,
        message
      }
      recordHumanGateEvent("human_gate_conflict", conflict, "human_gate_conflict")
      if (conflict.sourceManagedRunId) {
        await getOperations().failConflict({
          gateId: conflict.gateId,
          projectId: conflict.projectId,
          featureId: conflict.featureId,
          runId: conflict.sourceManagedRunId,
          threadId: conflict.sourceThreadId
        })
      }
      throw halt(HUMAN_GATE_CONFLICT_MESSAGE)
    }

    const gate: HarnessHumanGateSnapshot = {
      gateId: `hg_${randomUUID().replace(/-/gu, "")}`,
      status: "pending",
      projectId: input.projectId,
      featureId: input.featureId,
      sourceThreadId: input.threadId,
      sourceManagedRunId: findManagedRunId(input.projectId, input.featureId, input.threadId),
      hookId: input.hookId,
      message,
      createdAt: formatGmt8Timestamp()
    }
    let resolveDecision!: (decision: "approve" | "reject") => void
    const decision = new Promise<"approve" | "reject">((resolve) => {
      resolveDecision = resolve
    })
    active = {
      gate,
      state: "pending",
      decision,
      resolve: resolveDecision,
      runtimeThreadId: input.runtimeThreadId
    }
    harnessNotifications.create({
      notificationId: gate.gateId,
      kind: "decision",
      type: "human_gate",
      projectId: gate.projectId,
      featureId: gate.featureId,
      sourceThreadId: gate.sourceThreadId,
      runId: gate.sourceManagedRunId,
      title: "Human Gate 需要人工确认",
      message: gate.message,
      humanGate: { hookId: gate.hookId },
      nodeId: gate.sourceManagedRunId ? managedRunStore.getRun({ projectId: gate.projectId, featureId: gate.featureId, runId: gate.sourceManagedRunId }).snapshot?.decisionBaseline?.nodeId : undefined,
      targets: ["app_view", "im", "system_notification"],
      policyResult: { type: "human_gate", reasonCode: "human_gate_requested" }
    })
    activeGates.set(key, active)
    recordHumanGateEvent("human_gate_requested", gate)

    const onAbort = (): void => {
      void rejectHumanGate(
        { projectId: gate.projectId, featureId: gate.featureId, gateId: gate.gateId },
        "source_run_aborted",
        "system"
      ).catch((error) => console.warn("[HumanGate] Failed to reject aborted Gate:", error))
    }
    input.abortSignal?.addEventListener("abort", onAbort, { once: true })
    if (input.abortSignal?.aborted) onAbort()
    void decision.finally(() => input.abortSignal?.removeEventListener("abort", onAbort))
  })

  const decision = await active.decision
  if (decision === "reject") throw halt("Human Gate 未通过，已终止当前 Agent Run")
  return {
    release: () => {
      if (activeGates.get(key) === active) activeGates.delete(key)
    }
  }
}

export async function approveHumanGate(
  input: HarnessHumanGateDecisionInput,
  channel: "desktop" | "im" = "desktop"
): Promise<boolean> {
  const key = featureKey(input.projectId, input.featureId)
  let approvedGate: HarnessHumanGateSnapshot | undefined
  let approvedActive: ActiveGate | undefined
  const result = await featureLocks.withKey(key, async () => {
    const notification = harnessNotifications.get(input.gateId)
    if (channel === "im" && notification?.disabledTargets?.im) return false
    const active = activeGates.get(key)
    const persisted = projectHumanGate(notification)
    if (persisted?.projectId !== input.projectId || persisted.featureId !== input.featureId) return false
    if (!active || active.state !== "pending" || persisted?.gateId !== input.gateId) return false
    if (
      !harnessNotifications.finish(input.gateId, {
        status: "resolved",
        action: "approve",
        channel,
        reasonCode: "human_gate_approved",
        result: "Human Gate 已批准"
      })
    )
      return false
    active.state = "approved"
    approvedGate = active.gate
    approvedActive = active
    recordHumanGateEvent("human_gate_approved", active.gate)
    return true
  })
  try {
    if (result && approvedGate?.sourceManagedRunId) {
      await getOperations().recordDecision({
        gateId: approvedGate.gateId,
        projectId: approvedGate.projectId,
        featureId: approvedGate.featureId,
        runId: approvedGate.sourceManagedRunId,
        threadId: approvedGate.sourceThreadId,
        decision: "approve",
        channel
      })
    }
  } catch (error) {
    console.error("[HumanGate] Failed to record approved ManagedRun decision:", error)
  } finally {
    approvedActive?.resolve("approve")
  }
  return result
}

export async function rejectHumanGate(
  input: HarnessHumanGateDecisionInput,
  reasonCode: "human_gate_rejected" | "source_run_aborted" = "human_gate_rejected",
  channel: "desktop" | "im" | "system" = "desktop"
): Promise<boolean> {
  const key = featureKey(input.projectId, input.featureId)
  let rejectedGate: HarnessHumanGateSnapshot | undefined
  let rejectedActive: ActiveGate | undefined
  const result = await featureLocks.withKey(key, async () => {
    const notification = harnessNotifications.get(input.gateId)
    if (channel === "im" && notification?.disabledTargets?.im) return false
    const active = activeGates.get(key)
    const persisted = projectHumanGate(notification)
    if (persisted?.projectId !== input.projectId || persisted.featureId !== input.featureId) return false
    if (persisted?.gateId !== input.gateId) return false
    rejectedGate = persisted
    rejectedActive = active
    recordHumanGateEvent("human_gate_rejected", persisted, reasonCode, false)
    const finished = harnessNotifications.finish(input.gateId, {
      status: channel === "system" ? "invalidated" : "resolved",
      action: "reject",
      channel,
      reasonCode: channel === "system" ? "source_run_aborted" : "human_gate_rejected",
      result: channel === "system" ? "来源执行已中断，Human Gate 已结束" : "Human Gate 已拒绝"
    })
    if (!finished) return false
    activeGates.delete(key)
    return true
  })
  try {
    if (result && rejectedGate?.sourceManagedRunId) {
      await getOperations().recordDecision({
        gateId: rejectedGate.gateId,
        projectId: rejectedGate.projectId,
        featureId: rejectedGate.featureId,
        runId: rejectedGate.sourceManagedRunId,
        threadId: rejectedGate.sourceThreadId,
        decision: "reject",
        channel,
        reasonCode
      })
    }
  } catch (error) {
    console.error("[HumanGate] Failed to cancel rejected ManagedRun:", error)
  } finally {
    rejectedActive?.resolve("reject")
  }
  return result
}

export function listPendingHumanGateRuntimeThreadIds(): string[] {
  return [...activeGates.values()]
    .filter((active) => active.state === "pending")
    .map((active) => active.runtimeThreadId)
}

export function hasPendingHumanGateForThread(threadId: string): boolean {
  return [...activeGates.values()].some(
    (active) =>
      active.state === "pending" &&
      (active.gate.sourceThreadId === threadId || active.runtimeThreadId === threadId)
  )
}

export function interruptHumanGatesForRun(runId: string): void {
  for (const [key, active] of activeGates) {
    if (active.gate.sourceManagedRunId !== runId || active.state !== "pending") continue
    harnessNotifications.finish(active.gate.gateId, {
      status: "invalidated",
      channel: "system",
      reasonCode: "managed_run_ended",
      result: "托管运行已结束，Human Gate 中断"
    })
    activeGates.delete(key)
    active.resolve("reject")
  }
}

let initialized = false
export function initializeHumanGateSource(callbacks: HumanGateOperations): void {
  if (initialized) return
  initialized = true
  operations = callbacks
  registerNotificationActions("human_gate", async (notification, input, origin) => {
    const gate = projectHumanGate(notification)
    if (!gate || (input.action !== "approve" && input.action !== "reject")) {
      return { applied: false, message: "Human Gate 操作无效。" }
    }
    const applied = input.action === "approve"
      ? await approveHumanGate(gate, origin.channel)
      : await rejectHumanGate(gate, "human_gate_rejected", origin.channel)
    return { applied, message: applied ? "Human Gate 已处理。" : "该决策已处理或已失效。" }
  })
}
