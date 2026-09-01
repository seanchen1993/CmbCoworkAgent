import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react"
import { ChevronDown, Loader2, MessageSquareText } from "lucide-react"
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
          className={cn(
            "h-8 gap-1.5 rounded-md px-1.5 text-xs transition-colors",
            enabled
              ? "text-primary hover:bg-primary/10 hover:text-primary"
              : "text-muted-foreground hover:bg-muted/60"
          )}
        >
          <span className="grid size-5 place-items-center">
            {loading || pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <MessageSquareText className="size-3.5" />
            )}
          </span>
          <span className="font-medium">{triggerLabel}</span>
          <ChevronDown className="size-3 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[340px] max-w-[calc(100vw-32px)] overflow-hidden border-border bg-background p-0 shadow-xl"
        align="start"
        side="top"
        sideOffset={8}
      >
        <div className="border-b border-border bg-muted/40 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
              <MessageSquareText className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">当前会话接入招乎</div>
              <div className="text-xs leading-5 text-muted-foreground">
                开放这一条已经存在的桌面会话。
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">接入当前会话</div>
              <div className="mt-1 text-[11px] leading-5 text-muted-foreground">
                开启后，这一条会话会出现在招乎的 /会话 列表中。
              </div>
            </div>
            <Switch
              aria-label="允许招乎访问当前会话"
              checked={enabled}
              disabled={toggleDisabled}
              onCheckedChange={(checked) => void setRemoteAccess(checked)}
            />
          </div>

          {!enabled && !routeAvailable && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
              {loadError ?? overview?.routeReason ?? "正在读取招乎连接状态…"}
            </div>
          )}

          {grant && grant.state === "suspended" && grant.suspendReason && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-muted-foreground">
              当前授权已暂停：{grant.suspendReason}
            </div>
          )}
        </div>

        <div className="border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={() => {
              onOpenSettings?.()
              setOpen(false)
            }}
            className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            打开机器人管理
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
