import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useBotWorkspaceStore } from "./bot-workspace-store"
import { botThreadView } from "./bot-thread-view"
import {
  BOT_MESSAGE_RESIDENT_LIMIT,
  BOT_MESSAGE_RESIDENT_BYTES,
  estimateBotMessageBytes,
  mergeBotThreadSummaries
} from "./bot-message-history"
import { parseStoredBotDraft } from "./bot-composer-draft"
import { botViewportPositionCache } from "./bot-viewport-position"
import { BotDomainError, type BotMessage, type BotReadState } from "../../../shared/bot-types"

const initial = useBotWorkspaceStore.getState(),
  main = "conversation",
  rootId = "root",
  view = botThreadView(main, rootId)
const readState: BotReadState = {
  revision: 0,
  lastReadSequence: 0,
  latestSequence: 2,
  unreadCount: 1,
  firstUnreadSequence: 2,
  manuallyUnread: false
}
const root: BotMessage = {
  id: rootId,
  sequence: 1,
  conversationId: main,
  sender: "user",
  botId: null,
  runId: null,
  replyTo: null,
  text: "Root",
  createdAt: 1,
  attachments: []
}
const child: BotMessage = {
  ...root,
  id: "child",
  sequence: 2,
  sender: "bot",
  threadRootId: rootId,
  text: "Branch answer"
}
const threadValue = { conversationId: main, rootId, root, count: 1, readState }
const api = {
  thread: vi.fn(),
  messages: vi.fn(),
  message: vi.fn(),
  send: vi.fn(),
  snapshot: vi.fn(),
  status: vi.fn(),
  threadSummaries: vi.fn(),
  read: vi.fn(),
  setReadState: vi.fn()
}
beforeEach(() => {
  botViewportPositionCache.clear()
  const cache = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => cache.set(key, value),
    removeItem: (key: string) => cache.delete(key)
  })
  vi.stubGlobal("window", { api: { bots: api } })
  Object.values(api).forEach((fn) => fn.mockReset())
  api.thread.mockResolvedValue(threadValue)
  api.threadSummaries.mockResolvedValue([])
  api.messages.mockImplementation(({ threadRootId }) =>
    Promise.resolve(threadRootId ? [child] : [root])
  )
  api.message.mockResolvedValue(child)
  const host = {
    protocol: 1 as const,
    hostId: "branch-test",
    runtimeReady: true,
    error: null,
    platform: "test",
    capabilities: ["message-threads"]
  }
  const snapshot = {
    cursor: 100000,
    bots: [],
    conversations: [
      {
        id: main,
        kind: "direct" as const,
        members: [],
        name: "Test",
        revision: 1,
        createdAt: 1,
        readState
      }
    ],
    runs: [],
    interactions: []
  }
  api.status.mockResolvedValue(host)
  api.snapshot.mockResolvedValue(snapshot)
  useBotWorkspaceStore.setState(
    {
      ...initial,
      selected: main,
      messages: { [main]: [root] },
      threads: {},
      drafts: {},
      pending: {},
      opening: {},
      sending: {},
      host,
      snapshot
    },
    true
  )
})
afterEach(() => {
  botViewportPositionCache.clear()
  useBotWorkspaceStore.setState(initial, true)
  vi.unstubAllGlobals()
})

it.each([false, true])(
  "opens the first unread message with an older-page affordance only for a visible predecessor (%s)",
  async (hasVisiblePredecessor) => {
    const answer = { ...child, threadRootId: undefined }
    useBotWorkspaceStore.setState({ selected: null, messages: {} })
    api.messages.mockImplementation(({ before }) =>
      Promise.resolve(before === 2 ? (hasVisiblePredecessor ? [root] : []) : [answer])
    )
    useBotWorkspaceStore.getState().select(main)
    await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[main]).toBe(false))
    const opened = useBotWorkspaceStore.getState()
    expect(opened.messages[main]).toEqual([answer])
    expect(opened.unreadAnchors[main]).toBe(2)
    expect(opened.hasOlder[main]).toBe(hasVisiblePredecessor)
    expect(api.messages.mock.calls.map(([input]) => input)).toEqual([
      { conversationId: main, after: 1, limit: 100 },
      { conversationId: main, before: 2, limit: 1 }
    ])
  }
)

it.each(["refresh", "load"])(
  "removes the speculative older-page affordance once %s returns the entire conversation",
  async (source) => {
    const answer = { ...child, threadRootId: undefined }
    useBotWorkspaceStore.setState({
      messages: { [main]: [answer] },
      hasOlder: { [main]: true },
      hasNewer: { [main]: false }
    })
    api.messages.mockResolvedValue([root, answer])
    api.snapshot.mockResolvedValue({
      ...useBotWorkspaceStore.getState().snapshot,
      cursor: 100001
    })
    if (source === "refresh") await useBotWorkspaceStore.getState().refresh()
    else await useBotWorkspaceStore.getState().loadMessages(main)
    expect(useBotWorkspaceStore.getState().hasOlder[main]).toBe(false)
    expect(useBotWorkspaceStore.getState().messages[main].map((message) => message.id)).toEqual([
      root.id,
      answer.id
    ])
  }
)

it("invalidates caches and persisted retries after restore while retaining unsent text", async () => {
  const state = useBotWorkspaceStore.getState()
  state.draft(main, "保留我尚未发送的说明")
  state.reply(main, rootId)
  localStorage.setItem(
    `bot-pending:${main}`,
    JSON.stringify({ nonce: "old-send", conversationId: main, text: "old", dataEpoch: "initial" })
  )
  const original = state.snapshot!
  api.snapshot.mockResolvedValue({ ...original, dataEpoch: "restored", cursor: 4 })
  api.status.mockResolvedValue({ ...state.host, hostId: "restored-host" })
  await state.refresh()
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[main]).toBe(false))
  const current = useBotWorkspaceStore.getState()
  expect(current.snapshot?.cursor).toBe(4)
  expect(current.drafts[main]).toEqual({ prompt: "保留我尚未发送的说明", attachments: [] })
  expect(current.pending).toEqual({})
  expect(
    parseStoredBotDraft(JSON.parse(localStorage.getItem(`bot-draft:${main}`)!), "restored")
  ).toEqual(current.drafts[main])
  // A newly opened window cannot revive an old pending send from localStorage.
  useBotWorkspaceStore.setState({ selected: null, drafts: {} })
  current.select(main, true)
  expect(useBotWorkspaceStore.getState().pending).toEqual({})
  expect(useBotWorkspaceStore.getState().drafts[main].replyToId).toBeUndefined()
})

it("does not apply an old send response or queued read after a restore", async () => {
  const state = useBotWorkspaceStore.getState()
  state.draft(main, "原来的消息")
  let finishSend!: () => void
  let finishRead!: (value: BotReadState) => void
  api.send.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishSend = resolve
      })
  )
  api.setReadState.mockImplementation(
    () =>
      new Promise<BotReadState>((resolve) => {
        finishRead = resolve
      })
  )
  const sending = state.send(main)
  const reading = state.markRead(main, 2, true)
  await vi.waitFor(() => expect(api.setReadState).toHaveBeenCalledTimes(1))
  const queued = state.markRead(main, 3, true)
  api.snapshot.mockResolvedValue({ ...state.snapshot, dataEpoch: "restored-later", cursor: 5 })
  api.status.mockResolvedValue({ ...state.host, hostId: "next-host" })
  await state.refresh()
  useBotWorkspaceStore.getState().draft(main, "恢复后写的新说明")
  finishSend()
  finishRead({ ...readState, revision: 999, lastReadSequence: 999 })
  await Promise.all([sending, reading, queued])
  expect(api.setReadState).toHaveBeenCalledTimes(1)
  expect(useBotWorkspaceStore.getState().drafts[main].prompt).toBe("恢复后写的新说明")
  expect(useBotWorkspaceStore.getState().snapshot?.conversations[0].readState?.revision).toBe(0)
})

it("isolates drafts and durable retries by view while using the real conversation ID for RPC", async () => {
  const state = useBotWorkspaceStore.getState()
  state.draft(main, "Main draft")
  state.select(view)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[view]).toBe(false))
  state.draft(view, "Branch draft")
  useBotWorkspaceStore.setState({ refresh: async () => {}, loadMessages: async () => {} })
  api.send.mockRejectedValueOnce(new Error("socket closed"))
  await expect(state.send(view)).rejects.toThrow("socket")
  const accepted = useBotWorkspaceStore.getState().pending[view]
  expect(accepted).toMatchObject({
    conversationId: main,
    threadRootId: rootId,
    text: "Branch draft"
  })
  state.select(main, true)
  expect(useBotWorkspaceStore.getState().drafts[main].prompt).toBe("Main draft")
  expect(useBotWorkspaceStore.getState().messages[main]).toEqual([root])
  state.select(view)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[view]).toBe(false))
  state.draft(view, "New branch draft")
  api.send.mockResolvedValue({ messageId: "accepted", runIds: [] })
  await state.send(view)
  expect(api.send.mock.calls[1][0]).toEqual(accepted)
  expect(useBotWorkspaceStore.getState().drafts[view].prompt).toBe("New branch draft")
  expect(useBotWorkspaceStore.getState().drafts[main].prompt).toBe("Main draft")
})

it("routes a search hit into its branch and fences older read-state responses", async () => {
  api.messages.mockResolvedValue([])
  await useBotWorkspaceStore.getState().jumpToMessage(main, child.id)
  expect(useBotWorkspaceStore.getState().selected).toBe(view)
  expect(useBotWorkspaceStore.getState().messages[view]).toEqual([child])
  expect(useBotWorkspaceStore.getState().threads[view].root.id).toBe(rootId)
  let resolve!: (value: typeof threadValue) => void
  api.thread.mockImplementationOnce(
    () =>
      new Promise<typeof threadValue>((done) => {
        resolve = done
      })
  )
  const pending = useBotWorkspaceStore.getState().refresh()
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"))
  const marked = {
    ...readState,
    revision: 2,
    unreadCount: 0,
    lastReadSequence: 2,
    firstUnreadSequence: null
  }
  useBotWorkspaceStore.setState({ threads: { [view]: { ...threadValue, readState: marked } } })
  resolve(threadValue)
  await pending
  expect(useBotWorkspaceStore.getState().threads[view].readState).toEqual(marked)
})

it("retains unchanged message identities and refuses stale branch read revisions", () => {
  const summary = { rootId, count: 2, readState: { ...readState, revision: 2, unreadCount: 0 } }
  const message = { ...root, threadSummary: summary }
  expect(mergeBotThreadSummaries([message], [summary])[0]).toBe(message)
  const updated = mergeBotThreadSummaries([message], [{ ...summary, count: 3, readState }])[0]
  expect(updated.threadSummary?.count).toBe(3)
  expect(updated.threadSummary?.readState).toEqual(summary.readState)
})

it("refreshes cached main-view branch counts after returning even when the global cursor is unchanged", async () => {
  const state = useBotWorkspaceStore.getState()
  state.select(view)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[view]).toBe(false))
  await state.refresh()
  api.threadSummaries.mockResolvedValue([{ rootId, count: 2, readState }])
  state.select(main, true)
  useBotWorkspaceStore.setState({ hasNewer: { [main]: true } })
  const messageCalls = api.messages.mock.calls.length
  await state.refresh()
  expect(useBotWorkspaceStore.getState().messages[main][0].threadSummary?.count).toBe(2)
  expect(api.messages.mock.calls.length).toBe(messageCalls)
  expect(useBotWorkspaceStore.getState().hasNewer[main]).toBe(true)
  const summaryCalls = api.threadSummaries.mock.calls.length
  await state.refresh()
  expect(api.threadSummaries.mock.calls.length).toBe(summaryCalls)
})

it("refreshes thread metadata after an opening poll consumed a newer cursor before the old page arrived", async () => {
  const state = useBotWorkspaceStore.getState()
  const snapshot = {
    ...state.snapshot!,
    conversations: state.snapshot!.conversations.map((conversation) => ({
      ...conversation,
      readState: {
        ...readState,
        lastReadSequence: root.sequence,
        latestSequence: root.sequence,
        unreadCount: 0,
        firstUnreadSequence: null
      }
    }))
  }
  useBotWorkspaceStore.setState({ snapshot })
  const staleSummary = { rootId, count: 1, readState }
  const staleRoot = { ...root, threadSummary: staleSummary }
  const currentSummary = {
    rootId,
    count: 2,
    readState: { ...readState, latestSequence: 3, unreadCount: 2 }
  }
  const currentRoot = { ...root, threadSummary: currentSummary }
  let finishPage!: (messages: BotMessage[]) => void
  // The domain read already captured the old page annotations. Its response is
  // still in flight when another Host task creates a new branch reply.
  api.messages.mockImplementationOnce(
    () => new Promise<BotMessage[]>((resolve) => (finishPage = resolve))
  )
  api.messages.mockResolvedValue([currentRoot])
  api.threadSummaries.mockResolvedValue([currentSummary])
  const loading = state.loadMessages(main)
  expect(useBotWorkspaceStore.getState().opening[main]).toBe(true)
  const currentCursor = snapshot.cursor + 1
  api.snapshot.mockResolvedValue({ ...snapshot, cursor: currentCursor })
  await state.refresh()
  expect(useBotWorkspaceStore.getState().snapshot?.cursor).toBe(currentCursor)
  expect(useBotWorkspaceStore.getState().opening[main]).toBe(true)
  expect(api.threadSummaries).not.toHaveBeenCalled()
  expect(api.messages).toHaveBeenCalledExactlyOnceWith({ conversationId: main, limit: 100 })

  finishPage([staleRoot])
  await loading
  expect(useBotWorkspaceStore.getState().opening[main]).toBe(false)
  expect(useBotWorkspaceStore.getState().messages[main][0].threadSummary).toEqual(staleSummary)
  // The main transcript was already read, so its automatic visible watermark
  // legitimately produces no new event that could rescue the next poll.
  await state.markRead(main, root.sequence)
  expect(api.setReadState).not.toHaveBeenCalled()
  // This ordinary next poll sees the same cursor and selection. Skipping reads
  // while opening must not count as refreshing the page that arrived afterward.
  await state.refresh()
  expect(useBotWorkspaceStore.getState().snapshot?.cursor).toBe(currentCursor)
  expect(api.threadSummaries).toHaveBeenCalledExactlyOnceWith({
    conversationId: main,
    rootIds: [rootId]
  })
  expect(useBotWorkspaceStore.getState().messages[main][0].threadSummary).toEqual(currentSummary)
})

it("refreshes the main transcript after work completed while viewing a branch", async () => {
  const state = useBotWorkspaceStore.getState()
  state.select(view)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[view]).toBe(false))
  await state.refresh()
  const answer = { ...child, threadRootId: undefined }
  api.messages.mockResolvedValue([root, answer])
  state.select(main, true)
  // The branch already consumed the global event cursor, but the cached main
  // transcript has not seen its new answer yet.
  await state.refresh()
  expect(useBotWorkspaceStore.getState().messages[main]).toEqual([root, answer])
})

it("retains only the selected transcript and its parent, preserving drafts and send receipts", async () => {
  const state = useBotWorkspaceStore.getState()
  state.draft(main, "Main draft")
  const receipt = { nonce: "pending", conversationId: main, threadRootId: rootId, text: "sent" }
  useBotWorkspaceStore.setState({
    hasOlder: { [main]: true },
    pending: { [view]: receipt }
  })
  for (let index = 0; index < 20; index++) {
    const id = botThreadView(main, `root-${index}`)
    state.select(id)
    await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[id]).toBe(false))
    state.draft(id, `Draft ${index}`)
    expect(Object.keys(useBotWorkspaceStore.getState().messages).sort()).toEqual([main, id].sort())
    expect(Object.keys(useBotWorkspaceStore.getState().threads)).toEqual([id])
  }
  state.select(main, true)
  expect(useBotWorkspaceStore.getState().messages).toEqual({ [main]: [root] })
  expect(useBotWorkspaceStore.getState().hasOlder[main]).toBe(true)
  expect(useBotWorkspaceStore.getState().drafts[botThreadView(main, "root-0")].prompt).toBe(
    "Draft 0"
  )
  expect(useBotWorkspaceStore.getState().pending[view]).toEqual(receipt)
  state.select("another")
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening.another).toBe(false))
  expect(Object.keys(useBotWorkspaceStore.getState().messages)).toEqual(["another"])
  expect(useBotWorkspaceStore.getState().threads).toEqual({})
  expect(useBotWorkspaceStore.getState().drafts[main].prompt).toBe("Main draft")
})

it("loads a requested restore when its transcript is no longer cached", async () => {
  useBotWorkspaceStore.setState({ selected: view, messages: { [view]: [child] } })
  useBotWorkspaceStore.getState().select(main, true)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().messages[main]).toEqual([root]))
})

it.each([false, true])(
  "leaves a remotely deleted branch and releases its history (another conversation=%s)",
  async (hasAnother) => {
    const state = useBotWorkspaceStore.getState()
    state.select(view)
    await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[view]).toBe(false))
    state.draft(view, "Unsent branch notes")
    useBotWorkspaceStore.setState({
      messages: { [view]: [{ ...child, steering: { runId: "run", state: "pending" } }] }
    })
    api.status.mockResolvedValue({
      ...state.host!,
      capabilities: ["message-threads", "current-task-instructions"]
    })
    const conversations = hasAnother
      ? [{ ...state.snapshot!.conversations[0], id: "remaining" }]
      : []
    api.snapshot.mockResolvedValue({ ...state.snapshot!, cursor: 100010, conversations })
    api.thread.mockClear().mockRejectedValue(new Error("The Bot was deleted"))
    api.message.mockClear().mockRejectedValue(new Error("The Bot was deleted"))
    await expect(state.refresh()).resolves.toBeUndefined()
    expect(api.thread).not.toHaveBeenCalled()
    expect(api.message).not.toHaveBeenCalled()
    expect(useBotWorkspaceStore.getState().selected).toBe(hasAnother ? "remaining" : null)
    expect(useBotWorkspaceStore.getState().messages[view]).toBeUndefined()
    expect(useBotWorkspaceStore.getState().threads[view]).toBeUndefined()
    expect(useBotWorkspaceStore.getState().drafts[view].prompt).toBe("Unsent branch notes")
    if (hasAnother)
      await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening.remaining).toBe(false))
  }
)

it("does not republish an in-flight history page after the last conversation is deleted", async () => {
  const state = useBotWorkspaceStore.getState()
  let finish!: (value: BotMessage[]) => void
  api.messages.mockImplementationOnce(
    () =>
      new Promise<BotMessage[]>((done) => {
        finish = done
      })
  )
  const older = state.loadMessages(main, root.sequence)
  api.snapshot.mockResolvedValue({ ...state.snapshot!, cursor: 100011, conversations: [] })
  await state.refresh()
  finish([root])
  await older
  expect(useBotWorkspaceStore.getState().selected).toBeNull()
  expect(useBotWorkspaceStore.getState().messages).toEqual({})
  expect(useBotWorkspaceStore.getState().loadingOlder).toEqual({})
})

it("does not let a superseded page request clear the current view's loading state", async () => {
  const state = useBotWorkspaceStore.getState()
  let finishOld!: (value: BotMessage[]) => void
  let finishNew!: (value: BotMessage[]) => void
  api.messages.mockImplementationOnce(
    () =>
      new Promise<BotMessage[]>((done) => {
        finishOld = done
      })
  )
  const oldPage = state.loadMessages(main, root.sequence)
  state.select(view)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[view]).toBe(false))
  state.select(main, true)
  api.messages.mockImplementationOnce(
    () =>
      new Promise<BotMessage[]>((done) => {
        finishNew = done
      })
  )
  const newPage = state.loadMessages(main, root.sequence)
  expect(finishNew).toBeTypeOf("function")
  finishOld([])
  await oldPage
  expect(useBotWorkspaceStore.getState().loadingOlder[main]).toBe(true)
  finishNew([])
  await newPage
  expect(useBotWorkspaceStore.getState().loadingOlder[main]).toBe(false)
  expect(useBotWorkspaceStore.getState().messages[main]).toEqual([root])
})

it("refreshes an older pending instruction while preserving the user's paged reading position", async () => {
  const state = useBotWorkspaceStore.getState()
  const pending = { ...root, steering: { runId: "running-task", state: "pending" as const } }
  useBotWorkspaceStore.setState({
    selected: main,
    messages: { [main]: [pending, child] },
    hasNewer: { [main]: true },
    host: { ...state.host!, capabilities: ["current-task-instructions"] }
  })
  api.status.mockResolvedValue({ ...state.host!, capabilities: ["current-task-instructions"] })
  api.snapshot.mockResolvedValue({ ...state.snapshot!, cursor: state.snapshot!.cursor + 1 })
  api.message.mockResolvedValue({
    ...pending,
    steering: { runId: "running-task", state: "accepted" }
  })
  await state.refresh()
  expect(api.message).toHaveBeenCalledWith({ conversationId: main, id: root.id })
  expect(useBotWorkspaceStore.getState().messages[main].map((message) => message.id)).toEqual([
    root.id,
    child.id
  ])
  expect(useBotWorkspaceStore.getState().messages[main][0].steering?.state).toBe("accepted")
  expect(useBotWorkspaceStore.getState().hasNewer[main]).toBe(true)
})

it("serializes an explicit read click after an in-flight visible watermark using the returned revision", async () => {
  let release!: (value: BotReadState) => void
  api.setReadState
    .mockImplementationOnce(
      () =>
        new Promise<BotReadState>((resolve) => {
          release = resolve
        })
    )
    .mockImplementationOnce(async (input) => ({
      ...readState,
      revision: input.revision + 1,
      lastReadSequence: input.throughSequence,
      unreadCount: 0
    }))
  const state = useBotWorkspaceStore.getState()
  const automatic = state.markRead(main, 1)
  await vi.waitFor(() => expect(api.setReadState).toHaveBeenCalledTimes(1))
  const manual = state.markRead(main, 2, true, false)
  expect(api.setReadState).toHaveBeenCalledTimes(1)
  release({ ...readState, revision: 1, lastReadSequence: 1 })
  await Promise.all([automatic, manual])
  expect(api.setReadState.mock.calls.map(([input]) => input)).toEqual([
    { conversationId: main, revision: 0, throughSequence: 1, unread: false },
    { conversationId: main, revision: 1, throughSequence: 2, unread: false }
  ])
  expect(useBotWorkspaceStore.getState().snapshot?.conversations[0].readState).toMatchObject({
    revision: 2,
    lastReadSequence: 2,
    unreadCount: 0
  })
})

it("drops an older queued automatic mark when a manual unread reminder arrives", async () => {
  let release!: (value: BotReadState) => void
  api.setReadState
    .mockImplementationOnce(
      () =>
        new Promise<BotReadState>((resolve) => {
          release = resolve
        })
    )
    .mockImplementationOnce(async (input) => ({
      ...readState,
      revision: input.revision + 1,
      lastReadSequence: 1,
      manuallyUnread: true
    }))
  const state = useBotWorkspaceStore.getState()
  const first = state.markRead(main, 1)
  await vi.waitFor(() => expect(api.setReadState).toHaveBeenCalledTimes(1))
  const stale = state.markRead(main, 2)
  const reminder = state.markRead(main, 2, true, true)
  release({ ...readState, revision: 1, lastReadSequence: 1 })
  await Promise.all([first, stale, reminder])
  expect(api.setReadState).toHaveBeenCalledTimes(2)
  expect(api.setReadState.mock.calls[1][0]).toMatchObject({ revision: 1, unread: true })
  await state.markRead(main, 2)
  expect(api.setReadState).toHaveBeenCalledTimes(2)
  expect(useBotWorkspaceStore.getState().automaticReadBlocked[main]).toBe(true)
})

it("does not silently replay a manual mark against another client's newer revision", async () => {
  const refresh = vi.fn(async () => {})
  useBotWorkspaceStore.setState({ refresh })
  api.setReadState.mockRejectedValueOnce(new Error("读取位置已变化，请刷新后重试"))
  await expect(useBotWorkspaceStore.getState().markRead(main, 2, true)).rejects.toThrow("已变化")
  expect(api.setReadState).toHaveBeenCalledTimes(1)
  expect(refresh).toHaveBeenCalledTimes(1)
})

const mainMessages = (start: number, count: number): BotMessage[] =>
  Array.from({ length: count }, (_, offset) => ({
    ...root,
    id: `history-${start + offset}`,
    sequence: start + offset,
    text: `Message ${start + offset}`
  }))

it("bounds both pagination directions and leaves released messages reachable without touching drafts or receipts", async () => {
  const corpus = mainMessages(1, 2500)
  const receipt = { nonce: "pending", conversationId: main, text: "submitted draft" }
  const state = useBotWorkspaceStore.getState()
  state.draft(main, "Unsent edits")
  useBotWorkspaceStore.setState({
    messages: { [main]: corpus.slice(1000) },
    hasOlder: { [main]: true },
    hasNewer: { [main]: false },
    pending: { [main]: receipt }
  })
  api.messages.mockImplementation(({ before, after, limit }) =>
    Promise.resolve(
      after !== undefined
        ? corpus.filter((message) => message.sequence > after).slice(0, limit)
        : corpus.filter((message) => message.sequence < (before ?? Infinity)).slice(-limit)
    )
  )
  await state.loadMessages(main, 1001)
  let current = useBotWorkspaceStore.getState()
  expect(current.messages[main]).toEqual(corpus.slice(900, 2400))
  expect(current.messages[main]).toHaveLength(BOT_MESSAGE_RESIDENT_LIMIT)
  expect(current.hasNewer[main]).toBe(true)
  expect(current.historyFollowTail[main]).toBe(false)
  await state.loadNewer(main)
  current = useBotWorkspaceStore.getState()
  expect(current.messages[main]).toEqual(corpus.slice(1000))
  expect(current.hasOlder[main]).toBe(true)
  await state.loadNewer(main)
  expect(useBotWorkspaceStore.getState().hasNewer[main]).toBe(false)
  expect(useBotWorkspaceStore.getState().drafts[main].prompt).toBe("Unsent edits")
  expect(useBotWorkspaceStore.getState().pending[main]).toEqual(receipt)
})

it("preserves the detached active window when automatic refresh would release its reading position", async () => {
  const existing = mainMessages(1, 1500)
  const state = useBotWorkspaceStore.getState()
  useBotWorkspaceStore.setState({
    messages: { [main]: existing },
    hasOlder: { [main]: false },
    hasNewer: { [main]: false }
  })
  state.setHistoryFollowTail(main, false)
  api.messages.mockResolvedValue(mainMessages(1402, 100))
  api.snapshot.mockResolvedValue({ ...state.snapshot!, cursor: 200000 })
  await state.refresh()
  let current = useBotWorkspaceStore.getState()
  expect(current.messages[main].map((message) => message.id)).toEqual(
    existing.map((message) => message.id)
  )
  expect(current.messages[main][0]).toBe(existing[0])
  expect(current.hasNewer[main]).toBe(true)
  expect(current.hasOlder[main]).toBe(false)
  // An explicit return to the latest page can release old rows and resume following.
  await state.loadMessages(main)
  current = useBotWorkspaceStore.getState()
  expect(current.messages[main][0].sequence).toBe(2)
  expect(current.messages[main].at(-1)?.sequence).toBe(1501)
  expect(current.hasOlder[main]).toBe(true)
  expect(current.hasNewer[main]).toBe(false)
  expect(current.historyFollowTail[main]).toBe(true)
})

it("enforces the byte budget when following a transcript with large message bodies", async () => {
  const large = mainMessages(1, 6).map((message) => ({
    ...message,
    text: "x".repeat(2 * 1024 * 1024)
  }))
  const state = useBotWorkspaceStore.getState()
  useBotWorkspaceStore.setState({
    messages: { [main]: large.slice(0, 3) },
    hasOlder: { [main]: false },
    hasNewer: { [main]: false }
  })
  api.messages.mockResolvedValue(large.slice(3))
  api.snapshot.mockResolvedValue({ ...state.snapshot!, cursor: 200001 })
  await state.refresh()
  const current = useBotWorkspaceStore.getState()
  expect(current.messages[main].length).toBeLessThan(large.length)
  expect(
    current.messages[main].reduce((bytes, message) => bytes + estimateBotMessageBytes(message), 0)
  ).toBeLessThanOrEqual(BOT_MESSAGE_RESIDENT_BYTES)
  expect(current.messages[main].at(-1)?.sequence).toBe(6)
  expect(current.hasOlder[main]).toBe(true)
})

it("retains parent follow state when opening a branch and drops it after leaving the project", async () => {
  const state = useBotWorkspaceStore.getState()
  state.setHistoryFollowTail(main, false)
  state.select(view)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[view]).toBe(false))
  expect(useBotWorkspaceStore.getState().historyFollowTail).toEqual({ [main]: false, [view]: true })
  state.select(main, true)
  expect(useBotWorkspaceStore.getState().historyFollowTail).toEqual({ [main]: false })
  // A late scroll callback from an unmounted branch cannot revive its cache.
  state.setHistoryFollowTail(view, true)
  expect(useBotWorkspaceStore.getState().historyFollowTail).toEqual({ [main]: false })
  state.select("another")
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening.another).toBe(false))
  expect(useBotWorkspaceStore.getState().historyFollowTail).toEqual({ another: true })
})

it("detaches immediately when revealing an already resident quoted message", async () => {
  const state = useBotWorkspaceStore.getState()
  state.setHistoryFollowTail(main, true)
  await state.jumpToMessage(main, root.id)
  expect(useBotWorkspaceStore.getState().historyFollowTail[main]).toBe(false)
  expect(api.message).not.toHaveBeenCalled()
  expect(useBotWorkspaceStore.getState().messages[main][0]).toBe(root)
})

it("keeps older/newer affordances accurate after initial, directional and targeted reads shrink their page size", async () => {
  const state = useBotWorkspaceStore.getState()
  const id = "adaptive-history"
  const corpus = mainMessages(1, 120).map((message) => ({ ...message, conversationId: id }))
  useBotWorkspaceStore.setState({
    selected: null,
    snapshot: {
      ...state.snapshot!,
      conversations: [
        {
          ...state.snapshot!.conversations[0],
          id,
          readState: { ...readState, firstUnreadSequence: null, unreadCount: 0 }
        }
      ]
    }
  })
  api.messages.mockImplementation(async ({ before, after, limit }) => {
    if (limit > 25) throw new BotDomainError("response_too_large", "Too big")
    return after !== undefined
      ? corpus.filter((message) => message.sequence > after).slice(0, limit)
      : corpus.filter((message) => message.sequence < (before ?? Infinity)).slice(-limit)
  })
  state.select(id)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[id]).toBe(false))
  let current = useBotWorkspaceStore.getState()
  expect(current.messages[id]).toEqual(corpus.slice(95))
  expect(current.hasOlder[id]).toBe(true)
  await state.loadMessages(id, 96)
  current = useBotWorkspaceStore.getState()
  expect(current.messages[id]).toEqual(corpus.slice(70))
  expect(current.hasOlder[id]).toBe(true)
  useBotWorkspaceStore.setState({
    messages: { [id]: corpus.slice(0, 25) },
    hasNewer: { [id]: true }
  })
  await state.loadNewer(id)
  expect(useBotWorkspaceStore.getState().messages[id]).toEqual(corpus.slice(0, 50))
  expect(useBotWorkspaceStore.getState().hasNewer[id]).toBe(true)
  api.message.mockResolvedValue(corpus[59])
  await state.jumpToMessage(id, corpus[59].id)
  current = useBotWorkspaceStore.getState()
  expect(current.messages[id]).toEqual(corpus.slice(34, 85))
  expect(current.hasOlder[id]).toBe(true)
  expect(current.hasNewer[id]).toBe(true)
})

it("does not notify subscribers repeatedly for the same visible history anchor", () => {
  const state = useBotWorkspaceStore.getState()
  const changed = vi.fn()
  const unsubscribe = useBotWorkspaceStore.subscribe(changed)
  try {
    state.setHistoryFollowTail(main, false, root.id)
    state.setHistoryFollowTail(main, false, root.id)
    state.setHistoryFollowTail(main, false, root.id)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(useBotWorkspaceStore.getState().historyAnchorIds[main]).toBe(root.id)
    state.setHistoryFollowTail(main, true)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(useBotWorkspaceStore.getState().historyAnchorIds[main]).toBeUndefined()
  } finally {
    unsubscribe()
  }
})

it.each(["reaction", "refresh"])(
  "enforces the final byte budget after %s metadata grows while keeping the visible anchor",
  async (source) => {
    const state = useBotWorkspaceStore.getState()
    const rows = mainMessages(1, 3)
    const overhead = rows.reduce(
      (bytes, message) => bytes + estimateBotMessageBytes(message) - message.text.length * 2,
      0
    )
    const body = "x".repeat(Math.floor((BOT_MESSAGE_RESIDENT_BYTES - overhead - 128) / 6))
    const large = rows.map((message) => ({ ...message, text: body }))
    useBotWorkspaceStore.setState({
      messages: { [main]: large },
      hasOlder: { [main]: false },
      hasNewer: { [main]: true }
    })
    state.setHistoryFollowTail(main, false, large[1].id)
    if (source === "reaction") {
      state.updateReactions(main, [
        {
          messageId: large[1].id,
          revision: 1,
          reactions: Array.from({ length: 10 }, (_, index) => ({
            emoji: "👍",
            by: `user-${index}`
          }))
        }
      ])
    } else {
      api.threadSummaries.mockResolvedValue([
        { rootId: large[1].id, count: 1, readState: { ...readState, revision: 1 } }
      ])
      api.snapshot.mockResolvedValue({ ...state.snapshot!, cursor: 200002 })
      await state.refresh()
    }
    const current = useBotWorkspaceStore.getState()
    expect(current.messages[main].some((message) => message.id === large[1].id)).toBe(true)
    expect(current.messages[main]).toHaveLength(2)
    expect(
      current.messages[main].reduce((bytes, message) => bytes + estimateBotMessageBytes(message), 0)
    ).toBeLessThanOrEqual(BOT_MESSAGE_RESIDENT_BYTES)
    expect(current.hasNewer[main]).toBe(true)
    expect(current.historyAnchorIds[main]).toBe(large[1].id)
  }
)

function installViewportCorpus(id = main, threadRootId?: string) {
  const corpus = mainMessages(1, 600).map((message) => ({
    ...message,
    conversationId: id,
    ...(threadRootId ? { threadRootId } : {})
  }))
  api.message.mockImplementation(async ({ id: messageId }) => {
    const target = corpus.find((message) => message.id === messageId)
    if (!target) throw new BotDomainError("reply_unavailable", "Missing message")
    return target
  })
  api.messages.mockImplementation(async ({ before, after, limit }) =>
    after !== undefined
      ? corpus.filter((message) => message.sequence > after).slice(0, limit)
      : corpus.filter((message) => message.sequence < (before ?? Infinity)).slice(-limit)
  )
  return corpus
}

async function openViewport(id: string) {
  const state = useBotWorkspaceStore.getState()
  if (state.selected === id) useBotWorkspaceStore.setState({ selected: null })
  state.select(id)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[id]).toBe(false))
  return useBotWorkspaceStore.getState().viewportLease!
}

it("restores an evicted Bot's old continuous window directly, preserving its visible offset and draft", async () => {
  const corpus = installViewportCorpus()
  const lease = await openViewport(main)
  const state = useBotWorkspaceStore.getState()
  state.draft(main, "Unsent explanation")
  const position = { messageId: corpus[60].id, offset: -17.5, followTail: false }
  expect(state.saveViewportPosition(main, position, lease)).toBe(true)
  await openViewport("another")
  expect(useBotWorkspaceStore.getState().messages[main]).toBeUndefined()
  api.messages.mockClear()
  const reopened = await openViewport(main)
  const current = useBotWorkspaceStore.getState()
  expect(current.messages[main]).toEqual(corpus.slice(10, 111))
  expect(api.messages.mock.calls.map(([input]) => input)).toEqual([
    { conversationId: main, before: 61, limit: 50 },
    { conversationId: main, after: 61, limit: 50 }
  ])
  expect(current.viewportRestore).toEqual(position)
  expect(current.historyFollowTail[main]).toBe(false)
  expect(current.historyAnchorIds[main]).toBe(corpus[60].id)
  expect(current.hasOlder[main]).toBe(true)
  expect(current.hasNewer[main]).toBe(true)
  expect(current.drafts[main].prompt).toBe("Unsent explanation")
  expect(current.saveViewportPosition(main, { ...position, offset: 9 }, lease)).toBe(false)
  expect(current.saveViewportPosition(main, { ...position, offset: 9 }, reopened)).toBe(false)
  current.clearViewportRestore(main, lease)
  expect(useBotWorkspaceStore.getState().viewportRestore).toEqual(position)
  current.clearViewportRestore(main, reopened)
  expect(current.saveViewportPosition(main, { ...position, offset: 9 }, reopened)).toBe(true)
  expect(
    current.saveViewportPosition(main, { ...position, messageId: "not-resident" }, reopened)
  ).toBe(false)
})

it("resumes a previously following Bot at the latest page instead of its ordinary unread marker", async () => {
  const corpus = installViewportCorpus()
  const lease = await openViewport(main)
  const state = useBotWorkspaceStore.getState()
  expect(
    state.saveViewportPosition(main, { messageId: null, offset: 0, followTail: true }, lease)
  ).toBe(true)
  await openViewport("another")
  api.messages.mockClear()
  await openViewport(main)
  const current = useBotWorkspaceStore.getState()
  expect(api.messages).toHaveBeenCalledExactlyOnceWith({ conversationId: main, limit: 100 })
  expect(current.messages[main]).toEqual(corpus.slice(-100))
  expect(current.viewportRestore).toEqual({ messageId: null, offset: 0, followTail: true })
  expect(current.unreadAnchors[main]).toBe(readState.firstUnreadSequence)
})

it("keeps a read branch's null unread marker separate from its parent's unread state", async () => {
  const corpus = installViewportCorpus(main, rootId)
  api.thread.mockResolvedValue({
    ...threadValue,
    readState: { ...readState, firstUnreadSequence: null, unreadCount: 0 }
  })
  await openViewport(view)
  expect(api.messages).toHaveBeenCalledExactlyOnceWith({
    conversationId: main,
    threadRootId: rootId,
    limit: 100
  })
  expect(useBotWorkspaceStore.getState().messages[view]).toEqual(corpus.slice(-100))
  expect(useBotWorkspaceStore.getState().unreadAnchors[view]).toBeNull()
})

it.each([main, view])(
  "prioritizes an explicitly unread reminder over saved reading position for %s",
  async (id) => {
    const corpus = installViewportCorpus(main, id === view ? rootId : undefined)
    const saved = botViewportPositionCache.open(id)
    botViewportPositionCache.save(saved.lease, {
      messageId: corpus[200].id,
      offset: 12,
      followTail: false
    })
    const unread = { ...readState, manuallyUnread: true, firstUnreadSequence: 350 }
    if (id === view) api.thread.mockResolvedValue({ ...threadValue, readState: unread })
    else
      useBotWorkspaceStore.setState({
        snapshot: {
          ...useBotWorkspaceStore.getState().snapshot!,
          conversations: [
            { ...useBotWorkspaceStore.getState().snapshot!.conversations[0], readState: unread }
          ]
        }
      })
    api.messages.mockClear()
    await openViewport(id)
    expect(api.message).not.toHaveBeenCalled()
    expect(api.messages.mock.calls.map(([input]) => input)).toEqual([
      {
        conversationId: main,
        ...(id === view ? { threadRootId: rootId } : {}),
        after: 349,
        limit: 100
      },
      {
        conversationId: main,
        ...(id === view ? { threadRootId: rootId } : {}),
        before: 350,
        limit: 1
      }
    ])
    expect(useBotWorkspaceStore.getState().viewportRestore).toBeNull()
    expect(useBotWorkspaceStore.getState().messages[id][0].sequence).toBe(350)
  }
)

it.each(["missing", "moved"])(
  "discards a %s saved target and uses normal unread positioning with a fresh lease",
  async (reason) => {
    installViewportCorpus()
    const saved = botViewportPositionCache.open(main)
    botViewportPositionCache.save(saved.lease, { messageId: "lost", offset: 15, followTail: false })
    if (reason === "moved") api.message.mockResolvedValue(child)
    const lease = await openViewport(main)
    const current = useBotWorkspaceStore.getState()
    expect(api.messages.mock.calls.map(([input]) => input)).toEqual([
      { conversationId: main, after: 1, limit: 100 },
      { conversationId: main, before: 2, limit: 1 }
    ])
    expect(current.viewportRestore).toBeNull()
    expect(current.error).toBeNull()
    expect(botViewportPositionCache.isCurrent(saved.lease)).toBe(false)
    expect(botViewportPositionCache.isCurrent(lease)).toBe(true)
    expect(botViewportPositionCache.open(main).position).toBeNull()
  }
)

it.each([new Error("network disconnected"), new BotDomainError("forbidden", "Permission denied")])(
  "reports a failed saved-target read without fetching an unrelated latest page (%s)",
  async (error) => {
    const saved = botViewportPositionCache.open(main)
    botViewportPositionCache.save(saved.lease, {
      messageId: root.id,
      offset: 15,
      followTail: false
    })
    api.message.mockRejectedValue(error)
    await openViewport(main)
    expect(api.messages).not.toHaveBeenCalled()
    expect(useBotWorkspaceStore.getState().messages[main]).toEqual([])
    expect(useBotWorkspaceStore.getState().error).toBeNull()
    expect(useBotWorkspaceStore.getState().transcriptError).toEqual({
      viewId: main,
      code: error instanceof BotDomainError ? error.code : null,
      ...(error instanceof BotDomainError ? { diagnostic: { code: error.code } } : {}),
      message: error.message
    })
  }
)

it("preserves exact diagnostics and target identity for a failed saved history read", async () => {
  const saved = botViewportPositionCache.open(main)
  botViewportPositionCache.save(saved.lease, {
    messageId: root.id,
    offset: 15,
    followTail: false
  })
  const diagnostic = {
    code: "history_unavailable",
    status: 503,
    requestId: "provider-history-request",
    correlationId: "transport-read-42",
    callId: "model-call-17"
  }
  api.message.mockRejectedValue(
    new BotDomainError("history_unavailable", "History unavailable", diagnostic)
  )
  await openViewport(main)
  expect(api.messages).not.toHaveBeenCalled()
  expect(useBotWorkspaceStore.getState().transcriptError).toEqual({
    viewId: main,
    code: "history_unavailable",
    message: "History unavailable",
    diagnostic
  })
  await useBotWorkspaceStore.getState().refresh()
  expect(useBotWorkspaceStore.getState().transcriptError?.diagnostic).toEqual(diagnostic)
  expect(api.message).toHaveBeenCalledExactlyOnceWith({ conversationId: main, id: root.id })
})

it("keeps a denied saved page visible through snapshot polling and retries its original position only on request", async () => {
  const corpus = installViewportCorpus()
  const readTarget = api.message.getMockImplementation()!
  const saved = botViewportPositionCache.open(main)
  const position = { messageId: corpus[60].id, offset: -17.5, followTail: false }
  botViewportPositionCache.save(saved.lease, position)
  const state = useBotWorkspaceStore.getState()
  state.draft(main, "Still composing during failed history restore")
  api.message.mockRejectedValue(new BotDomainError("forbidden", "Permission denied"))
  const failedLease = await openViewport(main)
  const failure = useBotWorkspaceStore.getState().transcriptError
  const snapshot = state.snapshot!
  const interaction = {
    id: "new-approval",
    runId: "active-run",
    kind: "approval",
    prompt: "Review the running task",
    actionHash: "action-hash",
    status: "pending",
    answer: null,
    revision: 1,
    expiresAt: 900000,
    createdAt: 2
  }
  for (let cursor = snapshot.cursor + 1; cursor <= snapshot.cursor + 3; cursor++) {
    api.snapshot.mockResolvedValue({ ...snapshot, cursor, interactions: [interaction] })
    await state.refresh()
    expect(useBotWorkspaceStore.getState().snapshot?.cursor).toBe(cursor)
    expect(useBotWorkspaceStore.getState().snapshot?.interactions).toEqual([interaction])
    expect(useBotWorkspaceStore.getState().transcriptError).toBe(failure)
    expect(useBotWorkspaceStore.getState().viewportRestore).toEqual(position)
    expect(useBotWorkspaceStore.getState().messages[main]).toEqual([])
  }
  expect(api.message).toHaveBeenCalledExactlyOnceWith({
    conversationId: main,
    id: corpus[60].id
  })
  expect(api.messages).not.toHaveBeenCalled()
  expect(api.threadSummaries).not.toHaveBeenCalled()
  expect(useBotWorkspaceStore.getState().error).toBeNull()
  api.message.mockImplementation(readTarget)
  state.retryMessages("another")
  expect(useBotWorkspaceStore.getState().transcriptError).toBe(failure)
  state.retryMessages(main)
  const retriedLease = useBotWorkspaceStore.getState().viewportLease!
  expect(retriedLease.generation).not.toBe(failedLease.generation)
  expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
  expect(useBotWorkspaceStore.getState().opening[main]).toBe(true)
  state.clearViewportRestore(main, failedLease)
  expect(useBotWorkspaceStore.getState().viewportRestore).toEqual(position)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[main]).toBe(false))
  const current = useBotWorkspaceStore.getState()
  expect(current.messages[main]).toEqual(corpus.slice(10, 111))
  expect(current.viewportRestore).toEqual(position)
  expect(current.drafts[main].prompt).toBe("Still composing during failed history restore")
  expect(current.saveViewportPosition(main, position, failedLease)).toBe(false)
  expect(api.messages.mock.calls.map(([input]) => input)).toEqual([
    { conversationId: main, before: 61, limit: 50 },
    { conversationId: main, after: 61, limit: 50 }
  ])
})

it("retries an ordinary first-page failure without losing a draft or mislabeling the Host connection", async () => {
  const state = useBotWorkspaceStore.getState()
  state.draft(main, "Unsent draft")
  api.messages.mockRejectedValueOnce(new Error("History is unavailable"))
  const failedLease = await openViewport(main)
  expect(useBotWorkspaceStore.getState().transcriptError).toEqual({
    viewId: main,
    code: null,
    message: "History is unavailable"
  })
  expect(useBotWorkspaceStore.getState().error).toBeNull()
  await state.refresh()
  expect(api.messages).toHaveBeenCalledTimes(2)
  state.retryMessages(main)
  state.retryMessages(main)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[main]).toBe(false))
  expect(api.messages).toHaveBeenCalledTimes(4)
  expect(useBotWorkspaceStore.getState().messages[main]).toEqual([root])
  expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
  expect(useBotWorkspaceStore.getState().drafts[main].prompt).toBe("Unsent draft")
  expect(botViewportPositionCache.isCurrent(failedLease)).toBe(false)
})

it("publishes a live snapshot even when its selected background history page fails", async () => {
  const state = useBotWorkspaceStore.getState()
  api.snapshot.mockResolvedValue({ ...state.snapshot!, cursor: state.snapshot!.cursor + 1 })
  api.messages.mockRejectedValue(new BotDomainError("forbidden", "History access denied"))
  await expect(state.refresh()).resolves.toBeUndefined()
  expect(useBotWorkspaceStore.getState().snapshot?.cursor).toBe(state.snapshot!.cursor + 1)
  expect(useBotWorkspaceStore.getState().messages[main]).toEqual([root])
  expect(useBotWorkspaceStore.getState().transcriptError).toEqual({
    viewId: main,
    code: "forbidden",
    diagnostic: { code: "forbidden" },
    message: "History access denied"
  })
  expect(useBotWorkspaceStore.getState().error).toBeNull()
  await state.refresh()
  expect(api.messages).toHaveBeenCalledTimes(1)
})

it("preserves an explicit failed jump identity for retry instead of reading a cached anchor or latest page", async () => {
  const corpus = installViewportCorpus("another")
  const readTarget = api.message.getMockImplementation()!
  const saved = botViewportPositionCache.open("another")
  botViewportPositionCache.save(saved.lease, {
    messageId: corpus[400].id,
    offset: 20,
    followTail: false
  })
  const state = useBotWorkspaceStore.getState()
  state.draft("another", "Draft in destination Bot")
  api.message.mockRejectedValue(new BotDomainError("forbidden", "Jump is unavailable"))
  await expect(state.jumpToMessage("another", corpus[60].id)).rejects.toThrow("Jump is unavailable")
  const failedLease = useBotWorkspaceStore.getState().viewportLease!
  expect(useBotWorkspaceStore.getState().transcriptError).toEqual({
    viewId: "another",
    code: "forbidden",
    diagnostic: { code: "forbidden" },
    message: "Jump is unavailable",
    targetId: corpus[60].id
  })
  api.snapshot.mockResolvedValue({
    ...state.snapshot!,
    cursor: state.snapshot!.cursor + 1,
    conversations: [{ ...state.snapshot!.conversations[0], id: "another" }]
  })
  await state.refresh()
  expect(api.message).toHaveBeenCalledTimes(1)
  expect(api.messages).not.toHaveBeenCalled()
  api.message.mockImplementation(readTarget)
  state.retryMessages("another")
  expect(useBotWorkspaceStore.getState().viewportLease?.generation).not.toBe(failedLease.generation)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening.another).toBe(false))
  expect(api.message.mock.calls.map(([input]) => input.id)).toEqual([corpus[60].id, corpus[60].id])
  expect(api.messages.mock.calls.map(([input]) => input)).toEqual([
    { conversationId: "another", before: 61, limit: 50 },
    { conversationId: "another", after: 61, limit: 50 }
  ])
  expect(useBotWorkspaceStore.getState().messages.another).toEqual(corpus.slice(10, 111))
  expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
  expect(useBotWorkspaceStore.getState().drafts.another.prompt).toBe("Draft in destination Bot")
})

it("clears selected-only errors when leaving and rejects a previous view's late failed callback", async () => {
  const saved = botViewportPositionCache.open(main)
  const position = { messageId: root.id, offset: 15, followTail: false }
  botViewportPositionCache.save(saved.lease, position)
  api.message.mockRejectedValueOnce(new Error("Old failed read"))
  await openViewport(main)
  expect(useBotWorkspaceStore.getState().transcriptError?.viewId).toBe(main)
  await openViewport("another")
  expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
  let reject!: (error: Error) => void
  api.message.mockImplementationOnce(
    () =>
      new Promise<BotMessage>((_resolve, fail) => {
        reject = fail
      })
  )
  useBotWorkspaceStore.getState().select(main)
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"))
  await openViewport("another")
  reject(new Error("Stale failure"))
  await Promise.resolve()
  await Promise.resolve()
  expect(useBotWorkspaceStore.getState().selected).toBe("another")
  expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
  expect(botViewportPositionCache.open(main).position).toEqual(position)
})

it.each(["older", "newer"] as const)(
  "retries a failed %s page without replacing the current window or reading the latest page",
  async (direction) => {
    const corpus = installViewportCorpus()
    const readPage = api.messages.getMockImplementation()!
    const lease = await openViewport(main)
    const state = useBotWorkspaceStore.getState()
    const resident = corpus.slice(100, 200)
    const position = { messageId: corpus[150].id, offset: -19, followTail: false }
    useBotWorkspaceStore.setState({
      messages: { [main]: resident },
      hasOlder: { [main]: true },
      hasNewer: { [main]: true },
      historyFollowTail: { [main]: false },
      historyAnchorIds: { [main]: position.messageId }
    })
    expect(state.saveViewportPosition(main, position, lease)).toBe(true)
    state.draft(main, "Draft beside paged history")
    api.messages.mockClear().mockRejectedValue(new BotDomainError("forbidden", "Page denied"))
    const read = () =>
      direction === "older" ? state.loadMessages(main, resident[0].sequence) : state.loadNewer(main)
    await expect(read()).rejects.toThrow("Page denied")
    const failure = useBotWorkspaceStore.getState().transcriptError
    expect(failure).toEqual({
      viewId: main,
      code: "forbidden",
      diagnostic: { code: "forbidden" },
      message: "Page denied",
      page: direction
    })
    expect(useBotWorkspaceStore.getState().messages[main]).toBe(resident)
    await state.refresh()
    expect(api.messages).toHaveBeenCalledTimes(1)
    expect(useBotWorkspaceStore.getState().transcriptError).toBe(failure)
    api.messages.mockImplementation(readPage)
    state.retryMessages(main)
    const retriedLease = useBotWorkspaceStore.getState().viewportLease!
    expect(retriedLease.generation).not.toBe(lease.generation)
    expect(useBotWorkspaceStore.getState().messages[main]).toBe(resident)
    await vi.waitFor(() =>
      expect(
        direction === "older"
          ? useBotWorkspaceStore.getState().loadingOlder[main]
          : useBotWorkspaceStore.getState().loadingNewer[main]
      ).toBe(false)
    )
    const expectedPage = {
      conversationId: main,
      ...(direction === "older" ? { before: 101 } : { after: 200 }),
      limit: 100
    }
    expect(api.messages.mock.calls.map(([input]) => input)).toEqual([expectedPage, expectedPage])
    expect(useBotWorkspaceStore.getState().messages[main]).toEqual(
      direction === "older" ? corpus.slice(0, 200) : corpus.slice(100, 300)
    )
    expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
    expect(useBotWorkspaceStore.getState().viewportRestore).toBeNull()
    expect(useBotWorkspaceStore.getState().historyAnchorIds[main]).toBe(position.messageId)
    expect(useBotWorkspaceStore.getState().historyFollowTail[main]).toBe(false)
    expect(useBotWorkspaceStore.getState().drafts[main].prompt).toBe("Draft beside paged history")
    expect(state.saveViewportPosition(main, position, retriedLease)).toBe(true)
  }
)

it("allows an explicitly requested latest page to replace a failed restored page and resume position saves", async () => {
  const corpus = installViewportCorpus()
  const saved = botViewportPositionCache.open(main)
  botViewportPositionCache.save(saved.lease, {
    messageId: corpus[60].id,
    offset: -12,
    followTail: false
  })
  api.message.mockRejectedValue(new BotDomainError("forbidden", "Saved target denied"))
  const lease = await openViewport(main)
  const state = useBotWorkspaceStore.getState()
  state.draft(main, "Keep this unsent draft")
  await state.loadMessages(main)
  expect(api.messages).toHaveBeenCalledExactlyOnceWith({ conversationId: main, limit: 100 })
  expect(useBotWorkspaceStore.getState().messages[main]).toEqual(corpus.slice(-100))
  expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
  expect(useBotWorkspaceStore.getState().viewportRestore).toBeNull()
  expect(useBotWorkspaceStore.getState().historyFollowTail[main]).toBe(true)
  expect(useBotWorkspaceStore.getState().historyAnchorIds[main]).toBeUndefined()
  expect(useBotWorkspaceStore.getState().drafts[main].prompt).toBe("Keep this unsent draft")
  expect(
    state.saveViewportPosition(main, { messageId: null, offset: 0, followTail: true }, lease)
  ).toBe(true)
})

it("retries an explicit latest-page failure as latest and leaves a previously saved old anchor canceled", async () => {
  const corpus = installViewportCorpus()
  const readPage = api.messages.getMockImplementation()!
  const lease = await openViewport(main)
  const state = useBotWorkspaceStore.getState()
  state.saveViewportPosition(
    main,
    { messageId: corpus[60].id, offset: 12, followTail: false },
    lease
  )
  api.messages.mockClear().mockRejectedValue(new Error("Latest page unavailable"))
  await expect(state.loadMessages(main)).rejects.toThrow("Latest page unavailable")
  expect(useBotWorkspaceStore.getState().transcriptError?.page).toBe("latest")
  const resident = useBotWorkspaceStore.getState().messages[main]
  await state.refresh()
  expect(api.messages).toHaveBeenCalledTimes(1)
  api.messages.mockImplementation(readPage)
  state.retryMessages(main)
  expect(useBotWorkspaceStore.getState().messages[main]).toBe(resident)
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[main]).toBe(false))
  expect(api.messages.mock.calls.map(([input]) => input)).toEqual([
    { conversationId: main, limit: 100 },
    { conversationId: main, limit: 100 }
  ])
  expect(api.message).not.toHaveBeenCalled()
  expect(useBotWorkspaceStore.getState().messages[main]).toEqual(corpus.slice(-100))
  expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
  expect(useBotWorkspaceStore.getState().historyFollowTail[main]).toBe(true)
})

it("clears a failed restored transcript after a successful send and reads the new tail once", async () => {
  const corpus = installViewportCorpus()
  const saved = botViewportPositionCache.open(main)
  botViewportPositionCache.save(saved.lease, {
    messageId: corpus[60].id,
    offset: -12,
    followTail: false
  })
  api.message.mockRejectedValue(new Error("Old target unavailable"))
  const lease = await openViewport(main)
  const state = useBotWorkspaceStore.getState()
  state.draft(main, "New request")
  api.send.mockResolvedValue({ messageId: "new-sent", runIds: [] })
  corpus.push({ ...root, id: "new-sent", text: "New request", sequence: 601 })
  await state.send(main)
  expect(api.messages).toHaveBeenCalledExactlyOnceWith({ conversationId: main, limit: 100 })
  expect(useBotWorkspaceStore.getState().messages[main]).toEqual(corpus.slice(-100))
  expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
  expect(useBotWorkspaceStore.getState().viewportRestore).toBeNull()
  expect(useBotWorkspaceStore.getState().historyFollowTail[main]).toBe(true)
  expect(useBotWorkspaceStore.getState().pending[main]).toBeUndefined()
  expect(
    state.saveViewportPosition(main, { messageId: null, offset: 0, followTail: true }, lease)
  ).toBe(true)
})

it("does not let a superseded jump failure overwrite a successful retry of the same selected view", async () => {
  const corpus = installViewportCorpus("another")
  const readTarget = api.message.getMockImplementation()!
  let rejectOld!: (error: Error) => void
  api.message.mockImplementationOnce(
    () =>
      new Promise<BotMessage>((_resolve, reject) => {
        rejectOld = reject
      })
  )
  const state = useBotWorkspaceStore.getState()
  const old = state.jumpToMessage("another", corpus[60].id).catch((error) => error)
  api.message.mockRejectedValueOnce(new Error("Current target temporarily denied"))
  await expect(state.jumpToMessage("another", corpus[80].id)).rejects.toThrow(
    "Current target temporarily denied"
  )
  api.message.mockImplementation(readTarget)
  state.retryMessages("another")
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening.another).toBe(false))
  const recovered = useBotWorkspaceStore.getState()
  expect(recovered.messages.another).toEqual(corpus.slice(30, 131))
  expect(recovered.transcriptError).toBeNull()
  rejectOld(new Error("Stale target denied"))
  await old
  expect(useBotWorkspaceStore.getState().messages.another).toBe(recovered.messages.another)
  expect(useBotWorkspaceStore.getState().viewportLease).toBe(recovered.viewportLease)
  expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
  expect(useBotWorkspaceStore.getState().opening.another).toBe(false)
})

it("returns no UI navigation receipt for a stale rejection while a newer target is still loading", async () => {
  const corpus = installViewportCorpus("another")
  await openViewport("another")
  let rejectOld!: (error: Error) => void
  let finishCurrent!: (message: BotMessage) => void
  api.message
    .mockImplementationOnce(
      () => new Promise<BotMessage>((_resolve, reject) => (rejectOld = reject))
    )
    .mockImplementationOnce(() => new Promise<BotMessage>((resolve) => (finishCurrent = resolve)))
  const state = useBotWorkspaceStore.getState()
  const old = state.jumpToMessage("another", corpus[60].id)
  const current = state.jumpToMessage("another", corpus[80].id)
  rejectOld(new Error("Old denied target"))
  expect(await old).toBeUndefined()
  expect(useBotWorkspaceStore.getState().opening.another).toBe(true)
  expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
  finishCurrent(corpus[80])
  const receipt = await current
  expect(receipt).toEqual({
    viewId: "another",
    lease: useBotWorkspaceStore.getState().viewportLease
  })
  expect(useBotWorkspaceStore.getState().messages.another).toContainEqual(corpus[80])
})

it("cancels a target read immediately and ignores its late page after a new navigation", async () => {
  const corpus = installViewportCorpus("another")
  await openViewport("another")
  const original = useBotWorkspaceStore.getState().messages.another
  let finishOld!: (message: BotMessage) => void
  api.message.mockImplementationOnce(
    () => new Promise<BotMessage>((resolve) => (finishOld = resolve))
  )
  const controller = new AbortController()
  const state = useBotWorkspaceStore.getState()
  const old = state.jumpToMessage("another", corpus[60].id, { signal: controller.signal })
  controller.abort()
  expect(useBotWorkspaceStore.getState().opening.another).toBe(false)
  expect(useBotWorkspaceStore.getState().messages.another).toBe(original)
  const receipt = await state.jumpToMessage("another", corpus[300].id)
  const current = useBotWorkspaceStore.getState()
  expect(receipt?.lease).toBe(current.viewportLease)
  finishOld(corpus[60])
  expect(await old).toBeUndefined()
  expect(useBotWorkspaceStore.getState().messages.another).toBe(current.messages.another)
  expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
})

it("returns the actual thread lease for a message navigation and retires it when leaving", async () => {
  const receipt = await useBotWorkspaceStore.getState().jumpToMessage(main, child.id)
  expect(receipt).toEqual({ viewId: view, lease: useBotWorkspaceStore.getState().viewportLease })
  expect(useBotWorkspaceStore.getState().selected).toBe(view)
  expect(botViewportPositionCache.isCurrent(receipt!.lease)).toBe(true)
  useBotWorkspaceStore.getState().select(main)
  expect(useBotWorkspaceStore.getState().viewportLease).not.toBe(receipt!.lease)
})

it("preserves a current thread-page failure through the main-conversation redirect", async () => {
  api.messages.mockRejectedValue(new Error("Current thread page denied"))
  await expect(useBotWorkspaceStore.getState().jumpToMessage(main, child.id)).rejects.toThrow(
    "Current thread page denied"
  )
  expect(useBotWorkspaceStore.getState().selected).toBe(view)
  expect(useBotWorkspaceStore.getState().transcriptError).toMatchObject({
    viewId: view,
    targetId: child.id,
    message: "Current thread page denied"
  })
})

it("does not surface a superseded thread failure through its parent navigation", async () => {
  let rejectChild!: (error: Error) => void
  api.message
    .mockResolvedValueOnce(child)
    .mockImplementationOnce(
      () => new Promise<BotMessage>((_resolve, reject) => (rejectChild = reject))
    )
  const navigation = useBotWorkspaceStore.getState().jumpToMessage(main, child.id)
  await vi.waitFor(() => expect(rejectChild).toBeTypeOf("function"))
  useBotWorkspaceStore.getState().select(main)
  rejectChild(new Error("Old thread denied"))
  expect(await navigation).toBeUndefined()
  expect(useBotWorkspaceStore.getState().selected).toBe(main)
  expect(useBotWorkspaceStore.getState().transcriptError).toBeNull()
})

it("retains the last actually read position when an uncommitted navigation is abandoned", async () => {
  const corpus = installViewportCorpus("another")
  await openViewport("another")
  const state = useBotWorkspaceStore.getState()
  expect(
    state.saveViewportPosition(
      "another",
      { messageId: corpus[540].id, offset: -12, followTail: false },
      state.viewportLease!
    )
  ).toBe(true)
  let rejectOld!: (error: Error) => void
  api.message.mockImplementationOnce(
    () => new Promise<BotMessage>((_resolve, reject) => (rejectOld = reject))
  )
  const navigation = state.jumpToMessage("another", corpus[60].id)
  await openViewport(main)
  rejectOld(new Error("Abandoned target denied"))
  expect(await navigation).toBeUndefined()
  await openViewport("another")
  expect(useBotWorkspaceStore.getState().viewportRestore).toEqual({
    messageId: corpus[540].id,
    offset: -12,
    followTail: false
  })
  expect(useBotWorkspaceStore.getState().messages.another).toContainEqual(corpus[540])
  expect(useBotWorkspaceStore.getState().messages.another).not.toContainEqual(corpus[60])
})

it("rejects a stale saved-target response after leaving and reopening the same view", async () => {
  const corpus = installViewportCorpus()
  const saved = botViewportPositionCache.open(main)
  const position = { messageId: corpus[60].id, offset: 17, followTail: false }
  botViewportPositionCache.save(saved.lease, position)
  let finish!: (value: BotMessage) => void
  api.message.mockImplementationOnce(
    () =>
      new Promise<BotMessage>((done) => {
        finish = done
      })
  )
  useBotWorkspaceStore.setState({ selected: null })
  const state = useBotWorkspaceStore.getState()
  state.select(main)
  const oldLease = useBotWorkspaceStore.getState().viewportLease!
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
  await openViewport("another")
  await openViewport(main)
  const current = useBotWorkspaceStore.getState()
  const readCalls = api.messages.mock.calls.length
  finish(corpus[60])
  await Promise.resolve()
  await Promise.resolve()
  expect(api.messages.mock.calls.length).toBe(readCalls)
  expect(useBotWorkspaceStore.getState().messages[main]).toBe(current.messages[main])
  expect(current.saveViewportPosition(main, position, oldLease)).toBe(false)
  expect(useBotWorkspaceStore.getState().opening[main]).toBe(false)
})

it("keeps restored older/newer affordances when target pages shrink and still retains the target", async () => {
  const id = "restore-adaptive"
  const corpus = installViewportCorpus(id)
  const saved = botViewportPositionCache.open(id)
  botViewportPositionCache.save(saved.lease, {
    messageId: corpus[200].id,
    offset: -15,
    followTail: false
  })
  const read = api.messages.getMockImplementation()!
  api.messages.mockImplementation(async (input) => {
    if (input.limit > 25) throw new BotDomainError("response_too_large", "Too big")
    return read(input)
  })
  await openViewport(id)
  const current = useBotWorkspaceStore.getState()
  expect(current.messages[id]).toEqual(corpus.slice(175, 226))
  expect(current.hasOlder[id]).toBe(true)
  expect(current.hasNewer[id]).toBe(true)
  expect(current.viewportRestore?.messageId).toBe(corpus[200].id)
})

it("opens an explicit cross-view target without reading the latest page or a saved viewport first", async () => {
  const corpus = installViewportCorpus("another")
  const saved = botViewportPositionCache.open("another")
  botViewportPositionCache.save(saved.lease, {
    messageId: corpus[400].id,
    offset: 20,
    followTail: false
  })
  await useBotWorkspaceStore.getState().jumpToMessage("another", corpus[60].id)
  expect(api.message).toHaveBeenCalledExactlyOnceWith({
    conversationId: "another",
    id: corpus[60].id
  })
  expect(api.messages.mock.calls.map(([input]) => input)).toEqual([
    { conversationId: "another", before: 61, limit: 50 },
    { conversationId: "another", after: 61, limit: 50 }
  ])
  expect(useBotWorkspaceStore.getState().viewportRestore).toBeNull()
  expect(useBotWorkspaceStore.getState().messages.another).toEqual(corpus.slice(10, 111))
})

it("does not reassert a canceled viewport after a reply is chosen while the target read is pending", async () => {
  const corpus = installViewportCorpus()
  const saved = botViewportPositionCache.open(main)
  botViewportPositionCache.save(saved.lease, {
    messageId: corpus[60].id,
    offset: 20,
    followTail: false
  })
  let finish!: (value: BotMessage) => void
  api.message.mockImplementationOnce(
    () =>
      new Promise<BotMessage>((done) => {
        finish = done
      })
  )
  useBotWorkspaceStore.setState({ selected: null })
  const state = useBotWorkspaceStore.getState()
  state.select(main)
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
  state.reply(main, root.id)
  expect(useBotWorkspaceStore.getState().viewportRestore).toBeNull()
  finish(corpus[60])
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[main]).toBe(false))
  expect(useBotWorkspaceStore.getState().viewportRestore).toBeNull()
  expect(useBotWorkspaceStore.getState().drafts[main].replyToId).toBe(root.id)
})

it("prunes all deleted conversation branch positions and revokes their callbacks on refresh", async () => {
  const mainLease = botViewportPositionCache.open(main).lease
  const branchLease = botViewportPositionCache.open(view).lease
  const siblingLease = botViewportPositionCache.open(botThreadView(main, "other-root")).lease
  const remaining = botViewportPositionCache.open("remaining").lease
  for (const lease of [mainLease, branchLease, siblingLease, remaining])
    botViewportPositionCache.save(lease, { messageId: root.id, offset: 5, followTail: false })
  const state = useBotWorkspaceStore.getState()
  api.snapshot.mockResolvedValue({
    ...state.snapshot!,
    cursor: 300000,
    conversations: [{ ...state.snapshot!.conversations[0], id: "remaining" }]
  })
  await state.refresh()
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening.remaining).toBe(false))
  expect(botViewportPositionCache.isCurrent(mainLease)).toBe(false)
  expect(botViewportPositionCache.isCurrent(branchLease)).toBe(false)
  expect(botViewportPositionCache.isCurrent(siblingLease)).toBe(false)
  expect(botViewportPositionCache.size()).toBe(1)
})

it("clears lightweight viewport identity when a different workspace data epoch is restored", async () => {
  const lease = botViewportPositionCache.open("old-only-view").lease
  botViewportPositionCache.save(lease, {
    messageId: "old-only-message",
    offset: 5,
    followTail: false
  })
  const state = useBotWorkspaceStore.getState()
  api.snapshot.mockResolvedValue({
    ...state.snapshot!,
    cursor: 3,
    dataEpoch: "different-workspace"
  })
  api.status.mockResolvedValue({ ...state.host!, hostId: "different-workspace" })
  await state.refresh()
  await vi.waitFor(() => expect(useBotWorkspaceStore.getState().opening[main]).toBe(false))
  expect(botViewportPositionCache.isCurrent(lease)).toBe(false)
  expect(botViewportPositionCache.open("old-only-view").position).toBeNull()
  expect(useBotWorkspaceStore.getState().viewportRestore).toBeNull()
})
