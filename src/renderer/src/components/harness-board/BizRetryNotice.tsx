import { useState } from "react"
import { ChevronDown, Loader2, PauseCircle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useHarnessNotifications, refreshAppNotifications } from "@/lib/harness-notifications"
import { cn } from "@/lib/utils"

export function BizRetryNotice({
  projectId,
  featureId
}: {
  projectId: string
  featureId: string
}): React.JSX.Element | null {
  const notifications = useHarnessNotifications()
  const pending = notifications.find(
    (item) =>
      item.type === "biz_retry" &&
      item.status === "pending" &&
      item.projectId === projectId &&
      item.featureId === featureId
  )
  if (!pending) return null
  return (
    <BizRetryDecisionCard
      key={pending.notificationId}
      notificationId={pending.notificationId}
      message={pending.message}
      humanGatePending={notifications.some(
        (item) =>
          item.type === "human_gate" &&
          item.status === "pending" &&
          item.projectId === projectId &&
          item.featureId === featureId
      )}
    />
  )
}

export function BizRetryDecisionCard({
  notificationId,
  message,
  humanGatePending,
  className
}: {
  notificationId: string
  message: string
  humanGatePending: boolean
  className?: string
}): React.JSX.Element {
  const [input, setInput] = useState("")
  const [messageOpen, setMessageOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const decide = async (
    action: "stop" | "continue" | "new_thread",
    continueMessage = ""
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.appNotifications.decide({
        notificationId,
        action,
        message: action === "continue" ? continueMessage : undefined
      })
      if (!result.applied) {
        setError(result.message)
        toast.error(result.message)
      } else {
        setMessageOpen(false)
        toast(result.message)
      }
      await refreshAppNotifications()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className={cn(
        "mb-4 space-y-3 rounded-xl border border-status-warning/35 bg-status-warning/10 p-4 shadow-sm",
        className
      )}
    >
      <div className="flex items-start gap-3">
        <PauseCircle className="mt-0.5 size-5 shrink-0 text-status-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">托管运行需要人工确认</div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {message}
          </p>
        </div>
        {busy && <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />}
      </div>
      {humanGatePending && (
        <p className="text-xs text-status-warning">请先处理 Human Gate，再继续托管。</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-status-critical">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => void decide("stop")}>
          终止本次托管运行
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || humanGatePending}
          onClick={() => void decide("new_thread")}
        >
          开启新会话
        </Button>
        <Popover open={messageOpen} onOpenChange={setMessageOpen}>
          <div className="flex">
            <Button
              size="sm"
              className="rounded-r-none"
              disabled={busy || humanGatePending}
              onClick={() => void decide("continue")}
            >
              继续当前会话
            </Button>
            <PopoverTrigger asChild>
              <Button
                size="sm"
                className="rounded-l-none border-l border-button-foreground/20 px-2"
                disabled={busy || humanGatePending}
                aria-label="补充消息后继续当前会话"
                title="输入用户消息"
              >
                <ChevronDown
                  className={`size-3.5 transition-transform ${messageOpen ? "rotate-180" : ""}`}
                />
              </Button>
            </PopoverTrigger>
          </div>
          <PopoverContent align="end" side="top" sideOffset={6} className="w-80 p-3">
            <div className="mb-2">
              <div className="text-sm font-medium">发送消息到当前会话</div>
            </div>
            <textarea
              className="min-h-16 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={busy}
              maxLength={10000}
              placeholder="输入补充消息"
              aria-label="继续当前会话的补充消息"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setMessageOpen(false)}
              >
                取消
              </Button>
              <Button
                size="sm"
                disabled={busy || input.trim().length === 0}
                onClick={() => void decide("continue", input)}
              >
                发送并继续
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </section>
  )
}
