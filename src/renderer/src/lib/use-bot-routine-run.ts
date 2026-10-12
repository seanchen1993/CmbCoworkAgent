import { useBotTrackedWork } from "./use-bot-tracked-work"
import { botApi } from "./bot-api"
import { useLayoutEffect, useRef, useState } from "react"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import {
  acknowledgePendingRoutineRun,
  inspectPendingRoutineRun,
  discardPendingRoutineRun,
  rememberPendingRoutineRun
} from "./bot-routine-run-pending"
import type { BotRoutine, BotRunStatus } from "../../../shared/bot-types"
export type BotRoutineRunOptions = (
  | {
      routine: Pick<BotRoutine, "botId" | "id" | "revision"> & Partial<Pick<BotRoutine, "schedule">>
      pendingTarget?: never
    }
  | { routine?: never; pendingTarget: { botId: string; id: string } }
) & {
  dataEpoch: string
  disabled: boolean
  onPendingCleared?(): void
}
const rejected = new Set([
  "invalid_input",
  "not_found",
  "version_conflict",
  "nonce_conflict",
  "skill_changed",
  "skill_unavailable",
  "skill_unverified",
  "skill_scope",
  "skill_catalog_unavailable",
  "event_version_required"
])
const labels: Partial<Record<BotRunStatus, string>> = {
  queued: "等待执行",
  running: "运行中",
  waiting_input: "等待处理",
  cancelling: "正在停止",
  needs_review: "待核对"
}

/** The Host receipt owns submission. A lost reply reuses its exact request,
 * including across dialog remounts; workspace snapshots own the live status. */
export function useBotRoutineRun({
  routine,
  pendingTarget,
  dataEpoch,
  disabled,
  onPendingCleared,
  visible
}: BotRoutineRunOptions & { visible: boolean }) {
  const target = routine ?? pendingTarget
  const requiresEventVersion =
    routine?.schedule?.kind === "event" && routine.schedule.eventPolicy?.mode === "latest-state"
  const supported = useBotWorkspaceStore((state) =>
    Boolean(
      state.host?.capabilities?.includes("routine-run-version") &&
      state.host?.capabilities?.includes("mutation-data-epoch-v2")
    )
  )
  const tracked = useBotTrackedWork(
    visible ? { kind: "routine", botId: target.botId, routineId: target.id } : undefined
  )
  const legacyActive = useBotWorkspaceStore((state) =>
    state.snapshot?.runs.find(
      (run) =>
        run.botId === target.botId &&
        run.source === `routine-manual:${target.id}` &&
        labels[run.status]
    )
  )
  const active = tracked.supported ? tracked.value?.run : legacyActive
  const statusUnknown = tracked.supported && !tracked.value
  const [editingEpoch] = useState(dataEpoch)
  const [authorityRetired, setAuthorityRetired] = useState(false)
  const mounted = useRef(true)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const currentEpoch = () =>
    (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === editingEpoch
  const live = () => mounted.current && currentEpoch()
  const [record, setRecord] = useState(() =>
    inspectPendingRoutineRun(target.botId, target.id, editingEpoch)
  )
  const pending = record.kind === "valid" ? record.input : null
  const blocked = record.kind !== "empty" && record.kind !== "valid"
  const [acknowledgementPending, setAcknowledgementPending] = useState(false)
  const acknowledged = useRef<{
    input: import("@/lib/bot-routine-run-pending").PendingRoutineRun
    rejected?: string
  } | null>(null)
  const refreshRecord = () =>
    setRecord(inspectPendingRoutineRun(target.botId, target.id, editingEpoch))
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const submit = async () => {
    if (
      !live() ||
      authorityRetired ||
      inFlight.current ||
      disabled ||
      (requiresEventVersion && !pending) ||
      blocked ||
      !supported ||
      (statusUnknown && !pending) ||
      (active && !pending)
    )
      return
    const current = inspectPendingRoutineRun(target.botId, target.id, editingEpoch)
    if (current.kind !== "empty" && current.kind !== "valid") {
      setRecord(current)
      return
    }
    const input =
      acknowledged.current?.input ??
      (current.kind === "valid"
        ? current.input
        : routine
          ? {
              botId: target.botId,
              id: target.id,
              revision: routine.revision,
              nonce: crypto.randomUUID(),
              expectedDataEpoch: editingEpoch
            }
          : null)
    if (!input) return
    try {
      if (!acknowledged.current) rememberPendingRoutineRun(input, editingEpoch)
      refreshRecord()
    } catch (error) {
      refreshRecord()
      setFailure(error instanceof Error ? error.message : "无法保留运行记录")
      return
    }
    if (!live()) return
    inFlight.current = true
    setBusy(true)
    setFailure(null)
    try {
      let receipt = acknowledged.current
      if (!receipt) {
        try {
          await botApi.runRoutine({
            id: input.id,
            nonce: input.nonce,
            revision: input.revision,
            ...(input.expectedDataEpoch === undefined
              ? {}
              : { expectedDataEpoch: input.expectedDataEpoch })
          })
          receipt = { input }
        } catch (error) {
          if (!currentEpoch()) return
          if ((error as { code?: string })?.code === "data_epoch") {
            if (live()) {
              setAuthorityRetired(true)
              setFailure("工作区数据已恢复，请重新打开例程。原运行记录仍保留，需核对原结果。")
            }
            return
          }
          if (!rejected.has((error as { code?: string })?.code ?? "")) {
            if (live()) setFailure("尚未确认运行状态。重试将核对同一次请求。")
            return
          }
          receipt = { input, rejected: error instanceof Error ? error.message : "例程未能启动" }
        }
      }
      if (!currentEpoch()) return
      acknowledged.current = receipt
      if (mounted.current) setAcknowledgementPending(true)
      if (!receipt.rejected && live()) await useBotWorkspaceStore.getState().refresh()
      if (!currentEpoch()) return
      if (!acknowledgePendingRoutineRun(input, editingEpoch)) {
        if (live()) setFailure("运行结果已确认，本机记录尚未清除。重试只同步结果和核对此条记录。")
        return
      }
      acknowledged.current = null
      if (mounted.current) setAcknowledgementPending(false)
      if (live()) {
        refreshRecord()
        onPendingCleared?.()
        if (receipt.rejected) setFailure(receipt.rejected)
      }
    } catch {
      if (live()) setFailure("运行结果已确认，状态同步失败。重试只同步结果和核对此条记录。")
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const buttonDisabled =
    disabled ||
    (requiresEventVersion && !pending) ||
    authorityRetired ||
    blocked ||
    dataEpoch !== editingEpoch ||
    !currentEpoch() ||
    busy ||
    !supported ||
    (statusUnknown && !pending) ||
    Boolean(active && !pending)
  const label = busy
    ? "确认中…"
    : pending
      ? "核对并重试"
      : requiresEventVersion
        ? "通过带版本事件运行"
        : statusUnknown
          ? "同步状态…"
          : active
            ? labels[active.status]
            : "运行一次"
  return {
    active,
    supported,
    trackedError: tracked.error,
    record,
    pending,
    blocked,
    failure,
    busy,
    buttonDisabled,
    label,
    hidden: Boolean(pendingTarget && record.kind === "empty" && !acknowledgementPending),
    showFeedback: Boolean(
      busy || active || pending || blocked || failure || tracked.error || statusUnknown
    ),
    editingEpoch,
    submit,
    discard: (raw: string) => discardPendingRoutineRun(target.botId, target.id, editingEpoch, raw),
    repaired: () => {
      acknowledged.current = null
      if (mounted.current) setAcknowledgementPending(false)
      refreshRecord()
      setFailure(null)
      onPendingCleared?.()
    }
  }
}
export type BotRoutineRunController = ReturnType<typeof useBotRoutineRun>
