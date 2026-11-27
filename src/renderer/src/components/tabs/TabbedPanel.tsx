import { cancelThreadSearchNavigation, isThreadSearchSurface, useThreadSearch } from "@/lib/thread-search-navigation"
import { useShallow } from "zustand/react/shallow"
import { isBtwThreadId } from "../../../../shared/btw-chat"
import { selectThreadSummary, useAppStore } from "@/lib/store"
import { useBotConversationLink } from "@/components/bots/use-bot-conversation-link"
import { LinkedBotConversation } from "@/components/bots/LinkedBotConversation"
import { ConversationTaskControls } from "@/components/bots/ConversationTaskControls"
import { isRegularChatThread, isManagedLocalWorkConversation } from "@/lib/thread-classification"
import { isRemoteInboxThread } from "@/lib/remote-thread-display"
import { lazy, memo, Suspense, useEffect, useRef, useState } from "react"
import { useThreadActions, useThreadContext, useThreadStateSelector } from "@/lib/thread-context"
import { TabBar } from "./TabBar"
import { ChatContainer, type ChatSurface } from "@/components/chat/ChatContainer"
import { ArrowLeft, Loader2 } from "lucide-react"
import { workspaceFilePreviewModeForPath } from "@/lib/file-preview-mode"
import { resolveAgentModeFromMetadata } from "../../../../shared/agent-mode-metadata"
import { bindDetachedBotThreadDraft, hasBotThreadDraft } from "@/lib/bot-conversation-draft"

const FileViewer = lazy(() => import("./FileViewer").then((m) => ({ default: m.FileViewer })))

interface TabbedPanelProps {
  threadId: string
  showTabBar?: boolean
  floatingChat?: boolean
  chatSurface?: ChatSurface
  hideWelcomeSkillTabs?: boolean
  readOnlyReason?: string | null
  historyOnly?: boolean
  searchAccessPending?: boolean
  onHarnessSessionCreated?: (threadId: string) => void
}

type ChatProps = React.ComponentProps<typeof ChatContainer>

function OrdinaryChat(props: ChatProps) {
  const [hasDraft] = useState(() => hasBotThreadDraft(props.threadId))
  return hasDraft ? <OrdinaryChatWithDraft {...props} /> : <ChatContainer {...props} />
}

function OrdinaryChatWithDraft({ threadId, ...props }: ChatProps) {
  const context = useThreadContext()
  const [loading, setLoading] = useState(true)
  const [activeDraft, setActiveDraft] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, retry] = useState(0)
  useEffect(() => {
    if (props.historyOnly) return undefined
    let disposed = false
    let unbind: (() => void) | undefined
    void window.api.threads.get(threadId).then(row => {
      if (disposed || !row) return
      unbind = bindDetachedBotThreadDraft(context, threadId, row, setError, () => setActiveDraft(false))
      setActiveDraft(Boolean(unbind))
    }).catch(() => {
      if (!disposed) setError("暂时无法恢复原任务的草稿，请重试。")
    }).finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true; unbind?.() }
  }, [context, threadId, attempt, props.historyOnly])
  if (loading && !props.historyOnly) return <div className="flex flex-1 items-center justify-center">
    <Loader2 aria-label="恢复原草稿" className="size-5 animate-spin" />
  </div>
  const resident = error && context.getThreadState(threadId)
  const hasResidentDraft = resident && Boolean(resident.draftInput || resident.draftBotReplyTo ||
    resident.draftAttachments.length || resident.draftMentionedWorkspaceFiles.length || resident.draftSkill ||
    resident.draftBuiltinBrowser)
  const recoveryError = activeDraft ? null : error
  return <>
    {error && <div data-chat-notice role="alert" className="px-4 py-2 text-sm text-muted-foreground">
      {error}
      <button type="button" onClick={() => { setLoading(true); setError(null); retry(value => value + 1) }} className="ml-2 underline">重试</button>
    </div>}
    <ChatContainer {...props} threadId={threadId} restoredBotDraft={activeDraft} restoredBotDraftError={recoveryError}
      readOnlyReason={props.readOnlyReason ?? (hasResidentDraft ? null : recoveryError)} />
  </>
}

export const TabbedPanel = memo(function TabbedPanel({
  threadId,
  showTabBar = true,
  floatingChat = false,
  chatSurface = "default",
  hideWelcomeSkillTabs = false,
  readOnlyReason = null,
  historyOnly = false,
  searchAccessPending = false,
  onHarnessSessionCreated
}: TabbedPanelProps): React.JSX.Element {
  const interactionDisabled = historyOnly || searchAccessPending
  const { managedCandidate, mayAssociate } = useAppStore(useShallow(state => {
    const row = isBtwThreadId(threadId) ? undefined : selectThreadSummary(state, threadId)
    return {
      managedCandidate: !interactionDisabled && isManagedLocalWorkConversation(row),
      mayAssociate: Boolean(
        !interactionDisabled && window.api.bots?.conversations &&
        isRegularChatThread(row) &&
        resolveAgentModeFromMetadata(row?.metadata) === "normal" &&
        !isRemoteInboxThread(row) &&
        !row?.metadata?.remoteState &&
        !row?.metadata?.remoteReadOnly &&
        !row?.metadata?.scheduledTaskId &&
        !threadId.startsWith("heartbeat")
      )
    }
  }))
  const linked = useBotConversationLink(threadId, managedCandidate)
  const activeTab = useThreadStateSelector(threadId, (state) => state.activeTab) ?? "agent"
  const openFiles = useThreadStateSelector(threadId, (state) => state.openFiles) ?? []
  const pendingApproval = useThreadStateSelector(threadId, (state) => state.pendingApproval)
  const setActiveTab = useThreadActions(threadId)?.setActiveTab
  const navigation = useThreadSearch((state) => state.navigation &&
    isThreadSearchSurface(state.navigation, threadId, chatSurface, state.projectRoute) ? state.navigation : null)
  const lastSearchNavigation = useRef<number | null>(null)
  useEffect(() => {
    if (!navigation || !setActiveTab) return
    if (lastSearchNavigation.current !== navigation.id) {
      lastSearchNavigation.current = navigation.id
      if (activeTab !== "agent") setActiveTab("agent")
    } else if (activeTab !== "agent") cancelThreadSearchNavigation()
  }, [navigation, activeTab, setActiveTab])
  const lastAutoFocusedApprovalIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (interactionDisabled) return
    if (!pendingApproval) {
      lastAutoFocusedApprovalIdRef.current = null
      return
    }
    if (lastAutoFocusedApprovalIdRef.current === pendingApproval.id) return

    lastAutoFocusedApprovalIdRef.current = pendingApproval.id
    if (activeTab !== "agent" && setActiveTab) {
      setActiveTab("agent")
    }
  }, [activeTab, interactionDisabled, pendingApproval, setActiveTab])

  // Determine what to render based on active tab
  const isAgentTab = interactionDisabled || activeTab === "agent"
  const activeFile = openFiles.find((f) => f.path === activeTab)
  const activeFilePreviewMode = activeFile
    ? workspaceFilePreviewModeForPath(activeFile.path)
    : undefined

  return (
    <div className="relative flex flex-1 flex-col min-w-0 min-h-0 overflow-hidden"
      data-thread-floating-chat={floatingChat && isAgentTab || undefined}>
      <div data-thread-floating-header>
      {(linked.value || mayAssociate) && !linked.loading && !linked.error && (
        <ConversationTaskControls
          threadId={threadId}
          link={linked.value}
          refresh={linked.refresh}
        />
      )}
      {/* Tab Bar (optional - can be rendered externally in titlebar) */}
      {showTabBar && <TabBar />}

      </div>

      {/* Content Area */}
      <div data-thread-chat-content className="flex flex-1 flex-col min-h-0 overflow-hidden">
        {linked.loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="animate-spin size-5" />
          </div>
        ) : linked.error ? (
          <div role="alert" className="p-4">
            {linked.error}
            <button onClick={linked.refresh} className="ml-2 rounded border px-2">
              重试读取
            </button>
          </div>
        ) : isAgentTab ? (
          historyOnly ? (
            <ChatContainer
              key={threadId}
              threadId={threadId}
              surface={chatSurface}
              hideWelcomeSkillTabs
              readOnlyReason={readOnlyReason}
              historyOnly
            />
          ) : linked.value ? (
            <LinkedBotConversation key={threadId} link={linked.value} />
          ) : (
            <OrdinaryChat
              key={threadId}
              threadId={threadId}
              surface={chatSurface}
              hideWelcomeSkillTabs={hideWelcomeSkillTabs}
              readOnlyReason={readOnlyReason}
              historyOnly={searchAccessPending}
              onHarnessSessionCreated={onHarnessSessionCreated}
            />
          )
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
})
