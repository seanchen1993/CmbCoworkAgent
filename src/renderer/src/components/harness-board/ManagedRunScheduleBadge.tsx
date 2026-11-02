import { useRef, useState } from "react"
import { ChevronDown, Clock, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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

export function ManagedRunScheduleBadge({
  schedule,
  error,
  disabled,
  onRetry
}: {
  schedule: ManagedRunSchedule | null
  error?: string
  disabled?: boolean
  onRetry: () => void
}): React.JSX.Element | null {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [scheduledAt, setScheduledAt] = useState("")
  const [busy, setBusy] = useState(false)
  if (!schedule && !error) return null
  const starting = schedule?.status === "starting"
  const label = error
    ? "预约状态读取失败"
    : starting
      ? "正在启动托管"
      : schedule?.status === "pending"
        ? "已预约托管运行"
        : schedule?.status === "missed"
          ? "托管预约已错过"
          : "预约托管启动失败"
  const tone = error
    ? "border-status-critical/40 bg-status-critical/10 text-status-critical hover:bg-status-critical/20"
    : starting
      ? "border-status-info/40 bg-status-info/10 text-status-info hover:bg-status-info/20"
      : schedule?.status === "pending"
        ? "border-status-nominal/50 bg-status-nominal/10 text-status-nominal hover:bg-status-nominal/20"
        : "border-status-warning/40 bg-status-warning/10 text-status-warning hover:bg-status-warning/20"
  const change = async (cancel: boolean): Promise<void> => {
    if (!schedule || busy || starting || disabled) return
    const identity = {
      projectId: schedule.projectId,
      featureId: schedule.featureId,
      scheduleId: schedule.scheduleId
    }
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
      setOpen(false)
      toast.success(cancel ? "已取消托管预约" : "托管启动时间已修改")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next)
        }}
      >
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            disabled={disabled || busy}
            title="查看预约时间、修改时间或取消预约"
            className={cn(
              "inline-flex h-6 max-w-full shrink-0 cursor-pointer items-center gap-1.5 rounded border px-2 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              tone
            )}
          >
            {starting ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <Clock className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{label}</span>
            <ChevronDown
              className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          aria-label="托管预约操作"
          className="w-72 space-y-3 p-3"
          onCloseAutoFocus={(event) => {
            if (editing) event.preventDefault()
          }}
        >
          {error ? (
            <>
              <p role="alert" className="break-words text-xs text-status-critical">
                {error}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setOpen(false)
                  onRetry()
                }}
              >
                重试
              </Button>
            </>
          ) : (
            schedule && (
              <>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">预约启动时间</p>
                  <p className="text-sm font-medium tabular-nums">{schedule.scheduledAt}</p>
                </div>
                {schedule.failureReason && (
                  <p className="break-words text-xs text-status-critical">
                    {schedule.failureReason}
                  </p>
                )}
                {starting && (
                  <p className="text-xs text-muted-foreground">正在启动，完成后可停止托管运行。</p>
                )}
                <div className="flex items-center gap-2 border-t border-border/70 pt-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled || starting || busy}
                    onClick={() => {
                      setScheduledAt(
                        parseManagedRunScheduleTime(schedule.scheduledAt) > Date.now()
                          ? schedule.scheduledAt
                          : nextManagedRunScheduleTime()
                      )
                      setOpen(false)
                      setEditing(true)
                    }}
                  >
                    修改时间
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-status-critical hover:text-status-critical"
                    disabled={disabled || starting || busy}
                    onClick={() => void change(true)}
                  >
                    取消预约
                  </Button>
                </div>
              </>
            )
          )}
        </PopoverContent>
      </Popover>
      {editing && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next && !busy) setEditing(false)
          }}
        >
          <DialogContent
            className="z-[60]"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              triggerRef.current?.focus()
            }}
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
    </>
  )
}
