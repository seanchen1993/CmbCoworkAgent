import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { ManagedRunStartTimeField } from "./ManagedRunStartTimeField"
import {
  parseManagedRunScheduleTime,
  nextManagedRunScheduleTime,
  type ManagedRunSchedule
} from "../../../../shared/managed-run-schedule"

export function ManagedRunScheduleNotice({
  schedule,
  error,
  disabled,
  className,
  onRetry
}: {
  schedule: ManagedRunSchedule | null
  error?: string
  disabled?: boolean
  className?: string
  onRetry: () => void
}): React.JSX.Element | null {
  const [editing, setEditing] = useState(false)
  const [scheduledAt, setScheduledAt] = useState("")
  const [busy, setBusy] = useState(false)
  if (error)
    return (
      <div
        role="alert"
        className="ml-2 mr-3 mt-2 flex items-center gap-2 text-sm text-status-critical"
      >
        <span>读取托管预约失败：{error}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          重试
        </Button>
      </div>
    )
  if (!schedule) return null
  const starting = schedule.status === "starting"
  const identity = {
    projectId: schedule.projectId,
    featureId: schedule.featureId,
    scheduleId: schedule.scheduleId
  }
  const change = async (cancel: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (cancel) await window.api.harnessBoard.cancelManagedRunSchedule(identity)
      else {
        if (!(parseManagedRunScheduleTime(scheduledAt) > Date.now())) {
          throw new Error("请选择晚于当前时间的预约时间")
        }
        await window.api.harnessBoard.updateManagedRunSchedule({ ...identity, scheduledAt })
      }
      setEditing(false)
      toast.success(cancel ? "已退出预约托管模式" : "托管启动时间已修改")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className={cn(
        "ml-2 mr-3 mt-2 flex shrink-0 flex-wrap items-center justify-between gap-3 p-3",
        className
      )}
    >
      <div className="grid min-w-0 gap-1 text-sm" role="status">
        <span className="font-semibold">
          {starting
            ? "正在启动托管"
            : schedule.status === "pending"
              ? "已预约定时启动托管"
              : schedule.status === "missed"
                ? "托管预约已错过"
                : "预约托管启动失败"}
        </span>
        <span className="text-xs leading-5 text-muted-foreground">{schedule.scheduledAt}</span>
        {schedule.failureReason && (
          <span className="text-xs text-status-critical">{schedule.failureReason}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="rounded-md border-border/80"
          disabled={disabled || starting || busy}
          onClick={() => {
            setScheduledAt(
              parseManagedRunScheduleTime(schedule.scheduledAt) > Date.now()
                ? schedule.scheduledAt
                : nextManagedRunScheduleTime()
            )
            setEditing(true)
          }}
        >
          修改时间
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-md text-muted-foreground hover:text-status-critical"
          disabled={disabled || starting || busy}
          onClick={() => void change(true)}
        >
          取消预约
        </Button>
      </div>
      {editing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setEditing(false)
          }}
        >
          <DialogContent
            className="z-[60]"
            onPointerDownOutside={(event) => event.preventDefault()}
          >
            <DialogHeader>
              <DialogTitle>修改托管启动时间</DialogTitle>
            </DialogHeader>
            <ManagedRunStartTimeField
              scheduled
              scheduledAt={scheduledAt}
              onTimeChange={setScheduledAt}
              disabled={busy || starting}
            />
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setEditing(false)}>
                取消
              </Button>
              <Button
                disabled={busy || starting || disabled || !scheduledAt}
                onClick={() => void change(false)}
              >
                保存启动时间
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
