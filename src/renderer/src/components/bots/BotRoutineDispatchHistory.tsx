import { useEffect, useState } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { botApi } from "@/lib/bot-api"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  BOT_ROUTINE_DISPATCH_CAPABILITY,
  type BotRoutineDispatchHistory
} from "../../../../shared/bot-routine-dispatch"

const labels = { triggered: "已触发", coalesced: "合并到未完成任务", skipped: "已跳过" }
export function BotRoutineDispatchLog({
  botId,
  routineId,
  timezone
}: {
  botId: string
  routineId: string
  timezone: string
}) {
  const supported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes(BOT_ROUTINE_DISPATCH_CAPABILITY) ?? false
  )
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const [open, setOpen] = useState(false),
    [before, setBefore] = useState<number | undefined>()
  const [loaded, setLoaded] = useState<{
    key: string
    page: BotRoutineDispatchHistory | null
    error: string | null
  } | null>(null)
  const [retry, setRetry] = useState(0)
  const queryKey = JSON.stringify([botId, routineId, dataEpoch, before, retry])
  const page = loaded?.key === queryKey ? loaded.page : null
  const error = loaded?.key === queryKey ? loaded.error : null
  useEffect(() => {
    if (!open || !supported) return
    let disposed = false
    void botApi
      .routineDispatchHistory({ botId, routineId, expectedDataEpoch: dataEpoch, before, limit: 10 })
      .then(
        (result) => {
          if (!disposed) setLoaded({ key: queryKey, page: result, error: null })
        },
        (failure) => {
          if (!disposed)
            setLoaded({
              key: queryKey,
              page: null,
              error: failure instanceof Error ? failure.message : "调度记录读取失败"
            })
        }
      )
    return () => {
      disposed = true
    }
  }, [botId, routineId, dataEpoch, before, open, supported, queryKey])
  if (!supported) return null
  const time = (value: number) =>
    new Date(value).toLocaleString("zh-CN", { timeZone: timezone, hour12: false })
  return (
    <section className="rounded-lg border bg-muted/20 text-xs">
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        查看调度记录
        <ChevronDown
          size={13}
          className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          <p className="leading-relaxed text-muted-foreground">
            停机期间错过的计划合并处理；已有任务未完成时，本次计划不会重复派发。结果不明的操作仍需核对。
          </p>
          {page && (
            <ul className="max-h-48 space-y-2 overflow-y-auto">
              {page.items.map((item) => (
                <li key={item.cursor} className="flex flex-wrap justify-between gap-1">
                  <time dateTime={new Date(item.dueAt).toISOString()}>{time(item.dueAt)}</time>
                  <span className="text-muted-foreground">
                    {labels[item.disposition]}
                    {item.status === "needs_review"
                      ? " · 待核对"
                      : item.status === "failed"
                        ? " · 执行失败"
                        : item.status === "succeeded"
                          ? " · 已完成"
                          : ""}
                  </span>
                </li>
              ))}
              {!page.items.length && (
                <li className="py-2 text-muted-foreground">尚无计划调度记录</li>
              )}
            </ul>
          )}
          {!page && !error && (
            <p role="status" className="text-muted-foreground">
              正在读取…
            </p>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => {
                setBefore(undefined)
                setRetry((value) => value + 1)
              }}
            >
              刷新
            </Button>
            {page?.next && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={() => setBefore(page.next!)}
              >
                更早记录
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
