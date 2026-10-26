import { botErrorMessage } from "@/lib/bot-error-message"
import { useRef, useState } from "react"
import { Clock, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react"
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
import type { BotClient, BotSchedule, BotScheduleInput } from "../../../../shared/bots/contracts"
import { botSchedulePresentation } from "@/lib/bot-schedule-view"

export function BotSchedulePanel({
  botId,
  schedules,
  client
}: {
  botId: string
  schedules: BotSchedule[]
  client: BotClient
}) {
  const [editing, setEditing] = useState<BotSchedule | "new" | null>(null)
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
  const edit = (schedule: BotSchedule | "new", opener: HTMLButtonElement, reschedule = false) => {
    trigger.current = opener
    setEditing(schedule)
    setError(null)
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
        : reschedule
          ? { ...schedule, enabled: true, runAt: undefined }
          : schedule
    )
  }
  return (
    <section className="bot-detail-section">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="!mb-0">例行任务</h3>
        <button
          className="bot-icon-button"
          aria-label="创建例行任务"
          onClick={(event) => edit("new", event.currentTarget)}
        >
          <Plus size={15} />
        </button>
      </div>
      {error && !editing && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!schedules.length && (
        <p className="text-muted-foreground">在聊天中安排一项定期工作，或点击 + 创建。</p>
      )}
      {schedules.map((schedule) => {
        const presentation = botSchedulePresentation(schedule)
        return (
          <div key={schedule.id} className="bot-task-item">
            <div className="flex items-center gap-2">
              <Clock size={13} />
              <span className="min-w-0 flex-1 truncate">{schedule.name}</span>
              <button
                className="bot-icon-button"
                disabled={busy}
                aria-label={
                  presentation.reschedule
                    ? "重新安排例行任务"
                    : schedule.enabled
                      ? "暂停例行任务"
                      : "启用例行任务"
                }
                onClick={(event) =>
                  presentation.reschedule
                    ? edit(schedule, event.currentTarget, true)
                    : void mutate(() =>
                        client.saveSchedule(
                          botId,
                          { ...schedule, enabled: !schedule.enabled },
                          { id: schedule.id, version: schedule.version }
                        )
                      )
                }
              >
                {presentation.reschedule ? (
                  <Clock size={13} />
                ) : schedule.enabled ? (
                  <Pause size={13} />
                ) : (
                  <Play size={13} />
                )}
              </button>
              <button
                className="bot-icon-button"
                disabled={busy}
                aria-label="编辑例行任务"
                onClick={(event) => edit(schedule, event.currentTarget)}
              >
                <Pencil size={13} />
              </button>
            </div>
            <small>{presentation.label}</small>
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
              <DialogTitle>{editing === "new" ? "创建例行任务" : "编辑例行任务"}</DialogTitle>
              <DialogDescription>按本机时区执行；请保持应用在后台运行。</DialogDescription>
            </DialogHeader>
            <form
              className="min-h-0 space-y-4 overflow-y-auto overscroll-contain"
              onSubmit={(event) => {
                event.preventDefault()
                void mutate(
                  () =>
                    client.saveSchedule(
                      botId,
                      input,
                      editing === "new" ? undefined : { id: editing.id, version: editing.version }
                    ),
                  true
                )
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
              <label className="bot-field">
                工作内容
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
                    defaultValue={
                      input.runAt
                        ? (() => {
                            const date = new Date(input.runAt!)
                            return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
                              .toISOString()
                              .slice(0, 16)
                          })()
                        : ""
                    }
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
                  保存
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
