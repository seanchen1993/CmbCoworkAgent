import type { BotRoutine } from "../../../shared/bot-types"

/** This describes the scheduler cursor, never successful task delivery. Human
 * pauses, skill revocations, clones and restored schedules are distinct. */
export function endedOnceSchedule(routine: BotRoutine): boolean {
  return (
    routine.schedule.kind === "once" &&
    !routine.enabled &&
    routine.desiredEnabled === true &&
    routine.nextAt === null &&
    !routine.activationRequired &&
    !routine.skillIssue
  )
}

export function needsFutureOnceSchedule(routine: BotRoutine, now = Date.now()): boolean {
  return !routine.enabled && routine.schedule.kind === "once" && routine.schedule.at <= now
}

export function routineStatusLabel(routine: BotRoutine, readinessSupport = false): string {
  if (readinessSupport && routine.effectiveState === "needs_setup")
    return routine.skillIssue ? "需要设置" : "已验证，待确认启用"
  if (routine.skillIssue) return "需要核对技能"
  if (endedOnceSchedule(routine)) return "计划已结束"
  if (!routine.enabled) return "已暂停"
  if (routine.nextAt !== null) return "按计划运行"
  return routine.schedule.kind === "event" ? "等待事件触发" : "已启用"
}

export function routineToggleLabel(routine: BotRoutine, readinessSupport = false): string {
  const needsSetup = readinessSupport && routine.effectiveState === "needs_setup"
  if (needsSetup && routine.skillIssue) return "核对设置"
  if (routine.enabled && !needsSetup) return "暂停"
  if (needsFutureOnceSchedule(routine)) return "重新安排"
  return readinessSupport ? "启用" : "恢复"
}
