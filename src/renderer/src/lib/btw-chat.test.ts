import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Thread, ModelConfig, QueuedMessage } from "@/types"
import { closeBtw, drainHiddenBtwQueue, resumeVisibleBtwQueue, setBtwPendingInteraction, getSideQuestion, isBtwSubmissionBlocked, loadBtwThread, loadBtwWorkspaceFiles, openBtw, respondBtwSkillIntent, respondBtwSkillConfirmation, retryBtwSkillGeneration, subscribeBtwSkillEvolution, useBtwChat } from "./btw-chat"
import { queueStorageKey } from "./queued-message-content"
import { openResourcePanelOverlay } from "./resource-panel-overlay-events"
import { registerSideThreadSummary, selectThreadSummary, useAppStore } from "./store"
import { loadWorkspaceFilesDeduped, markWorkspaceFilesStale } from "./workspace-file-load"

function setup() {
  const parentId = randomUUID()
  const id = `btw-${parentId}-${randomUUID()}`
  const parent: Thread = {
    thread_id: parentId, title: "主对话", status: "idle", created_at: new Date(), updated_at: new Date()
  }
  const thread: Thread = {
    ...parent, thread_id: id, title: "辅助对话 1", metadata: { btwParentId: parentId }
  }
  const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const get = vi.fn<() => Promise<Thread | null>>().mockResolvedValue(thread)
  const created = { id, ordinal: 1, thread }
  const create = vi.fn<() => Promise<typeof created>>().mockResolvedValue(created)
  const reconcile = vi.fn<typeof window.api.agent.reconcileCurrentRunQueuedMessages>()
    .mockResolvedValue({ pendingIds: [], injectedIds: [], durableIds: [] })
  const removeItem = vi.fn()
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    localStorage: { removeItem },
    api: {
      btw: { create, close },
      agent: { reconcileCurrentRunQueuedMessages: reconcile },
      threads: {
        get,
        delete: vi.fn().mockResolvedValue(undefined),
        listPage: vi.fn().mockResolvedValue({ threads: [parent], hasMore: false })
      }
    }
  }))
  useAppStore.setState({ threads: [parent], currentThreadId: parentId, mainView: "thread", rightModule: "work", rightPanelCollapsed: false })
  return { parent, parentId, id, close, get, removeItem, create, created, reconcile }
}

function mockSkillEvolution() {
  function channel<T>() {
    let listener: ((event: T) => void) | undefined
    return {
      subscribe: (callback: (event: T) => void) => {
        listener = callback
        return () => { listener = undefined }
      },
      send: (event: T) => listener?.(event)
    }
  }
  type Api = Window["api"]["skillEvolution"]
  type EventOf<E extends "onIntentRequest" | "onConfirmRequest" | "onBtwRequestClosed" | "onGenerating"> =
    Parameters<Parameters<Api[E]>[0]>[0]
  const intent = channel<EventOf<"onIntentRequest">>()
  const confirm = channel<EventOf<"onConfirmRequest">>()
  const closed = channel<EventOf<"onBtwRequestClosed">>()
  const generation = channel<EventOf<"onGenerating">>()
  const api = {
    onIntentRequest: intent.subscribe,
    onConfirmRequest: confirm.subscribe,
    onBtwRequestClosed: closed.subscribe,
    onGenerating: generation.subscribe,
    intentResponse: vi.fn<Api["intentResponse"]>().mockResolvedValue(true),
    confirmResponse: vi.fn<Api["confirmResponse"]>().mockResolvedValue(undefined),
    retryGeneration: vi.fn<Api["retryGeneration"]>().mockResolvedValue(undefined)
  } satisfies Api
  Object.assign(window.api, { skillEvolution: api })
  return { api, intent, confirm, closed, generation }
}

type FirstQuestionContext = NonNullable<Parameters<typeof openBtw>[2]>["context"]
type SideStream = NonNullable<ReturnType<FirstQuestionContext["getStreamData"]>["stream"]>

function deferredStream(draftInput = "") {
  const listeners = new Set<() => void>()
  const appendMessage = vi.fn()
  const setDraftInput = vi.fn()
  const setError = vi.fn()
  const submit = vi.fn<SideStream["submit"]>()
  let stream: { submit: typeof submit } | null = null
  let historyLoading = true
  function publish() { listeners.forEach(listener => listener()) }
  function subscribe(_id: string, callback: () => void) {
    listeners.add(callback)
    return () => { listeners.delete(callback) }
  }
  const context: FirstQuestionContext = {
    initializeThread: vi.fn(),
    getThreadActions: () => ({ appendMessage, setDraftInput, setError, setActiveTurnStartTime: vi.fn() }),
    getThreadState: () => ({ historyLoading, currentModel: "model", workspacePath: "/project", draftInput }) as ReturnType<FirstQuestionContext["getThreadState"]>,
    getStreamData: () => ({ stream }) as ReturnType<FirstQuestionContext["getStreamData"]>,
    subscribeToStream: (id, callback) => subscribe(id, () => callback()),
    subscribeToThreadState: (id, callback) => subscribe(id, () => callback())
  }
  return { context, appendMessage, setDraftInput, setError, submit, listeners, publish,
    ready: () => { stream = { submit }; historyLoading = false; publish() } }
}

afterEach(() => {
  useBtwChat.setState({ tabs: [], selected: {} })
  useAppStore.setState({
    threads: [], sideThreads: new Map(), currentThreadId: null, models: [],
    skillGenerationByThread: new Map(), skillRetryContextByThread: new Map()
  })
  vi.unstubAllGlobals()
})

describe("辅助对话会话状态", () => {
  it("keeps skill decisions in their owning tabs and removes only the matching settled request", async () => {
    const { parentId, id, created, close } = setup()
    const siblingId = `btw-${parentId}-${randomUUID()}`
    const skill = mockSkillEvolution()
    const stop = subscribeBtwSkillEvolution()
    try {
      await openBtw(parentId, "model")
      registerSideThreadSummary({ ...created.thread, thread_id: siblingId })
      useBtwChat.setState(state => ({
        tabs: [...state.tabs, { id: siblingId, parentId, number: 2 }],
        selected: { [parentId]: siblingId }
      }))
      const intent = {
        requestId: "intent", summary: "可复用技能", toolCallCount: 4,
        turnCount: 2, mode: "mode_a_rule", context: { turns: [] }
      } as const
      const confirmation = { requestId: "confirm", skillId: "skill", name: "技能", description: "摘要", content: "正文" }
      skill.intent.send({ ...intent, threadId: parentId })
      skill.intent.send({ ...intent, threadId: id })
      skill.confirm.send({ ...confirmation, threadId: id })
      skill.confirm.send({ ...confirmation, requestId: "new-confirm", threadId: id })
      skill.confirm.send({ ...confirmation, threadId: siblingId })
      const requests = (threadId: string) => useBtwChat.getState().tabs.find(tab => tab.id === threadId)
        ?.skillRequests?.map(entry => entry.request.requestId) ?? []

      expect(useBtwChat.getState().selected[parentId]).toBe(siblingId)
      expect(requests(id)).toEqual(["intent", "confirm", "new-confirm"])
      expect(requests(siblingId)).toEqual(["confirm"])
      expect(useAppStore.getState().skillGenerationByThread.has(parentId)).toBe(false)

      await respondBtwSkillConfirmation(siblingId, "new-confirm", true, "错误归属")
      expect(skill.api.confirmResponse).not.toHaveBeenCalled()
      skill.closed.send({ threadId: id, kind: "confirm", requestId: "confirm" })
      expect(requests(id)).toEqual(["intent", "new-confirm"])
      expect(requests(siblingId)).toEqual(["confirm"])
      await respondBtwSkillConfirmation(id, "new-confirm", true, "编辑稿")
      expect(skill.api.confirmResponse).toHaveBeenCalledExactlyOnceWith("new-confirm", true, "编辑稿")
      skill.api.intentResponse.mockResolvedValueOnce(false)
      await respondBtwSkillIntent(id, "intent", true)
      expect(requests(id)).toEqual([])
      expect(useAppStore.getState().skillRetryContextByThread.has(id)).toBe(false)

      close.mockRejectedValueOnce(new Error("Still settling"))
      await closeBtw(id)
      skill.intent.send({ ...intent, threadId: id })
      skill.confirm.send({ ...confirmation, threadId: id })
      skill.generation.send({ threadId: id, phase: "error", text: "late error" })
      expect(requests(id)).toEqual([])
      expect(useAppStore.getState().skillGenerationByThread.has(id)).toBe(false)
    } finally {
      stop()
    }
  })

  it("keeps a side generation error and retries with its accepted context only once", async () => {
    const { parentId, id } = setup()
    const skill = mockSkillEvolution()
    const stop = subscribeBtwSkillEvolution()
    try {
      await openBtw(parentId, "model")
      useBtwChat.setState({ selected: { [parentId]: "new-tab" } })
      const context = { turns: ["side"] }
      skill.intent.send({ threadId: id, requestId: "intent", summary: "摘要",
        toolCallCount: 4, turnCount: 2, mode: "mode_a_rule", context })
      await respondBtwSkillIntent(id, "intent", true)
      skill.generation.send({ threadId: id, phase: "start", text: "" })
      skill.generation.send({ threadId: id, phase: "token", text: "片段" })
      const confirmation = {
        threadId: id, requestId: "tool-confirm", skillId: "tool-skill", name: "技能",
        description: "摘要", content: "正文"
      }
      skill.confirm.send(confirmation)
      expect(useAppStore.getState().skillGenerationByThread.get(id)).toMatchObject({
        phase: "generating", streamedText: "片段"
      })
      skill.closed.send({ threadId: id, kind: "confirm", requestId: "tool-confirm" })
      skill.generation.send({ threadId: id, phase: "error", text: "生成失败" })
      skill.generation.send({ threadId: parentId, phase: "error", text: "parent" })
      expect(useAppStore.getState().skillGenerationByThread.get(id)).toMatchObject({
        phase: "error", errorText: "生成失败"
      })
      expect(useAppStore.getState().skillGenerationByThread.has(parentId)).toBe(false)
      await Promise.all([retryBtwSkillGeneration(id), retryBtwSkillGeneration(id)])
      expect(skill.api.retryGeneration).toHaveBeenCalledExactlyOnceWith(id, { context, intentMode: "mode_a_rule" })
      skill.confirm.send({ ...confirmation, source: "proposal", requestId: "proposal-confirm" })
      expect(useAppStore.getState().skillGenerationByThread.get(id)?.phase).toBe("done")
      skill.closed.send({ threadId: id, kind: "confirm", requestId: "proposal-confirm" })
      expect(useBtwChat.getState().tabs.find(tab => tab.id === id)?.skillRequests).toEqual([])
      expect(useAppStore.getState().skillRetryContextByThread.get(id)).toEqual({ context, intentMode: "mode_a_rule" })
      skill.generation.send({ threadId: id, phase: "error", text: "无法保存技能" })
      expect(useAppStore.getState().skillGenerationByThread.get(id)?.phase).toBe("error")
      await retryBtwSkillGeneration(id)
      expect(skill.api.retryGeneration).toHaveBeenCalledTimes(2)
      expect(skill.api.retryGeneration).toHaveBeenLastCalledWith(id, { context, intentMode: "mode_a_rule" })
      skill.confirm.send({ ...confirmation, source: "proposal", requestId: "retried-proposal-confirm" })
      skill.closed.send({ threadId: id, kind: "confirm", requestId: "retried-proposal-confirm" })
      skill.generation.send({ threadId: id, phase: "settled", text: "" })
      expect(useAppStore.getState().skillGenerationByThread.has(id)).toBe(false)
      expect(useAppStore.getState().skillRetryContextByThread.has(id)).toBe(false)
    } finally {
      stop()
    }
  })

  it("updates a background approval badge without changing selection or reviving a closed tab", async () => {
    const { parentId, id } = setup()
    await openBtw(parentId, "model")
    useBtwChat.setState({ selected: { [parentId]: "new-tab" } })
    setBtwPendingInteraction(id, true)
    const waiting = useBtwChat.getState()
    expect(waiting.tabs[0].pending).toBe(true)
    expect(waiting.selected[parentId]).toBe("new-tab")
    setBtwPendingInteraction(id, true)
    expect(useBtwChat.getState()).toBe(waiting)
    setBtwPendingInteraction(id, false)
    expect(useBtwChat.getState().tabs[0].pending).toBe(false)
    await closeBtw(id)
    setBtwPendingInteraction(id, true)
    expect(useBtwChat.getState().tabs).toHaveLength(0)
  })

  it("sends exact supported file candidates for validation and keeps a refused tab unopened", async () => {
    const { create, parentId } = setup()
    const { context } = deferredStream()
    create.mockRejectedValueOnce(new Error("当前草稿已保留"))

    await expect(openBtw(parentId, "model", {
      text: 'Email name@example.com about @types/node and @"release notes.md" @notes.txt @Makefile @image.png', context
    })).rejects.toThrow("当前草稿已保留")
    expect(create).toHaveBeenCalledExactlyOnceWith({ parentId, modelId: "model",
      fileCandidates: ["release notes.md", "types/node", "notes.txt", "Makefile"] })
    expect(context.initializeThread).not.toHaveBeenCalled()
    expect(useBtwChat.getState().tabs).toEqual([])
    expect(useAppStore.getState().rightModule).toBe("work")
  })

  it.each(["exclusive", "shared"])("releases a %s @file scan consumer on close, while hiding keeps it active", async ownership => {
    const { parentId, id } = setup()
    const workspacePath = `/project-${id}`
    const files = [{ path: "/notes.txt", is_dir: false }]
    const opened = { success: true, scanId: "scan-id", workspacePath }
    const page = { success: true, files, workspacePath, done: true }
    let releasePage!: () => void
    const pendingPage = new Promise<typeof page>(resolve => { releasePage = () => resolve(page) })
    let reportPageRequested!: () => void
    const pageRequested = new Promise<void>(resolve => { reportPageRequested = resolve })
    const fileScanOpen = vi.fn().mockResolvedValue(opened)
    const fileScanNext = vi.fn(() => {
      reportPageRequested()
      return pendingPage
    })
    const fileScanCancel = vi.fn().mockResolvedValue({ success: true })
    Object.assign(window.api, { workspace: { fileScanOpen, fileScanNext, fileScanCancel } })

    await openBtw(parentId, "model")
    const side = loadBtwWorkspaceFiles(id, workspacePath).catch(error => error.name)
    await pageRequested
    const parent = ownership === "shared" ? loadWorkspaceFilesDeduped(parentId, workspacePath) : undefined
    useAppStore.getState().setRightModule("work")
    expect(fileScanCancel).not.toHaveBeenCalled()
    await closeBtw(id)
    releasePage()
    try {
      expect(await side).toBe("AbortError")
      if (parent) {
        expect(await parent).toMatchObject({ success: true, files })
        expect(fileScanCancel).not.toHaveBeenCalled()
      } else {
        expect(fileScanCancel).toHaveBeenCalledWith(opened.scanId)
      }
      expect(fileScanOpen).toHaveBeenCalledTimes(1)
    } finally {
      markWorkspaceFilesStale(parentId, workspacePath)
    }
  })

  it("preserves panel navigation while creating a side tab", async () => {
    const { parentId, id, create, created } = setup()
    let finishCreating!: () => void
    create.mockReturnValue(new Promise(resolve => { finishCreating = () => resolve(created) }))
    const opening = openBtw(parentId, "model")
    useAppStore.getState().setRightModule("browser")
    useAppStore.getState().setRightModule("work")
    finishCreating()
    await opening
    expect(useAppStore.getState().rightModule).toBe("work")
    expect(useBtwChat.getState().selected[parentId]).toBe(id)
  })

  it("adds a late side tab without replacing the selected sibling", async () => {
    const { parentId, id, create, created } = setup()
    const first = `btw-${parentId}-${randomUUID()}`
    const second = `btw-${parentId}-${randomUUID()}`
    useAppStore.setState({ rightModule: "btw", rightPanelCollapsed: false })
    useBtwChat.setState({
      tabs: [{ id: first, parentId, number: 1 }, { id: second, parentId, number: 2 }],
      selected: { [parentId]: first }
    })
    let finishCreating!: () => void
    create.mockReturnValue(new Promise(resolve => { finishCreating = () => resolve(created) }))
    const opening = openBtw(parentId, "model")
    useBtwChat.setState({ selected: { [parentId]: second } })
    finishCreating()
    await opening
    expect(useBtwChat.getState().tabs.map(tab => tab.id)).toEqual([first, second, id])
    expect(useBtwChat.getState().selected[parentId]).toBe(second)
  })

  it("does not expand a collapsed panel over an opened resource drawer", async () => {
    const { parentId, id, create, created } = setup()
    useAppStore.getState().setRightPanelCollapsed(true)
    let finishCreating!: () => void
    create.mockReturnValue(new Promise(resolve => { finishCreating = () => resolve(created) }))
    const opening = openBtw(parentId, "model")
    openResourcePanelOverlay("preview")
    finishCreating()
    await opening
    expect(useAppStore.getState().rightPanelCollapsed).toBe(true)
    expect(useBtwChat.getState().selected[parentId]).toBe(id)
  })

  it("starts the first question once after switching parent before creation or stream readiness", async () => {
    const { parent, parentId, id, create, created, reconcile } = setup()
    const side = deferredStream()
    const question = "/goal status"
    const settleHistory = vi.fn()
    let finishCreating!: () => void
    create.mockReturnValue(new Promise(resolve => { finishCreating = () => resolve(created) }))
    useAppStore.setState({ models: [{ id: "model", available: true } as ModelConfig] })
    const opening = openBtw(parentId, "model", { text: question, context: side.context, settleHistory })
    await useAppStore.getState().selectThread("another-parent")
    finishCreating()
    await opening
    await useAppStore.getState().loadThreads()
    expect(useAppStore.getState().threads).toEqual([parent])
    expect(selectThreadSummary(useAppStore.getState(), id)?.metadata).toEqual({ btwParentId: parentId })
    expect(useAppStore.getState().currentThreadId).toBe("another-parent")
    expect(useAppStore.getState().rightModule).toBe("work")
    expect(side.context.initializeThread).toHaveBeenCalledExactlyOnceWith(id)
    expect(side.submit).not.toHaveBeenCalled()
    expect(getSideQuestion(id)).toBe(question)

    let finishTurn!: () => void
    side.submit.mockReturnValue(new Promise(resolve => { finishTurn = () => resolve() }))
    side.ready()
    side.publish()
    expect(side.submit).toHaveBeenCalledExactlyOnceWith({ messages: [{ type: "human", content: question }] },
      expect.objectContaining({ config: { configurable: { thread_id: id, model_id: "model", agent_mode: "normal", hook_turn_id: expect.any(String) } } }))
    expect(getSideQuestion(id)).toBe(question)
    expect(side.appendMessage).not.toHaveBeenCalled()
    expect(settleHistory).not.toHaveBeenCalled()
    const options = side.submit.mock.calls[0][1]!
    options.onPromptAccepted?.("/project")
    options.onPromptAccepted?.("/project")
    expect(side.appendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: options.config?.configurable?.hook_turn_id, role: "user", content: question
    }))
    expect(getSideQuestion(id)).toBeUndefined()
    expect(settleHistory).toHaveBeenCalledExactlyOnceWith("/project")
    expect(side.listeners.size).toBe(0)
    finishTurn()
    await Promise.resolve()
    expect(side.setDraftInput).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  it("stops a pending first question when closing starts and keeps failed closes retryable", async () => {
    const { parentId, id, close, create } = setup()
    const side = deferredStream()
    let failClose!: (error: Error) => void
    close.mockReturnValueOnce(new Promise<void>((_, reject) => { failClose = reject }))
    await openBtw(parentId, "model", { text: "还没发送的问题", context: side.context })
    const otherId = `btw-${parentId}-${randomUUID()}`
    create.mockResolvedValueOnce({ id: otherId, ordinal: 2, thread: { ...useAppStore.getState().sideThreads.get(id)!, thread_id: otherId } })
    await openBtw(parentId, "model")
    expect(side.listeners.size).toBe(2)
    const closing = closeBtw(id)
    side.ready()
    expect(side.submit).not.toHaveBeenCalled()
    expect(side.listeners.size).toBe(0)
    expect(isBtwSubmissionBlocked(id)).toBe(true)
    expect(isBtwSubmissionBlocked(otherId)).toBe(false)
    failClose(new Error("退出超时"))
    await closing
    expect(isBtwSubmissionBlocked(id)).toBe(true)
    expect(useBtwChat.getState().tabs.find(tab => tab.id === id)?.closeState).toBe("failed")
    expect(useBtwChat.getState().selected[parentId]).toBe(otherId)

    await closeBtw(id)
    expect(close).toHaveBeenCalledTimes(2)
    expect(useBtwChat.getState().tabs.map(tab => tab.id)).toEqual([otherId])
    expect(isBtwSubmissionBlocked(id)).toBe(true)
  })

  it.each([false, true])("preserves an unacknowledged first question as a draft when the lookup fails: %s", async lookupFails => {
    const { parentId, id, reconcile } = setup()
    const side = deferredStream()
    useAppStore.setState({ models: [{ id: "model", available: true } as ModelConfig] })
    if (lookupFails) reconcile.mockRejectedValueOnce(new Error("无法确认会话记录"))
    side.submit.mockResolvedValue(undefined)
    await openBtw(parentId, "model", { text: "未确认的问题", context: side.context })
    side.ready()
    await vi.waitFor(() => expect(getSideQuestion(id)).toBeUndefined())
    expect(side.setDraftInput).toHaveBeenCalledExactlyOnceWith("未确认的问题")
    expect(side.setError).toHaveBeenCalledExactlyOnceWith(lookupFails
      ? "无法确认首条辅助消息是否已发送。重发前请先核对对话记录。"
      : "首条辅助消息未确认，已保留为草稿。")
    expect(side.appendMessage).not.toHaveBeenCalled()
    expect(side.submit).toHaveBeenCalledOnce()
  })

  it("does not replace an existing side draft when the first question's status cannot be confirmed", async () => {
    const { parentId, id, reconcile } = setup()
    const side = deferredStream("已经在输入框中的内容")
    useAppStore.setState({ models: [{ id: "model", available: true } as ModelConfig] })
    reconcile.mockRejectedValueOnce(new Error("无法确认会话记录"))
    side.submit.mockResolvedValue(undefined)
    await openBtw(parentId, "model", { text: "未确认的问题", context: side.context })
    side.ready()
    await vi.waitFor(() => expect(getSideQuestion(id)).toBeUndefined())
    expect(side.setDraftInput).not.toHaveBeenCalled()
    expect(side.setError).toHaveBeenCalledExactlyOnceWith("无法确认首条辅助消息是否已发送。重发前请先核对对话记录。")
  })

  it("does not duplicate a stored first question when the stream ends before its receipt", async () => {
    const { parentId, id, reconcile } = setup()
    const side = deferredStream()
    useAppStore.setState({ models: [{ id: "model", available: true } as ModelConfig] })
    side.submit.mockResolvedValue(undefined)
    reconcile.mockImplementation(async (_id, ids) => ({ pendingIds: [], injectedIds: [], durableIds: ids }))
    await openBtw(parentId, "model", { text: "已经记入消息记录的问题", context: side.context })
    side.ready()
    await vi.waitFor(() => expect(getSideQuestion(id)).toBeUndefined())
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(id, [side.submit.mock.calls[0][1]?.config?.configurable?.hook_turn_id])
    expect(side.setDraftInput).not.toHaveBeenCalled()
    expect(side.setError).not.toHaveBeenCalled()
    expect(side.appendMessage).not.toHaveBeenCalled()
  })

  it.each(["send", "close", "stop", "return"] as const)("hands a hidden side queue to its stream only while needed: %s", async action => {
    const { id, parentId } = setup()
    await openBtw(parentId, "model")
    useAppStore.setState({ models: [{ id: "model", available: true } as ModelConfig] })
    const side = deferredStream()
    const draft: QueuedMessage = { id: "one", text: "追问", modelId: "model", created_at: new Date(), updated_at: new Date() }
    const state = { ...side.context.getThreadState(id), historyLoading: false, queuedMessages: [draft], queueAutoDrainSuppressed: false }
    let loading = true
    const actions = {
      ...side.context.getThreadActions(id),
      deleteQueuedMessage: () => { state.queuedMessages = []; side.publish() },
      prependQueuedMessage: vi.fn()
    }
    const context = {
      ...side.context, getThreadState: () => state, getThreadActions: () => actions,
      getStreamData: () => ({ stream: { submit: side.submit }, isLoading: loading })
    } as unknown as Parameters<typeof drainHiddenBtwQueue>[1]
    side.submit.mockImplementation(async (_input, options) => { options?.onPromptAccepted?.("/project") })
    drainHiddenBtwQueue(id, context)
    drainHiddenBtwQueue(id, context)
    expect(side.submit).not.toHaveBeenCalled()
    if (action === "return") resumeVisibleBtwQueue(id)
    if (action === "stop") state.queueAutoDrainSuppressed = true
    if (action === "close") await closeBtw(id)
    loading = false
    side.publish()
    await Promise.resolve()
    expect(side.submit).toHaveBeenCalledTimes(action === "send" ? 1 : 0)
    expect(side.listeners.size).toBe(0)
    if (action === "send") expect(side.appendMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "one", content: "追问" }))
  })

  it("keeps the tab while its runtime is closing and removes it after acknowledgement", async () => {
    const { parentId, id, close } = setup()
    let finish!: () => void
    close.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    await openBtw(parentId, "model")
    const closing = closeBtw(id)
    await closeBtw(id)
    expect(close).toHaveBeenCalledExactlyOnceWith(id)
    expect(useBtwChat.getState().selected[parentId]).toBe(id)
    finish()
    await closing
    expect(useBtwChat.getState().tabs).toEqual([])
    expect(selectThreadSummary(useAppStore.getState(), id)).toBeUndefined()
    expect(useAppStore.getState().currentThreadId).toBe(parentId)
  })

  it("releases the closed tab's skill content and ignores late updates", async () => {
    const { parentId, id, created } = setup()
    await openBtw(parentId, "model")
    const { setSkillGenerationPhase, appendSkillGenerationToken, setSkillRetryContext } = useAppStore.getState()
    setSkillGenerationPhase("generating", undefined, id)
    appendSkillGenerationToken("辅助对话的技能正文", id)
    setSkillRetryContext({ context: "辅助对话的消息", intentMode: "mode_a_rule" }, id)
    setSkillGenerationPhase("generating", undefined, parentId)
    setSkillRetryContext({ context: "主对话的消息", intentMode: "mode_a_rule" }, parentId)

    await closeBtw(id)
    useAppStore.getState().addThreadSummary(created.thread)
    expect(useAppStore.getState().sideThreads.has(id)).toBe(false)
    setSkillGenerationPhase("done", undefined, id)
    appendSkillGenerationToken("迟到的技能正文", id)
    setSkillRetryContext({ context: "迟到的消息", intentMode: "mode_a_rule" }, id)

    const { skillGenerationByThread, skillRetryContextByThread } = useAppStore.getState()
    expect([...skillGenerationByThread.keys()]).toEqual([parentId])
    expect([...skillRetryContextByThread.keys()]).toEqual([parentId])
  })

  it("retires missing child state and closes descendants after an acknowledged parent deletion", async () => {
    const missing = setup()
    await openBtw(missing.parentId, "model")
    missing.get.mockResolvedValue(null)
    expect(await loadBtwThread(missing.id, missing.parentId)).toBeNull()
    expect(useBtwChat.getState().tabs).toEqual([])

    const parent = setup()
    await openBtw(parent.parentId, "model")
    await useAppStore.getState().deleteThread(parent.parentId)
    expect(useBtwChat.getState().tabs).toEqual([])
    expect(useAppStore.getState().sideThreads.size).toBe(0)
    expect(parent.removeItem).toHaveBeenCalledWith(queueStorageKey(parent.id))
  })

  it("keeps the parent and the surviving side tab when only one child was deleted", async () => {
    const { parentId, id, create, created, removeItem } = setup()
    await openBtw(parentId, "model")
    const sibling = `btw-${parentId}-${randomUUID()}`
    create.mockResolvedValueOnce({ id: sibling, ordinal: 2, thread: { ...created.thread, thread_id: sibling } })
    await openBtw(parentId, "model")
    vi.mocked(window.api.threads.delete).mockResolvedValueOnce({
      deletedSideThreadIds: [id], deletionError: "shell_timed_out"
    })
    await expect(useAppStore.getState().deleteThread(parentId)).rejects.toThrow("shell_timed_out")
    expect(useBtwChat.getState().tabs.map(tab => tab.id)).toEqual([sibling])
    expect(useAppStore.getState().currentThreadId).toBe(parentId)
    expect(selectThreadSummary(useAppStore.getState(), parentId)).toBeDefined()
    expect(removeItem).toHaveBeenCalledWith(queueStorageKey(id))
    expect(removeItem).not.toHaveBeenCalledWith(queueStorageKey(sibling))
    expect(removeItem).not.toHaveBeenCalledWith(queueStorageKey(parentId))
    await useAppStore.getState().deleteThread(parentId)
    expect(useBtwChat.getState().tabs).toEqual([])
  })
})
