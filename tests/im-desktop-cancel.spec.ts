import assert from "node:assert/strict"
import { ImConversationTurnQueue } from "../src/main/services/im/conversation-turn-queue"
import type { ImEventRecord, ImEventStore } from "../src/main/services/im/event-store"

async function main(): Promise<void> {
  const events = ["a", "b"].map((threadId) => ({
    eventId: threadId,
    conversationKey: "same-conversation",
    targetSnapshot: { threadId },
    state: "queued"
  })) as ImEventRecord[]
  const signals = new Map<string, AbortSignal>()
  const store = {
    listQueuedEvents: () => events.filter((event) => event.state === "queued"),
    getNextQueuedEventForThread: (threadId: string) =>
      events.find(
        (event) => event.targetSnapshot?.threadId === threadId && event.state === "queued"
      ),
    getEvent: (id: string) => events.find((event) => event.eventId === id)
  } as unknown as ImEventStore
  const queue = new ImConversationTurnQueue(async (event, signal) => {
    signals.set(event.eventId, signal)
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true })
    )
    event.state = "cancelled"
  }, store)
  try {
    const pending = queue.notify("same-conversation")
    assert.equal(signals.size, 2)
    assert.equal(queue.abortThreadFromDesktop("missing"), false)
    assert.equal(queue.abortThreadFromDesktop("a"), true)
    assert.equal(signals.get("a")?.aborted, true)
    assert.equal(signals.get("b")?.aborted, false, "another thread must keep running")
    assert.equal(queue.abortCurrentImEvent("same-conversation", undefined, "b"), true)
    await pending
    assert.equal(queue.hasActiveRuns(), false)
    assert.equal(queue.abortThreadFromDesktop("a"), false)
  } finally {
    await queue.stop()
  }
  console.log("PASS desktop and remote stop use the same thread-scoped cancellation")
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
