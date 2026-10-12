import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
const stores: BotStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
it("actual awaited Bot false result is not human memory evidence, while accepted user follow-up remains", async () => {
  let now = 1800000000000
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "User-owned" }),
    b = store.createBot({ nonce: "b", name: "Helper" })
  store.send({
    nonce: "goal",
    conversationId: a.conversationId,
    text: "Verify project facts"
  })
  const parent = store.claim("parent")!
  const sent = store.sendPeer(parent.lease, {
    nonce: "delegate",
    recipient: b.bot.id,
    text: "Verify details"
  })
  store.waitForPeer(parent.lease, sent.runIds[0])
  const child = store.claim("child")!
  const falsePeer = store.sendPeer(child.lease, {
    nonce: "reply",
    recipient: a.bot.id,
    text: "INCORRECT_BOT_FACT_PRIVATE",
    intent: "status"
  })
  expect(() => store.steering.interruptIfPending(parent.lease)).toThrow(/补充/)
  const human = store.send({
    nonce: "human-correction",
    conversationId: a.conversationId,
    steerRunId: parent.run.id,
    text: "REAL_USER_FACT_CONFIRMED"
  })
  const accepted = await store.steering.queue(parent.lease).take({
    threadId: parent.run.id,
    ownerRunToken: `${parent.lease.owner}:${parent.lease.fence}`,
    appliedIds: [],
    phase: "beforeModel"
  })
  expect(accepted.map((m) => m.id)).toEqual([falsePeer.messageId, human.messageId])
  store.finish(parent.lease, "succeeded", "Explicitly evaluated the supplied statements")
  now += 16000
  const snapshot = store.memory.prepare(a.bot.id)!
  expect(snapshot.evidence).toHaveLength(1)
  expect(snapshot.evidence[0].user).toContain(
    `[User follow-up ${human.messageId}] REAL_USER_FACT_CONFIRMED`
  )
  expect(snapshot.evidence[0].user).not.toContain("INCORRECT_BOT_FACT_PRIVATE")
  expect(snapshot.evidence[0].user).not.toContain(`[User follow-up ${falsePeer.messageId}]`)
})
