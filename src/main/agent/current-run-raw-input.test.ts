import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearCurrentRunMessageQueue,
  createCurrentRunMessageQueueMiddleware,
  deleteCurrentRunQueuedMessage,
  queueCurrentRunMessage,
  setCurrentRunInjectionNotifier,
  setCurrentRunMessageQueueOwner
} from "./current-run-message-queue"

const threadId = "raw-input-queue"
const runToken = "run-original"
type QueueHook = (
  state: { messages: BaseMessage[] },
  runtime: { configurable: { thread_id: string } }
) => Promise<unknown>

function inject(phase: "beforeModel" | "afterModel", onInjected: (raw?: string) => void) {
  const middleware = createCurrentRunMessageQueueMiddleware(runToken, onInjected) as unknown as {
    beforeModel: QueueHook | { hook: QueueHook }
    afterModel: { hook: QueueHook }
  }
  const hook = phase === "afterModel" ? middleware.afterModel.hook : middleware.beforeModel
  return (typeof hook === "function" ? hook : hook.hook)(
    { messages: [phase === "afterModel" ? new AIMessage("done") : new HumanMessage("A")] },
    { configurable: { thread_id: threadId } }
  )
}

function enqueue(id: string, rawUserInput?: string) {
  expect(queueCurrentRunMessage(threadId, { id, content: id, rawUserInput }, runToken)).toBe(true)
}

beforeEach(() => {
  clearCurrentRunMessageQueue(threadId)
  setCurrentRunMessageQueueOwner(threadId, runToken)
  setCurrentRunInjectionNotifier(() => {})
})
afterEach(() => {
  clearCurrentRunMessageQueue(threadId)
  setCurrentRunInjectionNotifier(() => {})
})

describe("raw input at the steering injection boundary", () => {
  it.each(["beforeModel", "afterModel"] as const)(
    "updates the active original input only after durable acknowledgement in %s",
    async (phase) => {
      let raw: string | undefined = "A"
      const onInjected = vi.fn((value: string | undefined) => {
        raw = value
      })
      let release!: () => void
      const persisted = new Promise<void>((resolve) => {
        release = resolve
      })
      const notifier = vi.fn(() => persisted)
      setCurrentRunInjectionNotifier(notifier)
      enqueue("B", "  原文 B\n")
      expect(raw).toBe("A")
      const pending = inject(phase, onInjected)
      await vi.waitFor(() => expect(notifier).toHaveBeenCalledOnce())
      expect(raw).toBe("A")
      release()
      await pending
      expect(onInjected).toHaveBeenCalledExactlyOnceWith("  原文 B\n")
      expect(raw).toBe("  原文 B\n")
    }
  )

  it("does not commit a deleted or unsuccessfully persisted steering message", async () => {
    const onInjected = vi.fn()
    enqueue("deleted", "B")
    deleteCurrentRunQueuedMessage(threadId, "deleted")
    await inject("beforeModel", onInjected)
    expect(onInjected).not.toHaveBeenCalled()
    enqueue("failed", "C")
    setCurrentRunInjectionNotifier(() => {
      throw new Error("persistence failed")
    })
    await expect(inject("beforeModel", onInjected)).rejects.toThrow("persistence failed")
    expect(onInjected).not.toHaveBeenCalled()
  })

  it("does not update a replacement run after an old acknowledgement finishes", async () => {
    const onInjected = vi.fn()
    let release!: () => void
    setCurrentRunInjectionNotifier(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    enqueue("B", "B")
    const pending = inject("beforeModel", onInjected)
    setCurrentRunMessageQueueOwner(threadId, "replacement")
    release()
    await pending
    expect(onInjected).not.toHaveBeenCalled()
  })

  it.each(["", undefined])("uses the final injected message's value, including %j", async (raw) => {
    const onInjected = vi.fn()
    enqueue("first", "B")
    enqueue("last", raw)
    await inject("beforeModel", onInjected)
    expect(onInjected).toHaveBeenCalledExactlyOnceWith(raw)
  })
})
