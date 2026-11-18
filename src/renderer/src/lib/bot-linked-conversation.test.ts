import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ComponentProps, ReactElement } from "react"
import type { BotSnapshot, BotClient } from "../../../shared/bots/contracts"
import type { BotWorkConversationResolution } from "../../../shared/bots/conversation"

const state = vi.hoisted(() => ({
  snapshot: null as BotSnapshot | null,
  presentedWorkId: null as string | null,
  history: { historyLoading: false, historyConversationPresence: "nonempty" },
  route: { mainView: "thread", currentThreadId: "original", showCustomizeView: false },
  read: vi.fn()
}))
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: () => [
    state.presentedWorkId,
    (workId: string | null) => { state.presentedWorkId = workId }
  ]
}))
vi.mock("../components/bots/use-bots", () => ({ useBots: () => ({ snapshot: state.snapshot }) }))
vi.mock("../components/bots/use-bot-read-state", () => ({ useBotReadState: state.read }))
vi.mock("./store", () => ({ useAppStore: (select: (route: typeof state.route) => unknown) => select(state.route) }))
vi.mock("./thread-context", () => ({
  useThreadStateSummaries: () => ({}),
  useThreadStateSelector: (_id: string, select: (history: typeof state.history) => unknown) => select(state.history)
}))
vi.mock("../components/bots/ConversationTaskControls", () => ({ returnToBotMain: vi.fn(), returnToBotTask: vi.fn() }))
vi.mock("../components/bots/BotConversation", () => ({ BotConversation: () => null }))
import { LinkedBotConversation } from "../components/bots/LinkedBotConversation"
import { BotConversation } from "../components/bots/BotConversation"

beforeEach(() => {
  state.read.mockClear()
  state.snapshot = null
  state.presentedWorkId = null
  state.history = { historyLoading: false, historyConversationPresence: "nonempty" }
  state.route = { mainView: "thread", currentThreadId: "original", showCustomizeView: false }
})
afterEach(() => vi.unstubAllGlobals())

function renderLinked(link: BotWorkConversationResolution) {
  const tree = LinkedBotConversation({ link })
  const wrapper = tree.props.children as ReactElement<{ children: ReactElement<ComponentProps<typeof BotConversation>> }>
  return wrapper.props.children.props
}

// Actual linked presenter; the normal work has finished dispatch, only its peer remains active.
it.each(["peer", "service", "idle"] as const)("retains scoped controls for linked %s work", async (mode) => {
  const link = {
    bot: { id: "owner" },
    work: { id: "work", botId: "owner", threadId: "original", backgroundBusy: mode === "service" }
  } as BotWorkConversationResolution
  state.snapshot = {
    bots: [link.bot], schedules: [], tasks: [], backgroundThreads: [],
    collaborationThreads: mode === "idle" ? [] : [link.work.threadId]
  } as unknown as BotSnapshot
  const stopConversation = vi.fn()
  vi.stubGlobal("window", { api: { bots: { hostId: "local", stopConversation } as unknown as BotClient } })
  const props = renderLinked(link)
  expect(Boolean(props.collaborationPending)).toBe(mode !== "idle")
  expect(props.backgroundBusy).toBe(mode === "service")
  expect(props.tasks).toEqual([])
  // Existing stop routing remains limited to this work, not the Bot's other conversations.
  await props.client.stopConversation(link.bot.id)
  expect(stopConversation).toHaveBeenCalledExactlyOnceWith("owner", undefined, "work")
})

it("acknowledges only the current visible work's exact activity version", () => {
  const work = { id: "work", botId: "owner", threadId: "original" }
  const activity = { kind: "work" as const, id: work.id, version: 3, unread: true, updatedAt: 100, preview: "Result" }
  const link = { bot: { id: "owner" }, work: { ...work, activity } } as BotWorkConversationResolution
  const client = { hostId: "local" }
  vi.stubGlobal("window", { api: { bots: client } })
  const render = (current = link) => {
    renderLinked(current)
    return state.read.mock.lastCall
  }

  const { onReadyChange } = renderLinked(link)
  expect(state.read.mock.lastCall).toEqual([client, undefined])
  onReadyChange!(true)
  state.history.historyLoading = true
  expect(render()).toEqual([client, undefined])
  state.history.historyLoading = false
  state.history.historyConversationPresence = "unknown"
  expect(render()).toEqual([client, undefined])
  state.history.historyConversationPresence = "nonempty"
  expect(render()).toEqual([client, activity])

  const newer = { ...activity, version: 4 }
  const updated = { ...link, work: { ...link.work, activity: newer } }
  expect(render(updated)).toEqual([client, newer])
  state.route.showCustomizeView = true
  expect(render(updated)).toEqual([client, undefined])
  state.route.showCustomizeView = false
  state.route.currentThreadId = "another-thread"
  expect(render(updated)).toEqual([client, undefined])
  state.route.currentThreadId = work.threadId
  const different = { ...updated, work: {
    ...updated.work, id: "another-work", activity: { ...newer, id: "another-work" }
  } }
  expect(render(different)).toEqual([client, undefined])
  expect(render({
    ...updated, work: { ...updated.work, activity: { ...newer, id: "another-work" } }
  })).toEqual([client, undefined])
  expect(render({ ...updated, work: { ...updated.work, deletionPending: true } })).toEqual([client, undefined])
  expect(render(updated)).toEqual([client, newer])
  onReadyChange!(false)
  expect(render(updated)).toEqual([client, undefined])
})
