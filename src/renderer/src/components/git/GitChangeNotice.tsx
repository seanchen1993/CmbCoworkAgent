import { useEffect } from "react"
import { AlertCircle, X } from "lucide-react"
import { useAppStore } from "@/lib/store"
import { openResourcePanelOverlay } from "@/lib/resource-panel-overlay-events"

export function GitChangeNotice({ threadId }: { threadId: string }): React.JSX.Element | null {
  const visible = useAppStore(
    (state) =>
      state.gitChangeNoticeEnabled &&
      state.gitChangeNoticePendingByThread[threadId] === true &&
      state.gitWorkspaceByThread[threadId] === true &&
      state.rightModule !== "git"
  )
  const setPending = useAppStore((state) => state.setGitChangeNoticePending)
  const setShowCustomizeView = useAppStore((state) => state.setShowCustomizeView)

  if (!visible) return null
  return (
    <div className="max-w-3xl mx-auto mb-2 flex items-center justify-between gap-3 rounded-xl border border-status-warning/40 bg-status-warning/10 px-3 py-2">
      <div className="min-w-0 flex items-center gap-2 text-[12px] text-foreground">
        <AlertCircle className="size-3.5 shrink-0 text-status-warning" />
        <span className="truncate">检测到文件变更，可打开 Git 面板查看。</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={() => { setPending(threadId, false); openResourcePanelOverlay("git") }} className="rounded-md bg-status-warning/15 px-2.5 py-1 text-xs font-medium text-status-warning transition-colors hover:bg-status-warning/20">打开</button>
        <button type="button" onClick={() => { setPending(threadId, false); setShowCustomizeView(true, "general", "git-change-notice") }} className="rounded-md px-2.5 py-1 text-xs font-medium text-status-warning transition-colors hover:bg-status-warning/15">配置</button>
        <button type="button" onClick={() => setPending(threadId, false)} className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-status-warning/15 hover:text-foreground" aria-label="关闭文件变更提示" title="关闭"><X className="size-3.5" /></button>
      </div>
    </div>
  )
}

export function useGitChangeNoticeListener(
  activeThreadId: string | null,
  rightModule: string
): void {
  const enabled = useAppStore((state) => state.gitChangeNoticeEnabled)
  const setPending = useAppStore((state) => state.setGitChangeNoticePending)

  useEffect(() => {
    if (!enabled) return
    return window.api.workspace.onFilesChanged((data) => {
      for (const threadId of data.threadIds) {
        if (rightModule === "git" && threadId === activeThreadId) continue
        setPending(threadId, true)
      }
    })
  }, [activeThreadId, enabled, rightModule, setPending])
}
