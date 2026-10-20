import { useAppStore } from "@/lib/store"
import { useBotConversationLink } from "@/components/bots/use-bot-conversation-link"
import { LinkedBotConversation } from "@/components/bots/LinkedBotConversation"
import { ConversationTaskControls } from "@/components/bots/ConversationTaskControls"
import { isRegularChatThread,isLocalWorkConversation,isHarnessProjectModeThread } from "@/lib/thread-classification"
import { isRemoteInboxThread } from "@/lib/remote-thread-display"
import { lazy, Suspense, useEffect, useRef } from "react"
import { useThreadActions, useThreadStateSelector } from "@/lib/thread-context"
import { TabBar } from "./TabBar"
import { ChatContainer, type ChatSurface } from "@/components/chat/ChatContainer"
import { ArrowLeft, Loader2 } from "lucide-react"
import { workspaceFilePreviewModeForPath } from "@/lib/file-preview-mode"

const FileViewer = lazy(() => import("./FileViewer").then((m) => ({ default: m.FileViewer })))

interface TabbedPanelProps {
  threadId: string
  showTabBar?: boolean
  chatSurface?: ChatSurface
  hideWelcomeSkillTabs?: boolean
  readOnlyReason?: string | null
  onHarnessSessionCreated?: (threadId: string) => void
}

export function TabbedPanel({
  threadId,
  showTabBar = true,
  chatSurface = "default",
  hideWelcomeSkillTabs = false,
  readOnlyReason = null,
  onHarnessSessionCreated
}: TabbedPanelProps): React.JSX.Element {
  const row=useAppStore(state=>state.threads.find(thread=>thread.thread_id===threadId))
  const managedCandidate=isLocalWorkConversation(row) && !isHarnessProjectModeThread(row) && !isRemoteInboxThread(row) && !row?.metadata?.remoteState && !row?.metadata?.remoteReadOnly
  const linked=useBotConversationLink(threadId,managedCandidate)
  const mayAssociate=Boolean(window.api.bots?.conversations && isRegularChatThread(row) && !isRemoteInboxThread(row) && !row?.metadata?.remoteState && !row?.metadata?.remoteReadOnly && !row?.metadata?.scheduledTaskId && !threadId.startsWith("heartbeat"))
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
  const activeFilePreviewMode = activeFile
    ? workspaceFilePreviewModeForPath(activeFile.path)
    : undefined

  return (
    <div className="flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden">
      {(linked.value || mayAssociate) && !linked.loading && !linked.error && <ConversationTaskControls threadId={threadId} link={linked.value} refresh={linked.refresh} />}
      {/* Tab Bar (optional - can be rendered externally in titlebar) */}
      {showTabBar && <TabBar />}

      {/* Subtle gradient fade from titlebar */}
      <div className="h-1 shrink-0 bg-gradient-to-b from-sidebar/80 to-transparent" />

      {/* Content Area */}
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        {linked.loading ? <div className="flex flex-1 items-center justify-center"><Loader2 className="animate-spin size-5" /></div> : linked.error ? <div role="alert" className="p-4">{linked.error}<button onClick={linked.refresh} className="ml-2 rounded border px-2">重试读取</button></div> : isAgentTab ? linked.value ? <LinkedBotConversation key={threadId} link={linked.value} /> : (
          <ChatContainer
            key={threadId}
            threadId={threadId}
            surface={chatSurface}
            hideWelcomeSkillTabs={hideWelcomeSkillTabs}
            readOnlyReason={readOnlyReason}
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
            {/* Remount for both file and task changes so same-named files never share preview state. */}
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  <span className="text-sm">加载文件中...</span>
                </div>
              }
            >
              <FileViewer
                key={JSON.stringify([threadId, activeFile.path])}
                filePath={activeFile.path}
                threadId={threadId}
                workspacePathKind="relative"
                previewMode={activeFilePreviewMode}
                htmlPreviewPolicy={
                  activeFilePreviewMode === "preview" ? "workspace-scripted" : undefined
                }
                requestLane="active-file-tab"
                visualEditPolicy="thread-submit"
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
