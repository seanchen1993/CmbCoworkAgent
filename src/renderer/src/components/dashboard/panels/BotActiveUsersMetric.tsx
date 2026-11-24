import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import type { BotActiveUsersPage } from "../../../../../shared/bots/telemetry"
import { DrilldownArrow } from "../DrilldownArrow"

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
})

function ActiveUsersTable({ items }: { items: BotActiveUsersPage["items"] }) {
  return (
    <table aria-label="活跃用户名单" className="w-full table-fixed border-separate border-spacing-0 text-left text-xs">
      <thead className="sticky top-0 z-10 bg-muted font-medium text-muted-foreground">
        <tr>
          <th scope="col" className="w-[28%] border-b py-2.5 pl-4 pr-1 font-medium sm:px-6 md:w-[20%]">
            用户
          </th>
          <th scope="col" className="hidden w-[17%] border-b px-3 py-2.5 font-medium md:table-cell">
            部门
          </th>
          <th
            scope="col"
            aria-label="活跃 Bot 数"
            title="本期有处理记录的 Bot 数量（去重估算）"
            className="w-[11%] border-b px-0.5 py-2.5 text-right font-medium md:w-[10%] md:px-3"
          >
            <span className="whitespace-nowrap sm:hidden">Bot 数</span>
            <span className="hidden sm:inline">活跃 Bot 数</span>
          </th>
          <th
            scope="col"
            aria-label="绑定招乎群聊数"
            title="本期 App 首次观察到的招乎群聊新增关联次数"
            className="w-[13%] border-b px-1 py-2.5 text-right font-medium md:px-2"
          >
            <span className="md:hidden">群绑定</span>
            <span className="hidden md:inline">绑定招乎群聊数</span>
          </th>
          <th
            scope="col"
            aria-label="交办任务数"
            title="本期新建的独立任务数，包含关联已有会话"
            className="w-[11%] border-b px-1 py-2.5 text-right font-medium md:w-[12%] md:px-3"
          >
            <span className="md:hidden">交办</span>
            <span className="hidden md:inline">交办任务数</span>
          </th>
          <th
            scope="col"
            aria-label="对话处理"
            title="本期普通私聊或群聊启动的 Bot 对话处理轮次"
            className="w-[12%] border-b px-1 py-2.5 text-right font-medium md:w-[11%] md:px-3"
          >
            <span className="md:hidden">对话</span>
            <span className="hidden md:inline">对话处理</span>
          </th>
          <th scope="col" className="w-[25%] border-b py-2.5 pl-2 pr-4 text-right font-medium sm:pr-6 md:w-[17%]">
            最近活跃
          </th>
        </tr>
      </thead>
      <tbody className="[&_tr:not(:last-child)_td]:border-b [&_td]:border-border/60">
        {items.map(({ sapId, userName, organization, activeBots, zhaohuGroupBindings, assignedWorks, chatRuns, lastActiveAt }) => (
          <tr key={sapId} className="hover:bg-muted/45">
            <td className="py-2.5 pl-4 pr-1 sm:px-6">
              <div className="truncate text-sm font-medium" title={userName || sapId}>
                {userName || sapId}
              </div>
              {userName && userName !== sapId && (
                <div className="mt-0.5 truncate tabular-nums text-muted-foreground" title={sapId}>
                  {sapId}
                </div>
              )}
              {organization && (
                <div className="mt-0.5 truncate text-muted-foreground md:hidden" title={organization}>
                  {organization}
                </div>
              )}
            </td>
            <td className="hidden px-3 py-2.5 text-muted-foreground md:table-cell">
              <span className="block truncate" title={organization}>{organization || "—"}</span>
            </td>
            <td className="px-0.5 py-2.5 text-right font-medium tabular-nums md:px-3">
              {activeBots?.toLocaleString("zh-CN") ?? "—"}
            </td>
            <td className="px-1 py-2.5 text-right font-medium tabular-nums md:px-2">
              {zhaohuGroupBindings?.toLocaleString("zh-CN") ?? "—"}
            </td>
            <td className="px-1 py-2.5 text-right font-medium tabular-nums md:px-3">
              {assignedWorks?.toLocaleString("zh-CN") ?? "—"}
            </td>
            <td className="px-1 py-2.5 text-right font-medium tabular-nums md:px-3">
              {chatRuns?.toLocaleString("zh-CN") ?? "—"}
            </td>
            <td className="py-2.5 pl-2 pr-4 text-right tabular-nums text-muted-foreground sm:pr-6">
              {lastActiveAt ? (
                <time dateTime={lastActiveAt}>{timeFormatter.format(new Date(lastActiveAt))}</time>
              ) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function BotActiveUsersMetric({
  value,
  loadPage
}: {
  value: string
  loadPage(cursor?: string): Promise<BotActiveUsersPage>
}) {
  const title = useRef<HTMLHeadingElement>(null)
  const [page, setPage] = useState<BotActiveUsersPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const live = useRef(false)
  const pending = useRef(false)

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      if (pending.current)
        void window.api.dashboard.cancelRequests?.(["dashboard:botActiveUsers"]).catch(() => {})
    }
  }, [])

  async function load() {
    if (pending.current) return
    pending.current = true
    setLoading(true)
    setError(null)
    try {
      const next = await loadPage(page?.nextCursor ?? undefined)
      if (live.current) {
        setPage((previous) => ({
          items: [...(previous?.items ?? []), ...next.items],
          nextCursor: next.nextCursor
        }))
      }
    } catch {
      if (live.current) setError("暂时无法读取用户列表")
    } finally {
      pending.current = false
      if (live.current) setLoading(false)
    }
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open && !page && !error) void load()
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="-m-1 flex min-w-0 flex-col rounded-md p-1 text-left hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted/60"
          aria-label={`查看活跃用户名单（${value}）`}
        >
          <span className="flex min-h-4 items-center text-[11px] text-muted-foreground">活跃用户</span>
          <span className="mt-1 inline-flex items-center gap-1.5 text-xl font-semibold tabular-nums">
            {value}
            <DrilldownArrow />
          </span>
        </button>
      </DialogTrigger>
      <DialogContent
        className="flex max-h-[min(40rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-[60rem] flex-col gap-0 rounded-xl p-0 shadow-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          title.current?.focus()
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border px-4 pb-4 pt-5 text-left sm:px-6">
          <DialogTitle ref={title} tabIndex={-1} className="pr-8 outline-none">
            活跃用户
          </DialogTitle>
          <DialogDescription className="pr-8 text-xs">
            当前时间和组织范围内有 Bot 处理记录的 App 用户。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {page && page.items.length > 0 && (
            <ActiveUsersTable items={page.items} />
          )}
          {loading && !page && (
            <p role="status" className="px-4 py-10 text-center text-sm text-muted-foreground">
              正在读取活跃用户…
            </p>
          )}
          {page?.items.length === 0 && !error && (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              当前范围暂无活跃用户。
            </p>
          )}
        </div>
        {(error || Boolean(page?.items.length)) && (
          <div className="flex min-h-13 shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-2 text-xs text-muted-foreground sm:px-6">
            {error ? (
              <>
                <p role="alert">{error}</p>
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  重试
                </Button>
              </>
            ) : (
              <>
                <p role="status" className="tabular-nums">
                  已加载 {page?.items.length.toLocaleString("zh-CN")} 位用户
                </p>
                {page?.nextCursor && (
                  <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
                    {loading ? "加载中…" : "加载更多"}
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
