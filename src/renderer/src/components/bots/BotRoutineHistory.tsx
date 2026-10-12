import { botApi } from "@/lib/bot-api"
import { BotRoutineDispatchLog } from "./BotRoutineDispatchHistory"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"
import { useEffect, useRef, useState } from "react"
import { AlertCircle, Check, Clock3, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import type { BotRoutine } from "../../../../shared/bot-types"
import type { BotRoutineHistory as History, BotRoutineRun } from "../../../../shared/bot-routines"
import { formatRoutineRunTimestamp } from "./upstream/grok-routine-time"

const labels: Record<BotRoutineRun["status"], string> = {
  queued: "等待执行",
  running: "运行中",
  waiting_input: "等待处理",
  cancelling: "正在停止",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已停止",
  needs_review: "待核对"
}
const triggers: Record<BotRoutineRun["trigger"], string> = {
  scheduled: "计划触发",
  manual: "手动运行",
  event: "事件触发"
}
const empty: History = { items: [], next: null }

export function BotRoutineHistory({
  routine,
  close,
  openMessage
}: {
  routine: BotRoutine
  close(): void
  openMessage(conversationId: string, messageId: string): void
}) {
  const viewVisible = useBotViewVisibility()
  const [cursors, setCursors] = useState<NonNullable<History["next"]>[]>([])
  const [page, setPage] = useState<History>(empty)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const currentRequest = useRef(0)
  const displayedQuery = useRef<string | null>(null)
  const before = cursors.at(-1)
  const queryKey = JSON.stringify([routine.botId, routine.id, before])
  useEffect(() => {
    if (!viewVisible) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const generation = ++currentRequest.current
    if (displayedQuery.current !== queryKey) {
      displayedQuery.current = queryKey
      setBusy(true)
      setPage(empty)
      setError(null)
    }
    const poll = async () => {
      try {
        const result = await botApi.routineHistory({
          botId: routine.botId,
          routineId: routine.id,
          before,
          limit: 20
        })
        if (disposed || generation !== currentRequest.current) return
        setPage(result)
        setNow(Date.now())
        setError(null)
      } catch (failure) {
        if (!disposed && generation === currentRequest.current)
          setError(failure instanceof Error ? failure.message : "运行记录读取失败")
      } finally {
        if (!disposed && generation === currentRequest.current) {
          setBusy(false)
          timer = setTimeout(() => void poll(), 2000)
        }
      }
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [routine.id, routine.botId, before, retry, viewVisible, queryKey])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>{routine.name} · 运行记录</DialogTitle>
          <DialogDescription>每次触发单独记录，时间以 {routine.timezone} 显示。</DialogDescription>
        </DialogHeader>
        <BotRoutineDispatchLog key={routine.id} botId={routine.botId} routineId={routine.id} timezone={routine.timezone} />
        {error && (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 text-sm text-destructive"
          >
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>
              重试
            </Button>
          </div>
        )}
        <div className="min-h-0 overflow-y-auto" aria-busy={busy}>
          {busy ? (
            <p role="status" className="py-10 text-center text-sm text-muted-foreground">
              正在读取运行记录…
            </p>
          ) : !page.items.length && !error ? (
            <p className="py-10 text-center text-sm text-muted-foreground">尚无运行记录</p>
          ) : (
            <ol className="divide-y divide-border/60">
              {page.items.map((run) => {
                const Icon =
                  run.status === "succeeded"
                    ? Check
                    : run.status === "failed" || run.status === "cancelled"
                      ? X
                      : run.status === "needs_review" || run.status === "waiting_input"
                        ? AlertCircle
                        : run.status === "running" || run.status === "cancelling"
                          ? Loader2
                          : Clock3
                return (
                  <li key={run.id} className="flex items-start gap-3 py-4" data-run-id={run.id}>
                    <Icon
                      size={16}
                      className={`mt-0.5 shrink-0 ${run.status === "running" || run.status === "cancelling" ? "animate-spin motion-reduce:animate-none" : ""} ${run.status === "failed" ? "text-destructive" : run.status === "succeeded" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                        <strong className="font-medium">{labels[run.status]}</strong>
                        <span className="text-xs text-muted-foreground">
                          {triggers[run.trigger]}
                        </span>
                      </div>
                      <time
                        className="block text-xs text-muted-foreground"
                        dateTime={new Date(run.createdAt).toISOString()}
                        title={`触发时间：${new Date(run.createdAt).toLocaleString(undefined, { timeZone: routine.timezone })} · ${routine.timezone}`}
                      >
                        {formatRoutineRunTimestamp(run.createdAt, now, routine.timezone)}
                      </time>
                      {run.summary && (
                        <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                          {run.summary}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        openMessage(run.conversationId, run.resultMessageId ?? run.messageId)
                      }
                    >
                      查看对话
                    </Button>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
        <footer className="flex items-center justify-between border-t pt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !cursors.length}
            onClick={() => setCursors((values) => values.slice(0, -1))}
          >
            上一页
          </Button>
          <span className="text-xs text-muted-foreground">第 {cursors.length + 1} 页</span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !page.next}
            onClick={() => {
              if (page.next) setCursors((values) => [...values, page.next!])
            }}
          >
            下一页
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
