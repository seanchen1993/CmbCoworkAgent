import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { BotClient, BotSnapshot, BotTask } from "../../../shared/bots/contracts"
import type { BotWorkConversationResolution } from "../../../shared/bots/conversation"

const fixture = vi.hoisted(() => ({
  snapshot: null as BotSnapshot | null,
  summaries: {} as Record<
    string,
    { workflowRunning?: boolean; hasRunningCoordinatorWorker?: boolean }
  >,
  capture: vi.fn()
}))
vi.mock("@/components/bots/use-bots", () => ({
  useBots: () => ({ snapshot: fixture.snapshot })
}))
vi.mock("@/lib/thread-context", () => ({
  useThreadStateSummaries: () => fixture.summaries
}))
vi.mock("@/components/bots/ConversationTaskControls", () => ({ returnToBotTask: vi.fn() }))
vi.mock("@/components/bots/BotConversation", () => ({
  BotConversation: (props: unknown) => {
    fixture.capture(props)
    return null
  }
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))
import { LinkedBotConversation } from "../components/bots/LinkedBotConversation"

const link = {
  bot: { id: "bot-a" },
  work: { id: "work-a", botId: "bot-a", threadId: "work-thread-a" }
} as BotWorkConversationResolution

function render() {
  renderToStaticMarkup(createElement(LinkedBotConversation, { link }))
  return fixture.capture.mock.lastCall![0] as {
    backgroundBusy: boolean
    client: BotClient
    tasks: BotTask[]
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.snapshot = {
    bots: [],
    schedules: [],
    tasks: [],
    backgroundThreads: []
  } as unknown as BotSnapshot
  fixture.summaries = {}
  vi.stubGlobal("window", { api: { bots: { hostId: "local", stopConversation: vi.fn() } } })
})
afterEach(() => vi.unstubAllGlobals())

describe("linked Bot conversation background controls", () => {
  it.each(["workflowRunning", "hasRunningCoordinatorWorker"] as const)(
    "keeps controls for %s after the foreground settles, then returns to idle",
    (kind) => {
      const completed = {
        id: "launch",
        threadId: link.work.threadId,
        state: "completed"
      } as BotTask
      fixture.snapshot!.tasks = [
        completed,
        { id: "unrelated", threadId: "other-thread", state: "running" } as BotTask
      ]
      fixture.summaries = { [link.work.threadId]: { [kind]: true } }
      expect(render()).toEqual(
        expect.objectContaining({ backgroundBusy: true, tasks: [completed] })
      )
      fixture.summaries = { [link.work.threadId]: { [kind]: false }, other: { [kind]: true } }
      expect(render().backgroundBusy).toBe(false)
    }
  )

  it("preserves accepted command controls without a Runtime summary", () => {
    fixture.snapshot!.backgroundThreads = [link.work.threadId]
    expect(render().backgroundBusy).toBe(true)
    fixture.snapshot!.backgroundThreads = ["other-thread"]
    expect(render().backgroundBusy).toBe(false)
    fixture.snapshot = null
    expect(render().backgroundBusy).toBe(false)
  })

  it("keeps stop bound to the same work and rejects another owner", async () => {
    fixture.summaries = { [link.work.threadId]: { workflowRunning: true } }
    const { client } = render()
    await client.stopConversation(link.bot.id)
    expect(window.api.bots.stopConversation).toHaveBeenCalledWith(
      link.bot.id,
      undefined,
      link.work.id
    )
    expect(() => client.stopConversation("other-bot")).toThrow("工作会话目标不一致")
    expect(window.api.bots.stopConversation).toHaveBeenCalledOnce()
  })
})
