import { memo, useEffect, useRef } from "react"
import { AlertCircle, Download, GitFork, HeartPulse, Loader2, Pencil, Trash2 } from "lucide-react"
import type { Thread } from "@/types"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu"
import { cn, truncate } from "@/lib/utils"

function formatCompactTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date
  const now = new Date()
  const diff = now.getTime() - d.getTime()

  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes}分钟`
  if (hours < 24) return `${hours}小时`
  if (days < 7) return `${days}天`

  const month = d.getMonth() + 1
  const day = d.getDate()
  if (d.getFullYear() === now.getFullYear()) return `${month}/${day}`
  return `${String(d.getFullYear()).slice(2)}/${month}/${day}`
}

export function getDisplayThreadTitle(thread: Thread): string {
  const title = thread.title?.trim()

  if (!title || title === "..." || title === "…") {
    return truncate(thread.thread_id, 20)
  }

  if (title.startsWith("[Heartbeat]")) return title.slice(12).trim()
  if (title.startsWith("[定时]")) return title.slice(5).trim()
  if (title.startsWith("[远端机器人] ")) return `(远端) ${title.slice(8).trim()}`
  if (title.startsWith("[机器人] ")) return title.slice(6).trim()

  return title
}

function ThreadStatusIcon({
  isLoading,
  pendingApproval,
  scheduledTaskLoading
}: {
  isLoading: boolean
  pendingApproval: boolean
  scheduledTaskLoading: boolean
}): React.JSX.Element | null {
  if (isLoading || scheduledTaskLoading) {
    return <Loader2 className="size-4 shrink-0 animate-spin text-status-info" />
  }

  if (pendingApproval) {
    return <AlertCircle className="size-4 shrink-0 text-status-warning" />
  }

  return null
}

function ThreadListItemImpl({
  thread,
  isLoading,
  hasPendingApproval,
  hasPendingUserInput,
  hasContextReminder,
  scheduledTaskLoading,
  isSelected,
  isEditing,
  isUnread,
  editingTitle,
  onSelect,
  onDelete,
  onExport,
  onFork,
  onForkFromCheckpoint,
  onRunFinished,
  onStartEditing,
  onSaveTitle,
  onCancelEditing,
  onEditingTitleChange,
  isExporting,
  isForking = false,
  hoverTitle,
  className,
  rowPaddingClassName = "px-3 py-2",
  statusIconSize = "default",
  showInlineFork = false,
  showInlineExport = false,
  dataThreadId
}: {
  thread: Thread
  isLoading: boolean
  hasPendingApproval: boolean
  hasPendingUserInput: boolean
  hasContextReminder: boolean
  scheduledTaskLoading: boolean
  isExporting: boolean
  isForking?: boolean
  isSelected: boolean
  isEditing: boolean
  isUnread: boolean
  editingTitle: string
  onSelect: () => void
  onDelete: () => void
  onExport: () => void
  onFork?: () => void
  onForkFromCheckpoint?: () => void
  onRunFinished: () => void
  onStartEditing: () => void
  onSaveTitle: () => void
  onCancelEditing: () => void
  onEditingTitleChange: (value: string) => void
  hoverTitle?: string
  className?: string
  rowPaddingClassName?: string
  statusIconSize?: "default" | "compact"
  showInlineFork?: boolean
  showInlineExport?: boolean
  dataThreadId?: string
}): React.JSX.Element {
  const isRunning = isLoading || scheduledTaskLoading
  const forkDisabled = isRunning || hasPendingApproval || hasPendingUserInput || isForking
  const wasRunningRef = useRef(false)
  const onRunFinishedRef = useRef(onRunFinished)

  useEffect(() => {
    onRunFinishedRef.current = onRunFinished
  }, [onRunFinished])

  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      onRunFinishedRef.current()
    }
    wasRunningRef.current = isRunning
  }, [isRunning])

  const displayTitle = getDisplayThreadTitle(thread)
  const pendingUserInputBadge = hasPendingUserInput ? (
    <span className="ml-1 shrink-0 rounded-sm border border-status-warning/45 bg-status-warning/10 px-1.5 py-0.5 text-[10px] leading-none text-status-warning">
      等待用户回复
    </span>
  ) : null

  const inlineActionCount = 2 + (showInlineFork && onFork ? 1 : 0) + (showInlineExport ? 1 : 0)
  const inlineActionWidth =
    inlineActionCount >= 4
      ? "group-hover:w-[6rem]"
      : inlineActionCount === 3
        ? "group-hover:w-[4.5rem]"
        : ""
  const inlineFocusWidth =
    inlineActionCount >= 4
      ? "group-focus-within:w-[6rem]"
      : inlineActionCount === 3
        ? "group-focus-within:w-[4.5rem]"
        : ""
  const inlineOuterWidth =
    inlineActionCount >= 4 ? "w-24" : inlineActionCount === 3 ? "w-[4.5rem]" : "w-14"

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-requirement-thread-id={dataThreadId}
          className={cn(
            "group flex cursor-pointer items-center gap-2 overflow-hidden rounded-sm transition-colors",
            rowPaddingClassName,
            isSelected
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "hover:bg-sidebar-accent/50",
            className
          )}
          onClick={() => {
            if (!isEditing) {
              onSelect()
            }
          }}
        >
          <ThreadStatusIcon
            isLoading={isLoading}
            pendingApproval={hasPendingApproval}
            scheduledTaskLoading={scheduledTaskLoading}
          />
          <div className="min-w-0 flex-1 overflow-hidden">
            {isEditing ? (
              <input
                type="text"
                value={editingTitle}
                onChange={(e) => onEditingTitleChange(e.target.value)}
                onBlur={onSaveTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSaveTitle()
                  if (e.key === "Escape") onCancelEditing()
                }}
                className="w-full rounded border border-border bg-background px-1 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <div
                className={cn(
                  "flex min-w-0 items-center",
                  statusIconSize === "compact" ? "text-xs" : "text-sm"
                )}
                title={hoverTitle ?? thread.title ?? thread.thread_id}
              >
                {thread.title?.startsWith("[定时]") ? (
                  <>
                    <span className="shrink-0 rounded bg-primary/15 px-1 py-px text-[10px] font-medium text-primary">
                      定时
                    </span>
                    <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                    {pendingUserInputBadge}
                  </>
                ) : thread.title?.startsWith("[Heartbeat]") ? (
                  <>
                    <HeartPulse className="mr-1 size-3 shrink-0 text-red-400" />
                    <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                    {pendingUserInputBadge}
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                    {pendingUserInputBadge}
                  </>
                )}
              </div>
            )}
          </div>
          {hasContextReminder && !isRunning ? (
            <span className="size-2 shrink-0 rounded-full bg-status-warning" />
          ) : (
            isUnread && !isRunning && <span className="size-2 shrink-0 rounded-full bg-blue-500" />
          )}
          <span
            className={cn(
              "relative ml-auto flex h-6 shrink-0 items-center justify-end overflow-hidden",
              inlineOuterWidth
            )}
          >
            <span className="absolute right-0 text-[10px] text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              {formatCompactTime(thread.updated_at)}
            </span>
            <span
              className={cn(
                "pointer-events-none absolute right-0 flex w-0 items-center justify-end gap-0.5 overflow-hidden opacity-0 transition-[width,opacity]",
                inlineActionWidth,
                inlineFocusWidth,
                "group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
              )}
            >
              <IconPopoverButton
                icon={<Pencil className="size-3" />}
                popoverContent="重命名会话"
                stopPropagation
                className="size-6 rounded-sm p-0 hover:bg-accent/20"
                onClick={onStartEditing}
              />
              {showInlineFork && onFork ? (
                <IconPopoverButton
                  icon={
                    isForking ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <GitFork className="size-3" />
                    )
                  }
                  popoverContent={forkDisabled ? "当前状态无法 fork" : "Fork 会话"}
                  disabled={forkDisabled}
                  stopPropagation
                  className={cn(
                    "size-6 rounded-sm p-0 hover:bg-accent/20",
                    forkDisabled && "cursor-not-allowed !opacity-30"
                  )}
                  onClick={onFork}
                />
              ) : null}
              {showInlineExport ? (
                <IconPopoverButton
                  icon={
                    isExporting ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Download className="size-3" />
                    )
                  }
                  popoverContent={isRunning ? "运行中，无法导出" : "导出会话"}
                  disabled={isRunning || isExporting}
                  stopPropagation
                  className={cn(
                    "size-6 rounded-sm p-0 hover:bg-accent/20",
                    (isRunning || isExporting) && "cursor-not-allowed !opacity-30"
                  )}
                  onClick={onExport}
                />
              ) : null}
              <IconPopoverButton
                icon={<Trash2 className="size-3" />}
                popoverContent={isRunning ? "任务运行中，无法删除" : "删除会话"}
                disabled={isRunning}
                stopPropagation
                className={cn(
                  "size-6 rounded-sm p-0 hover:bg-accent/20",
                  isRunning && "cursor-not-allowed !opacity-30"
                )}
                onClick={onDelete}
              />
            </span>
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onStartEditing}>
          <Pencil className="mr-2 size-4" />
          重命名
        </ContextMenuItem>
        <ContextMenuItem onClick={onExport} disabled={isRunning || isExporting}>
          {isExporting ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Download className="mr-2 size-4" />
          )}
          {isRunning ? "运行中，无法导出" : isExporting ? "正在导出" : "导出会话"}
        </ContextMenuItem>
        {onFork ? (
          <ContextMenuItem onClick={onFork} disabled={forkDisabled}>
            {isForking ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <GitFork className="mr-2 size-4" />
            )}
            {isForking ? "正在 fork" : forkDisabled ? "当前状态无法 fork" : "Fork 当前会话"}
          </ContextMenuItem>
        ) : null}
        {onForkFromCheckpoint ? (
          <ContextMenuItem onClick={onForkFromCheckpoint} disabled={forkDisabled}>
            {isForking ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <GitFork className="mr-2 size-4" />
            )}
            从 checkpoint fork
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete} disabled={isRunning}>
          <Trash2 className="mr-2 size-4" />
          {isRunning ? "运行中，无法删除" : "删除"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export type ThreadListItemProps = Parameters<typeof ThreadListItemImpl>[0]

function areThreadListItemPropsEqual(
  prev: ThreadListItemProps,
  next: ThreadListItemProps
): boolean {
  if (
    prev.thread !== next.thread ||
    prev.isLoading !== next.isLoading ||
    prev.hasPendingApproval !== next.hasPendingApproval ||
    prev.hasPendingUserInput !== next.hasPendingUserInput ||
    prev.hasContextReminder !== next.hasContextReminder ||
    prev.scheduledTaskLoading !== next.scheduledTaskLoading ||
    prev.isExporting !== next.isExporting ||
    prev.isForking !== next.isForking ||
    prev.isSelected !== next.isSelected ||
    prev.isEditing !== next.isEditing ||
    prev.isUnread !== next.isUnread ||
    Boolean(prev.onForkFromCheckpoint) !== Boolean(next.onForkFromCheckpoint) ||
    Boolean(prev.onFork) !== Boolean(next.onFork) ||
    prev.hoverTitle !== next.hoverTitle ||
    prev.className !== next.className ||
    prev.rowPaddingClassName !== next.rowPaddingClassName ||
    prev.statusIconSize !== next.statusIconSize ||
    prev.showInlineFork !== next.showInlineFork ||
    prev.showInlineExport !== next.showInlineExport ||
    prev.dataThreadId !== next.dataThreadId
  ) {
    return false
  }
  if (next.isEditing && prev.editingTitle !== next.editingTitle) return false
  return true
}

export const ThreadListItem = memo(ThreadListItemImpl, areThreadListItemPropsEqual)
