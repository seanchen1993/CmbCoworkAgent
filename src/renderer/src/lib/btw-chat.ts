import { useSyncExternalStore } from "react"
import { create } from "zustand"
import { isThreadRetired, registerSideThreadSummary, retireRendererThread, useAppStore } from "./store"
import { toast } from "sonner"
import { clearBtwReferences } from "./btw-references"
import { onOpenResourcePanelOverlay } from "./resource-panel-overlay-events"
import { releaseSubmitInFlightLock, subscribeSubmitInFlightRelease, submitInFlightLockStore, tryAcquireSubmitInFlightLock } from "./submit-in-flight-lock"
import { getQueuedDisplayContent, getQueuedModelContent, guardCoordinatorPlainText, nextOrdinaryQueuedMessage } from "./queued-message-content"
import type { useThreadContext } from "./thread-context"
import { loadWorkspaceFilesDeduped } from "./workspace-file-load"
import { BTW_FILE_CANDIDATE_LIMIT, BTW_FILE_CANDIDATE_PATH_LIMIT, isBtwThreadId, type BtwSkillRequestClosed } from "../../../shared/btw-chat"
import { extractAtFileMentions, isSupportedWorkspaceMentionFilePath, normalizeAtFileMentionPath } from "../features/mentions/useAtFileMentions"

type SideCloseState = "closing" | "failed"
type SkillEvolutionApi = Window["api"]["skillEvolution"]
type SkillIntent = Parameters<Parameters<SkillEvolutionApi["onIntentRequest"]>[0]>[0]
type SkillConfirm = Parameters<Parameters<SkillEvolutionApi["onConfirmRequest"]>[0]>[0]
type SideSkillRequest = { kind: "intent"; request: SkillIntent } | { kind: "confirm"; request: SkillConfirm }

interface SideTab {
  id: string
  number: number
  parentId: string
  firstInput?: string
  closeState?: SideCloseState
  pending?: boolean
  skillRequests?: SideSkillRequest[]
}
interface SideTabs { tabs: SideTab[]; selected: Record<string, string> }
type ThreadContext = ReturnType<typeof useThreadContext>
type FirstQuestionContext = Pick<ThreadContext,
  "getStreamData" | "getThreadState" | "initializeThread" | "subscribeToStream" | "subscribeToThreadState"> & {
  getThreadActions: (id: string) => Pick<ReturnType<ThreadContext["getThreadActions"]>,
    "appendMessage" | "setDraftInput" | "setError" | "setActiveTurnStartTime">
}

export const useBtwChat = create<SideTabs>(() => ({ tabs: [], selected: {} }))
export const BTW_QUEUE_CONFIGURATION_ERROR = "请核对辅助对话的模型和工作目录，消息已保留在队列中。"

const desktopViewport = "(min-width: 768px)"

function subscribeBtwViewport(onChange: () => void) {
  const query = window.matchMedia?.(desktopViewport)
  query?.addEventListener("change", onChange)
  return () => query?.removeEventListener("change", onChange)
}

function isDesktopBtwViewport(): boolean {
  return window.matchMedia?.(desktopViewport).matches ?? window.innerWidth >= 768
}

export function useDesktopBtwViewport(): boolean {
  return useSyncExternalStore(subscribeBtwViewport, isDesktopBtwViewport, () => false)
}

// A tab badge must not keep its idle chat and stream hydrated.
export function setBtwPendingInteraction(id: string, pending: boolean) {
  useBtwChat.setState(state => {
    if (!state.tabs.some(tab => tab.id === id && Boolean(tab.pending) !== pending)) return state
    return { tabs: state.tabs.map(tab => tab.id === id ? { ...tab, pending } : tab) }
  })
}

export function getSideQuestion(id: string) {
  return useBtwChat.getState().tabs.find(tab => tab.id === id)?.firstInput
}

export function isBtwSubmissionBlocked(id: string): boolean {
  return isBtwThreadId(id) && (isThreadRetired(id) ||
    useBtwChat.getState().tabs.some(tab => tab.id === id && tab.closeState !== undefined))
}

function getOpenSideTab(id: string | undefined): SideTab | undefined {
  if (!id || !isBtwThreadId(id) || isThreadRetired(id)) return
  return useBtwChat.getState().tabs.find(tab => tab.id === id && !tab.closeState)
}

function addSideSkillRequest(entry: SideSkillRequest): void {
  const tab = getOpenSideTab(entry.request.threadId)
  if (!tab || tab.skillRequests?.some(item => item.request.requestId === entry.request.requestId)) return
  useBtwChat.setState(({ tabs }) => ({
    tabs: tabs.map(item => item === tab ? { ...tab, skillRequests: [...(tab.skillRequests ?? []), entry] } : item)
  }))
  if (entry.kind === "confirm" && entry.request.source === "proposal") {
    useAppStore.getState().setSkillGenerationPhase("done", undefined, tab.id)
  }
}

function removeSideSkillRequest({ threadId, kind, requestId }: BtwSkillRequestClosed): void {
  const tab = getOpenSideTab(threadId)
  const remaining = tab?.skillRequests?.filter(entry => entry.kind !== kind || entry.request.requestId !== requestId)
  if (!tab || !remaining || remaining.length === tab.skillRequests?.length) return
  useBtwChat.setState(({ tabs }) => ({
    tabs: tabs.map(item => item === tab ? { ...tab, skillRequests: remaining } : item)
  }))
}

/** Follow skill interactions while the owning chat is hidden or its stream holder is evicted. */
export function subscribeBtwSkillEvolution(): () => void {
  const api = window.api.skillEvolution
  const unsubscribe = [
    api.onIntentRequest(request => addSideSkillRequest({ kind: "intent", request })),
    api.onConfirmRequest(request => addSideSkillRequest({ kind: "confirm", request })),
    api.onBtwRequestClosed(removeSideSkillRequest),
    api.onGenerating(({ threadId, phase, text }) => {
      const tab = getOpenSideTab(threadId)
      if (!tab) return
      const app = useAppStore.getState()
      if (phase === "start") app.setSkillGenerationPhase("generating", undefined, tab.id)
      else if (phase === "token") app.appendSkillGenerationToken(text, tab.id)
      else if (phase === "error") app.setSkillGenerationPhase("error", text || "生成失败", tab.id)
      else if (phase === "settled") app.setSkillGenerationPhase(null, undefined, tab.id)
    })
  ]
  return () => unsubscribe.forEach(stop => stop())
}

export async function respondBtwSkillIntent(threadId: string, requestId: string, accepted: boolean): Promise<void> {
  const entry = getOpenSideTab(threadId)?.skillRequests?.find(item =>
    item.kind === "intent" && item.request.requestId === requestId
  )
  if (entry?.kind !== "intent") return
  try {
    const answered = await window.api.skillEvolution.intentResponse(requestId, accepted)
    removeSideSkillRequest({ threadId, kind: "intent", requestId })
    if (answered && accepted && getOpenSideTab(threadId)) {
      useAppStore.getState().setSkillRetryContext({
        context: entry.request.context,
        intentMode: entry.request.mode
      }, threadId)
    }
  } catch (error) {
    if (getOpenSideTab(threadId)) toast.error(error instanceof Error ? error.message : "无法确认技能生成请求。")
  }
}

export async function respondBtwSkillConfirmation(
  threadId: string, requestId: string, approved: boolean, content?: string
): Promise<void> {
  if (!getOpenSideTab(threadId)?.skillRequests?.some(item =>
    item.kind === "confirm" && item.request.requestId === requestId
  )) return
  try {
    await window.api.skillEvolution.confirmResponse(requestId, approved, content)
    removeSideSkillRequest({ threadId, kind: "confirm", requestId })
  } catch (error) {
    if (getOpenSideTab(threadId)) toast.error(error instanceof Error ? error.message : "无法确认技能草稿。")
  }
}

export async function retryBtwSkillGeneration(threadId: string): Promise<void> {
  const app = useAppStore.getState()
  const context = app.skillRetryContextByThread.get(threadId)
  if (!getOpenSideTab(threadId) || !context || app.skillGenerationByThread.get(threadId)?.phase !== "error") return
  app.setSkillGenerationPhase("generating", undefined, threadId)
  try {
    await window.api.skillEvolution.retryGeneration(threadId, context)
  } catch (error) {
    if (getOpenSideTab(threadId)) {
      app.setSkillGenerationPhase("error", error instanceof Error ? error.message : "重试失败", threadId)
    }
  }
}

export async function loadBtwWorkspaceFiles(id: string, workspacePath: string) {
  const isOpen = ({ tabs }: SideTabs) => tabs.some(tab => tab.id === id && tab.closeState === undefined)
  if (!isOpen(useBtwChat.getState())) return null
  const controller = new AbortController()
  // Keep preparing a submitted message when its tab is merely hidden.
  const unsubscribe = useBtwChat.subscribe((state, previous) => {
    if (state.tabs !== previous.tabs && !isOpen(state)) controller.abort()
  })
  try {
    return await loadWorkspaceFilesDeduped(id, workspacePath, { signal: controller.signal })
  } finally {
    unsubscribe()
  }
}

export async function confirmBtwMessageDurable(threadId: string, messageId: string): Promise<boolean | undefined> {
  try {
    const result = await window.api.agent.reconcileCurrentRunQueuedMessages(threadId, [messageId])
    return result.durableIds.includes(messageId)
  } catch {
    return undefined
  }
}

function acknowledgeSideQuestion(id: string, question: string) {
  useBtwChat.setState(state => {
    if (!state.tabs.some(tab => tab.id === id && tab.firstInput === question)) return state
    return { tabs: state.tabs.map(tab => tab.id === id ? { ...tab, firstInput: undefined } : tab) }
  })
}

// Both slash submissions and queued follow-ups use the thread's existing stream.
async function submitSideTurn(
  context: FirstQuestionContext, id: string, modelId: string, messageId: string,
  content: string, displayContent: string, onAccepted: (workspace?: string) => void
) {
  const actions = context.getThreadActions(id)
  const stream = context.getStreamData(id).stream
  if (!stream) throw new Error("辅助对话尚未就绪。")
  const startedAt = new Date()
  actions.setActiveTurnStartTime(startedAt.getTime())
  let accepted = false
  try {
    await stream.submit({ messages: [{ type: "human", content }] }, {
      config: { configurable: { thread_id: id, model_id: modelId, agent_mode: "normal", hook_turn_id: messageId } },
      onPromptAccepted: workspace => {
        if (accepted || isThreadRetired(id)) return
        accepted = true
        actions.appendMessage({
          id: messageId, role: "user", content: displayContent,
          created_at: startedAt, start_at: startedAt, end_at: startedAt
        })
        onAccepted(workspace)
      }
    })
  } finally {
    if (!isThreadRetired(id)) actions.setActiveTurnStartTime(null)
  }
}

interface FirstQuestion {
  text: string
  context: FirstQuestionContext
  settleHistory?: (acceptedWorkspace?: string | null) => void
}

function startFirstQuestion(id: string, { text: question, context, settleHistory }: FirstQuestion) {
  const pending = () => getSideQuestion(id) === question && !isThreadRetired(id)
  const canStart = () => pending() && !isBtwSubmissionBlocked(id)
  if (!canStart()) return settleHistory?.()
  const unsubscribe: Array<() => void> = []
  const stopWaiting = () => unsubscribe.splice(0).forEach(stop => stop())
  const actions = context.getThreadActions(id)
  const preserveDraft = (message: string) => {
    settleHistory?.()
    if (!pending()) return
    if (!context.getThreadState(id).draftInput) actions.setDraftInput(question)
    actions.setError(message)
    acknowledgeSideQuestion(id, question)
  }

  const sendWhenReady = () => {
    if (!canStart()) {
      settleHistory?.()
      stopWaiting()
      return
    }
    const state = context.getThreadState(id)
    if (state.historyRestorationFailed) {
      stopWaiting()
      preserveDraft("无法加载辅助对话，首条消息已保留为草稿。")
      return
    }
    const { stream } = context.getStreamData(id)
    if (!stream || state.historyLoading || state.historyRestorationPending) return
    stopWaiting()
    const model = useAppStore.getState().models.find(model => model.id === state.currentModel)
    if (!model?.available || !state.workspacePath) {
      preserveDraft("请核对辅助对话的模型和工作目录，首条消息已保留为草稿。")
      return
    }
    if (!tryAcquireSubmitInFlightLock(submitInFlightLockStore, true, id)) {
      preserveDraft("辅助对话正在提交消息，首条消息已保留为草稿。")
      return
    }

    const messageId = crypto.randomUUID()
    void (async () => {
      let submissionError: string | undefined
      try {
        try {
          await submitSideTurn(context, id, model.id, messageId, question, question,
            workspace => {
              settleHistory?.(workspace)
              acknowledgeSideQuestion(id, question)
            })
        } catch (error) {
          submissionError = error instanceof Error ? error.message : "发送辅助问题失败。"
        }
        if (!pending()) return

        // Stopping the stream can drop the receipt after the main process has
        // committed this exact user message. The transcript sync will render it.
        const durable = await confirmBtwMessageDurable(id, messageId)
        if (durable === undefined) preserveDraft("无法确认首条辅助消息是否已发送。重发前请先核对对话记录。")
        else if (durable) {
          settleHistory?.(context.getThreadState(id).workspacePath)
          acknowledgeSideQuestion(id, question)
        } else preserveDraft(submissionError || context.getThreadState(id).error || "首条辅助消息未确认，已保留为草稿。")
      } finally {
        settleHistory?.()
        releaseSubmitInFlightLock(submitInFlightLockStore, true, id)
      }
    })()
  }

  unsubscribe.push(
    context.subscribeToThreadState(id, sendWhenReady),
    context.subscribeToStream(id, sendWhenReady),
    useBtwChat.subscribe(() => {
      if (!canStart()) {
        settleHistory?.()
        stopWaiting()
      }
    })
  )
  try {
    context.initializeThread(id)
    sendWhenReady()
  } catch (error) {
    stopWaiting()
    preserveDraft(error instanceof Error ? error.message : "无法初始化辅助对话。")
  }
}

// A hidden side tab has no ChatContainer to drain its queue. Subscribe only
// while it actually has queued work; the visible composer takes back ownership on mount.
const hiddenQueues = new Map<string, () => void>()

export function resumeVisibleBtwQueue(id: string) {
  hiddenQueues.get(id)?.()
}

export function drainHiddenBtwQueue(id: string, context: ThreadContext) {
  if (hiddenQueues.has(id) || isBtwSubmissionBlocked(id) || !context.getThreadState(id).queuedMessages.length) return
  const subscriptions: Array<() => void> = []
  const stop = () => {
    hiddenQueues.delete(id)
    subscriptions.splice(0).forEach(unsubscribe => unsubscribe())
  }
  function drain() {
    const state = context.getThreadState(id)
    if (isBtwSubmissionBlocked(id) || !state.queuedMessages.length || state.queueAutoDrainSuppressed ||
      state.error || state.historyRestorationFailed) return stop()
    const { stream, isLoading } = context.getStreamData(id)
    if (!stream || isLoading || state.historyLoading || state.historyRestorationPending ||
      state.pendingApproval || state.pendingUserInput || state.scheduledTaskLoading) return
    const next = nextOrdinaryQueuedMessage(state.queuedMessages)
    if (!next) return stop()
    if (!tryAcquireSubmitInFlightLock(submitInFlightLockStore, true, id)) return
    const actions = context.getThreadActions(id)
    const models = useAppStore.getState().models
    const model = models.find(m => m.available && m.id === next.modelId) ??
      models.find(m => m.available && m.id === state.currentModel)
    if (!model || !state.workspacePath) {
      stop()
      actions.setError(BTW_QUEUE_CONFIGURATION_ERROR)
      releaseSubmitInFlightLock(submitInFlightLockStore, true, id)
      return
    }
    actions.deleteQueuedMessage(next.id)
    let accepted = false
    void (async () => {
      let error: string | undefined
      try {
        try {
          await submitSideTurn(context, id, model.id, next.id, getQueuedModelContent(next),
            guardCoordinatorPlainText(getQueuedDisplayContent(next)), () => { accepted = true })
        } catch (cause) {
          error = cause instanceof Error ? cause.message : "发送辅助问题失败。"
        }
        if (accepted || isBtwSubmissionBlocked(id)) return
        const durable = await confirmBtwMessageDurable(id, next.id)
        if (durable || isBtwSubmissionBlocked(id)) return
        if (!context.getThreadState(id).queueAutoDrainSuppressed)
          actions.setError(error || "排队消息未确认，已保留在队列中。")
        actions.prependQueuedMessage(durable === undefined ? { ...next, handoffRequestedAt: new Date() } : next)
      } finally {
        releaseSubmitInFlightLock(submitInFlightLockStore, true, id)
      }
    })()
  }
  hiddenQueues.set(id, stop)
  subscriptions.push(context.subscribeToStream(id, drain), context.subscribeToThreadState(id, drain),
    subscribeSubmitInFlightRelease(submitInFlightLockStore, id, drain),
    useBtwChat.subscribe(() => { if (isBtwSubmissionBlocked(id)) stop() }))
  drain()
}

export async function openBtw(parentId: string, modelId: string, first?: FirstQuestion) {
  const fileCandidates = first ? [...new Set(extractAtFileMentions(first.text)
    .map(normalizeAtFileMentionPath)
    .filter(path => path && path.length <= BTW_FILE_CANDIDATE_PATH_LIMIT && !path.includes("\0") &&
      isSupportedWorkspaceMentionFilePath(path)))] : []
  if (fileCandidates.length > BTW_FILE_CANDIDATE_LIMIT) {
    throw new Error("需要核对的 @文件太多，当前草稿已保留。")
  }
  const app = useAppStore.getState()
  let activate = app.currentThreadId === parentId && app.mainView === "thread" && !app.showCustomizeView
  // Creation may read a large parent transcript. Preserve navigation performed while it runs.
  const stopWatchingRoute = useAppStore.subscribe((state, prev) => {
    activate &&= state.currentThreadId === prev.currentThreadId && state.mainView === prev.mainView &&
      state.rightModule === prev.rightModule && state.rightPanelCollapsed === prev.rightPanelCollapsed &&
      state.showCustomizeView === prev.showCustomizeView
  })
  const stopWatchingSelection = useBtwChat.subscribe((state, prev) => {
    activate &&= state.selected[parentId] === prev.selected[parentId]
  })
  const stopWatchingOverlay = onOpenResourcePanelOverlay(() => { activate = false })
  const { id, ordinal, thread } = await window.api.btw.create({
    parentId, modelId, ...(fileCandidates.length && { fileCandidates })
  }).finally(() => {
    stopWatchingRoute()
    stopWatchingSelection()
    stopWatchingOverlay()
  })
  if (isThreadRetired(parentId)) return
  registerSideThreadSummary(thread)
  useBtwChat.setState(({ tabs, selected }) => ({
    tabs: [...tabs, { id, number: ordinal, parentId, firstInput: first?.text }],
    selected: activate || !selected[parentId] ? { ...selected, [parentId]: id } : selected
  }))
  if (first) startFirstQuestion(id, first)
  if (activate) {
    useAppStore.setState({ rightModule: "btw", rightPanelCollapsed: false })
  }
  return id
}

function removeSideTab(id: string) {
  const tab = useBtwChat.getState().tabs.find(candidate => candidate.id === id)
  if (!tab) return
  clearBtwReferences(id)
  useBtwChat.setState(({ tabs, selected }) => {
    const remaining = tabs.filter(t => t.id !== id)
    const next = { ...selected }
    if (next[tab.parentId] === id) {
      const siblings = tabs.filter(t => t.parentId === tab.parentId)
      const index = siblings.indexOf(tab)
      const target = siblings[index + 1] ?? siblings[index - 1]
      if (target) next[tab.parentId] = target.id
      else delete next[tab.parentId]
    }
    return { tabs: remaining, selected: next }
  })
  const state = useBtwChat.getState()
  const app = useAppStore.getState()
  if (!state.selected[tab.parentId] && app.currentThreadId === tab.parentId && app.rightModule === "btw")
    useAppStore.getState().setRightModule("work")
}

export function forgetBtw(id: string) {
  removeSideTab(id)
  retireRendererThread(id)
}

export async function loadBtwThread(id: string, parentId: string) {
  const thread = await window.api.threads.get(id)
  if (!useBtwChat.getState().tabs.some(tab => tab.id === id && tab.parentId === parentId)) return null
  if (!thread || thread.metadata?.btwParentId !== parentId) {
    forgetBtw(id)
    return null
  }
  registerSideThreadSummary(thread)
  return thread
}

export async function closeBtw(id: string) {
  const tab = useBtwChat.getState().tabs.find(tab => tab.id === id)
  if (!tab || tab.closeState === "closing") return
  useBtwChat.setState(state => ({
    tabs: state.tabs.map(tab => tab.id === id ? { ...tab, closeState: "closing", skillRequests: undefined } : tab)
  }))
  useAppStore.getState().setSkillGenerationPhase(null, undefined, id)
  try {
    await window.api.btw.close(id)
    forgetBtw(id)
  } catch (error) {
    if (!useBtwChat.getState().tabs.some(tab => tab.id === id)) return
    useBtwChat.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id ? { ...tab, closeState: "failed" } : tab) }))
    toast.error(error instanceof Error ? error.message : "关闭辅助对话失败。")
  }
}

useAppStore.subscribe((state, previous) => {
  if (state.sideThreads.size < previous.sideThreads.size) {
    for (const id of previous.sideThreads.keys()) {
      if (!state.sideThreads.has(id)) removeSideTab(id)
    }
  }
  if (state.threads === previous.threads) return
  const selected = useBtwChat.getState().selected
  const retiredParents = Object.keys(selected).filter(isThreadRetired)
  if (!retiredParents.length) return
  const next = { ...selected }
  for (const parentId of retiredParents) delete next[parentId]
  useBtwChat.setState({ selected: next })
})
