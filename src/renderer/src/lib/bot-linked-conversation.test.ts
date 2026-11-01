import { afterEach, expect, it, vi } from "vitest"
import type { ComponentProps, ReactElement } from "react"
import type { BotSnapshot, BotClient } from "../../../shared/bots/contracts"
import type { BotWorkConversationResolution } from "../../../shared/bots/conversation"

const state = vi.hoisted(() => ({ snapshot: null as BotSnapshot | null }))
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useMemo: (factory: () => unknown) => factory()
}))
vi.mock("../components/bots/use-bots", () => ({ useBots: () => ({ snapshot: state.snapshot }) }))
vi.mock("./thread-context", () => ({ useThreadStateSummaries: () => ({}) }))
vi.mock("../components/bots/ConversationTaskControls", () => ({ returnToBotTask: vi.fn() }))
vi.mock("../components/bots/BotConversation", () => ({ BotConversation: () => null }))
import { LinkedBotConversation } from "../components/bots/LinkedBotConversation"
import { BotConversation } from "../components/bots/BotConversation"

afterEach(() => vi.unstubAllGlobals())

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
  const tree = LinkedBotConversation({ link })
  const wrapper = tree.props.children as ReactElement<{ children: ReactElement<ComponentProps<typeof BotConversation>> }>
  const props = wrapper.props.children.props
  expect(Boolean(props.collaborationPending)).toBe(mode !== "idle")
  expect(props.backgroundBusy).toBe(mode === "service")
  expect(props.tasks).toEqual([])
  // Existing stop routing remains limited to this work, not the Bot's other conversations.
  await props.client.stopConversation(link.bot.id)
  expect(stopConversation).toHaveBeenCalledExactlyOnceWith("owner", undefined, "work")
})
