import { useId, useLayoutEffect, useRef } from "react"
import { FocusScope } from "@radix-ui/react-focus-scope"
import { hideOthers } from "aria-hidden"
import { createPortal } from "react-dom"
import { AlertTriangle, GitCommit, Loader2, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getOpenWorkbenchDialog } from "@/lib/modal-dialog"

interface GitPushDialogProps {
  open: boolean
  running: boolean
  submitDisabled?: boolean
  loading?: boolean
  branch: string
  pendingCommits?: Array<{ hash: string; message: string; date: string }>
  onOpenChange: (open: boolean) => void
  onSubmit: () => void
}

export function GitPushDialog({
  open,
  running,
  submitDisabled = false,
  loading = false,
  branch,
  pendingCommits,
  onOpenChange,
  onSubmit
}: GitPushDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  const invokerRef = useRef<HTMLElement | null>(null)
  const previousButton = useRef<HTMLButtonElement | null>(null)
  const backdropPress = useRef(false)
  const titleId = useId()
  const descriptionId = useId()
  const commitCount = pendingCommits?.length ?? 0
  const noPushableCommits = !loading && commitCount === 0

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!open || !dialog) return
    invokerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    let restoreBackground: (() => void) | undefined
    previousButton.current = null
    // A workbench approval can arrive while push metadata or the push itself is pending.
    // Its portal must take focus above this native top-layer dialog.
    const syncModal = (): void => {
      if (getOpenWorkbenchDialog()) {
        if (dialog.matches(":popover-open")) {
          dialog.hidePopover()
          restoreBackground?.()
          restoreBackground = undefined
        }
      } else if (!dialog.matches(":popover-open")) {
        const first = previousButton.current?.isConnected && !previousButton.current.disabled
          ? previousButton.current
          : dialog.querySelector<HTMLButtonElement>("button:enabled")
        if (first) first.autofocus = true
        dialog.showPopover()
        restoreBackground = hideOthers(dialog)
        if (first) first.autofocus = false
      }
    }
    // Native autofocus needs layout. Finish the click and React commit first.
    const timer = window.setTimeout(syncModal, 0)
    const observer = new MutationObserver(syncModal)
    observer.observe(document.body, { childList: true })
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
      if (dialog.matches(":popover-open")) dialog.hidePopover()
      restoreBackground?.()
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      const dialog = dialogRef.current
      if (!dialog?.matches(":popover-open") || event.defaultPrevented) return
      if (event.key === "Escape") {
        // Disabling the focused Push button can leave focus on document.body.
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.isComposing) onOpenChange(false)
      } else if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const buttons = dialog.querySelectorAll<HTMLButtonElement>("button:enabled")
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        const active = document.activeElement
        if (!dialog.contains(active) || active === dialog || active === (event.shiftKey ? first : last)) {
          event.preventDefault()
          const next = event.shiftKey ? last : first
          next.focus({ preventScroll: true })
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [open, onOpenChange])

  if (!open) return null
  return createPortal(
    <div
      ref={dialogRef}
      popover="manual"
      className="fixed inset-0 m-0 h-full w-full max-w-none place-items-center overflow-hidden border-0 bg-black/35 p-0 text-foreground [&:popover-open]:grid [-webkit-app-region:no-drag]"
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLButtonElement) previousButton.current = event.target
      }}
      onPointerDown={(event) => {
        backdropPress.current = event.target === event.currentTarget && event.button === 0 && !event.ctrlKey
      }}
      onClick={(event) => {
        if (backdropPress.current && event.target === event.currentTarget) onOpenChange(false)
        backdropPress.current = false
      }}
    >
      <FocusScope
        asChild
        trapped
        loop
        onMountAutoFocus={(event) => event.preventDefault()}
        onUnmountAutoFocus={(event) => {
          event.preventDefault()
          if (!dialogRef.current && document.activeElement === document.body && !getOpenWorkbenchDialog()) {
            invokerRef.current?.focus({ preventScroll: true })
          }
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          data-cmb-modal-dialog="true"
          className="relative max-h-full w-full max-w-lg overflow-auto rounded-2xl border border-border bg-background shadow-xl"
        >
          <div className="grid gap-4 [&>*]:min-w-0">
            <div className="px-5 py-4 border-b border-border/70">
              <h2 id={titleId} className="text-[16px] font-semibold">Git 推送</h2>
              <div id={descriptionId} className="mt-1 text-xs text-muted-foreground">
                只推送已提交但未 push 的 commit
              </div>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div className="rounded-xl border border-border/70 bg-muted/25 p-3 space-y-2">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">分支</span>
                  <span className="font-mono text-foreground truncate max-w-[300px]" title={branch || "-"}>
                    {branch || "-"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">待推送</span>
                  <span className="font-medium">
                    {loading ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Loader2 className="size-3 animate-spin" />
                        读取中
                      </span>
                    ) : (
                      `${commitCount} commits`
                    )}
                  </span>
                </div>
              </div>

              {loading ? (
                <div className="rounded-lg border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    正在读取当前仓库待推送提交...
                  </div>
                </div>
              ) : noPushableCommits ? (
                <div className="rounded-lg border border-amber-500/45 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <div>
                      <div className="font-semibold">没有可 Push 的 commit</div>
                      <div className="mt-1 text-xs leading-5">
                        当前分支没有检测到待推送提交。如需推送新改动，请先完成 Commit。
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-border/70 bg-muted/20 p-2.5 text-sm text-muted-foreground">
                  Push 不会提交当前未提交文件。如需推送新的改动，请先完成 Commit。
                </div>
              )}

              {pendingCommits && pendingCommits.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <GitCommit className="size-3.5" />
                    待推送的 {pendingCommits.length} 个提交
                  </div>
                  <div className="rounded-lg border border-border/70 bg-muted/10 divide-y divide-border/50 max-h-[180px] overflow-y-auto">
                    {pendingCommits.map((commit) => (
                      <div key={commit.hash} className="px-2.5 py-2 flex items-start gap-2">
                        <code className="shrink-0 text-[10px] font-mono text-muted-foreground mt-0.5">
                          {commit.hash.slice(0, 7)}
                        </code>
                        <span className="text-xs text-foreground break-all leading-5">
                          {commit.message}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="px-5 pb-5 pt-2 flex flex-col gap-2">
              <Button
                id="git-push-button"
                type="button"
                className="w-full h-9"
                disabled={running || submitDisabled || loading || noPushableCommits}
                onClick={onSubmit}
              >
                {running ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    推送中，可能稍慢，请耐心等待...
                  </>
                ) : (
                  <>
                    <Upload className="size-4" />
                    Push 推送
                  </>
                )}
              </Button>

              <Button
                id="git-cancel-button"
                type="button"
                variant="ghost"
                className="w-full h-9"
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </button>
        </div>
      </FocusScope>
    </div>,
    document.body
  )
}
