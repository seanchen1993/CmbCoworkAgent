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
  runtime: { configurable: { thread_id: string }; signal?: AbortSignal }
) => Promise<unknown>

function inject(
  phase: "beforeModel" | "afterModel",
  onInjected: (raw?: string) => void,
  owner = runToken,
  signal?: AbortSignal
) {
  const middleware = createCurrentRunMessageQueueMiddleware(owner, onInjected) as unknown as {
    beforeModel: QueueHook | { hook: QueueHook }
    afterModel: { hook: QueueHook }
  }
  const hook = phase === "afterModel" ? middleware.afterModel.hook : middleware.beforeModel
  return (typeof hook === "function" ? hook : hook.hook)(
    { messages: [phase === "afterModel" ? new AIMessage("done") : new HumanMessage("A")] },
    { configurable: { thread_id: threadId }, signal }
  )
}

function enqueue(id: string, rawUserInput?: string, onInjected?: () => void) {
  expect(
    queueCurrentRunMessage(threadId, { id, content: id, rawUserInput, onInjected }, runToken)
  ).toBe(true)
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
      const snapshots: Array<[string, string | undefined]> = []
      const onInjected = vi.fn((value: string | undefined) => {
        raw = value
      })
      let release!: () => void
      const persisted = new Promise<void>((resolve) => {
        release = resolve
      })
      const notifier = vi.fn(() => persisted)
      setCurrentRunInjectionNotifier(notifier)
      enqueue("B", "  原文 B\n", () => snapshots.push(["B", raw]))
      enqueue("C", "  原文 C\n", () => snapshots.push(["C", raw]))
      expect(raw).toBe("A")
      const pending = inject(phase, onInjected)
      await vi.waitFor(() => expect(notifier).toHaveBeenCalledOnce())
      expect(raw).toBe("A")
      expect(snapshots).toEqual([])
      release()
      await pending
      await inject(phase, onInjected)
      expect(onInjected).toHaveBeenCalledExactlyOnceWith("  原文 C\n")
      expect(raw).toBe("  原文 C\n")
      expect(snapshots).toEqual([
        ["B", "  原文 C\n"],
        ["C", "  原文 C\n"]
      ])
    }
  )

  it("does not commit a deleted or unsuccessfully persisted steering message", async () => {
    const onInjected = vi.fn()
    const deletedEffect = vi.fn()
    const failedEffect = vi.fn()
    enqueue("deleted", "B", deletedEffect)
    deleteCurrentRunQueuedMessage(threadId, "deleted")
    await inject("beforeModel", onInjected)
    expect(onInjected).not.toHaveBeenCalled()
    expect(deletedEffect).not.toHaveBeenCalled()
    enqueue("failed", "C", failedEffect)
    setCurrentRunInjectionNotifier(() => {
      throw new Error("persistence failed")
    })
    await expect(inject("beforeModel", onInjected)).rejects.toThrow("persistence failed")
    expect(onInjected).not.toHaveBeenCalled()
    expect(failedEffect).not.toHaveBeenCalled()
    setCurrentRunInjectionNotifier(() => {})
    await inject("beforeModel", onInjected)
    expect(onInjected).toHaveBeenCalledExactlyOnceWith("C")
    expect(failedEffect).toHaveBeenCalledOnce()
  })

  it("drops a withdrawn message if its pending persistence fails", async () => {
    const onInjected = vi.fn()
    const effect = vi.fn()
    let failPersistence!: (error: Error) => void
    setCurrentRunInjectionNotifier(
      () =>
        new Promise<void>((_resolve, reject) => {
          failPersistence = reject
        })
    )
    enqueue("withdrawn", "B", effect)
    const pending = inject("beforeModel", onInjected)
    deleteCurrentRunQueuedMessage(threadId, "withdrawn")
    failPersistence(new Error("persistence failed"))
    await expect(pending).rejects.toThrow("persistence failed")
    setCurrentRunInjectionNotifier(() => {})
    await inject("beforeModel", onInjected)
    expect(onInjected).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
  })

  it("does not update a replacement run after an old acknowledgement finishes", async () => {
    const onInjected = vi.fn()
    const effect = vi.fn()
    let release!: () => void
    setCurrentRunInjectionNotifier(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    enqueue("B", "B", effect)
    const pending = inject("beforeModel", onInjected)
    setCurrentRunMessageQueueOwner(threadId, "replacement")
    release()
    await expect(pending).resolves.toBeUndefined()
    expect(onInjected).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
  })

  it.each(["beforeModel", "afterModel"] as const)(
    "does not commit original input or staged effects when %s is cancelled during persistence",
    async (phase) => {
      const controller = new AbortController()
      const onInjected = vi.fn()
      const effect = vi.fn()
      let release!: () => void
      const notifier = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
      setCurrentRunInjectionNotifier(notifier)
      enqueue("B", "pending input", effect)
      const pending = inject(phase, onInjected, runToken, controller.signal)
      expect(notifier).toHaveBeenCalledOnce()
      controller.abort()
      release()
      await expect(pending).resolves.toBeUndefined()
      expect(onInjected).not.toHaveBeenCalled()
      expect(effect).not.toHaveBeenCalled()
    }
  )

  it("commits the latest prepared effects in the physical continuation", async () => {
    const original = vi.fn()
    const edited = vi.fn()
    const onInjected = vi.fn()
    enqueue("guide", "original", original)
    enqueue("guide", "edited", edited)
    setCurrentRunMessageQueueOwner(threadId, "continuation")
    await inject("beforeModel", onInjected)
    expect(onInjected).not.toHaveBeenCalled()
    expect(edited).not.toHaveBeenCalled()
    await inject("beforeModel", onInjected, "continuation")
    expect(onInjected).toHaveBeenCalledExactlyOnceWith("edited")
    expect(edited).toHaveBeenCalledOnce()
    expect(original).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    "reserves the drained id until persistence settles (success: %j)",
    async (ok) => {
      let persist!: () => void
      let failPersistence!: (error: Error) => void
      setCurrentRunInjectionNotifier(
        () =>
          new Promise<void>((resolve, reject) => {
            persist = resolve
            failPersistence = reject
          })
      )
      const original = vi.fn()
      const edited = vi.fn()
      const onInjected = vi.fn()
      enqueue("guide", "original", original)
      const pending = inject("beforeModel", onInjected)
      const acceptedWhileDraining = queueCurrentRunMessage(
        threadId,
        { id: "guide", content: "edited", rawUserInput: "edited", onInjected: edited },
        runToken
      )

      if (ok) {
        persist()
        await pending
        expect(onInjected).toHaveBeenCalledExactlyOnceWith("original")
        expect(original).toHaveBeenCalledOnce()
        expect(edited).not.toHaveBeenCalled()
      } else {
        failPersistence(new Error("persistence failed"))
        await expect(pending).rejects.toThrow("persistence failed")
        enqueue("guide", "edited", edited)
        setCurrentRunInjectionNotifier(() => {})
        await inject("beforeModel", onInjected)
        expect(onInjected).toHaveBeenCalledExactlyOnceWith("edited")
        expect(edited).toHaveBeenCalledOnce()
        expect(original).not.toHaveBeenCalled()
      }
      expect(acceptedWhileDraining).toBe(false)
      await expect(inject("beforeModel", onInjected)).resolves.toBeUndefined()
    }
  )

  it("keeps the durable batch and runs later effects if one effect throws", async () => {
    const onInjected = vi.fn()
    const effect = vi.fn()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      enqueue("first", "B", () => {
        throw new Error("effect failed")
      })
      enqueue("last", "C", effect)
      const result = await inject("beforeModel", onInjected)
      expect(result).toMatchObject({ messages: [{ id: "first" }, { id: "last" }] })
      expect(onInjected).toHaveBeenCalledExactlyOnceWith("C")
      expect(effect).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it.each(["", undefined])("uses the final injected message's value, including %j", async (raw) => {
    const onInjected = vi.fn()
    enqueue("first", "B")
    enqueue("last", raw)
    await inject("beforeModel", onInjected)
    expect(onInjected).toHaveBeenCalledExactlyOnceWith(raw)
  })
})
