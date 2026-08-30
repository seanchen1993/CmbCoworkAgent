import { randomUUID } from "crypto"
import { BrowserWindow } from "electron"
import { AsyncKeyedLock } from "../ipc/async-keyed-lock"
import { HookHaltError } from "../hooks/halt"
import { trackEvent } from "../services/event-reporter"
import type {
  HarnessHumanGateChangedEvent,
  HarnessHumanGateDecisionInput,
  HarnessHumanGateSnapshot
} from "../../shared/harness-board-types"
import { managedRunStore } from "./managed-run-store"
import {
  formatGmt8Timestamp,
  getHarnessFeatureBinding,
  listHarnessHumanGates,
  setHarnessHumanGate
} from "./service"

export const HUMAN_GATE_CHANGED_CHANNEL = "harnessBoard:humanGateChanged"
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

function publishHumanGateChanged(
  gate: HarnessHumanGateSnapshot,
  humanGate?: HarnessHumanGateSnapshot
): void {
  const event: HarnessHumanGateChangedEvent = {
    projectId: gate.projectId,
    featureId: gate.featureId,
    sourceThreadId: gate.sourceThreadId,
    ...(humanGate ? { humanGate } : {})
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send(HUMAN_GATE_CHANGED_CHANNEL, event)
  }
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
  if (includeManagedRun && gate.sourceManagedRunId) {
    const record = managedRunStore.getRun({
      projectId: gate.projectId,
      featureId: gate.featureId,
      runId: gate.sourceManagedRunId
    })
    if (!record.snapshot || record.corrupt) return
    try {
      managedRunStore.appendEvent(record.snapshot, {
        type,
        scope: "stage",
        source: "human_gate",
        nodeId: record.snapshot.decisionBaseline?.nodeId,
        threadId: gate.sourceThreadId,
        reasonCode,
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

function validateRequest(input: HumanGateRequestInput): string {
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
  const binding = getHarnessFeatureBinding(input.projectId, input.featureId)
  if (!binding) throw halt("humanGate 对应的 Feature 绑定不存在")
  return message
}

export async function requestHumanGate(input: HumanGateRequestInput): Promise<HumanGateLease> {
  const message = validateRequest(input)
  const key = featureKey(input.projectId, input.featureId)
  let active!: ActiveGate
  await featureLocks.withKey(key, async () => {
    const existing =
      activeGates.get(key) ?? getHarnessFeatureBinding(input.projectId, input.featureId)?.humanGate
    if (existing) {
      const conflictGate = "gate" in existing ? existing.gate : existing
      recordHumanGateEvent(
        "human_gate_conflict",
        {
          ...conflictGate,
          sourceThreadId: input.threadId,
          sourceManagedRunId: findManagedRunId(input.projectId, input.featureId, input.threadId),
          hookId: input.hookId,
          message
        },
        "human_gate_conflict"
      )
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
    setHarnessHumanGate(input.projectId, input.featureId, gate)
    activeGates.set(key, active)
    recordHumanGateEvent("human_gate_requested", gate)
    publishHumanGateChanged(gate, gate)

    const onAbort = (): void => {
      void rejectHumanGate(
        { projectId: gate.projectId, featureId: gate.featureId, gateId: gate.gateId },
        "human_gate_rejected"
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

export async function approveHumanGate(input: HarnessHumanGateDecisionInput): Promise<boolean> {
  const key = featureKey(input.projectId, input.featureId)
  return featureLocks.withKey(key, async () => {
    const active = activeGates.get(key)
    const persisted = getHarnessFeatureBinding(input.projectId, input.featureId)?.humanGate
    if (!active || active.state !== "pending" || persisted?.gateId !== input.gateId) return false
    active.state = "approved"
    recordHumanGateEvent("human_gate_approved", active.gate)
    setHarnessHumanGate(input.projectId, input.featureId, undefined)
    publishHumanGateChanged(active.gate)
    active.resolve("approve")
    return true
  })
}

export async function rejectHumanGate(
  input: HarnessHumanGateDecisionInput,
  reasonCode: "human_gate_rejected" | "app_closed_during_human_gate" = "human_gate_rejected"
): Promise<boolean> {
  const key = featureKey(input.projectId, input.featureId)
  let rejectedGate: HarnessHumanGateSnapshot | undefined
  let rejectedActive: ActiveGate | undefined
  const result = await featureLocks.withKey(key, async () => {
    const active = activeGates.get(key)
    const persisted = getHarnessFeatureBinding(input.projectId, input.featureId)?.humanGate
    if (persisted?.gateId !== input.gateId) return false
    rejectedGate = persisted
    rejectedActive = active
    recordHumanGateEvent("human_gate_rejected", persisted, reasonCode, false)
    setHarnessHumanGate(input.projectId, input.featureId, undefined)
    activeGates.delete(key)
    publishHumanGateChanged(persisted)
    return true
  })
  try {
    if (result && rejectedGate?.sourceManagedRunId) {
      const { cancelManagedRunForHumanGate } = await import("./auto-mode-controller")
      await cancelManagedRunForHumanGate({
        projectId: rejectedGate.projectId,
        featureId: rejectedGate.featureId,
        runId: rejectedGate.sourceManagedRunId,
        threadId: rejectedGate.sourceThreadId,
        reasonCode,
        summary:
          reasonCode === "app_closed_during_human_gate"
            ? "应用在 Human Gate 等待期间关闭，托管运行已取消"
            : "Human Gate 未通过，托管运行已取消"
      })
    }
  } catch (error) {
    console.error("[HumanGate] Failed to cancel rejected ManagedRun:", error)
  } finally {
    rejectedActive?.resolve("reject")
  }
  return result
}

export function getHumanGateForThread(threadId: string): HarnessHumanGateSnapshot | undefined {
  return listHarnessHumanGates().find((gate) => gate.sourceThreadId === threadId)
}

export function listPendingHumanGateRuntimeThreadIds(): string[] {
  return [...activeGates.values()]
    .filter((active) => active.state === "pending")
    .map((active) => active.runtimeThreadId)
}

export async function recoverHumanGatesAtStartup(): Promise<void> {
  for (const gate of listHarnessHumanGates()) {
    await rejectHumanGate(gate, "app_closed_during_human_gate")
  }
}
