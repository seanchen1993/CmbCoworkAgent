import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useAppStore } from "./store"

describe("settings overlay navigation", () => {
  const initialState = useAppStore.getState()
  beforeEach(() => useAppStore.setState(initialState, true))
  afterEach(() => vi.unstubAllGlobals())

  for (const mainView of [
    "thread",
    "scheduled",
    "market",
    "kanban",
    "dashboard",
    "harness",
    "claudecode"
  ] as const) {
    it(`preserves the entire ${mainView} workspace when settings opens and closes`, () => {
      useAppStore.setState({
        mainView,
        currentThreadId: "current-thread",
        previousThreadId: "different-previous-thread",
        rightModule: "git",
        rightPanelCollapsed: false,
        showDashboardView: mainView === "dashboard",
        showHarnessBoardView: mainView === "harness",
        showKanbanView: mainView === "kanban"
      })
      const before = useAppStore.getState()
      before.setShowCustomizeView(true, "models", "provider")
      expect(useAppStore.getState()).toEqual({
        ...before,
        showCustomizeView: true,
        customizeInitialTab: "models",
        customizeInitialSection: "provider"
      })
      useAppStore.getState().setShowCustomizeView(false)
      expect(useAppStore.getState()).toEqual(before)
    })
  }

  it("preserves focused agents and does not select a thread for a new task", () => {
    const workflowAgentFocusView = { threadId: "task", runId: "run", agentIndex: 1, label: "agent" }
    useAppStore.setState({ currentThreadId: null, previousThreadId: "old", workflowAgentFocusView })
    useAppStore.getState().setMainView("customize")
    useAppStore.getState().setShowCustomizeView(false)
    expect(useAppStore.getState().currentThreadId).toBeNull()
    expect(useAppStore.getState().workflowAgentFocusView).toBe(workflowAgentFocusView)
  })

  it("does not resurrect navigation changed while settings was open", () => {
    useAppStore.setState({ currentThreadId: "deleted" })
    useAppStore.getState().setShowCustomizeView(true)
    useAppStore.setState({ currentThreadId: null })
    useAppStore.getState().setShowCustomizeView(false)
    expect(useAppStore.getState().currentThreadId).toBeNull()
  })

  it("explicit market navigation closes settings and overrides the covered view", () => {
    useAppStore.setState({ mainView: "kanban" })
    useAppStore.getState().setShowCustomizeView(true)
    useAppStore.getState().setShowCustomizeView(true, "market")
    expect(useAppStore.getState()).toMatchObject({ mainView: "market", showCustomizeView: false })
  })

  it("ignores a dashboard permission response from a previous account", async () => {
    let resolve!: (allowed: boolean) => void
    vi.stubGlobal("window", {
      api: {
        dashboard: {
          isAllowed: () =>
            new Promise<boolean>((done) => {
              resolve = done
            })
        }
      }
    })
    const request = useAppStore.getState().loadDashboardAllowed()
    useAppStore.setState({ accountRevision: 1, dashboardAllowed: false })
    resolve(true)
    await request
    expect(useAppStore.getState().dashboardAllowed).toBe(false)
  })

  it("restores the previous conversation when dashboard access is lost", async () => {
    vi.stubGlobal("window", {
      api: { dashboard: { isAllowed: async () => false } }
    })
    const thread = { thread_id: "previous-thread" } as (typeof initialState.threads)[number]
    useAppStore.setState({
      threads: [thread],
      mainView: "dashboard",
      showDashboardView: true,
      currentThreadId: null,
      previousThreadId: thread.thread_id
    })

    await useAppStore.getState().loadDashboardAllowed()

    expect(useAppStore.getState()).toMatchObject({
      dashboardAllowed: false,
      mainView: "thread",
      showDashboardView: false,
      currentThreadId: thread.thread_id,
      previousThreadId: null
    })
  })
})
