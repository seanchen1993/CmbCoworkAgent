import { describe, expect, it, vi } from "vitest"
import { BotMemoryMaintainer, type BotMemoryBatch } from "./memory-maintainer"

const batch = (botId: string, conversation: string, editVersion = 1): BotMemoryBatch => ({
  botId,
  conversation,
  userText: conversation,
  editVersion,
  threadId: `thread-${botId}`,
  modelRef: null
})
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("Bot background memory batches", () => {
  it("serializes model calls across Bots, merges pending turns, and discards stale edit epochs", async () => {
    const received: BotMemoryBatch[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const maintainer = new BotMemoryMaintainer(async (incoming) => {
      received.push(incoming)
      if (received.length === 1) await gate
    })
    maintainer.enqueue(batch("a", "first"))
    await tick()
    maintainer.enqueue(batch("a", "second"))
    maintainer.enqueue(batch("a", "third"))
    maintainer.enqueue(batch("b", "stale"))
    maintainer.enqueue(batch("b", "after deletion", 2))
    expect(received).toHaveLength(1)
    release()
    await tick()
    expect(received.map((item) => item.conversation)).toEqual([
      "first",
      "second\n\nthird",
      "after deletion"
    ])
    expect(received.map((item) => item.userText)).toEqual([
      "first",
      "second\n\nthird",
      "after deletion"
    ])
    await maintainer.close()
  })
  it("bounds conversation size and aborts the active request without starting pending work", async () => {
    const received: BotMemoryBatch[] = [],
      signals: AbortSignal[] = []
    const maintainer = new BotMemoryMaintainer(async (incoming, signal) => {
      received.push(incoming)
      signals.push(signal)
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      )
    })
    maintainer.enqueue(batch("a", "x".repeat(40_000)))
    await tick()
    maintainer.enqueue(batch("b", "pending"))
    await maintainer.close()
    maintainer.enqueue(batch("c", "too late"))
    await tick()
    expect(received).toHaveLength(1)
    expect(received[0].conversation.length).toBeLessThanOrEqual(12_000)
    expect(received[0].userText.length).toBeLessThanOrEqual(12_000)
    expect(signals[0].aborted).toBe(true)
  })
  it("continues other Bots after an extraction failure", async () => {
    const onError = vi.fn(),
      received: string[] = []
    const maintainer = new BotMemoryMaintainer(async (incoming) => {
      received.push(incoming.botId)
      if (incoming.botId === "a") throw new Error("provider failed")
    }, onError)
    maintainer.enqueue(batch("a", "first"))
    maintainer.enqueue(batch("b", "second"))
    await tick()
    expect(received).toEqual(["a", "b"])
    expect(onError).toHaveBeenCalledTimes(1)
    await maintainer.close()
  })
})
