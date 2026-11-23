import { useId, useRef, useState } from "react"
import { Clock, Pause, Play, Plus } from "lucide-react"
import { botErrorMessage } from "@/lib/bot-error-message"
import { botSchedulePresentation, botWorkMonitorLabel } from "@/lib/bot-schedule-view"
import type { BotClient, BotSchedule } from "../../../../shared/bots/contracts"
import { BotDetailCard } from "./BotDetailsPane"
import { BotScheduleEditor, type BotScheduleEditorTarget } from "./BotScheduleEditor"

const COLLAPSED_SCHEDULE_COUNT = 4

export function BotSchedulePanel({
  botId,
  schedules,
  groupId,
  client,
  work,
  allowCreate = true,
  readOnly = false,
  emptyMessage = "暂无例行任务"
}: {
  botId: string
  groupId?: string
  schedules: BotSchedule[]
  client: BotClient
  work?: { id: string; title: string }
  allowCreate?: boolean
  readOnly?: boolean
  emptyMessage?: string
}) {
  const listId = useId()
  const [expanded, setExpanded] = useState(false)
  const visibleSchedules = expanded ? schedules : schedules.slice(0, COLLAPSED_SCHEDULE_COUNT)
  const [editing, setEditing] = useState<BotScheduleEditorTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const update = async (operation: () => Promise<unknown>) => {
    if (lock.current || readOnly) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
    } catch (cause) {
      setError(botErrorMessage(cause, "操作失败，请重试"))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const edit = (
    schedule: BotSchedule | "new",
    opener: HTMLButtonElement,
    action?: BotScheduleEditorTarget["action"]
  ) => {
    setError(null)
    setEditing({ schedule, opener, action })
  }
  return (
    <BotDetailCard
      className="bot-schedules"
      title="例行任务"
      count={schedules.length}
      actions={
        allowCreate &&
        !readOnly && (
          <button
            type="button"
            className="bot-icon-button"
            aria-label="创建例行任务"
            onClick={(event) => edit("new", event.currentTarget)}
          >
            <Plus size={15} />
          </button>
        )
      }
    >
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!schedules.length && <p className="bot-detail-empty">{emptyMessage}</p>}
      {visibleSchedules.map((schedule) => {
        const nameId = `${listId}-${schedule.id}`
        const presentation = botSchedulePresentation(schedule)
        const expired = (schedule.workMonitor ?? schedule.fixedReminder)?.ended === "expired"
        const action = schedule.pendingOccurrenceId
          ? "withdraw"
          : expired
            ? "renew"
            : presentation.reschedule
              ? "reschedule"
              : schedule.enabled
                ? "pause"
                : "resume"
        const actionLabel = {
          withdraw: "撤回本次执行",
          renew: "续期例行任务",
          reschedule: "重新安排例行任务",
          pause: "暂停例行任务",
          resume: "启用例行任务"
        }[action]
        const ActionIcon =
          action === "withdraw" || action === "pause" ? Pause : action === "resume" ? Play : Clock
        return (
          <div key={schedule.id} className="bot-schedule-row">
            <Clock size={15} className="bot-schedule-icon" aria-hidden="true" />
            <button
              type="button"
              className="bot-schedule-summary"
              aria-label={readOnly ? "查看例行任务" : "编辑例行任务"}
              aria-describedby={nameId}
              title={schedule.name}
              disabled={busy}
              onClick={(event) => edit(schedule, event.currentTarget)}
            >
              <span id={nameId}>{schedule.name}</span>
              <small title={presentation.label}>
                {presentation.label}
                {schedule.desktopWork && !work && " · 关联任务"}
                {schedule.workMonitor && ` · ${botWorkMonitorLabel(schedule)}`}
                {schedule.fixedReminder && " · 固定提醒"}
                {schedule.explicitSkill && ` · /${schedule.explicitSkill.name}`}
              </small>
            </button>
            {!readOnly && (
              <button
                type="button"
                className="bot-icon-button"
                disabled={busy || schedule.workMonitor?.ended === "condition"}
                aria-label={actionLabel}
                aria-describedby={nameId}
                title={actionLabel}
                onClick={(event) =>
                  action === "reschedule" || action === "renew"
                    ? edit(schedule, event.currentTarget, action)
                    : void update(() =>
                        client.saveSchedule(
                          botId,
                          { ...schedule, enabled: action === "resume" },
                          {
                            id: schedule.id,
                            version: schedule.version,
                            ...(action === "withdraw"
                              ? { withdrawTaskId: schedule.pendingOccurrenceId }
                              : {})
                          }
                        )
                      )
                }
              >
                <ActionIcon size={13} />
              </button>
            )}
          </div>
        )
      })}
      {schedules.length > COLLAPSED_SCHEDULE_COUNT && (
        <button
          type="button"
          className="bot-work-more"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起例行任务" : `展开其余 ${schedules.length - visibleSchedules.length} 项`}
        </button>
      )}
      {editing && (
        <BotScheduleEditor
          client={client}
          botId={botId}
          target={editing}
          groupId={groupId}
          work={work}
          readOnly={readOnly}
          onClose={() => setEditing(null)}
        />
      )}
    </BotDetailCard>
  )
}
