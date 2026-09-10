import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react"
import { ChevronDown, ChevronRight, Loader2, MessageSquareText } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { isBuiltinRobotThreadRemoteAccessEligible } from "@/lib/builtin-robot-remote-access"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import type { BuiltinRobotRemoteAccessOverview } from "@/types"

interface ThreadRemoteAccessSwitcherProps {
  threadId?: string | null
  onOpenSettings?: () => void
}

export const ThreadRemoteAccessSwitcher = memo(ThreadRemoteAccessSwitcherImpl)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ThreadRemoteAccessSwitcherImpl({
  threadId,
  onOpenSettings
}: ThreadRemoteAccessSwitcherProps): JSX.Element | null {
  const threads = useAppStore((state) => state.threads)
  const currentThread = useMemo(
    () => threads.find((thread) => thread.thread_id === threadId) ?? null,
    [threadId, threads]
  )
  const eligible = isBuiltinRobotThreadRemoteAccessEligible(currentThread)
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState<BuiltinRobotRemoteAccessOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const requestVersionRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const requestVersion = ++requestVersionRef.current
    if (!threadId || !eligible) {
      if (mountedRef.current) {
        setOverview(null)
        setLoadError(null)
        setLoading(false)
      }
      return
    }

    setLoading(true)
    try {
      const next = await window.api.builtinRobot.getRemoteAccess()
      if (mountedRef.current && requestVersion === requestVersionRef.current) {
        setOverview(next)
        setLoadError(null)
      }
    } catch (error) {
      if (mountedRef.current && requestVersion === requestVersionRef.current) {
        setOverview(null)
        setLoadError(errorMessage(error))
      }
    } finally {
      if (mountedRef.current && requestVersion === requestVersionRef.current) {
        setLoading(false)
      }
    }
  }, [eligible, threadId])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    const unsubscribe = window.api.builtinRobot.onStatus(() => {
      void refresh()
    })
    return () => {
      mountedRef.current = false
      requestVersionRef.current += 1
      unsubscribe()
    }
  }, [refresh])

  useEffect(() => {
    setOpen(false)
  }, [threadId])

  if (!threadId || !eligible) return null

  const grant = overview?.threadGrants.find((candidate) => candidate.threadId === threadId)
  const enabled = grant?.state === "active"
  const routeAvailable = overview?.routeAvailable === true
  const toggleDisabled = pending || loading || (!enabled && !routeAvailable)
  const triggerLabel = enabled ? "已接入招乎" : "接入招乎"
  const triggerValue = pending
    ? "处理中"
    : loading
      ? "读取中"
      : loadError
        ? "状态异常"
        : enabled
          ? "已接入"
          : "未接入"

  const setRemoteAccess = async (nextEnabled: boolean): Promise<void> => {
    if (pending || toggleDisabled) return
    setPending(true)
    try {
      const next = await window.api.builtinRobot.setThreadRemoteAccess(threadId, nextEnabled)
      if (!mountedRef.current) return
      setOverview(next)
      setLoadError(null)
      toast.success(nextEnabled ? "当前会话已接入招乎" : "当前会话已停止接入招乎")
    } catch (error) {
      if (mountedRef.current) {
        toast.error(`更新招乎接入失败：${errorMessage(error)}`)
      }
    } finally {
      if (mountedRef.current) setPending(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={`当前会话：${triggerLabel}`}
          aria-label={`当前会话：${triggerLabel}`}
          className="h-8 gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60"
        >
          <span className={cn("grid size-5 place-items-center", enabled && "text-primary")}>
            {loading || pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <MessageSquareText className="size-3.5" />
            )}
          </span>
          <span className="font-medium text-foreground">招乎接入</span>
          <span
            className={cn(
              "ml-auto text-[11px] font-medium",
              loadError ? "text-status-warning" : enabled ? "text-primary" : "text-muted-foreground"
            )}
          >
            {triggerValue}
          </span>
          <ChevronDown className="size-3 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[300px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border-border/70 bg-popover p-1.5 shadow-xl"
        align="start"
        side="left"
        sideOffset={8}
      >
        <div className="flex items-center gap-3 rounded-lg bg-background-interactive/45 px-3 py-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <MessageSquareText className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-foreground">接入当前会话</div>
            <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
              开启后，可从招乎查看并继续此会话
            </div>
          </div>
          <Switch
            aria-label="允许招乎访问当前会话"
            checked={enabled}
            disabled={toggleDisabled}
            onCheckedChange={(checked) => void setRemoteAccess(checked)}
            className="disabled:opacity-100"
          />
        </div>

        <div className="space-y-1.5 pt-1.5">
          {!enabled && !routeAvailable && (
            <div className="rounded-lg border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-[10px] leading-4 text-muted-foreground">
              {loadError ?? overview?.routeReason ?? "正在读取招乎连接状态…"}
            </div>
          )}

          {grant && grant.state === "suspended" && grant.suspendReason && (
            <div className="rounded-lg border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-[10px] leading-4 text-muted-foreground">
              当前授权已暂停：{grant.suspendReason}
            </div>
          )}
        </div>

        {onOpenSettings && (
          <button
            type="button"
            onClick={() => {
              onOpenSettings()
              setOpen(false)
            }}
            className="mt-1 flex h-8 w-full items-center rounded-lg px-3 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            招乎机器人管理
            <ChevronRight className="ml-auto size-3 opacity-70" />
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
