import { CalendarClock, Pause, Pencil, Play, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BotRoutine } from "../../../../shared/bot-types"
import { BotRoutineActions } from "./BotRoutineActions"
import { formatRoutineSchedule } from "@/lib/bot-routine-draft"
import { routineStatusLabel, routineToggleLabel } from "@/lib/bot-routine-presentation"

/** Present saved state only; the resource owner retains mutation and version guards. */
export function BotRoutineCard({
  routine,
  dataEpoch,
  busy,
  readinessSupport = false,
  detail = false,
  edit,
  editInChat,
  history,
  webhook,
  remove,
  toggle
}: {
  routine: BotRoutine
  dataEpoch?: string
  busy: boolean
  readinessSupport?: boolean
  detail?: boolean
  edit?: () => void
  editInChat?: () => void
  history?: () => void
  webhook?: () => void
  remove?: () => void
  toggle(): void
}) {
  if (detail)
    return (
      <BotRoutineDetail
        routine={routine}
        dataEpoch={dataEpoch}
        busy={busy}
        readinessSupport={readinessSupport}
        edit={edit}
        editInChat={editInChat}
        history={history}
        webhook={webhook}
        remove={remove}
        toggle={toggle}
      />
    )
  const needsSetup = readinessSupport && routine.effectiveState === "needs_setup"
  const effectiveEnabled = routine.enabled && !needsSetup
  return (
    <BotRoutineActions
      key={`${dataEpoch}:${routine.id}`}
      routine={routine}
      dataEpoch={dataEpoch}
      busy={busy}
      mutationDisabled={busy || !dataEpoch}
      readinessSupport={readinessSupport}
      inlineRun
      edit={edit}
      editInChat={editInChat}
      history={history}
      webhook={webhook}
      remove={remove}
      toggle={toggle}
    >
      {(more, runControl) => (
        <div
          id={`bot-routine-${routine.id}`}
          tabIndex={0}
          className="bot-routine-card rounded-2xl border p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
              <CalendarClock size={18} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <h3 className="break-words text-sm font-medium leading-6">{routine.name}</h3>
              <p className="text-xs text-muted-foreground">
                {routineStatusLabel(routine, readinessSupport)}
              </p>
            </div>
            {more}
          </div>
          <p className="my-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
            {routine.prompt}
          </p>
          {!!routine.skillReferences?.length && (
            <p className="mb-3 break-words text-xs text-muted-foreground">
              技能：
              {routine.skillReferences
                .map((skill) => `${skill.name} · v${skill.version}`)
                .join("、")}
            </p>
          )}
          {routine.skillIssue && (
            <p role="status" className="mb-3 text-xs text-destructive">
              {routine.skillIssue}。请编辑例程确认版本后恢复。
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t pt-3">
            <small className="min-w-0 max-w-full break-words text-xs leading-relaxed text-muted-foreground">
              {effectiveEnabled && routine.nextAt
                ? `下次：${new Date(routine.nextAt).toLocaleString(undefined, { timeZone: routine.timezone })}`
                : formatRoutineSchedule(routine.schedule, routine.timezone)}
              <span className="mt-0.5 block text-[11px]">{routine.timezone}</span>
            </small>
            <div className="ml-auto flex items-start gap-1">
              {runControl}
              {edit && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={edit}
                  className="rounded-lg"
                >
                  <Pencil size={14} aria-hidden="true" />
                  编辑
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </BotRoutineActions>
  )
}

/** Detail always describes the saved trigger, including full custom expressions. */
function routineDetailSchedule(routine: BotRoutine): string {
  const text = formatRoutineSchedule(routine.schedule, routine.timezone)
  if (routine.schedule.kind === "event") return `事件触发：${routine.schedule.topic}`
  if (routine.schedule.kind === "cron" && text.startsWith("自定义 cron："))
    return `自定义 cron：${routine.schedule.expression}`
  return text
}

function BotRoutineDetail({
  routine,
  dataEpoch,
  busy,
  readinessSupport = false,
  edit,
  editInChat,
  history,
  webhook,
  remove,
  toggle
}: Parameters<typeof BotRoutineCard>[0]) {
  const needsSetup = readinessSupport && routine.effectiveState === "needs_setup"
  const effectiveEnabled = routine.enabled && !needsSetup
  const state = routineStatusLabel(routine, readinessSupport)
  const toggleLabel = routineToggleLabel(routine, readinessSupport)
  return (
    <BotRoutineActions
      key={`${dataEpoch}:${routine.id}`}
      routine={routine}
      dataEpoch={dataEpoch}
      busy={busy}
      mutationDisabled={busy || !dataEpoch}
      readinessSupport={readinessSupport}
      inlineRun
      edit={edit}
      editInChat={editInChat}
      history={history}
      webhook={webhook}
      remove={remove}
      toggle={toggle}
    >
      {(more, runControl) => (
        <div
          id={`bot-routine-${routine.id}`}
          tabIndex={0}
          className="bot-routine-card bot-routine-detail-content outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="bot-routine-detail-body space-y-6 px-6 py-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">{state}</p>
              {more}
            </div>
            <section>
              <h3 className="text-xs font-medium text-muted-foreground">指令</h3>
              <p
                data-testid="bot-routine-instruction"
                className="my-3 whitespace-pre-wrap break-words text-sm leading-relaxed"
              >
                {routine.prompt}
              </p>
            </section>
            <section className="space-y-3">
              <h3 className="text-xs font-medium text-muted-foreground">何时运行</h3>
              <small
                data-testid="bot-routine-schedule"
                className="block min-w-0 max-w-full whitespace-pre-wrap break-words text-sm leading-relaxed"
              >
                {routineDetailSchedule(routine)}
                <span className="mt-1 block text-xs text-muted-foreground">{routine.timezone}</span>
              </small>
              {effectiveEnabled && routine.nextAt && (
                <p className="text-xs text-muted-foreground">
                  下次：
                  {new Date(routine.nextAt).toLocaleString(undefined, {
                    timeZone: routine.timezone
                  })}
                </p>
              )}
            </section>
            {!!routine.skillReferences?.length && (
              <p className="break-words text-xs text-muted-foreground">
                技能：
                {routine.skillReferences
                  .map((skill) => `${skill.name} · v${skill.version}`)
                  .join("、")}
              </p>
            )}
            {routine.skillIssue && (
              <p role="status" className="text-xs text-destructive">
                {routine.skillIssue}。请编辑例程确认版本后恢复。
              </p>
            )}
            {runControl}
          </div>
          <footer className="bot-routine-detail-footer flex flex-wrap items-center gap-2 px-4 py-4">
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              disabled={busy || !dataEpoch}
              onClick={toggle}
            >
              {effectiveEnabled ? <Pause size={14} /> : <Play size={14} />}
              {toggleLabel}
            </Button>
            {editInChat && (
              <Button
                size="sm"
                variant="outline"
                className="rounded-full"
                disabled={busy}
                onClick={editInChat}
              >
                <Pencil size={14} />
                编辑
              </Button>
            )}
            {remove && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto rounded-full text-destructive"
                disabled={busy}
                onClick={remove}
              >
                <Trash2 size={14} />
                删除
              </Button>
            )}
          </footer>
        </div>
      )}
    </BotRoutineActions>
  )
}
