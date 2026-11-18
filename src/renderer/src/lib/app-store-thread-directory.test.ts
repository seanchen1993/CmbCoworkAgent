import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ThreadSummaryPage } from "../../../main/types"
import type { Thread } from "../types"
import { initializeStartupWorkspace, useAppStore } from "./store"
import { useChatSourceNavigation } from "./chat-source-navigation"

function createThread(threadId: string): Thread {
  return {
    thread_id: threadId,
    created_at: new Date(1),
    updated_at: new Date(1),
    status: "idle",
    title: threadId
  }
}

function createPage(threads: Thread[]): ThreadSummaryPage {
  return {
    threads,
    beforeUpdatedAt: null,
    beforeThreadId: null,
    hasMore: false
  }
}

function resetRoute(): void {
  useAppStore.setState({
    threads: [],
    currentThreadId: null,
    previousThreadId: null,
    mainView: "thread",
    showHarnessBoardView: false,
    showKanbanView: false,
    showCustomizeView: false,
    showClaudeCodeView: false,
    showDashboardView: false
  })
}

describe("app store thread-directory loading", () => {
  beforeEach(() => {
    resetRoute()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("refreshes the directory without navigating away from project mode", async () => {
    const chatThread = createThread("chat-thread")
    const listPage = vi.fn().mockResolvedValue(createPage([chatThread]))
    vi.stubGlobal("window", { api: { threads: { listPage } } })
    useAppStore.setState({
      mainView: "harness",
      currentThreadId: null,
      previousThreadId: "previous-chat",
      showHarnessBoardView: true
    })

    await useAppStore.getState().loadThreads()

    const state = useAppStore.getState()
    expect(state.threads).toEqual([chatThread])
    expect(state.mainView).toBe("harness")
    expect(state.currentThreadId).toBeNull()
    expect(state.previousThreadId).toBe("previous-chat")
    expect(state.showHarnessBoardView).toBe(true)
  })

  it("selects the first chat thread only during explicit startup bootstrap", async () => {
    const chatThread = createThread("chat-thread")
    const listPage = vi.fn().mockResolvedValue(createPage([chatThread]))
    vi.stubGlobal("window", { api: { threads: { listPage } } })

    await useAppStore.getState().loadThreads({ selectInitialThread: true })

    const state = useAppStore.getState()
    expect(state.mainView).toBe("thread")
    expect(state.currentThreadId).toBe(chatThread.thread_id)
  })

  it("does not overwrite a project-mode switch made while startup loading is pending", async () => {
    const chatThread = createThread("chat-thread")
    let resolvePage: ((page: ThreadSummaryPage) => void) | undefined
    const pendingPage = new Promise<ThreadSummaryPage>((resolve) => {
      resolvePage = resolve
    })
    const listPage = vi.fn().mockReturnValue(pendingPage)
    vi.stubGlobal("window", { api: { threads: { listPage } } })

    const loading = useAppStore.getState().loadThreads({ selectInitialThread: true })
    useAppStore.getState().setShowHarnessBoardView(true)
    resolvePage?.(createPage([chatThread]))
    await loading

    const state = useAppStore.getState()
    expect(state.threads).toEqual([chatThread])
    expect(state.mainView).toBe("harness")
    expect(state.currentThreadId).toBeNull()
    expect(state.showHarnessBoardView).toBe(true)
  })

  it("waits for a newer overlapping refresh before startup continues", async () => {
    const chatThread = createThread("chat-thread")
    let resolveBootstrap: ((page: ThreadSummaryPage) => void) | undefined
    let resolveRefresh: ((page: ThreadSummaryPage) => void) | undefined
    const bootstrapPage = new Promise<ThreadSummaryPage>((resolve) => {
      resolveBootstrap = resolve
    })
    const refreshPage = new Promise<ThreadSummaryPage>((resolve) => {
      resolveRefresh = resolve
    })
    const listPage = vi
      .fn()
      .mockReturnValueOnce(bootstrapPage)
      .mockReturnValueOnce(refreshPage)
    vi.stubGlobal("window", { api: { threads: { listPage } } })

    const bootstrap = useAppStore.getState().loadThreads({ selectInitialThread: true })
    const refresh = useAppStore.getState().loadThreads()
    let bootstrapSettled = false
    void bootstrap.then(() => {
      bootstrapSettled = true
    })
    resolveBootstrap?.(createPage([chatThread]))
    await Promise.resolve()
    await Promise.resolve()
    expect(bootstrapSettled).toBe(false)
    expect(useAppStore.getState().threads).toEqual([])

    resolveRefresh?.(createPage([chatThread]))
    await Promise.all([bootstrap, refresh])

    const state = useAppStore.getState()
    expect(state.mainView).toBe("thread")
    expect(state.currentThreadId).toBe(chatThread.thread_id)
  })

  it("ignores a superseded refresh failure while a newer refresh succeeds", async () => {
    const chatThread = createThread("chat-thread")
    let resolveBootstrap: ((page: ThreadSummaryPage) => void) | undefined
    let rejectSuperseded: ((error: Error) => void) | undefined
    let resolveLatest: ((page: ThreadSummaryPage) => void) | undefined
    const bootstrapPage = new Promise<ThreadSummaryPage>((resolve) => {
      resolveBootstrap = resolve
    })
    const supersededPage = new Promise<ThreadSummaryPage>((_resolve, reject) => {
      rejectSuperseded = reject
    })
    const latestPage = new Promise<ThreadSummaryPage>((resolve) => {
      resolveLatest = resolve
    })
    const listPage = vi
      .fn()
      .mockReturnValueOnce(bootstrapPage)
      .mockReturnValueOnce(supersededPage)
      .mockReturnValueOnce(latestPage)
    vi.stubGlobal("window", { api: { threads: { listPage } } })

    const bootstrap = useAppStore.getState().loadThreads({ selectInitialThread: true })
    const supersededRefresh = useAppStore.getState().loadThreads().catch(() => undefined)
    resolveBootstrap?.(createPage([chatThread]))
    await Promise.resolve()
    await Promise.resolve()

    const latestRefresh = useAppStore.getState().loadThreads()
    rejectSuperseded?.(new Error("superseded refresh failed"))
    resolveLatest?.(createPage([chatThread]))
    await Promise.all([bootstrap, supersededRefresh, latestRefresh])

    const state = useAppStore.getState()
    expect(state.mainView).toBe("thread")
    expect(state.currentThreadId).toBe(chatThread.thread_id)
  })

  it("rejects startup loading when the latest directory request fails", async () => {
    const listPage = vi.fn().mockRejectedValue(new Error("latest refresh failed"))
    vi.stubGlobal("window", { api: { threads: { listPage } } })

    await expect(
      useAppStore.getState().loadThreads({ selectInitialThread: true })
    ).rejects.toThrow("latest refresh failed")
  })
})

describe("app startup destination", () => {
  beforeEach(resetRoute)
  afterEach(() => {
    useChatSourceNavigation.getState().clear()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function fixture(threads: Thread[] = [createThread("first")], navigationType = "navigate") {
    const getStartupView = vi.fn().mockResolvedValue("bots")
    const listPage = vi.fn().mockResolvedValue(createPage(threads))
    const create = vi.fn().mockResolvedValue(createThread("new"))
    vi.stubGlobal("window", {
      electron: { getStartupView },
      api: { threads: { listPage, create } },
      performance: { getEntriesByType: () => [{ type: navigationType }] }
    })
    return { getStartupView, listPage, create }
  }

  it.each([{ threads: [] }, { threads: [createThread("first")] }])("opens Bots without selecting or creating a workbench task (%j)", async ({ threads }) => {
    const { getStartupView, create } = fixture(threads)
    await initializeStartupWorkspace(() => true)
    expect(getStartupView).toHaveBeenCalledOnce()
    expect(useAppStore.getState()).toMatchObject({ mainView: "bots", currentThreadId: null, threads })
    expect(create).not.toHaveBeenCalled()

    useAppStore.getState().setMainView("thread")
    await useAppStore.getState().loadThreads()
    expect(useAppStore.getState().mainView).toBe("thread")
    expect(getStartupView).toHaveBeenCalledOnce()
  })

  it("falls back to selecting the first workbench task when the preference is unavailable", async () => {
    const { getStartupView } = fixture()
    getStartupView.mockRejectedValue(new Error("unavailable"))
    vi.spyOn(console, "warn").mockImplementation(() => {})

    await initializeStartupWorkspace(() => true)
    expect(useAppStore.getState()).toMatchObject({ mainView: "thread", currentThreadId: "first" })
  })

  it("does not apply the preference to a renderer reload", async () => {
    const { getStartupView } = fixture([createThread("first")], "reload")

    await initializeStartupWorkspace(() => true)
    expect(getStartupView).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject({ mainView: "thread", currentThreadId: "first" })
  })

  it("preserves a pending deep link when the Bots preference returns", async () => {
    const { getStartupView, create } = fixture()
    let finish!: (view: string) => void
    getStartupView.mockReturnValue(new Promise<string>((resolve) => { finish = resolve }))
    const startup = initializeStartupWorkspace(() => true)
    useChatSourceNavigation.getState().request({ threadId: "linked", messageId: "message", ordinal: 2 })
    finish("bots")

    await startup
    expect(useAppStore.getState()).toMatchObject({ mainView: "thread", currentThreadId: null })
    expect(useChatSourceNavigation.getState().target?.threadId).toBe("linked")
    expect(create).not.toHaveBeenCalled()
  })

  it("preserves explicit navigation even after returning to the original surface while the preference is pending", async () => {
    const { getStartupView } = fixture()
    let finish!: (view: string) => void
    getStartupView.mockReturnValue(new Promise<string>((resolve) => { finish = resolve }))
    const startup = initializeStartupWorkspace(() => true)
    useAppStore.getState().setShowCustomizeView(true, "general")
    useAppStore.getState().setShowCustomizeView(false)
    finish("bots")

    await startup
    expect(useAppStore.getState()).toMatchObject({ mainView: "thread", currentThreadId: null })
  })

  it("keeps an explicitly selected startup thread", async () => {
    const { getStartupView } = fixture()
    await useAppStore.getState().selectThread("selected")

    await initializeStartupWorkspace(() => true)
    expect(getStartupView).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toMatchObject({ mainView: "thread", currentThreadId: "selected" })
  })

  it("selects a new task on the first launch with the default setting and an empty directory", async () => {
    const { getStartupView, create } = fixture([])
    getStartupView.mockResolvedValue("thread")

    await initializeStartupWorkspace(() => true)
    expect(create).toHaveBeenCalledOnce()
    expect(useAppStore.getState()).toMatchObject({ mainView: "thread", currentThreadId: "new" })
  })

  it("creates the default first task without replacing a session explicitly selected while creation is pending", async () => {
    const { getStartupView, create } = fixture([])
    getStartupView.mockResolvedValue("thread")
    let finish!: (thread: Thread) => void
    create.mockReturnValue(new Promise<Thread>((resolve) => { finish = resolve }))
    const startup = initializeStartupWorkspace(() => true)
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    await useAppStore.getState().selectThread("selected")
    finish(createThread("new"))

    await startup
    expect(useAppStore.getState().currentThreadId).toBe("selected")
    expect(useAppStore.getState().threads[0]?.thread_id).toBe("new")
  })
})
