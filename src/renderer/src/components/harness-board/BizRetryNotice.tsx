import { useState } from "react"
import { Loader2, PauseCircle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { useHarnessNotifications, refreshAppNotifications } from "@/lib/harness-notifications"

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
    <BizRetryActions
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

function BizRetryActions({
  notificationId,
  message,
  humanGatePending
}: {
  notificationId: string
  message: string
  humanGatePending: boolean
}): React.JSX.Element {
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const decide = async (action: "stop" | "continue" | "new_thread"): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.appNotifications.decide({
        notificationId,
        action,
        message: action === "continue" ? input : undefined
      })
      if (!result.applied) {
        setError(result.message)
        toast.error(result.message)
      } else {
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
    <section className="mb-4 space-y-3 rounded-xl border border-status-warning/35 bg-status-warning/10 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <PauseCircle className="mt-0.5 size-5 shrink-0 text-status-warning" />
        <div className="min-w-0">
          <div className="text-sm font-semibold">托管运行需要人工确认</div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {message}
          </p>
        </div>
      </div>
      <textarea
        className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        disabled={busy || humanGatePending}
        maxLength={10000}
        placeholder="继续当前会话的补充消息（留空默认：继续当前任务）"
        aria-label="继续当前会话的补充消息"
      />
      {humanGatePending && (
        <p className="text-xs text-status-warning">请先处理 Human Gate，再继续托管。</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-status-critical">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {busy && <Loader2 className="size-4 animate-spin self-center" />}
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
        <Button
          size="sm"
          disabled={busy || humanGatePending}
          onClick={() => void decide("continue")}
        >
          在当前会话继续
        </Button>
      </div>
    </section>
  )
}
