import { useCallback, useEffect, useRef, useState } from "react"
import { FolderOpen, GitFork, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import type { ForkableCheckpoint, Thread, ThreadForkOverrides } from "@/types"

type ForkDestinationMode = "local" | "workspace"

function getThreadWorkspacePath(thread: Thread): string | null {
  const metadataPath = thread.metadata?.workspacePath
  return typeof metadataPath === "string" && metadataPath.trim() ? metadataPath : null
}

function getWorkspaceName(path: string | null): string {
  if (!path) return "未关联工作区"
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) || path
}

function formatCheckpointTime(value?: string): string {
  if (!value) return "未知时间"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "未知时间"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date)
}

function getForkUnstableReasonLabel(reason?: ForkableCheckpoint["unstableReason"]): string {
  switch (reason) {
    case "interrupt":
      return "中断中"
    case "pending_approval":
      return "等待审批"
    case "pending_writes":
      return "写入未完成"
    case "in_progress_turn":
      return "运行中"
    case "missing_boundary_marker":
      return "非完成边界"
    default:
      return "不可 fork"
  }
}

export function ThreadForkCheckpointDialog({
  thread,
  displayTitle,
  preserveView = false,
  onClose,
  onForked,
  onForkingChange
}: {
  thread: Thread
  displayTitle: string
  preserveView?: boolean
  onClose: () => void
  onForked?: (thread: Thread) => void | Promise<void>
  onForkingChange?: (threadId: string | null) => void
}): React.JSX.Element {
  const { forkThread, listForkableCheckpoints } = useAppStore()
  const [checkpoints, setCheckpoints] = useState<ForkableCheckpoint[]>([])
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<ForkableCheckpoint | null>(null)
  const [destinationMode, setDestinationMode] = useState<ForkDestinationMode>("local")
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [selectingWorkspace, setSelectingWorkspace] = useState(false)
  const [loadingCheckpoints, setLoadingCheckpoints] = useState(true)
  const [isForking, setIsForking] = useState(false)
  const requestIdRef = useRef(0)

  useEffect(() => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    let canceled = false

    void listForkableCheckpoints(thread.thread_id)
      .then((items) => {
        if (canceled || requestIdRef.current !== requestId) return
        setCheckpoints(items)
        setSelectedCheckpoint(
          items.find((checkpoint) => checkpoint.isStableTurnBoundary) ?? null
        )
      })
      .catch((error) => {
        if (canceled || requestIdRef.current !== requestId) return
        toast.error(error instanceof Error ? error.message : "读取 checkpoint 失败")
      })
      .finally(() => {
        if (canceled || requestIdRef.current !== requestId) return
        setLoadingCheckpoints(false)
      })

    return () => {
      canceled = true
      requestIdRef.current += 1
    }
  }, [listForkableCheckpoints, thread.thread_id])

  const handleSelectWorkspace = useCallback(async (): Promise<string | null> => {
    if (selectingWorkspace) return workspacePath
    setSelectingWorkspace(true)
    try {
      const selectedPath = await window.api.workspace.select()
      if (selectedPath) {
        setDestinationMode("workspace")
        setWorkspacePath(selectedPath)
      }
      return selectedPath
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "选择工作区失败")
      return null
    } finally {
      setSelectingWorkspace(false)
    }
  }, [selectingWorkspace, workspacePath])

  const handleFork = useCallback(async (): Promise<void> => {
    if (!selectedCheckpoint?.isStableTurnBoundary || isForking) return

    let selectedWorkspacePath = workspacePath
    if (destinationMode === "workspace" && !selectedWorkspacePath) {
      selectedWorkspacePath = await handleSelectWorkspace()
      if (!selectedWorkspacePath) return
    }

    const overrides: ThreadForkOverrides | undefined =
      destinationMode === "workspace"
        ? { workspacePath: selectedWorkspacePath }
        : undefined

    setIsForking(true)
    onForkingChange?.(thread.thread_id)
    try {
      const forkedThread = await forkThread(
        {
          sourceThreadId: thread.thread_id,
          checkpointId: selectedCheckpoint.checkpointId,
          overrides
        },
        preserveView ? { preserveView: true } : undefined
      )
      await onForked?.(forkedThread)
      onClose()
      toast.success("已从历史 checkpoint 创建新会话")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Fork 会话失败")
    } finally {
      setIsForking(false)
      onForkingChange?.(null)
    }
  }, [
    destinationMode,
    forkThread,
    handleSelectWorkspace,
    isForking,
    onClose,
    onForked,
    onForkingChange,
    preserveView,
    selectedCheckpoint,
    thread,
    workspacePath
  ])

  const busy = isForking || selectingWorkspace
  const currentWorkspacePath = getThreadWorkspacePath(thread)

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-base">从 checkpoint fork</DialogTitle>
          <DialogDescription className="truncate">{displayTitle}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-2 overflow-y-auto p-3">
          {loadingCheckpoints ? (
            <div className="flex h-28 items-center justify-center text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : checkpoints.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              暂无可 fork 的 checkpoint
            </div>
          ) : (
            checkpoints.map((checkpoint) => {
              const selected = selectedCheckpoint?.checkpointId === checkpoint.checkpointId
              const disabled = !checkpoint.isStableTurnBoundary || busy
              return (
                <button
                  key={checkpoint.checkpointId}
                  type="button"
                  disabled={disabled}
                  className={cn(
                    "w-full rounded-sm border border-border px-3 py-2 text-left transition-colors",
                    disabled
                      ? "cursor-not-allowed bg-muted/30 opacity-60"
                      : selected
                        ? "border-primary bg-primary/10"
                        : "hover:border-primary/40 hover:bg-accent/60"
                  )}
                  onClick={() => setSelectedCheckpoint(checkpoint)}
                >
                  <div className="mb-1 flex min-w-0 items-center gap-2 text-xs">
                    <span className="shrink-0 text-muted-foreground">
                      {formatCheckpointTime(checkpoint.createdAt)}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      {checkpoint.messageCount} 条消息
                    </span>
                    <span
                      className={cn(
                        "ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-[10px]",
                        checkpoint.isStableTurnBoundary
                          ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {checkpoint.isStableTurnBoundary
                        ? "可 fork"
                        : getForkUnstableReasonLabel(checkpoint.unstableReason)}
                    </span>
                  </div>
                  <div className="truncate text-sm text-foreground">
                    {checkpoint.lastMessagePreview || "无可见消息"}
                  </div>
                  {checkpoint.lastUserMessagePreview ? (
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      用户：{checkpoint.lastUserMessagePreview}
                    </div>
                  ) : null}
                </button>
              )
            })
          )}
        </div>
        <div className="space-y-3 border-t border-border p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setDestinationMode("local")}
              className={cn(
                "rounded-sm border px-3 py-2 text-left transition-colors",
                destinationMode === "local"
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-accent"
              )}
            >
              <div className="text-sm font-medium">派生到本地</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {getWorkspaceName(currentWorkspacePath)}
              </div>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDestinationMode("workspace")}
              className={cn(
                "rounded-sm border px-3 py-2 text-left transition-colors",
                destinationMode === "workspace"
                  ? "border-primary bg-primary/10"
                  : "border-border hover:bg-accent"
              )}
            >
              <div className="text-sm font-medium">派生到其他工作区</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {workspacePath ? getWorkspaceName(workspacePath) : "选择一个本地工作区路径"}
              </div>
            </button>
          </div>
          {destinationMode === "workspace" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void handleSelectWorkspace()}
              className="w-full justify-start"
            >
              {selectingWorkspace ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FolderOpen className="size-4" />
              )}
              {workspacePath || "选择工作区文件夹"}
            </Button>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button
              type="button"
              disabled={!selectedCheckpoint || busy}
              onClick={() => void handleFork()}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <GitFork className="size-4" />
              )}
              {busy
                ? selectingWorkspace
                  ? "选择中"
                  : "正在 fork"
                : destinationMode === "workspace" && !workspacePath
                  ? "选择工作区并 Fork"
                  : "Fork"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
