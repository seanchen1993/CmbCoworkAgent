import { lazy, Suspense, useEffect, useRef } from "react"
import { useThreadActions, useThreadStateSelector } from "@/lib/thread-context"
import { TabBar } from "./TabBar"
import { ChatContainer, type ChatSurface } from "@/components/chat/ChatContainer"
import { ArrowLeft, Loader2 } from "lucide-react"

const FileViewer = lazy(() => import("./FileViewer").then((m) => ({ default: m.FileViewer })))

interface TabbedPanelProps {
  threadId: string
  showTabBar?: boolean
  hasPendingGitDiffNotice?: boolean
  chatSurface?: ChatSurface
  hideWelcomeSkillTabs?: boolean
  readOnlyReason?: string | null
  onRequestOpenGitPanel?: () => void
  onDismissGitChangeNotice?: () => void
  onThreadGitStatusChange?: (threadId: string, isGit: boolean) => void
  onHarnessSessionCreated?: (threadId: string) => void
}

export function TabbedPanel({
  threadId,
  showTabBar = true,
  hasPendingGitDiffNotice = false,
  chatSurface = "default",
  hideWelcomeSkillTabs = false,
  readOnlyReason = null,
  onRequestOpenGitPanel,
  onDismissGitChangeNotice,
  onThreadGitStatusChange,
  onHarnessSessionCreated
}: TabbedPanelProps): React.JSX.Element {
  const activeTab = useThreadStateSelector(threadId, (state) => state.activeTab) ?? "agent"
  const openFiles = useThreadStateSelector(threadId, (state) => state.openFiles) ?? []
  const pendingApproval = useThreadStateSelector(threadId, (state) => state.pendingApproval)
  const setActiveTab = useThreadActions(threadId)?.setActiveTab
  const lastAutoFocusedApprovalIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!pendingApproval) {
      lastAutoFocusedApprovalIdRef.current = null
      return
    }
    if (lastAutoFocusedApprovalIdRef.current === pendingApproval.id) return

    lastAutoFocusedApprovalIdRef.current = pendingApproval.id
    if (activeTab !== "agent" && setActiveTab) {
      setActiveTab("agent")
    }
  }, [activeTab, pendingApproval, setActiveTab])

  // Determine what to render based on active tab
  const isAgentTab = activeTab === "agent"
  const activeFile = openFiles.find((f) => f.path === activeTab)

  return (
    <div className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden">
      {/* Tab Bar (optional - can be rendered externally in titlebar) */}
      {showTabBar && <TabBar />}

      {/* Subtle gradient fade from titlebar */}
      <div className="h-1 shrink-0 bg-gradient-to-b from-sidebar/80 to-transparent" />

      {/* Content Area */}
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        {isAgentTab ? (
          <ChatContainer
            key={threadId}
            threadId={threadId}
            showGitChangeNotice={hasPendingGitDiffNotice}
            surface={chatSurface}
            hideWelcomeSkillTabs={hideWelcomeSkillTabs}
            readOnlyReason={readOnlyReason}
            onOpenGitPanel={onRequestOpenGitPanel}
            onDismissGitChangeNotice={onDismissGitChangeNotice}
            onThreadGitStatusChange={onThreadGitStatusChange}
            onHarnessSessionCreated={onHarnessSessionCreated}
          />
        ) : activeFile ? (
          <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
            <div className="flex h-10 shrink-0 items-center border-b border-border/60 px-3">
              <button
                type="button"
                onClick={() => setActiveTab?.("agent")}
                className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
              >
                <ArrowLeft className="size-3.5" />
                返回对话
              </button>
            </div>
            {/* Use key to force remount when file changes, ensuring fresh state */}
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  <span className="text-sm">加载文件中...</span>
                </div>
              }
            >
              <FileViewer
                key={activeFile.path}
                filePath={activeFile.path}
                threadId={threadId}
                workspacePathKind="relative"
                requestLane="active-file-tab"
              />
            </Suspense>
          </div>
        ) : (
          // Fallback - shouldn't happen but just in case
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            Select a tab to view content
          </div>
        )}
      </div>
    </div>
  )
}
