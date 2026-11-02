import { useId, useRef, useState } from "react"
import { Check, ChevronDown, Info, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { ManagedSessionPreview } from "./ManagedSessionPreview"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import {
  getManagedRunInitialSession,
  type ManagedRunSessionOption
} from "@/lib/managed-run-session-options"

export interface ManagedRunStartDialogInput {
  workspacePath: string
  initialUserMessage?: string
  existingThreadId?: string
  imEnabled: boolean
}

function ManagedSessionList({
  sessions,
  selectedThreadId,
  previousThreadId,
  portalContainer,
  previewThreadId,
  onPreviewChange,
  disabled,
  onSelect
}: {
  sessions: ManagedRunSessionOption[]
  selectedThreadId: string | null
  previousThreadId?: string
  portalContainer: HTMLElement | null
  previewThreadId: string | null
  onPreviewChange: (threadId: string, open: boolean) => void
  disabled: boolean
  onSelect: (threadId: string) => void
}): React.JSX.Element {
  const groupId = useId()
  return (
    <div
      role="radiogroup"
      aria-label="选择现有会话"
      className="max-h-72 min-h-0 overflow-y-auto p-1"
    >
      {sessions.map((session) => (
        <div
          key={session.threadId}
          className={cn(
            "flex items-center gap-2 rounded-sm px-2 py-2 transition-[background-color,box-shadow]",
            !disabled && !session.disabledReason && "hover:bg-muted/45 hover:shadow-sm"
          )}
        >
          <label
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-sm",
              session.disabledReason || disabled
                ? "cursor-not-allowed opacity-50"
                : "cursor-pointer"
            )}
          >
            <input
              type="radio"
              name={groupId}
              value={session.threadId}
              checked={session.threadId === selectedThreadId}
              disabled={disabled || Boolean(session.disabledReason)}
              onChange={() => onSelect(session.threadId)}
              onClick={() => {
                if (selectedThreadId === session.threadId) onSelect(session.threadId)
              }}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="flex size-4 shrink-0 items-center justify-center rounded-sm text-primary peer-focus-visible:ring-1 peer-focus-visible:ring-ring"
            >
              {session.threadId === selectedThreadId && <Check className="size-3.5" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm" title={session.title}>
                  {session.title}
                </span>
                {session.threadId === previousThreadId && (
                  <span className="shrink-0 text-xs text-muted-foreground">上次托管</span>
                )}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                最近活动：{session.lastActiveAt || "未知"}
              </span>
            </span>
            {session.disabledReason && (
              <span className="shrink-0 text-xs">{session.disabledReason}</span>
            )}
          </label>
          <ManagedSessionPreview
            threadId={session.threadId}
            title={session.title}
            portalContainer={portalContainer}
            disabled={disabled || session.disabledReason === "会话不可用"}
            open={previewThreadId === session.threadId}
            onOpenChange={(open) => onPreviewChange(session.threadId, open)}
          />
        </div>
      ))}
    </div>
  )
}

export function ManagedRunStartDialog({
  sessions,
  previousThreadId,
  defaultWorkspacePath,
  defaultUserMessage,
  featureImManagementAvailable,
  featureImUnavailableReason,
  updatingManagedRun,
  onClose,
  onConfirm
}: {
  sessions: ManagedRunSessionOption[]
  previousThreadId?: string
  defaultWorkspacePath: string
  defaultUserMessage: string
  featureImManagementAvailable: boolean
  featureImUnavailableReason: string | null
  updatingManagedRun: boolean
  onClose: () => void
  onConfirm: (input: ManagedRunStartDialogInput) => Promise<boolean>
}): React.JSX.Element {
  const hasMoreSessions = useAppStore((state) => state.threadDirectoryHasMore)
  const loadingMoreSessions = useAppStore((state) => state.threadDirectoryLoadingMore)
  const loadMoreSessions = useAppStore((state) => state.loadMoreThreads)
  const initialSession = getManagedRunInitialSession(sessions, previousThreadId)
  const sessionModeId = useId()
  const [useNewSession, setUseNewSession] = useState(true)
  const [sessionListOpen, setSessionListOpen] = useState(false)
  const [previewThreadId, setPreviewThreadId] = useState<string | null>(null)
  const [dialogPortalContainer, setDialogPortalContainer] = useState<HTMLDivElement | null>(null)
  const useExistingSession = !useNewSession
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    initialSession?.threadId ??
      sessions.find((session) => !session.disabledReason)?.threadId ??
      null
  )
  const [managedRunWorkspacePath, setManagedRunWorkspacePath] = useState(defaultWorkspacePath)
  const [managedRunUserMessage, setManagedRunUserMessage] = useState(defaultUserMessage)
  const defaultMessageRef = useRef(defaultUserMessage)
  const [managedRunImEnabled, setManagedRunImEnabled] = useState(featureImManagementAvailable)
  const [pickingManagedRunWorkspace, setPickingManagedRunWorkspace] = useState(false)
  const selectedSession = sessions.find((session) => session.threadId === selectedThreadId)
  const effectiveWorkspacePath = useExistingSession
    ? (selectedSession?.workspacePath ?? "")
    : managedRunWorkspacePath
  const handleSessionListOpenChange = (open: boolean): void => {
    setSessionListOpen(open)
    if (!open) setPreviewThreadId(null)
  }
  const handlePickManagedRunWorkspace = async (): Promise<void> => {
    if (useExistingSession || pickingManagedRunWorkspace || updatingManagedRun) return
    setPickingManagedRunWorkspace(true)
    try {
      const path = await window.api.workspace.select()
      if (typeof path === "string" && path.trim()) setManagedRunWorkspacePath(path)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPickingManagedRunWorkspace(false)
    }
  }
  const handleConfirmManagedRun = async (): Promise<void> => {
    if (
      updatingManagedRun ||
      pickingManagedRunWorkspace ||
      !effectiveWorkspacePath.trim() ||
      (useExistingSession && (!selectedSession || selectedSession.disabledReason))
    )
      return
    const message = managedRunUserMessage.trim()
    const started = await onConfirm({
      workspacePath: effectiveWorkspacePath,
      initialUserMessage:
        message && message !== defaultMessageRef.current.trim() ? message : undefined,
      existingThreadId: useExistingSession ? (selectedThreadId ?? undefined) : undefined,
      imEnabled: managedRunImEnabled
    })
    if (started) onClose()
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !updatingManagedRun) onClose()
      }}
    >
      <DialogContent
        ref={setDialogPortalContainer}
        className="z-[60] max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-visible"
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>开启托管运行</DialogTitle>
        </DialogHeader>
        <div className="grid min-h-0 gap-2 overflow-y-auto py-2 pr-1">
          <div id={sessionModeId} className="flex items-center gap-1.5 text-sm font-medium">
            会话来源
          </div>
          <div className="mb-2 grid gap-2 rounded-lg border border-border/70 bg-background/70 px-3 py-2.5">
            <div
              role="radiogroup"
              aria-labelledby={sessionModeId}
              className="flex items-center gap-4 text-sm"
            >
              {[
                { isNew: true, label: "新建会话" },
                { isNew: false, label: "使用现有会话" }
              ].map((option) => (
                <label
                  key={option.label}
                  className={cn(
                    "flex items-center gap-1.5 whitespace-nowrap",
                    updatingManagedRun ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                  )}
                >
                  <input
                    type="radio"
                    name={sessionModeId}
                    value={option.isNew ? "new" : "existing"}
                    checked={useNewSession === option.isNew}
                    onChange={() => {
                      setUseNewSession(option.isNew)
                      handleSessionListOpenChange(!option.isNew)
                    }}
                    disabled={updatingManagedRun}
                    className="size-3.5 shrink-0 appearance-none rounded-full border border-muted-foreground/60 bg-background checked:border-primary checked:bg-primary checked:shadow-[inset_0_0_0_3px_var(--background)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  />
                  {option.label}
                </label>
              ))}
            </div>
            <Popover
              open={useExistingSession && sessionListOpen}
              onOpenChange={handleSessionListOpenChange}
            >
              {useExistingSession && (
                <PopoverAnchor asChild>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={updatingManagedRun}
                      aria-label="选择现有会话"
                      className="h-9 w-full min-w-0 justify-between gap-2 rounded-md px-3 text-xs font-normal"
                    >
                      <span className="truncate" title={selectedSession?.title}>
                        {selectedSession?.title || "请选择会话"}
                      </span>
                      <ChevronDown className="size-3.5 shrink-0" />
                    </Button>
                  </PopoverTrigger>
                </PopoverAnchor>
              )}
              <PopoverContent
                portalContainer={dialogPortalContainer}
                align="start"
                aria-label="选择现有会话"
                className="z-[70] flex max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] flex-col p-0"
                onInteractOutside={(event) => {
                  if (!previewThreadId) return
                  event.preventDefault()
                  // Avoid a second dismissal from the focus change following this click.
                  if (event.detail.originalEvent.type === "pointerdown") {
                    event.detail.originalEvent.preventDefault()
                  }
                }}
              >
                <ManagedSessionList
                  sessions={sessions}
                  selectedThreadId={selectedThreadId}
                  previousThreadId={previousThreadId}
                  portalContainer={dialogPortalContainer}
                  previewThreadId={previewThreadId}
                  onPreviewChange={(threadId, open) => {
                    setPreviewThreadId((current) =>
                      open ? threadId : current === threadId ? null : current
                    )
                  }}
                  disabled={updatingManagedRun}
                  onSelect={(threadId) => {
                    setSelectedThreadId(threadId)
                    handleSessionListOpenChange(false)
                  }}
                />
                {sessions.length === 0 && (
                  <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                    {hasMoreSessions ? "已加载的会话中暂无当前特性的会话" : "当前特性暂无现有会话"}
                  </p>
                )}
                {hasMoreSessions && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 rounded-none border-t text-xs"
                    disabled={updatingManagedRun || loadingMoreSessions}
                    onClick={() => void loadMoreSessions()}
                  >
                    {loadingMoreSessions ? (
                      <Loader2 className="mr-2 size-3.5 animate-spin" />
                    ) : (
                      <ChevronDown className="mr-2 size-3.5" />
                    )}
                    {loadingMoreSessions ? "正在加载…" : "加载更早会话"}
                  </Button>
                )}
                {(!selectedSession || selectedSession.disabledReason) && (
                  <p
                    role="alert"
                    className="shrink-0 border-t px-3 py-2 text-xs text-status-warning"
                  >
                    {selectedSession?.disabledReason ||
                      (sessions.length
                        ? "请选择可用的现有会话"
                        : hasMoreSessions
                          ? "可加载更早会话，或开启新会话"
                          : "当前特性暂无现有会话，请开启新会话")}
                  </p>
                )}
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <span>会话工作区</span>
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    aria-label="托管模式会话工作区提示"
                    className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Info className="size-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="z-[70] max-w-72">
                  该路径将作为本次托管模式自动创建会话时使用的会话工作区
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Input
            value={effectiveWorkspacePath}
            readOnly
            title={effectiveWorkspacePath}
            placeholder="请选择文件夹"
            aria-label="会话工作区"
            disabled={useExistingSession || pickingManagedRunWorkspace || updatingManagedRun}
            className="min-w-0 cursor-pointer text-foreground"
            onClick={() => void handlePickManagedRunWorkspace()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                void handlePickManagedRunWorkspace()
              }
            }}
          />
          <label className="mt-2 grid gap-2 text-sm font-medium">
            启动会话的初始用户消息
            <textarea
              value={managedRunUserMessage}
              onChange={(event) => setManagedRunUserMessage(event.target.value)}
              placeholder="留空则使用当前步骤的默认用户消息"
              rows={4}
              disabled={updatingManagedRun}
              className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm font-normal shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
          <div className="mt-2 flex items-start justify-between gap-4 rounded-lg border border-border/70 bg-background/70 px-3 py-2.5">
            <div>
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <span>通过招乎管理托管运行</span>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="查看通过招乎管理托管运行的说明"
                      >
                        <Info className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="z-[70] max-w-80 text-xs leading-5">
                      托管模式需要人工介入的决策可经由招乎审批
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {featureImUnavailableReason
                  ? featureImUnavailableReason
                  : "确认后同步更新“通过招乎管理特性”开关"}
              </div>
            </div>
            <Switch
              aria-label="通过招乎管理托管运行"
              checked={managedRunImEnabled}
              disabled={
                updatingManagedRun || (!managedRunImEnabled && !featureImManagementAvailable)
              }
              onCheckedChange={setManagedRunImEnabled}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={updatingManagedRun}>
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void handleConfirmManagedRun()}
            disabled={
              !effectiveWorkspacePath.trim() ||
              updatingManagedRun ||
              pickingManagedRunWorkspace ||
              (useExistingSession && (!selectedSession || Boolean(selectedSession.disabledReason)))
            }
          >
            {updatingManagedRun && <Loader2 className="size-4 animate-spin" />}
            确认并开启托管
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
