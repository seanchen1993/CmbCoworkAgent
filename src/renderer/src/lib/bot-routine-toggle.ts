import type { BotSaveRoutineInput } from "../../../shared/bot-routines"
import type { BotRoutine } from "../../../shared/bot-types"
import { needsFutureOnceSchedule } from "./bot-routine-presentation"
import {
  acknowledgePendingRoutine,
  inspectPendingRoutine,
  isDefinitiveRoutineSaveError,
  rememberPendingRoutine
} from "./bot-routine-pending"

export interface BotRoutineOpenIntent {
  id: string
  dataEpoch: string
  mode: "view" | "recover" | "edit" | "reschedule" | "history" | "delete"
}

/** Preserve the original save identity before a toggle can reach the Host.
 * Busy state, view lifetime and editor ownership stay with the caller. */
export async function toggleBotRoutine(input: {
  botId: string
  routine: BotRoutine
  dataEpoch: string
  editorSupport: boolean
  mutationSupport: boolean
  readinessSupport?: boolean
  setup?(): void
  reschedule?(): void
  isLive(): boolean
  isCurrentEpoch(): boolean
  save(request: BotSaveRoutineInput): Promise<unknown>
  recover(): void
}): Promise<boolean> {
  const { botId, routine, dataEpoch } = input
  if (!dataEpoch || !input.isLive()) return false
  if (routine.botId !== botId) throw new Error("例程不属于此 Bot，请重新打开后核对。")
  // A lost pause acknowledgement must never become an inverse resume.
  if (input.editorSupport && inspectPendingRoutine(botId, routine.id, dataEpoch).kind !== "empty") {
    input.recover()
    return false
  }
  if (!input.mutationSupport) throw new Error("请更新 Bot 后台后调整例程。原记录保持不变。")
  if (input.readinessSupport && routine.effectiveState === "needs_setup" && routine.skillIssue) {
    input.setup?.()
    if (!input.setup) throw new Error("请在例程设置中核对技能后启用。")
    return false
  }
  // The old timestamp cannot be resumed. Open the existing editor before
  // generating a nonce or saving; never move the time or replay a consumed run.
  if (needsFutureOnceSchedule(routine)) {
    input.reschedule?.()
    if (!input.reschedule) throw new Error("请在例程设置中选择新的运行时间。")
    return false
  }
  const effectiveEnabled =
    routine.enabled && !(input.readinessSupport && routine.effectiveState === "needs_setup")
  const request: BotSaveRoutineInput = {
    ...(input.editorSupport ? { nonce: crypto.randomUUID() } : {}),
    expectedDataEpoch: dataEpoch,
    botId,
    id: routine.id,
    revision: routine.revision,
    name: routine.name,
    prompt: routine.prompt,
    schedule: routine.schedule,
    timezone: routine.timezone,
    enabled: !effectiveEnabled,
    ...(input.readinessSupport ? { desiredEnabled: !effectiveEnabled } : {})
  }
  if (request.nonce) rememberPendingRoutine(request, dataEpoch)
  if (!input.isLive()) return false
  try {
    await input.save(request)
  } catch (error) {
    if (request.nonce && input.isCurrentEpoch()) {
      if (isDefinitiveRoutineSaveError(error)) acknowledgePendingRoutine(request, dataEpoch)
      else if (input.isLive()) input.recover()
    }
    throw error
  }
  if (request.nonce && input.isCurrentEpoch() && !acknowledgePendingRoutine(request, dataEpoch)) {
    if (input.isLive()) input.recover()
    throw new Error("例程结果已确认，本机记录尚未清除。请在编辑器中核对原请求。")
  }
  return true
}
