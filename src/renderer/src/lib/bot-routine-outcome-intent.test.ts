import { botThreadView, botViewAddress } from "./bot-thread-view"
import { expect, it } from "vitest"
import { routineOutcomeIntent } from "./bot-routine-outcome-intent"
import type { BotMessage, CoworkBot } from "../../../shared/bot-types"

const bot = { id: "bot", hidden: false, deletedAt: null } as CoworkBot
const message = {
  id: "message",
  sender: "system",
  runId: "run",
  botId: "bot",
  conversationId: "chat",
  threadRootId: "root",
  routineOutcome: {
    version: 1,
    operation: "create",
    id: "routine",
    botId: "bot",
    name: "日报",
    revision: 1,
    dataEpoch: "initial"
  }
} as BotMessage
const input = {
  message,
  conversation: { id: "chat", members: ["bot"] },
  threadRootId: "root",
  dataEpoch: "initial",
  bots: [bot],
  active: true,
  capabilities: ["routine-save-outcomes"]
}
it("routes a confirmed outcome only to the existing read-only Resources intent", () => {
  expect(routineOutcomeIntent(input)).toEqual({
    botId: "bot",
    intent: { id: "routine", dataEpoch: "initial", mode: "view" }
  })
})
it.each([
  { active: false },
  { dataEpoch: "restored" },
  { capabilities: [] },
  { threadRootId: undefined },
  { conversation: { id: "foreign", members: ["bot"] } },
  { conversation: { id: "chat", members: [] } },
  { bots: [] },
  { bots: [{ ...bot, hidden: true }] },
  { bots: [{ ...bot, deletedAt: 1 }] },
  { message: { ...message, botId: "other" } },
  { message: { ...message, sender: "bot" as const } },
  { message: { ...message, runId: null } },
  {
    message: {
      ...message,
      routineOutcome: { ...message.routineOutcome!, version: 2 }
    } as unknown as BotMessage
  }
])("rejects a stale, hidden, retired or unsupported live address: %j", (change) => {
  expect(routineOutcomeIntent({ ...input, ...change })).toBeNull()
})

it("uses the real selected thread view identity rather than a conversation-only address", () => {
  const selected = botThreadView("chat", "root")
  const address = botViewAddress(selected)
  expect(selected).toBe("chat/thread/root")
  expect(selected).not.toBe(input.conversation.id)
  expect(
    routineOutcomeIntent({
      ...input,
      threadRootId: address.threadRootId,
      conversation: { ...input.conversation, id: address.conversationId }
    })
  ).not.toBeNull()
  expect(
    routineOutcomeIntent({ ...input, threadRootId: botViewAddress("chat").threadRootId })
  ).toBeNull()
})
