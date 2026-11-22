import { useRef, useState } from "react"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { botErrorMessage } from "@/lib/bot-error-message"
import { botSchedulePresentation, botWorkMonitorModeLabel } from "@/lib/bot-schedule-view"
import type {
  BotClient,
  BotSchedule,
  BotScheduleEditInput,
  BotScheduleInput
} from "../../../../shared/bots/contracts"
import {
  BOT_WORK_MONITOR_MODES,
  type BotWorkScheduleMonitor
} from "../../../../shared/bots/schedule-observation"
import { useBotWorks } from "./use-bot-works"

function localDateTime(value?: string): string {
  if (!value) return ""
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ""
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

type ObservationEdit = NonNullable<BotScheduleEditInput["workMonitor"]>

function ObservationFields({
  botId,
  client,
  groupId,
  original,
  value,
  disabled,
  onChange
}: {
  botId: string
  client: BotClient
  groupId?: string
  original: BotWorkScheduleMonitor
  value: ObservationEdit
  disabled: boolean
  onChange(value: ObservationEdit): void
}) {
  const [choosing, setChoosing] = useState(false)
  const [title, setTitle] = useState(original.lastSuccessful?.title ?? "当前任务")
  const directory = useBotWorks(client, choosing ? botId : undefined, null, 0, groupId)
  const tasks = [
    ...new Map([...directory.priority, ...directory.items].map((work) => [work.id, work])).values()
  ].filter(
    (work) =>
      (groupId ? work.source?.transport === "im" && work.source.bindingId === groupId : !work.source || work.source.personal === true) &&
      !work.deletionPending &&
      !work.deletionCommitted &&
      (!work.conversation || work.conversation.state === "bound")
  )
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm" title={title}>
          {title}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={choosing}
          disabled={disabled}
          onClick={() => setChoosing((open) => !open)}
        >
          {choosing ? "收起" : "更换观察任务"}
        </Button>
      </div>
      {choosing && (
        <>
          <input
            className="bot-work-search"
            aria-label="搜索任务"
            placeholder="搜索已有任务…"
            value={directory.query}
            onChange={(event) => directory.setQuery(event.target.value)}
          />
          {directory.error && (
            <p role="alert" className="text-sm text-destructive">
              {directory.error}
            </p>
          )}
          <div className="grid max-h-36 gap-1 overflow-auto">
            {tasks.map((work) => (
              <Button
                key={work.id}
                type="button"
                variant="ghost"
                className="justify-start"
                disabled={disabled}
                onClick={() => {
                  setTitle(work.title)
                  onChange({ ...value, workId: work.id })
                  setChoosing(false)
                }}
              >
                <span className="truncate">{work.title}</span>
              </Button>
            ))}
            {directory.cursor && (
              <Button
                type="button"
                variant="ghost"
                disabled={directory.loading || disabled}
                onClick={() => void directory.more()}
              >
                显示更多任务
              </Button>
            )}
            {!directory.loading && !directory.error && !tasks.length && (
              <span className="text-sm text-muted-foreground">没有可观察的任务</span>
            )}
          </div>
        </>
      )}
      <label className="bot-field">
        通知条件
        <Select
          value={value.mode}
          disabled={disabled}
          onValueChange={(mode) => {
            const valid = BOT_WORK_MONITOR_MODES.find((candidate) => candidate === mode)
            if (valid) onChange({ ...value, mode: valid })
          }}
        >
          <SelectTrigger aria-label="通知条件" className="h-11 rounded-xl shadow-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent data-bot-popup className="bot-workspace-select rounded-xl">
            {BOT_WORK_MONITOR_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {botWorkMonitorModeLabel(mode)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    </div>
  )
}

export type BotScheduleEditorTarget = {
  schedule: BotSchedule | "new"
  opener: HTMLButtonElement
  action?: "reschedule" | "renew"
}

export function BotScheduleEditor({
  target,
  botId,
  client,
  groupId,
  work,
  readOnly = false,
  onClose
}: {
  target: BotScheduleEditorTarget
  botId: string
  client: BotClient
  groupId?: string
  work?: { id: string; title: string }
  readOnly?: boolean
  onClose(): void
}) {
  const { schedule: editing, opener, action } = target
  const [input, setInput] = useState<BotScheduleInput>(() => {
    if (editing === "new")
      return {
        name: "",
        message: "",
        frequency: "daily",
        runAtTime: "09:00",
        weekday: 1,
        intervalMinutes: 60,
        enabled: true
      }
    return action
      ? { ...editing, enabled: true, ...(editing.frequency === "once" ? { runAt: undefined } : {}) }
      : editing
  })
  const original = editing === "new" ? undefined : editing.workMonitor
  const [observation, setObservation] = useState<ObservationEdit | undefined>(
    original && { workId: original.workId, mode: original.mode }
  )
  const [expiryInput, setExpiryInput] = useState<string | null>(action === "renew" ? "" : null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleting = confirmDelete && editing !== "new" && !readOnly
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const deleteButton = useRef<HTMLButtonElement>(null)
  const focusRegion = useRef(opener.closest<HTMLElement>(".bot-schedule-event, .bot-schedules"))
  const creation = useRef<{ fingerprint: string; operationId: string } | null>(null)
  const mutate = async (operation: () => Promise<unknown>) => {
    if (lock.current || readOnly) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
      onClose()
    } catch (cause) {
      setError(botErrorMessage(cause, "操作失败，请重试"))
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const dismiss = () => {
    if (lock.current) return
    if (!deleting) {
      onClose()
      return
    }
    setConfirmDelete(false)
    setError(null)
    requestAnimationFrame(() => deleteButton.current?.focus())
  }
  const followUp = editing !== "new" ? (editing.workMonitor ?? editing.fixedReminder) : undefined
  const renewing = followUp?.ended === "expired" && input.enabled
  const save = (target: BotSchedule | "new") => {
    if (target !== "new") {
      const existing: BotScheduleEditInput = { id: target.id, version: target.version }
      if (
        observation &&
        (observation.workId !== target.workMonitor?.workId ||
          observation.mode !== target.workMonitor?.mode)
      )
        existing.workMonitor = observation
      if (expiryInput === null || (expiryInput === "" && !followUp?.expiresAt && !renewing))
        return client.saveSchedule(botId, input, existing)
      const expires = new Date(expiryInput)
      if (!Number.isFinite(expires.getTime())) throw new Error("请选择有效的失效时间")
      return client.saveSchedule(botId, input, { ...existing, expiresAt: expires.toISOString() })
    }
    if (!work && !groupId) return client.saveSchedule(botId, input, undefined)
    const fingerprint = JSON.stringify([groupId, work?.id, input])
    if (creation.current?.fingerprint !== fingerprint)
      creation.current = { fingerprint, operationId: crypto.randomUUID() }
    return client.saveSchedule(botId, input, undefined, {
      ...(work ? { workId: work.id } : {}),
      ...(groupId ? { imConversationId: groupId } : {}),
      operationId: creation.current.operationId
    })
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <DialogContent
        className="bot-editor flex max-h-[calc(100dvh-3rem)] flex-col sm:max-w-[440px]"
        onCloseAutoFocus={(event) => {
          const region = focusRegion.current
          const next = opener.isConnected
            ? opener
            : (region?.querySelector<HTMLElement>("button:not(:disabled)") ?? region)
          if (next?.isConnected) {
            event.preventDefault()
            if (next === region) next.tabIndex = -1
            next.focus({ preventScroll: true })
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {deleting
              ? "删除例行任务？"
              : readOnly
                ? "例行任务详情"
                : editing === "new"
                  ? "创建例行任务"
                  : renewing
                    ? "续期例行任务"
                    : "编辑例行任务"}
          </DialogTitle>
          <DialogDescription>
            {deleting ? (
              `将删除「${editing.name}」。此操作不可撤销。`
            ) : readOnly && editing !== "new" ? (
              botSchedulePresentation(editing).label
            ) : (
              <>
                {editing !== "new" && editing.fixedReminder
                  ? "到点发送填写的提醒内容。"
                  : editing !== "new" && editing.workMonitor
                    ? ""
                    : work
                      ? `到期在「${work.title}」中执行填写的工作。`
                      : editing !== "new" && editing.desktopWork
                        ? "到期在已关联的任务中继续执行。"
                        : ""}
                按本机时区执行，请保持应用在后台运行。
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {deleting ? (
          <DialogFooter>
            <Button type="button" variant="ghost" autoFocus disabled={busy} onClick={dismiss}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void mutate(() => client.removeSchedule(editing.id, editing.version))}
            >
              确认删除
            </Button>
          </DialogFooter>
        ) : (
          <form
            className="min-h-0 space-y-4 overflow-y-auto overscroll-contain"
            onSubmit={(event) => {
              event.preventDefault()
              if (!readOnly) void mutate(() => save(editing))
            }}
          >
            <fieldset className="min-w-0 space-y-4" disabled={readOnly || busy}>
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
                <ObservationFields
                  botId={botId}
                  client={client}
                  groupId={groupId}
                  original={editing.workMonitor}
                  value={observation}
                  disabled={busy}
                  onChange={setObservation}
                />
              )}
              <label className="bot-field">
                {editing !== "new" && editing.fixedReminder
                  ? "提醒内容"
                  : editing !== "new" && editing.workMonitor
                    ? "观察说明"
                    : "工作内容"}
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
                  disabled={busy}
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
            </fieldset>
            <DialogFooter>
              {editing !== "new" && !readOnly && (
                <Button
                  ref={deleteButton}
                  variant="ghost"
                  type="button"
                  className="mr-auto text-destructive"
                  disabled={busy}
                  onClick={() => {
                    setError(null)
                    setConfirmDelete(true)
                  }}
                >
                  <Trash2 size={15} className="mr-2" />
                  删除
                </Button>
              )}
              <Button type="button" variant="ghost" disabled={busy} onClick={dismiss}>
                {readOnly ? "关闭详情" : "取消"}
              </Button>
              {!readOnly && (
                <Button
                  className="rounded-full bg-foreground px-5 text-background hover:bg-foreground/90"
                  disabled={busy || !input.name.trim() || !input.message.trim()}
                >
                  {renewing ? "续期" : "保存"}
                </Button>
              )}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
