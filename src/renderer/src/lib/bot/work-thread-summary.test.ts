import { readFileSync } from "node:fs"
import ts from "typescript"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Thread } from "../../types"
import type { BotClient } from "../../../../shared/bots/contracts"
import type { BotWorkItem } from "../../../../shared/bots/work"
import { botErrorMessage } from "../bot-error-message"
import { useAppStore } from "../store"

const fixture = vi.hoisted(() => ({
  threads: [] as Thread[], get: vi.fn(), add: vi.fn(), load: vi.fn(), select: vi.fn()
}))
vi.mock("../store", () => ({
  isThreadRetired: () => false,
  useAppStore: { getState: () => ({
    threads: fixture.threads, addThreadSummary: fixture.add,
    loadThreads: fixture.load, selectThread: fixture.select
  }) }
}))
import {
  ensureBotWorkThreadSummary,
  matchesBoundBotWorkThreadSummary,
  openBotWorkThreadChat,
  resolveBotWorkThreadForNavigation
} from "./work-thread-summary"

const thread = (id: string): Thread => ({
  thread_id: id, created_at: new Date(1), updated_at: new Date(2), status: "idle",
  metadata: { botWorkId: "work", botWorkModelRoutingMode: "default", model: "selected" },
  thread_values: { messages: ["not for directory"] }
})

beforeEach(() => {
  vi.clearAllMocks()
  fixture.threads = []
  fixture.get.mockResolvedValue(thread("older"))
  vi.stubGlobal("window", { api: { threads: { get: fixture.get } } })
})
afterEach(() => vi.unstubAllGlobals())

describe("Bot work outside the sidebar first page", () => {
  it("loads the exact work settings without loading all directory pages or keeping messages", async () => {
    fixture.threads = Array.from({ length: 128 }, (_, i) => thread(`newer-${i}`))
    await ensureBotWorkThreadSummary("older", () => true)
    expect(fixture.get).toHaveBeenCalledExactlyOnceWith("older")
    expect(fixture.add).toHaveBeenCalledExactlyOnceWith({ ...thread("older"), thread_values: {} })
  })

  it("uses an existing summary without another read", async () => {
    fixture.threads = [thread("older")]
    await ensureBotWorkThreadSummary("older", () => true)
    expect(fixture.get).not.toHaveBeenCalled()
    expect(fixture.add).not.toHaveBeenCalled()
  })

  it("refreshes an unbound cached row only with the original task's bound metadata", async () => {
    const work = { id: "work", botId: "bot", threadId: "older", conversation: {
      origin: "created", state: "bound", ref: {
        kind: "local_thread", threadId: "older", incarnation: { token: "incarnation", legacyCreatedAt: 1 }
      }
    } } as BotWorkItem
    const exact = { ...thread("older"), metadata: {
      ...thread("older").metadata, botHostId: "local", botLocalConversation: true, botId: "bot",
      botWorkOrigin: "created", botAudienceKey: "desktop"
    } }
    fixture.threads = [thread("older")]
    const matches = (row: Thread) => matchesBoundBotWorkThreadSummary(row, work)
    fixture.get.mockResolvedValueOnce({ ...exact, created_at: new Date(3) })
    await expect(ensureBotWorkThreadSummary("older", () => true, matches)).rejects.toThrow("原任务关联已变化")
    expect(fixture.add).not.toHaveBeenCalled()

    fixture.get.mockResolvedValueOnce(exact)
    await ensureBotWorkThreadSummary("older", () => true, matches)
    expect(fixture.add).toHaveBeenCalledExactlyOnceWith({ ...exact, thread_values: {} })
  })

  it("does not publish after navigating away or overwrite a concurrent refresh", async () => {
    await ensureBotWorkThreadSummary("older", () => false)
    expect(fixture.add).not.toHaveBeenCalled()
    fixture.get.mockImplementationOnce(async () => {
      fixture.threads = [{ ...thread("older"), metadata: { model: "new-choice" } }]
      return thread("older")
    })
    await ensureBotWorkThreadSummary("older", () => true)
    expect(fixture.add).not.toHaveBeenCalled()
  })

  it.each([null, thread("replacement")])("fails instead of rendering ordinary global controls for a missing work", async (row) => {
    fixture.get.mockResolvedValueOnce(row)
    await expect(ensureBotWorkThreadSummary("older", () => true)).rejects.toThrow("任务原会话不存在")
    expect(fixture.add).not.toHaveBeenCalled()
  })
})

const boundWork = {
  id: "work", botId: "bot", threadId: "older", audienceKey: "desktop",
  threadInitialized: true,
  conversation: {
    origin: "created", state: "bound", ref: {
      kind: "local_thread", threadId: "older", incarnation: { token: "original", legacyCreatedAt: 1 }
    }
  }
} as BotWorkItem
const queuedWork: BotWorkItem = {
  ...boundWork, conversation: undefined, threadInitialized: false,
  state: "active", executionState: "queued"
}
const boundThread = {
  ...thread("older"), metadata: {
    ...thread("older").metadata, botHostId: "local", botLocalConversation: true, botId: "bot",
    botWorkOrigin: "created", botAudienceKey: "desktop", cmb_thread_incarnation: "original"
  }
}

function navigationClient(work = boundWork, hostId = "local") {
  const open = vi.fn(async () => ({ threadId: work.threadId }))
  const expose = vi.fn(async () => work)
  return { open, expose, client: { hostId, open, conversations: { expose } } as unknown as BotClient }
}

describe("resolving the existing ordinary conversation for Bot work", () => {
  it("activates the original thread's chat tab before selecting that thread", async () => {
    const setActiveTab = vi.fn()
    const getThreadActions = vi.fn(() => ({ setActiveTab }))
    await openBotWorkThreadChat({ getThreadActions }, "older")
    expect(getThreadActions).toHaveBeenCalledExactlyOnceWith("older")
    expect(setActiveTab).toHaveBeenCalledExactlyOnceWith("agent")
    expect(fixture.select).toHaveBeenCalledExactlyOnceWith("older")
    expect(setActiveTab.mock.invocationCallOrder[0]).toBeLessThan(fixture.select.mock.invocationCallOrder[0])
  })

  it("exposes an unbound work through the Host and makes the original summary available", async () => {
    const { client, expose, open } = navigationClient()
    fixture.threads = [thread("older")]
    fixture.get.mockResolvedValueOnce(boundThread)
    await expect(resolveBotWorkThreadForNavigation(client, { ...boundWork, conversation: undefined }, () => true))
      .resolves.toBe("older")
    expect(open).not.toHaveBeenCalled()
    expect(expose).toHaveBeenCalledExactlyOnceWith("bot", "work")
    expect(fixture.load).toHaveBeenCalledOnce()
    expect(fixture.add).toHaveBeenCalledExactlyOnceWith({ ...boundThread, thread_values: {} })
  })

  it("initializes the original conversation of a new desktop work while its first turn is still queued", async () => {
    const { client, expose, open } = navigationClient()
    // The production expose IPC initializes a new native work before exposing it.
    expose.mockResolvedValueOnce({ ...boundWork, executionState: "queued" })
    fixture.get.mockResolvedValueOnce(boundThread)
    await expect(resolveBotWorkThreadForNavigation(client, queuedWork, () => true)).resolves.toBe(queuedWork.threadId)
    expect(open).not.toHaveBeenCalled()
    expect(expose).toHaveBeenCalledExactlyOnceWith(queuedWork.botId, queuedWork.id)
    expect(fixture.add).toHaveBeenCalledExactlyOnceWith({ ...boundThread, thread_values: {} })
  })

  it.each([
    { ...queuedWork, threadInitialized: true },
    { ...boundWork, threadInitialized: false }
  ])("does not initialize a missing conversation for initialized or already associated work", async (work) => {
    const { client, expose, open } = navigationClient()
    expose.mockRejectedValueOnce(new Error("原会话不存在"))
    await expect(resolveBotWorkThreadForNavigation(client, work, () => true)).rejects.toThrow("原会话不存在")
    expect(open).not.toHaveBeenCalled()
    expect(fixture.load).not.toHaveBeenCalled()
  })

  it.each([
    { cmb_thread_incarnation: "replacement" },
    { botId: "other-bot" },
    { remoteReadOnly: true }
  ])("rejects a changed or remote conversation row (%j)", async (metadata) => {
    const { client } = navigationClient()
    fixture.get.mockResolvedValueOnce({ ...boundThread, metadata: { ...boundThread.metadata, ...metadata } })
    await expect(resolveBotWorkThreadForNavigation(client, boundWork, () => true))
      .rejects.toThrow("原任务关联已变化")
    expect(fixture.add).not.toHaveBeenCalled()
  })

  it("rejects a different thread in the exposure receipt", async () => {
    const { client } = navigationClient({ ...boundWork, threadId: "different" })
    await expect(resolveBotWorkThreadForNavigation(client, boundWork, () => true))
      .rejects.toThrow("原会话身份已变化")
    expect(fixture.load).not.toHaveBeenCalled()
  })

  it("keeps the preview's original incarnation when the exposure receipt points to a replacement", async () => {
    const { client } = navigationClient({ ...boundWork, conversation: {
      state: "bound", origin: "created", ref: {
        kind: "local_thread", threadId: "older", incarnation: { token: "replacement", legacyCreatedAt: 1 }
      }
    } })
    fixture.get.mockResolvedValueOnce({
      ...boundThread, metadata: { ...boundThread.metadata, cmb_thread_incarnation: "replacement" }
    })
    await expect(resolveBotWorkThreadForNavigation(client, boundWork, () => true))
      .rejects.toThrow("原任务关联已变化")
    expect(fixture.add).not.toHaveBeenCalled()
  })

  it.each([
    { reason: "remote host", hostId: "remote", work: boundWork },
    { reason: "IM audience", hostId: "local", work: { ...boundWork, audienceKey: "im" } },
    { reason: "channel source", hostId: "local", work: { ...boundWork, source: {
      transport: "im" as const, bindingId: "binding", conversationId: "conversation",
      grantVersion: 1, audienceKey: "im", eventId: "event", messageId: "message", senderId: "sender"
    } } },
    { reason: "pending deletion", hostId: "local", work: { ...boundWork, deletionPending: true } },
    { reason: "committed deletion", hostId: "local", work: { ...boundWork, deletionCommitted: true } }
  ])("does not expose unavailable work ($reason)", async ({ hostId, work }) => {
    const { client, expose, open } = navigationClient(work, hostId)
    await expect(resolveBotWorkThreadForNavigation(client, {
      ...work, threadInitialized: false, conversation: undefined
    }, () => true)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
    expect(expose).not.toHaveBeenCalled()
  })

  it("discards exposure after the user closes or changes the preview", async () => {
    const { client, expose } = navigationClient()
    let current = true
    expose.mockImplementationOnce(async () => { current = false; return boundWork })
    await expect(resolveBotWorkThreadForNavigation(client, boundWork, () => current)).resolves.toBeNull()
    expect(fixture.load).not.toHaveBeenCalled()
  })
})

function startDetachedWorkNavigation() {
  const source = readFileSync(new URL("../../components/bots/BotsWorkspace.tsx", import.meta.url), "utf8")
  const start = source.indexOf("  useEffect(() => {\n    if (!loadedWork || loadedWork.source")
  const end = source.indexOf("\n  // Old saved navigation", start)
  if (start < 0 || end < 0) throw new Error("Detached work navigation effect not found")
  // Capture the actual effect and its asynchronous completion without mounting the workspace.
  const { outputText } = ts.transpileModule(source.slice(start, end).replace("void (async", "pending = (async"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  })
  const ref = { kind: "local_thread", threadId: "older", incarnation: { token: "original", legacyCreatedAt: 1 } } as const
  const work = { ...boundWork, conversation: { state: "detached", ref } }
  const updateView = vi.fn(), error = vi.fn()
  const activeWorkIdByBot = { [work.botId]: work.id }
  const navigation = { current: true }
  const scope = {
    loadedWork: work, selected: { id: work.botId },
    client: { hostId: "local", conversations: { expose: vi.fn(async () => work) } },
    useAppStore, resolveBotWorkThreadForNavigation, botErrorMessage, updateView,
    captureWorkNavigation: () => () => navigation.current,
    useBotViewStore: { getState: () => ({ hosts: { local: { activeWorkIdByBot } } }) },
    toast: { error }
  }
  const run = new Function(...Object.keys(scope), `
    let pending, dispose;
    const useEffect = effect => { dispose = effect(); };
    ${outputText}
    return { pending, dispose };
  `)
  const { pending, dispose } = run(...Object.values(scope)) as { pending: Promise<void>; dispose(): void }
  return { pending, dispose, updateView, error, navigation, activeWorkIdByBot, work }
}

describe("opening a detached work's original conversation", () => {
  const original = {
    ...thread("older"), metadata: { cmb_thread_incarnation: "original", memoryEnabled: true }
  }

  it("adds the exact original summary before opening a conversation beyond the first page", async () => {
    fixture.threads = Array.from({ length: 128 }, (_, index) => thread(`newer-${index}`))
    fixture.get.mockResolvedValueOnce(original)
    const { pending, updateView, error } = startDetachedWorkNavigation()
    await pending
    expect(fixture.get).toHaveBeenCalledExactlyOnceWith("older")
    expect(fixture.add).toHaveBeenCalledExactlyOnceWith({ ...original, thread_values: {} })
    expect(fixture.add.mock.invocationCallOrder[0]).toBeLessThan(updateView.mock.invocationCallOrder[0])
    expect(fixture.select).toHaveBeenCalledExactlyOnceWith("older")
    expect(error).not.toHaveBeenCalled()
  })

  it("keeps the current view when the same thread ID now has a different incarnation", async () => {
    fixture.get.mockResolvedValueOnce({ ...original, metadata: { cmb_thread_incarnation: "replacement" } })
    const { pending, updateView, error } = startDetachedWorkNavigation()
    await pending
    expect(fixture.add).not.toHaveBeenCalled()
    expect(fixture.select).not.toHaveBeenCalled()
    expect(updateView).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledExactlyOnceWith("原任务关联已变化，无法加载设置。")
  })

  it("discards the summary when the navigation has been superseded during the read", async () => {
    let finishRead!: (row: Thread) => void
    fixture.get.mockImplementationOnce(() => new Promise<Thread>(resolve => { finishRead = resolve }))
    const { pending, dispose, updateView, error } = startDetachedWorkNavigation()
    await vi.waitFor(() => expect(fixture.get).toHaveBeenCalledExactlyOnceWith("older"))
    dispose()
    finishRead(original)
    await pending
    expect(fixture.add).not.toHaveBeenCalled()
    expect(fixture.select).not.toHaveBeenCalled()
    expect(updateView).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it("clears the stale Bot task selection without taking over a newer route", async () => {
    let finishRead!: (row: Thread) => void
    fixture.get.mockImplementationOnce(() => new Promise<Thread>(resolve => { finishRead = resolve }))
    const { pending, navigation, work, updateView, error } = startDetachedWorkNavigation()
    await vi.waitFor(() => expect(fixture.get).toHaveBeenCalledExactlyOnceWith("older"))
    navigation.current = false
    finishRead(original)
    await pending
    expect(fixture.add).not.toHaveBeenCalled()
    expect(fixture.select).not.toHaveBeenCalled()
    expect(updateView).toHaveBeenCalledExactlyOnceWith({ activeWorkIdByBot: { [work.botId]: null } })
    expect(error).not.toHaveBeenCalled()
  })

  it("keeps a newer task selection when the detached work resolves", async () => {
    let finishRead!: (row: Thread) => void
    fixture.get.mockImplementationOnce(() => new Promise<Thread>(resolve => { finishRead = resolve }))
    const { pending, navigation, work, activeWorkIdByBot, updateView, error } = startDetachedWorkNavigation()
    await vi.waitFor(() => expect(fixture.get).toHaveBeenCalledExactlyOnceWith("older"))
    navigation.current = false
    activeWorkIdByBot[work.botId] = "new-selection"
    finishRead(original)
    await pending
    expect(fixture.select).not.toHaveBeenCalled()
    expect(updateView).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})
