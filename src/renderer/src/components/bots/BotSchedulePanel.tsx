import { botErrorMessage } from "@/lib/bot-error-message"
import { useRef, useState } from "react"
import { Clock, Pause, Play, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import type { BotClient, BotSchedule, BotScheduleEditInput, BotScheduleInput } from "../../../../shared/bots/contracts"
import { BOT_WORK_MONITOR_MODES, type BotWorkScheduleMonitor } from "../../../../shared/bots/schedule-observation"
import { botSchedulePresentation, botWorkMonitorLabel, botWorkMonitorModeLabel } from "@/lib/bot-schedule-view"
import { useBotWorks } from "./use-bot-works"

function localDateTime(value?: string): string {
  if (!value) return ""
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ""
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

type ObservationEdit = NonNullable<BotScheduleEditInput["workMonitor"]>

function ObservationFields({ botId, client, original, value, disabled, onChange }: {
  botId: string
  client: BotClient
  original: BotWorkScheduleMonitor
  value: ObservationEdit
  disabled: boolean
  onChange(value: ObservationEdit): void
}) {
  const [choosing, setChoosing] = useState(false)
  const [title, setTitle] = useState(original.lastSuccessful?.title ?? "当前任务")
  const directory = useBotWorks(client, choosing ? botId : undefined, null, 0)
  const tasks = [...new Map([...directory.priority, ...directory.items].map(work => [work.id, work])).values()]
    .filter(work => !work.source && !work.deletionPending && !work.deletionCommitted &&
      (!work.conversation || work.conversation.state === "bound"))
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm" title={title}>{title}</span>
        <Button type="button" variant="ghost" size="sm" aria-expanded={choosing} disabled={disabled}
          onClick={() => setChoosing(open => !open)}>{choosing ? "收起" : "更换观察任务"}</Button>
      </div>
      {choosing && <>
        <input className="bot-work-search" aria-label="搜索任务" placeholder="搜索已有任务…"
          value={directory.query} onChange={event => directory.setQuery(event.target.value)} />
        {directory.error && <p role="alert" className="text-sm text-destructive">{directory.error}</p>}
        <div className="grid max-h-36 gap-1 overflow-auto">
          {tasks.map(work => <Button key={work.id} type="button" variant="ghost" className="justify-start"
            disabled={disabled} onClick={() => {
              setTitle(work.title)
              onChange({ ...value, workId: work.id })
              setChoosing(false)
            }}><span className="truncate">{work.title}</span></Button>)}
          {directory.cursor && <Button type="button" variant="ghost" disabled={directory.loading || disabled}
            onClick={() => void directory.more()}>显示更多任务</Button>}
          {!directory.loading && !directory.error && !tasks.length &&
            <span className="text-sm text-muted-foreground">没有可观察的任务</span>}
        </div>
      </>}
      <label className="bot-field">
        通知条件
        <Select value={value.mode} disabled={disabled} onValueChange={mode => {
          const valid = BOT_WORK_MONITOR_MODES.find(candidate => candidate === mode)
          if (valid) onChange({ ...value, mode: valid })
        }}>
          <SelectTrigger aria-label="通知条件" className="h-11 rounded-xl shadow-none"><SelectValue /></SelectTrigger>
          <SelectContent data-bot-popup className="bot-workspace-select rounded-xl">
            {BOT_WORK_MONITOR_MODES.map(mode => <SelectItem key={mode} value={mode}>
              {botWorkMonitorModeLabel(mode)}
            </SelectItem>)}
          </SelectContent>
        </Select>
      </label>
    </div>
  )
}

export function BotSchedulePanel({
  botId,
  schedules,
  client,
  work,
  allowCreate = true
}: {
  botId: string
  schedules: BotSchedule[]
  client: BotClient
  work?: { id: string; title: string }
  allowCreate?: boolean
}) {
  const [editing, setEditing] = useState<BotSchedule | "new" | null>(null)
  const [observation, setObservation] = useState<ObservationEdit | undefined>()
  const [expiryInput, setExpiryInput] = useState<string | null>(null)
  const [input, setInput] = useState<BotScheduleInput>({
    name: "",
    message: "",
    frequency: "daily",
    runAtTime: "09:00",
    weekday: 1,
    intervalMinutes: 60,
    enabled: true
  })
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const creation = useRef<{ fingerprint: string; operationId: string } | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const mutate = async (operation: () => Promise<unknown>, close = false) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
      if (close) setEditing(null)
    } catch (cause) {
      setError(botErrorMessage(cause, "操作失败，请重试"))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const edit = (schedule: BotSchedule | "new", opener: HTMLButtonElement, action?: "reschedule" | "renew") => {
    trigger.current = opener
    setEditing(schedule)
    const original = schedule !== "new" ? schedule.workMonitor : undefined
    setObservation(original ? { workId: original.workId, mode: original.mode } : undefined)
    setExpiryInput(action === "renew" ? "" : null)
    setError(null)
    creation.current = null
    setInput(
      schedule === "new"
        ? {
            name: "",
            message: "",
            frequency: "daily",
            runAtTime: "09:00",
            weekday: 1,
            intervalMinutes: 60,
            enabled: true
          }
        : action
          ? { ...schedule, enabled: true, ...(schedule.frequency === "once" ? { runAt: undefined } : {}) }
          : schedule
    )
  }
  const followUp = editing && editing !== "new" ? editing.workMonitor ?? editing.fixedReminder : undefined
  const renewing = followUp?.ended === "expired" && input.enabled
  const save = (target: BotSchedule | "new") => {
    if (target !== "new") {
      const existing: BotScheduleEditInput = { id: target.id, version: target.version }
      if (observation && (observation.workId !== target.workMonitor?.workId ||
        observation.mode !== target.workMonitor?.mode)) existing.workMonitor = observation
      if (expiryInput === null || (expiryInput === "" && !followUp?.expiresAt && !renewing))
        return client.saveSchedule(botId, input, existing)
      const expires = new Date(expiryInput)
      if (!Number.isFinite(expires.getTime())) throw new Error("请选择有效的失效时间")
      return client.saveSchedule(botId, input, { ...existing, expiresAt: expires.toISOString() })
    }
    if (!work) return client.saveSchedule(botId, input, undefined)
    const fingerprint = JSON.stringify([work.id, input])
    if (creation.current?.fingerprint !== fingerprint)
      creation.current = { fingerprint, operationId: crypto.randomUUID() }
    return client.saveSchedule(botId, input, undefined, {
      workId: work.id,
      operationId: creation.current.operationId
    })
  }
  return (
    <section className="bot-detail-section bot-detail-card bot-schedules" aria-label="例行任务">
      <div className="bot-detail-card-heading">
        <h3>例行{schedules.length > 0 && <span className="bot-detail-count">{schedules.length}</span>}</h3>
        {allowCreate && (
          <button
            type="button" className="bot-icon-button"
            aria-label="创建例行任务"
            onClick={(event) => edit("new", event.currentTarget)}
          >
            <Plus size={15} />
          </button>
        )}
      </div>
      {error && !editing && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!schedules.length && (
        <p className="bot-detail-empty">暂无例行</p>
      )}
      {schedules.map((schedule) => {
        const presentation = botSchedulePresentation(schedule)
        const expired = (schedule.workMonitor ?? schedule.fixedReminder)?.ended === "expired"
        const action = schedule.pendingOccurrenceId ? "withdraw" : expired ? "renew" :
          presentation.reschedule ? "reschedule" : schedule.enabled ? "pause" : "resume"
        const actionLabel = {
          withdraw: "撤回本次执行", renew: "续期例行任务", reschedule: "重新安排例行任务",
          pause: "暂停例行任务", resume: "启用例行任务"
        }[action]
        const ActionIcon = action === "withdraw" || action === "pause" ? Pause : action === "resume" ? Play : Clock
        return (
          <div key={schedule.id} className="bot-schedule-row">
              <Clock size={15} className="bot-schedule-icon" aria-hidden="true" />
              <button type="button" className="bot-schedule-summary" aria-label="编辑例行任务"
                title={schedule.name} disabled={busy} onClick={(event) => edit(schedule, event.currentTarget)}>
                <span>{schedule.name}</span>
                <small title={presentation.label}>
                  {presentation.label}
                  {schedule.desktopWork && !work && " · 关联任务"}
                  {schedule.workMonitor && ` · ${botWorkMonitorLabel(schedule)}`}
                  {schedule.fixedReminder && " · 固定提醒"}
                </small>
              </button>
              <button
                type="button" className="bot-icon-button"
                disabled={busy || schedule.workMonitor?.ended === "condition"}
                aria-label={actionLabel}
                title={actionLabel}
                onClick={(event) =>
                  action === "reschedule" || action === "renew"
                    ? edit(schedule, event.currentTarget, action)
                    : void mutate(() =>
                        client.saveSchedule(
                          botId,
                          { ...schedule, enabled: action === "resume" },
                          { id: schedule.id, version: schedule.version,
                            ...(action === "withdraw" ? { withdrawTaskId: schedule.pendingOccurrenceId } : {}) }
                        )
                      )
                }
              >
                <ActionIcon size={13} />
              </button>
          </div>
        )
      })}
      {editing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setEditing(null)
          }}
        >
          <DialogContent
            className="bot-editor flex max-h-[calc(100dvh-3rem)] flex-col sm:max-w-[440px]"
            onCloseAutoFocus={(event) => {
              if (!trigger.current?.isConnected) return
              event.preventDefault()
              trigger.current.focus({ preventScroll: true })
            }}
          >
            <DialogHeader>
              <DialogTitle>{editing === "new" ? "创建例行任务" : renewing ? "续期例行任务" : "编辑例行任务"}</DialogTitle>
              <DialogDescription>
                {editing !== "new" && editing.fixedReminder
                  ? "按填写内容提醒一次。"
                  : editing !== "new" && editing.workMonitor
                  ? ""
                  : work
                    ? `到期在「${work.title}」中执行填写的工作。`
                    : editing !== "new" && editing.desktopWork
                      ? "到期在已关联的任务中继续执行。"
                      : ""}
                按本机时区执行；请保持应用在后台运行。
              </DialogDescription>
            </DialogHeader>
            <form
              className="min-h-0 space-y-4 overflow-y-auto overscroll-contain"
              onSubmit={(event) => {
                event.preventDefault()
                void mutate(() => save(editing), true)
              }}
            >
              <label className="bot-field">
                名称
                <input
                  autoFocus
                  required
                  maxLength={120}
                  value={input.name}
                  onChange={(event) =>
                    setInput((value) => ({ ...value, name: event.target.value }))
                  }
                />
              </label>
              {editing !== "new" && editing.workMonitor && observation && (
                <ObservationFields botId={botId} client={client} original={editing.workMonitor}
                  value={observation} disabled={busy} onChange={setObservation} />
              )}
              <label className="bot-field">
                {editing !== "new" && editing.fixedReminder ? "提醒内容" :
                  editing !== "new" && editing.workMonitor ? "观察说明" : "工作内容"}
                <textarea
                  required
                  rows={3}
                  maxLength={30_000}
                  value={input.message}
                  onChange={(event) =>
                    setInput((value) => ({ ...value, message: event.target.value }))
                  }
                />
              </label>
              <label className="bot-field">
                重复
                <Select
                  value={input.frequency}
                  disabled={busy || (editing !== "new" && Boolean(editing.fixedReminder))}
                  onValueChange={(frequency) =>
                    setInput((value) => ({
                      ...value,
                      frequency: frequency as BotScheduleInput["frequency"],
                      runAtTime: value.runAtTime ?? "09:00",
                      weekday: value.weekday ?? 1,
                      intervalMinutes: value.intervalMinutes ?? 60
                    }))
                  }
                >
                  <SelectTrigger aria-label="重复" className="h-11 rounded-xl shadow-none">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent data-bot-popup className="bot-workspace-select rounded-xl">
                    <SelectItem value="daily">每天</SelectItem>
                    <SelectItem value="weekly">每周</SelectItem>
                    <SelectItem value="interval">固定间隔</SelectItem>
                    <SelectItem value="once">仅一次</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              {input.frequency === "once" ? (
                <label className="bot-field">
                  时间
                  <input
                    required
                    type="datetime-local"
                    onChange={(event) => {
                      const date = new Date(event.target.value)
                      setInput((value) => ({
                        ...value,
                        runAt: Number.isFinite(date.getTime()) ? date.toISOString() : undefined
                      }))
                    }}
                    defaultValue={localDateTime(input.runAt)}
                  />
                </label>
              ) : input.frequency === "interval" ? (
                <label className="bot-field">
                  间隔（分钟）
                  <input
                    type="number"
                    required
                    min={5}
                    max={525600}
                    value={input.intervalMinutes ?? 60}
                    onChange={(event) =>
                      setInput((value) => ({
                        ...value,
                        intervalMinutes: Number(event.target.value)
                      }))
                    }
                  />
                </label>
              ) : (
                <label className="bot-field">
                  时刻
                  <input
                    type="time"
                    required
                    value={input.runAtTime ?? "09:00"}
                    onChange={(event) =>
                      setInput((value) => ({ ...value, runAtTime: event.target.value }))
                    }
                  />
                </label>
              )}
              {followUp && (
                <label className="bot-field">
                  失效时间
                  <input
                    aria-label="失效时间"
                    type="datetime-local"
                    required={Boolean(followUp.expiresAt || renewing)}
                    value={expiryInput ?? localDateTime(followUp.expiresAt)}
                    onChange={(event) => setExpiryInput(event.target.value)}
                  />
                </label>
              )}
              {input.frequency === "weekly" && (
                <label className="bot-field">
                  星期
                  <Select
                    value={String(input.weekday ?? 1)}
                    disabled={busy}
                    onValueChange={(weekday) =>
                      setInput((value) => ({ ...value, weekday: Number(weekday) }))
                    }
                  >
                    <SelectTrigger aria-label="星期" className="h-11 rounded-xl shadow-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent data-bot-popup className="bot-workspace-select rounded-xl">
                      {["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map(
                        (name, index) => (
                          <SelectItem key={index} value={String(index)}>
                            {name}
                          </SelectItem>
                        )
                      )}
                    </SelectContent>
                  </Select>
                </label>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                {editing !== "new" && (
                  <Button
                    variant="ghost"
                    type="button"
                    className="mr-auto text-destructive"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !window.confirm(`确定要删除例行任务「${editing.name}」吗？此操作不可撤销。`)
                      )
                        return
                      void mutate(() => client.removeSchedule(editing.id, editing.version), true)
                    }}
                  >
                    <Trash2 size={15} className="mr-2" />
                    删除
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setEditing(null)}
                >
                  取消
                </Button>
                <Button
                  className="rounded-full bg-foreground px-5 text-background hover:bg-foreground/90"
                  disabled={busy || !input.name.trim() || !input.message.trim()}
                >
                  {renewing ? "续期" : "保存"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
