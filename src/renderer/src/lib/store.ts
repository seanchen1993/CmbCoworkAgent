import { create } from "zustand"
import type { EvolutionCandidate } from "@/api/evolution"
import type { Thread, ModelConfig, Provider, Message } from "@/types"
import { findFirstChatThread, isHarnessFeatureThread } from "./thread-classification"

const MAX_WORKER_FOCUS_MESSAGES = 2_000
const MAX_WORKER_SIGNATURE_CHARS = 512

function contentTextLength(content: Message["content"] | undefined): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0

  return content.reduce((total, block) => {
    if (typeof block.text === "string") return total + block.text.length
    if (typeof block.content === "string") return total + block.content.length
    return total
  }, 0)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function boundedTextSignature(value: string): string {
  if (value.length <= MAX_WORKER_SIGNATURE_CHARS * 2) return value
  return [
    value.length,
    value.slice(0, MAX_WORKER_SIGNATURE_CHARS),
    value.slice(-MAX_WORKER_SIGNATURE_CHARS)
  ].join("\u001e")
}

function contentSignatureKey(content: Message["content"] | undefined): string {
  if (typeof content === "string") return boundedTextSignature(content)
  if (!Array.isArray(content)) return ""

  const text = content
    .map((block) => {
      if (typeof block.text === "string") return block.text
      if (typeof block.content === "string") return block.content
      return block.type ?? ""
    })
    .join("\n")
  return boundedTextSignature(text)
}

function toolCallsSignatureKey(toolCalls: Message["tool_calls"] | undefined): string {
  if (!toolCalls?.length) return ""
  return boundedTextSignature(
    toolCalls
      .map((toolCall, index) =>
        [
          toolCall.id ?? index,
          toolCall.name ?? "",
          toolCall.args ? boundedTextSignature(stableStringify(toolCall.args)) : ""
        ].join(":")
      )
      .join("|")
  )
}

function workerFocusMessageSignature(message: Message): string | undefined {
  const contentKey = contentSignatureKey(message.content)
  if (message.role === "assistant") {
    const toolCallKey = toolCallsSignatureKey(message.tool_calls)
    if (!contentKey && !toolCallKey) return undefined
    return ["assistant", contentKey, toolCallKey].join("\u001f")
  }
  if (message.role === "tool" && message.tool_call_id) {
    return ["tool", message.tool_call_id, message.name ?? "", contentKey].join("\u001f")
  }
  return undefined
}

function isWorkerSnapshotMessageId(id: string): boolean {
  return id.startsWith("worker-snapshot-")
}

function isWorkerNonSnapshotMessageId(id: string): boolean {
  return !isWorkerSnapshotMessageId(id)
}

function isWorkerSnapshotPair(a: Message, b: Message): boolean {
  return (
    (isWorkerSnapshotMessageId(a.id) && isWorkerNonSnapshotMessageId(b.id)) ||
    (isWorkerNonSnapshotMessageId(a.id) && isWorkerSnapshotMessageId(b.id))
  )
}

function isSameWorkerAssistantText(a: Message, b: Message): boolean {
  if (a.role !== "assistant" || b.role !== "assistant") return false
  if (!isWorkerSnapshotPair(a, b)) return false
  if (a.tool_calls?.length || b.tool_calls?.length) return false
  if (typeof a.content !== "string" || typeof b.content !== "string") return false
  const first = a.content.trim()
  const second = b.content.trim()
  if (!first || !second) return false
  return first.includes(second) || second.includes(first)
}

function findSameWorkerAssistantTextIndex(
  messages: Message[],
  message: Message
): number | undefined {
  const index = messages.findIndex((item) => isSameWorkerAssistantText(item, message))
  return index >= 0 ? index : undefined
}

function incrementSignatureCount(map: Map<string, number>, signature: string | undefined): void {
  if (!signature) return
  map.set(signature, (map.get(signature) ?? 0) + 1)
}

function takeWindowedSignatureMatch(
  indexes: number[] | undefined,
  remainingBySignature: Map<string, number>,
  signature: string | undefined
): number | undefined {
  if (!indexes?.length || !signature) return undefined
  const remaining = remainingBySignature.get(signature) ?? 0
  if (remaining <= 0) return indexes.shift()

  // Focused live events normally describe the newest worker turn. If older
  // turns produced identical text, match against the newest compatible replay
  // window rather than the oldest matching snapshot.
  const matchPosition = Math.max(0, indexes.length - remaining)
  const [index] = indexes.splice(matchPosition, 1)
  remainingBySignature.set(signature, remaining - 1)
  return index
}

function pruneWorkerFocusMessages(messages: Message[]): Message[] {
  if (messages.length <= MAX_WORKER_FOCUS_MESSAGES) return messages
  return messages.slice(-MAX_WORKER_FOCUS_MESSAGES)
}

function resolveWorkerFocusContent(
  existingMessage: Message,
  incomingMessage: Message
): Message["content"] {
  if (
    isWorkerNonSnapshotMessageId(existingMessage.id) &&
    existingMessage.id === incomingMessage.id
  ) {
    return incomingMessage.content ?? existingMessage.content ?? ""
  }

  if (isWorkerSnapshotMessageId(incomingMessage.id)) {
    return preferIncomingContent(existingMessage.content, incomingMessage.content)
  }

  if (isWorkerSnapshotMessageId(existingMessage.id)) {
    return preferIncomingContent(incomingMessage.content, existingMessage.content)
  }

  return preferIncomingContent(existingMessage.content, incomingMessage.content)
}

function preferIncomingContent(
  existing: Message["content"] | undefined,
  incoming: Message["content"] | undefined
): Message["content"] {
  const existingLength = contentTextLength(existing)
  const incomingLength = contentTextLength(incoming)
  if (incomingLength === 0) return existing ?? ""
  if (existingLength > incomingLength) return existing ?? ""

  return incoming ?? ""
}

type EvolutionTab = "candidates" | "traces" | "review"
type MainView =
  | "thread"
  | "customize"
  | "evolution"
  | "kanban"
  | "harness"
  | "claudecode"
  | "dashboard"

interface ThreadNavigationOptions {
  preserveView?: boolean
}

function resolveChatThreadId(threads: Thread[], preferredThreadId?: string | null): string | null {
  const preferredThread = preferredThreadId
    ? threads.find((thread) => thread.thread_id === preferredThreadId)
    : null
  if (preferredThread && !isHarnessFeatureThread(preferredThread)) {
    return preferredThread.thread_id
  }
  return findFirstChatThread(threads)?.thread_id ?? null
}

interface EvolutionRunProgress {
  runId: string
  traceId: string
  index: number
  total: number
  status: "pending" | "running" | "completed" | "failed"
  message?: string
  candidateCount?: number
}

export interface WorkerFocusView {
  threadId: string
  workerId: string
  workerThreadId: string
  role: "implementer" | "verifier"
  description: string
  status?: "running" | "completed" | "failed" | "cancelled"
}

interface AppState {
  // Main content view routing
  mainView: MainView

  // Threads
  threads: Thread[]
  currentThreadId: string | null

  // Models and Providers (global, not per-thread)
  models: ModelConfig[]
  providers: Provider[]

  // Right panel state (UI state, not thread data)
  rightPanelTab: "todos" | "files" | "subagents"

  // Settings dialog state
  settingsOpen: boolean

  // Sidebar state
  sidebarCollapsed: boolean
  rightPanelCollapsed: boolean

  // Split view for inspecting a single coordinator worker stream.
  workerFocusView: WorkerFocusView | null
  workerFocusMessagesThreadId: string | null
  workerFocusMessages: Message[]
  openWorkerFocusView: (view: WorkerFocusView) => void
  closeWorkerFocusView: () => void
  appendWorkerFocusMessage: (workerThreadId: string, message: Message) => void
  appendWorkerFocusMessages: (workerThreadId: string, messages: Message[]) => void

  // Kanban view state
  showKanbanView: boolean
  showSubagentsInKanban: boolean

  // Harness board view state
  showHarnessBoardView: boolean

  // Claude Code view state
  showClaudeCodeView: boolean
  previousThreadId: string | null // 切换到 Claude Code 前保存的线程 ID
  setShowClaudeCodeView: (show: boolean) => void

  // Dashboard view state
  showDashboardView: boolean
  setShowDashboardView: (show: boolean) => void
  dashboardAllowed: boolean | null // null = loading
  loadDashboardAllowed: () => Promise<void>

  // Customize view state
  showCustomizeView: boolean
  customizeInitialTab: string | null
  marketInitialSkillCategory: string | null
  marketInitialSkillSearchQuery: string | null
  marketInitialSkillDetailName: string | null
  marketInitialSkillFilters: string[] | null
  marketInitialTab: string | null

  // Thread actions
  loadThreads: () => Promise<void>
  createThread: (
    metadata?: Record<string, unknown>,
    options?: ThreadNavigationOptions
  ) => Promise<Thread>
  selectThread: (threadId: string, options?: ThreadNavigationOptions) => Promise<void>
  deleteThread: (threadId: string) => Promise<void>
  updateThread: (threadId: string, updates: Partial<Thread>) => Promise<void>
  generateTitleForFirstMessage: (threadId: string, content: string) => Promise<void>

  // Model actions
  loadModels: () => Promise<void>
  loadProviders: () => Promise<void>

  // Panel actions
  setRightPanelTab: (tab: "todos" | "files" | "subagents") => void

  // Settings actions
  setSettingsOpen: (open: boolean) => void

  // Sidebar actions
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleRightPanel: () => void
  setRightPanelCollapsed: (collapsed: boolean) => void

  // Kanban actions
  setShowKanbanView: (show: boolean) => void
  setShowSubagentsInKanban: (show: boolean) => void

  // Harness board actions
  setShowHarnessBoardView: (show: boolean) => void

  // Customize actions
  setShowCustomizeView: (show: boolean, tab?: string) => void
  setMarketInitialSkillCategory: (category: string | null) => void
  setMarketInitialSkillSearchQuery: (query: string | null) => void
  setMarketInitialSkillDetailName: (name: string | null) => void
  setMainView: (view: MainView) => void
  setMarketInitialSkillFilters: (filters: string[] | null) => void
  setMarketInitialTab: (tab: string | null) => void

  // Plugin state sync — increment to trigger RightPanel refresh
  pluginVersion: number
  bumpPluginVersion: () => void

  // Skill evolution — true when threshold reached, clears when Evolution panel opens
  pendingEvolution: boolean
  setPendingEvolution: (v: boolean) => void
  cloudEvolutionUpdates: EvolutionCandidate[]
  setCloudEvolutionUpdates: (updates: EvolutionCandidate[]) => void

  // Skill generation virtual subagent — shown in the right panel agents section.
  // State is stored per-thread so switching threads preserves each thread's card.
  skillGenerationByThread: Map<
    string,
    {
      phase: "generating" | "done" | "error" | null
      streamedText: string
      errorText: string
    }
  >
  setSkillGenerationPhase: (phase: "generating" | "done" | "error" | null, text?: string) => void
  appendSkillGenerationToken: (token: string) => void

  // Per-thread retry context — cached when the user accepts the intent banner so that
  // the retry button can replay the generation without re-running the full proposal flow.
  skillRetryContextByThread: Map<string, { context: unknown; intentMode: string }>
  setSkillRetryContext: (retryContext: { context: unknown; intentMode: string } | null) => void

  // Evolution UI state — persists while switching customize submenus
  evolutionTab: EvolutionTab
  setEvolutionTab: (tab: EvolutionTab) => void
  evolutionRunning: boolean
  setEvolutionRunning: (running: boolean) => void
  evolutionRunningSummary: string | null
  setEvolutionRunningSummary: (summary: string | null) => void
  evolutionSummary: string | null
  setEvolutionSummary: (summary: string | null) => void
  evolutionSelectedTraceIds: Set<string>
  setEvolutionSelectedTraceIds: (ids: Set<string>) => void
  evolutionRunProgress: Record<string, EvolutionRunProgress>
  setEvolutionRunProgress: (progress: Record<string, EvolutionRunProgress>) => void
  mergeEvolutionRunProgress: (payload: EvolutionRunProgress) => void
  // Streaming text from the current/last optimizer LLM call
  evolutionStreamedText: string
  setEvolutionStreamedText: (text: string) => void
  appendEvolutionStreamedText: (chunk: string) => void
  evolutionStreamError: string | null
  setEvolutionStreamError: (err: string | null) => void
  // Options used for the last optimizer run (for retry)
  evolutionLastRunOpts: {
    mode?: "auto" | "selected"
    traceIds?: string[]
    threadId?: string
    traceLimit?: number
  } | null
  setEvolutionLastRunOpts: (
    opts: {
      mode?: "auto" | "selected"
      traceIds?: string[]
      threadId?: string
      traceLimit?: number
    } | null
  ) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  threads: [],
  currentThreadId: null,
  models: [],
  providers: [],
  rightPanelTab: "todos",
  settingsOpen: false,
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  workerFocusView: null,
  workerFocusMessagesThreadId: null,
  workerFocusMessages: [],
  mainView: "thread",
  showKanbanView: false,
  showSubagentsInKanban: true,
  showHarnessBoardView: false,
  showClaudeCodeView: false,
  showDashboardView: false,
  dashboardAllowed: null,
  previousThreadId: null,
  showCustomizeView: false,
  customizeInitialTab: null,
  marketInitialSkillCategory: null,
  marketInitialSkillSearchQuery: null,
  marketInitialSkillDetailName: null,
  marketInitialSkillFilters: null,
  marketInitialTab: null,
  pluginVersion: 0,
  evolutionTab: "candidates",
  evolutionRunning: false,
  evolutionRunningSummary: null,
  evolutionSummary: null,
  evolutionSelectedTraceIds: new Set<string>(),
  evolutionRunProgress: {},
  evolutionStreamedText: "",
  evolutionStreamError: null,
  evolutionLastRunOpts: null,

  // Thread actions
  loadThreads: async () => {
    const threads = await window.api.threads.list()
    set({ threads })

    // Select the first chat thread if none selected. Harness feature threads
    // are rendered inside project mode and should not become the default chat.
    if (!get().currentThreadId) {
      const firstChatThread = findFirstChatThread(threads)
      if (firstChatThread) {
        await get().selectThread(firstChatThread.thread_id)
      }
    }
  },

  createThread: async (metadata?: Record<string, unknown>, options?: ThreadNavigationOptions) => {
    const thread = await window.api.threads.create(metadata)
    set((state) => ({
      threads: [thread, ...state.threads],
      currentThreadId: thread.thread_id,
      ...(options?.preserveView
        ? {}
        : {
            showKanbanView: false,
            showHarnessBoardView: false,
            showCustomizeView: false,
            showClaudeCodeView: false,
            showDashboardView: false,
            previousThreadId: null,
            mainView: "thread" as const,
            workerFocusView: null,
            workerFocusMessagesThreadId: null,
            workerFocusMessages: []
          })
      // skillGenerationByThread is NOT reset here: new threads start with no entry
      // in the map, so the card is naturally absent without discarding other threads' state.
    }))
    return thread
  },

  selectThread: async (threadId: string, options?: ThreadNavigationOptions) => {
    set({
      currentThreadId: threadId,
      ...(options?.preserveView
        ? {}
        : {
            showKanbanView: false,
            showHarnessBoardView: false,
            showCustomizeView: false,
            showClaudeCodeView: false,
            showDashboardView: false,
            previousThreadId: null,
            mainView: "thread" as const,
            workerFocusView: null,
            workerFocusMessagesThreadId: null,
            workerFocusMessages: []
          })
      // skillGenerationByThread is NOT cleared here: each thread retains its own card
      // state so switching back to a thread shows the card exactly as it was left.
    })
  },

  deleteThread: async (threadId: string) => {
    console.log("[Store] Deleting thread:", threadId)
    try {
      await window.api.threads.delete(threadId)
      console.log("[Store] Thread deleted from backend")

      set((state) => {
        const threads = state.threads.filter((t) => t.thread_id !== threadId)
        const wasCurrentThread = state.currentThreadId === threadId
        const newCurrentId = wasCurrentThread
          ? state.mainView === "harness"
            ? null
            : findFirstChatThread(threads)?.thread_id || null
          : state.currentThreadId

        return {
          threads,
          currentThreadId: newCurrentId,
          // 如果被删除的线程是之前保存的，清掉避免恢复到无效 id
          previousThreadId: state.previousThreadId === threadId ? null : state.previousThreadId,
          ...(state.workerFocusView?.threadId === threadId
            ? {
                workerFocusView: null,
                workerFocusMessagesThreadId: null,
                workerFocusMessages: []
              }
            : {})
        }
      })
    } catch (error) {
      console.error("[Store] Failed to delete thread:", error)
      throw error
    }
  },

  updateThread: async (threadId: string, updates: Partial<Thread>) => {
    const updated = await window.api.threads.update(threadId, updates)
    set((state) => ({
      threads: state.threads.map((t) => (t.thread_id === threadId ? updated : t))
    }))
  },

  generateTitleForFirstMessage: async (threadId: string, content: string) => {
    try {
      const generatedTitle = await window.api.threads.generateTitle(content)
      await get().updateThread(threadId, { title: generatedTitle })
    } catch (error) {
      console.error("[Store] Failed to generate title:", error)
    }
  },

  // Model actions
  loadModels: async () => {
    const models = await window.api.models.list()
    set({ models })
  },

  loadProviders: async () => {
    const providers = await window.api.models.listProviders()
    set({ providers })
  },

  // Panel actions
  setRightPanelTab: (tab: "todos" | "files" | "subagents") => {
    set({ rightPanelTab: tab })
  },

  // Settings actions
  setSettingsOpen: (open: boolean) => {
    set({ settingsOpen: open })
  },

  // Sidebar actions
  toggleSidebar: () => {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
  },

  setSidebarCollapsed: (collapsed: boolean) => {
    set({ sidebarCollapsed: collapsed })
  },

  toggleRightPanel: () => {
    set((state) => ({ rightPanelCollapsed: !state.rightPanelCollapsed }))
  },

  setRightPanelCollapsed: (collapsed: boolean) => {
    set({ rightPanelCollapsed: collapsed })
  },

  openWorkerFocusView: (view) => {
    set({
      workerFocusView: view,
      workerFocusMessagesThreadId: view.workerThreadId,
      workerFocusMessages: []
    })
  },

  closeWorkerFocusView: () => {
    set({
      workerFocusView: null,
      workerFocusMessagesThreadId: null,
      workerFocusMessages: []
    })
  },

  appendWorkerFocusMessage: (workerThreadId, message) => {
    get().appendWorkerFocusMessages(workerThreadId, [message])
  },

  appendWorkerFocusMessages: (workerThreadId, messages) => {
    if (messages.length === 0) return
    set((state) => {
      if (state.workerFocusView?.workerThreadId !== workerThreadId) return {}
      const existingMessages =
        state.workerFocusMessagesThreadId === workerThreadId ? state.workerFocusMessages : []

      const next = [...existingMessages]
      const indexById = new Map(next.map((item, index) => [item.id, index]))
      const liveIndexesBySignature = new Map<string, number[]>()
      const snapshotIndexesBySignature = new Map<string, number[]>()
      const incomingLiveCountsBySignature = new Map<string, number>()
      const incomingSnapshotCountsBySignature = new Map<string, number>()
      for (const message of messages) {
        const signature = workerFocusMessageSignature(message)
        if (isWorkerNonSnapshotMessageId(message.id)) {
          incrementSignatureCount(incomingLiveCountsBySignature, signature)
        }
        if (isWorkerSnapshotMessageId(message.id)) {
          incrementSignatureCount(incomingSnapshotCountsBySignature, signature)
        }
      }
      next.forEach((item, index) => {
        const signature = workerFocusMessageSignature(item)
        if (signature && isWorkerNonSnapshotMessageId(item.id)) {
          const indexes = liveIndexesBySignature.get(signature) ?? []
          indexes.push(index)
          liveIndexesBySignature.set(signature, indexes)
        }
        if (signature && isWorkerSnapshotMessageId(item.id)) {
          const indexes = snapshotIndexesBySignature.get(signature) ?? []
          indexes.push(index)
          snapshotIndexesBySignature.set(signature, indexes)
        }
      })

      for (const message of messages) {
        const signature = workerFocusMessageSignature(message)
        const existingIndex =
          indexById.get(message.id) ??
          (signature && isWorkerSnapshotMessageId(message.id)
            ? takeWindowedSignatureMatch(
                liveIndexesBySignature.get(signature),
                incomingSnapshotCountsBySignature,
                signature
              )
            : undefined) ??
          (signature && isWorkerNonSnapshotMessageId(message.id)
            ? takeWindowedSignatureMatch(
                snapshotIndexesBySignature.get(signature),
                incomingLiveCountsBySignature,
                signature
              )
            : undefined) ??
          findSameWorkerAssistantTextIndex(next, message)
        if (existingIndex === undefined) {
          indexById.set(message.id, next.length)
          if (signature && isWorkerNonSnapshotMessageId(message.id)) {
            const indexes = liveIndexesBySignature.get(signature) ?? []
            indexes.push(next.length)
            liveIndexesBySignature.set(signature, indexes)
          }
          if (signature && isWorkerSnapshotMessageId(message.id)) {
            const indexes = snapshotIndexesBySignature.get(signature) ?? []
            indexes.push(next.length)
            snapshotIndexesBySignature.set(signature, indexes)
          }
          next.push(message)
          continue
        }

        const existing = next[existingIndex]
        const id = existing.id
        next[existingIndex] = {
          ...existing,
          ...message,
          id,
          content: resolveWorkerFocusContent(existing, message),
          tool_calls:
            message.tool_calls && message.tool_calls.length > 0
              ? message.tool_calls
              : existing.tool_calls,
          status: message.status ?? existing.status,
          is_error: message.is_error ?? existing.is_error
        }
        indexById.set(id, existingIndex)
        indexById.set(message.id, existingIndex)
      }
      const prunedMessages = pruneWorkerFocusMessages(next)
      return {
        workerFocusMessagesThreadId: workerThreadId,
        workerFocusMessages: prunedMessages
      }
    })
  },

  // Claude Code actions
  setShowClaudeCodeView: (show: boolean) => {
    if (show) {
      // 保存当前线程 ID，切回时恢复；如果已有保存的（如从看板过来），不覆盖
      const prev = get().previousThreadId || get().currentThreadId
      set({
        showClaudeCodeView: true,
        showKanbanView: false,
        showHarnessBoardView: false,
        showCustomizeView: false,
        showDashboardView: false,
        mainView: "claudecode",
        previousThreadId: prev,
        currentThreadId: null,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: []
      })
    } else {
      const restored = get().previousThreadId
      const currentThreadId = resolveChatThreadId(get().threads, restored)
      set({
        showClaudeCodeView: false,
        mainView: "thread",
        currentThreadId,
        previousThreadId: null
      })
    }
  },

  // Dashboard actions
  loadDashboardAllowed: async () => {
    const allowed = await window.api.dashboard.isAllowed().catch(() => false)
    const state = get()
    set({
      dashboardAllowed: allowed,
      ...(allowed ? {} : {
        showDashboardView: false,
        mainView: state.mainView === "dashboard" ? "thread" as const : state.mainView
      })
    })
  },

  setShowDashboardView: (show: boolean) => {
    if (show && get().dashboardAllowed !== true) return
    if (show) {
      const prev = get().previousThreadId || get().currentThreadId
      set({
        showDashboardView: true,
        showClaudeCodeView: false,
        showKanbanView: false,
        showHarnessBoardView: false,
        showCustomizeView: false,
        mainView: "dashboard",
        previousThreadId: prev,
        currentThreadId: null,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: []
      })
    } else {
      const restored = get().previousThreadId
      const currentThreadId = resolveChatThreadId(get().threads, restored)
      set({
        showDashboardView: false,
        mainView: "thread",
        currentThreadId,
        previousThreadId: null
      })
    }
  },

  // Kanban actions
  setShowKanbanView: (show: boolean) => {
    if (show) {
      // 保存当前线程（如果有且没有已保存的）
      const prev = get().previousThreadId || get().currentThreadId
      set({
        showKanbanView: true,
        showHarnessBoardView: false,
        showCustomizeView: false,
        showClaudeCodeView: false,
        showDashboardView: false,
        mainView: "kanban",
        currentThreadId: null,
        previousThreadId: prev,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: []
      })
    } else {
      const restored = get().previousThreadId
      const currentThreadId = resolveChatThreadId(get().threads, restored)
      set({
        showKanbanView: false,
        mainView: "thread",
        currentThreadId,
        previousThreadId: null
      })
    }
  },

  setShowSubagentsInKanban: (show: boolean) => {
    set({ showSubagentsInKanban: show })
  },

  // Harness board actions
  setShowHarnessBoardView: (show: boolean) => {
    if (show) {
      const prev = get().previousThreadId || get().currentThreadId
      set({
        showHarnessBoardView: true,
        showKanbanView: false,
        showCustomizeView: false,
        showClaudeCodeView: false,
        showDashboardView: false,
        mainView: "harness",
        currentThreadId: null,
        previousThreadId: prev
      })
    } else {
      const restored = get().previousThreadId
      const chatThreadId = resolveChatThreadId(get().threads, restored)
      set({
        showHarnessBoardView: false,
        mainView: "thread",
        currentThreadId: chatThreadId,
        previousThreadId: null
      })
    }
  },

  setShowCustomizeView: (show: boolean, tab?: string) => {
    if (show) {
      set({
        showCustomizeView: true,
        showKanbanView: false,
        showHarnessBoardView: false,
        showClaudeCodeView: false,
        showDashboardView: false,
        customizeInitialTab: tab ?? null,
        mainView: "customize",
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: []
      })
    } else {
      const restored = get().previousThreadId
      const currentThreadId = resolveChatThreadId(get().threads, restored)
      set({
        showCustomizeView: false,
        customizeInitialTab: null,
        mainView: "thread",
        currentThreadId,
        previousThreadId: null
      })
    }
  },

  setMarketInitialSkillCategory: (category) => {
    set({ marketInitialSkillCategory: category })
  },

  setMarketInitialSkillSearchQuery: (query) => {
    set({ marketInitialSkillSearchQuery: query })
  },

  setMarketInitialSkillDetailName: (name) => {
    set({ marketInitialSkillDetailName: name })
  },

  setMarketInitialSkillFilters: (filters) => {
    set({ marketInitialSkillFilters: filters })
  },

  setMarketInitialTab: (tab) => {
    set({ marketInitialTab: tab })
  },

  setMainView: (view) => {
    if (view === "kanban") {
      set({
        mainView: "kanban",
        showKanbanView: true,
        showHarnessBoardView: false,
        showCustomizeView: false,
        showClaudeCodeView: false,
        showDashboardView: false,
        currentThreadId: null,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: []
      })
      return
    }

    if (view === "customize") {
      set({
        mainView: "customize",
        showCustomizeView: true,
        showKanbanView: false,
        showHarnessBoardView: false,
        showClaudeCodeView: false,
        showDashboardView: false,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: []
      })
      return
    }

    if (view === "evolution") {
      set({
        mainView: "customize",
        showCustomizeView: true,
        showKanbanView: false,
        showHarnessBoardView: false,
        showClaudeCodeView: false,
        customizeInitialTab: "evolution",
        showDashboardView: false,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: []
      })
      return
    }

    if (view === "dashboard") {
      if (get().dashboardAllowed !== true) return
      const prev = get().previousThreadId || get().currentThreadId
      set({
        mainView: "dashboard",
        showDashboardView: true,
        showCustomizeView: false,
        showKanbanView: false,
        showHarnessBoardView: false,
        showClaudeCodeView: false,
        previousThreadId: prev,
        currentThreadId: null,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: []
      })
      return
    }

    if (view === "claudecode") {
      const prev = get().previousThreadId || get().currentThreadId
      set({
        mainView: "claudecode",
        showClaudeCodeView: true,
        showCustomizeView: false,
        showKanbanView: false,
        showHarnessBoardView: false,
        showDashboardView: false,
        previousThreadId: prev,
        currentThreadId: null
      })
      return
    }

    if (view === "harness") {
      const prev = get().previousThreadId || get().currentThreadId
      set({
        mainView: "harness",
        showHarnessBoardView: true,
        showCustomizeView: false,
        showKanbanView: false,
        showClaudeCodeView: false,
        showDashboardView: false,
        previousThreadId: prev,
        currentThreadId: null,
        workerFocusView: null,
        workerFocusMessagesThreadId: null,
        workerFocusMessages: []
      })
      return
    }

    const restored = get().previousThreadId
    const chatThreadId = resolveChatThreadId(get().threads, restored)
    set({
      mainView: "thread",
      showCustomizeView: false,
      showKanbanView: false,
      showHarnessBoardView: false,
      showClaudeCodeView: false,
      showDashboardView: false,
      currentThreadId: chatThreadId,
      previousThreadId: null
    })
  },

  bumpPluginVersion: () => {
    set((state) => ({ pluginVersion: state.pluginVersion + 1 }))
  },

  pendingEvolution: false,
  setPendingEvolution: (v) => set({ pendingEvolution: v }),
  cloudEvolutionUpdates: [],
  setCloudEvolutionUpdates: (updates) => set({ cloudEvolutionUpdates: updates }),

  // Per-thread skill generation state — keyed by threadId.
  skillGenerationByThread: new Map(),

  setSkillGenerationPhase: (phase, text = "") =>
    set((state) => {
      const threadId = state.currentThreadId
      if (!threadId) return {}
      const next = new Map(state.skillGenerationByThread)
      if (phase === null) {
        next.delete(threadId)
        // Also clear the retry context when the card is dismissed
        const retryNext = new Map(state.skillRetryContextByThread)
        retryNext.delete(threadId)
        return { skillGenerationByThread: next, skillRetryContextByThread: retryNext }
      } else if (phase === "error") {
        next.set(threadId, { phase: "error", streamedText: "", errorText: text })
      } else {
        next.set(threadId, { phase, streamedText: "", errorText: "" })
      }
      return { skillGenerationByThread: next }
    }),

  // Per-thread retry context — cached on intent accept, cleared on dismiss.
  skillRetryContextByThread: new Map(),

  setSkillRetryContext: (retryContext) =>
    set((state) => {
      const threadId = state.currentThreadId
      if (!threadId) return {}
      const next = new Map(state.skillRetryContextByThread)
      if (retryContext) {
        next.set(threadId, retryContext)
      } else {
        next.delete(threadId)
      }
      return { skillRetryContextByThread: next }
    }),

  appendSkillGenerationToken: (token) =>
    set((state) => {
      const threadId = state.currentThreadId
      if (!threadId) return {}
      const current = state.skillGenerationByThread.get(threadId) ?? {
        phase: "generating" as const,
        streamedText: "",
        errorText: ""
      }
      const next = new Map(state.skillGenerationByThread)
      next.set(threadId, { ...current, streamedText: current.streamedText + token })
      return { skillGenerationByThread: next }
    }),

  setEvolutionTab: (tab) => set({ evolutionTab: tab }),
  setEvolutionRunning: (running) => set({ evolutionRunning: running }),
  setEvolutionRunningSummary: (summary) => set({ evolutionRunningSummary: summary }),
  setEvolutionSummary: (summary) => set({ evolutionSummary: summary }),
  setEvolutionSelectedTraceIds: (ids) => set({ evolutionSelectedTraceIds: new Set(ids) }),
  setEvolutionRunProgress: (progress) => set({ evolutionRunProgress: { ...progress } }),
  mergeEvolutionRunProgress: (payload) =>
    set((state) => ({
      evolutionRunProgress: {
        ...state.evolutionRunProgress,
        [payload.traceId]: payload
      }
    })),
  setEvolutionStreamedText: (text) => set({ evolutionStreamedText: text }),
  appendEvolutionStreamedText: (chunk) =>
    set((state) => ({ evolutionStreamedText: state.evolutionStreamedText + chunk })),
  setEvolutionStreamError: (err) => set({ evolutionStreamError: err }),
  setEvolutionLastRunOpts: (opts) => set({ evolutionLastRunOpts: opts })
}))

// ─────────────────────────────────────────────────────────
// Selector helpers
// ─────────────────────────────────────────────────────────

const EMPTY_SKILL_GEN = { phase: null, streamedText: "", errorText: "" } as const

/**
 * Returns the skill generation card state for the given thread.
 * Use this instead of reading skillGenerationByThread directly so callers
 * always get a stable fallback when no entry exists for the thread.
 */
export function selectSkillGenerationAgent(
  state: AppState,
  threadId: string | null
): { phase: "generating" | "done" | "error" | null; streamedText: string; errorText: string } {
  if (!threadId) return EMPTY_SKILL_GEN
  return state.skillGenerationByThread.get(threadId) ?? EMPTY_SKILL_GEN
}

/**
 * Returns the cached retry context (proposal context + intent mode) for the given thread,
 * or null if the user has not accepted the intent banner for this thread yet.
 */
export function selectSkillRetryContext(
  state: AppState,
  threadId: string | null
): { context: unknown; intentMode: string } | null {
  if (!threadId) return null
  return state.skillRetryContextByThread.get(threadId) ?? null
}
