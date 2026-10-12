import { afterEach, expect, it } from "vitest"
import { BotStore } from "../../../main/bots/store"
import { assertBotPendingWorkCard } from "./bot-pending-work-card"
import type { BotPendingCard } from "../../../shared/bot-work-pages"
const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const bot = store.createBot({ nonce: "bot", name: "Owner" })
  store.send({ nonce: "task", conversationId: bot.conversationId, text: "Task" })
  const claim = store.claim("worker")!
  const item = store.requestInteraction(claim.lease, {
    kind: "approval",
    prompt: "Exact original diff\n" + "汉".repeat(20000),
    action: { kind: "write", path: "authorized/file.txt", sha256: "a".repeat(64) }
  })
  const owner = { hostId: "host", dataEpoch: store.dataEpoch() }
  const descriptor = store.workPages.pendingInteractions(
    { ...owner, scope: { kind: "conversation", conversationId: bot.conversationId } },
    "host"
  ).items[0]
  const card = store.workPages.pendingCard(
    {
      ...owner,
      ...descriptor.address,
      interactionId: descriptor.id,
      revision: descriptor.revision
    },
    "host"
  )
  return { store, item, owner, descriptor, card }
}
it("mounts the current original approval including complete diff/action hash, not a descriptor preview", () => {
  const f = fixture()
  expect(JSON.stringify(f.descriptor)).not.toContain("Exact original diff")
  const actual = assertBotPendingWorkCard(f.card, f.descriptor, f.owner)
  expect(actual.interaction.prompt).toBe(f.item.prompt)
  expect(actual.interaction.actionHash).toBe(f.item.actionHash)
  expect(actual.interaction.promptTruncated).not.toBe(true)
})
it("refuses changed Host/epoch/conversation/branch/Bot/fence/revision and fake truncated cards", () => {
  const f = fixture(),
    mutations: BotPendingCard[] = [
      { ...f.card, hostId: "other" },
      { ...f.card, dataEpoch: "restored" },
      { ...f.card, run: { ...f.card.run, conversationId: "other" } },
      { ...f.card, run: { ...f.card.run, threadRootId: "private" } },
      { ...f.card, run: { ...f.card.run, botId: "other" } },
      { ...f.card, run: { ...f.card.run, fence: f.card.run.fence + 1 } },
      { ...f.card, run: { ...f.card.run, revision: 0 } },
      {
        ...f.card,
        interaction: { ...f.card.interaction, revision: f.card.interaction.revision + 1 }
      },
      { ...f.card, interaction: { ...f.card.interaction, status: "answered" } },
      { ...f.card, interaction: { ...f.card.interaction, promptTruncated: true } }
    ]
  for (const card of mutations)
    expect(() => assertBotPendingWorkCard(card, f.descriptor, f.owner)).toThrow("已变化")
})
