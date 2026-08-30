import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react"
import { Brain, Check, ChevronDown, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAppStore } from "@/lib/store"
import { isHarnessProjectModeThread } from "@/lib/thread-classification"
import { cn } from "@/lib/utils"

interface MemorySessionSwitcherProps {
  onOpenSettings?: () => void
}

export const MemorySessionSwitcher = memo(MemorySessionSwitcherImpl)

function isSessionMemoryEnabled(metadata: unknown): boolean {
  return Boolean(
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).memoryEnabled === true
  )
}

function MemorySessionSwitcherImpl({ onOpenSettings }: MemorySessionSwitcherProps): JSX.Element {
  const currentThreadId = useAppStore((state) => state.currentThreadId)
  const threads = useAppStore((state) => state.threads)
  const patchThreadMetadata = useAppStore((state) => state.patchThreadMetadata)
  const [open, setOpen] = useState(false)
  const [globalEnabled, setGlobalEnabled] = useState(false)
  const [projectModeMemoryEnabled, setProjectModeMemoryEnabled] = useState(false)
  const [loadingGlobal, setLoadingGlobal] = useState(true)
  const [pending, setPending] = useState(false)
  const mountedRef = useRef(true)

  const currentThread = useMemo(
    () => threads.find((thread) => thread.thread_id === currentThreadId) ?? null,
    [currentThreadId, threads]
  )
  const sessionEnabled = isSessionMemoryEnabled(currentThread?.metadata)
  const projectModeMemoryBlocked =
    isHarnessProjectModeThread(currentThread) && !projectModeMemoryEnabled
  const effectiveEnabled = sessionEnabled && globalEnabled && !projectModeMemoryBlocked
  const pausedByGlobal = sessionEnabled && !globalEnabled && !projectModeMemoryBlocked
  const enabledOptionSelected = sessionEnabled && !projectModeMemoryBlocked

  const triggerLabel = pending
    ? "记忆"
    : pausedByGlobal
      ? "记忆暂停"
      : effectiveEnabled
        ? "记忆开"
        : "记忆关"
  const triggerTone = pausedByGlobal
    ? "text-amber-600 hover:bg-amber-500/10 dark:text-amber-300"
    : effectiveEnabled
      ? "text-teal-600 hover:bg-teal-500/10 dark:text-teal-300"
      : "text-muted-foreground hover:bg-muted/60"
  const iconTone = pausedByGlobal
    ? "text-amber-500"
    : effectiveEnabled
      ? "text-teal-500"
      : "text-muted-foreground"

  const loadGlobalEnabled = useCallback(async () => {
    try {
      const [enabled, projectModeEnabled] = await Promise.all([
        window.api.memory.getEnabled(),
        window.api.memory.getProjectModeEnabled()
      ])
      if (mountedRef.current) {
        setGlobalEnabled(enabled)
        setProjectModeMemoryEnabled(projectModeEnabled)
      }
    } catch (error) {
      console.error("[MemorySessionSwitcher] Failed to load memory setting:", error)
    } finally {
      if (mountedRef.current) setLoadingGlobal(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadGlobalEnabled()
    const unsubscribe = window.api.memory.onChanged(() => {
      void loadGlobalEnabled()
    })
    return () => {
      mountedRef.current = false
      unsubscribe()
    }
  }, [loadGlobalEnabled])

  const setSessionMemoryEnabled = useCallback(
    async (enabled: boolean) => {
      if (!currentThreadId) {
        toast.info("请先选择一个会话")
        return
      }
      if (pending) return

      setPending(true)
      try {
        if (enabled && !globalEnabled) {
          await window.api.memory.setEnabled(true)
          if (mountedRef.current) setGlobalEnabled(true)
        }

        await patchThreadMetadata(currentThreadId, { set: { memoryEnabled: enabled } })
        if (!mountedRef.current) return
        setOpen(false)
        toast.success(enabled ? "当前会话记忆已开启，将在下一次对话中生效" : "当前会话记忆已关闭")
      } catch (error) {
        if (!mountedRef.current) return
        toast.error(`记忆设置失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (mountedRef.current) setPending(false)
      }
    },
    [
      currentThreadId,
      globalEnabled,
      pending,
      patchThreadMetadata
    ]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={`当前会话记忆：${triggerLabel}`}
          aria-label={`当前会话记忆：${triggerLabel}`}
          className={cn("h-8 gap-1.5 rounded-md px-1.5 text-xs transition-colors", triggerTone)}
        >
          <span className={cn("grid size-5 place-items-center", iconTone)}>
            {pending || loadingGlobal ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Brain className="size-3.5" />
            )}
          </span>
          <span className="font-medium">{triggerLabel}</span>
          <ChevronDown className="size-3 opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[360px] max-w-[calc(100vw-32px)] overflow-hidden border-border bg-background p-0 shadow-xl"
        align="start"
        sideOffset={8}
      >
        <div className="border-b border-border bg-muted/40 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-foreground text-background shadow-sm">
              <Brain className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">会话记忆</div>
              <div className="text-xs leading-5 text-muted-foreground">
                控制当前会话是否使用长期记忆。
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-1 p-2">
          <button
            type="button"
            disabled={pending || loadingGlobal || projectModeMemoryBlocked}
            onClick={() => {
              void setSessionMemoryEnabled(true)
            }}
            className={cn(
              "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
              enabledOptionSelected
                ? "border-teal-200 bg-teal-50/80 text-foreground dark:border-teal-500/30 dark:bg-teal-500/10"
                : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground",
              (pending || loadingGlobal || projectModeMemoryBlocked) &&
                "cursor-not-allowed opacity-60"
            )}
          >
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-teal-100 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300">
              {pending && !enabledOptionSelected ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Brain className="size-3.5" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-sm font-semibold">开启当前会话</span>
              <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">
                本会话后续运行可检索记忆，并在成功结束后保存值得记住的信息。
              </span>
            </span>
            {enabledOptionSelected && (
              <span className="mt-1 grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-background">
                <Check className="size-3.5" />
              </span>
            )}
          </button>

          <button
            type="button"
            disabled={pending || loadingGlobal}
            onClick={() => {
              void setSessionMemoryEnabled(false)
            }}
            className={cn(
              "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
              !enabledOptionSelected
                ? "border-border bg-muted/60 text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground",
              (pending || loadingGlobal) && "cursor-not-allowed opacity-60"
            )}
          >
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
              <Brain className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-sm font-semibold">关闭当前会话</span>
              <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">
                本会话后续运行不会读取记忆，也不会在结束后自动写入记忆。
              </span>
            </span>
            {!enabledOptionSelected && (
              <span className="mt-1 grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-background">
                <Check className="size-3.5" />
              </span>
            )}
          </button>
        </div>

        {pausedByGlobal && (
          <div className="mx-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            全局记忆子系统已关闭；重新开启本会话会自动唤起它。
          </div>
        )}

        <div className="border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={() => {
              onOpenSettings?.()
              setOpen(false)
            }}
            className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            打开记忆管理
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
