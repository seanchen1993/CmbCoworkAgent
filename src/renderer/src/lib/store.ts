import { create } from "zustand"
import type { Thread, ModelConfig, Provider } from "@/types"

type EvolutionTab = "candidates" | "traces"

interface EvolutionRunProgress {
  runId: string
  traceId: string
  index: number
  total: number
  status: "pending" | "running" | "completed" | "failed"
  message?: string
  candidateCount?: number
}

interface AppState {
  // Main content view routing
  mainView: "thread" | "customize" | "evolution" | "kanban"

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

  // Kanban view state
  showKanbanView: boolean
  showSubagentsInKanban: boolean

  // Customize view state
  showCustomizeView: boolean
  customizeInitialTab: string | null

  // Thread actions
  loadThreads: () => Promise<void>
  createThread: (metadata?: Record<string, unknown>) => Promise<Thread>
  selectThread: (threadId: string) => Promise<void>
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

  // Customize actions
  setShowCustomizeView: (show: boolean, tab?: string) => void
  setMainView: (view: "thread" | "customize" | "evolution" | "kanban") => void

  // Plugin state sync — increment to trigger RightPanel refresh
  pluginVersion: number
  bumpPluginVersion: () => void

  // Skill evolution — true when threshold reached, clears when Evolution panel opens
  pendingEvolution: boolean
  setPendingEvolution: (v: boolean) => void

  // Skill generation virtual subagent — shown in the right panel agents section.
  // State is stored per-thread so switching threads preserves each thread's card.
  skillGenerationByThread: Map<string, {
    phase: "generating" | "done" | "error" | null
    streamedText: string
    errorText: string
  }>
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
  evolutionLastRunOpts: { mode?: "auto" | "selected"; traceIds?: string[]; threadId?: string; traceLimit?: number } | null
  setEvolutionLastRunOpts: (opts: { mode?: "auto" | "selected"; traceIds?: string[]; threadId?: string; traceLimit?: number } | null) => void
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
  mainView: "thread",
  showKanbanView: false,
  showSubagentsInKanban: true,
  showCustomizeView: false,
  customizeInitialTab: null,
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

    // Select first thread if none selected
    if (!get().currentThreadId && threads.length > 0) {
      await get().selectThread(threads[0].thread_id)
    }
  },

  createThread: async (metadata?: Record<string, unknown>) => {
    const thread = await window.api.threads.create(metadata)
    set((state) => ({
      threads: [thread, ...state.threads],
      currentThreadId: thread.thread_id,
      showKanbanView: false,
      showCustomizeView: false,
      mainView: "thread"
      // skillGenerationByThread is NOT reset here: new threads start with no entry
      // in the map, so the card is naturally absent without discarding other threads' state.
    }))
    return thread
  },

  selectThread: async (threadId: string) => {
    set({
      currentThreadId: threadId,
      showKanbanView: false,
      showCustomizeView: false,
      mainView: "thread"
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
          ? threads[0]?.thread_id || null
          : state.currentThreadId

        return {
          threads,
          currentThreadId: newCurrentId
        }
      })
    } catch (error) {
      console.error("[Store] Failed to delete thread:", error)
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

  // Kanban actions
  setShowKanbanView: (show: boolean) => {
    if (show) {
      set({
        showKanbanView: true,
        showCustomizeView: false,
        mainView: "kanban",
        currentThreadId: null
      })
    } else {
      set({ showKanbanView: false, mainView: "thread" })
    }
  },

  setShowSubagentsInKanban: (show: boolean) => {
    set({ showSubagentsInKanban: show })
  },

  setShowCustomizeView: (show: boolean, tab?: string) => {
    if (show) {
      set({
        showCustomizeView: true,
        showKanbanView: false,
        customizeInitialTab: tab ?? null,
        mainView: "customize"
      })
    } else {
      set({
        showCustomizeView: false,
        customizeInitialTab: null,
        mainView: "thread"
      })
    }
  },

  setMainView: (view) => {
    if (view === "kanban") {
      set({
        mainView: "kanban",
        showKanbanView: true,
        showCustomizeView: false,
        currentThreadId: null
      })
      return
    }

    if (view === "customize") {
      set({
        mainView: "customize",
        showCustomizeView: true,
        showKanbanView: false
      })
      return
    }

    if (view === "evolution") {
      set({
        mainView: "customize",
        showCustomizeView: true,
        showKanbanView: false,
        customizeInitialTab: "evolution"
      })
      return
    }

    set({
      mainView: "thread",
      showCustomizeView: false,
      showKanbanView: false
    })
  },

  bumpPluginVersion: () => {
    set((state) => ({ pluginVersion: state.pluginVersion + 1 }))
  },

  pendingEvolution: false,
  setPendingEvolution: (v) => set({ pendingEvolution: v }),

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
      const current = state.skillGenerationByThread.get(threadId)
        ?? { phase: "generating" as const, streamedText: "", errorText: "" }
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
