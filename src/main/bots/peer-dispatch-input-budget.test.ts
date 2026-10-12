import { afterEach, expect, it } from "vitest"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { MessageContent } from "@langchain/core/messages"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { avatarImage } from "./image-fixtures"

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(count: number) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-peer-input-budget-")))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const files = new BotArtifacts(join(directory, "objects"), store)
  cleanup.push(() => files.close())
  const a = store.createBot({ nonce: "a", name: "Original" }),
    b = store.createBot({ nonce: "b", name: "Reply" })
  store.send({
    nonce: "goal",
    conversationId: a.conversationId,
    text: "Original user goal"
  })
  const parent = store.claim("parent")!,
    sent = store.sendPeer(parent.lease, {
      nonce: "request",
      recipient: b.bot.id,
      text: "Review"
    })
  store.waitForPeer(parent.lease, sent.runIds[0])
  const child = store.claim("child")!
  const image = await files.publish(
    {
      id: "chart",
      conversationId: b.conversationId,
      runId: child.run.id,
      name: "chart.png",
      mime: "image/png"
    },
    Buffer.from(await avatarImage(), "base64"),
    child.lease
  )
  const images = store.peerImageSources(child.lease, [{ artifact_id: image.id }])
  const deliveries = Array.from({ length: count }, (_, i) =>
    store.sendPeer(child.lease, {
      nonce: `update-${i}`,
      recipient: a.bot.id,
      intent: "status",
      text: `Update ${i}`,
      images
    })
  )
  expect(() => store.steering.interruptIfPending(parent.lease)).toThrow(/补充/)
  const input = {
    threadId: parent.run.id,
    ownerRunToken: `${parent.lease.owner}:${parent.lease.fence}`,
    appliedIds: [] as string[],
    phase: "beforeModel" as const
  }
  return { store, parent, deliveries, input }
}
// The decoder's output size is controlled here; the artifact, alias and durable
// input queue are real. Raster validation is covered by the real image parser
// exchange/HTTP graph tests rather than pretending these blocks are decoded pixels.
it("oversized first image input is rejected without accepting or discarding its durable message", async () => {
  const f = await fixture(1)
  const blocks: MessageContent = [
    { type: "image_url", image_url: { url: "x".repeat(6 * 1024 * 1024) } }
  ]
  const queue = f.store.steering.queue(f.parent.lease, async () => blocks)
  await expect(queue.take(f.input)).rejects.toMatchObject({
    code: "peer_image_context_limit"
  })
  expect(f.store.steering.acceptedMessageIds(f.parent.run.id)).toEqual([])
  expect(f.store.steering.hasPending(f.parent.run.id)).toBe(true)
  await expect(queue.take(f.input)).rejects.toMatchObject({
    code: "peer_image_context_limit"
  })
  expect(f.store.steering.acceptedMessageIds(f.parent.run.id)).toEqual([])
})
it("a bounded image batch preserves the next input and recovers stable IDs without reaccepting a different message", async () => {
  const f = await fixture(3)
  const blocks: MessageContent = [
    { type: "image_url", image_url: { url: "x".repeat(2 * 1024 * 1024) } }
  ]
  const queue = f.store.steering.queue(f.parent.lease, async () => blocks)
  const first = await queue.take(f.input)
  expect(first.map((message) => message.id)).toEqual(
    f.deliveries.slice(0, 2).map((delivery) => delivery.messageId)
  )
  expect(f.store.steering.acceptedMessageIds(f.parent.run.id)).toEqual(
    first.map((message) => message.id)
  )
  expect(f.store.steering.state(f.deliveries[2].messageId)?.state).toBe("pending")
  const replay = await queue.take(f.input)
  expect(replay.map((message) => message.id)).toEqual(first.map((message) => message.id))
  const last = await queue.take({
    ...f.input,
    appliedIds: first.map((message) => message.id!)
  })
  expect(last.map((message) => message.id)).toEqual([f.deliveries[2].messageId])
  expect(f.store.steering.acceptedMessageIds(f.parent.run.id)).toEqual(
    f.deliveries.map((delivery) => delivery.messageId)
  )
})
