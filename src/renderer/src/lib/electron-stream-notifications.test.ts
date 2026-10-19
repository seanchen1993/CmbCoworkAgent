import { afterEach, describe, expect, it, vi } from "vitest"
import type { UseStreamTransport } from "@langchain/langgraph-sdk/react"
import { createElectronStream } from "./electron-stream"
import { StreamUiNotifications } from "./stream-ui-notifications"
import type { FunctionConversationTranscriptStamp } from "../../../shared/mods/v2/conversation-transcript"

type Event = { event: string; data: unknown }
const delta = (text = "x"): Event => ({
  event: "messages",
  data: [{ id: "reply", type: "ai", content: text }, {}]
})
const nativeStamp: FunctionConversationTranscriptStamp = {
  conversationId: "conversation",
  branchId: "branch",
  uuid: "reply",
  sequence: 1,
  door: "response",
  messageType: "assistant",
  origin: { kind: "model", model: "test" }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function heldTransport(events: Event[], error?: Error) {
  const processed = deferred()
  const finish = deferred()
  const transport: UseStreamTransport = {
    async stream() {
      return (async function* () {
        for (const event of events) yield event
        processed.resolve()
        await finish.promise
        if (error) throw error
      })()
    }
  }
  return { transport, processed, finish }
}

function frameClock() {
  vi.useFakeTimers()
  let next = 0
  const frames = new Map<number, () => void>()
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.set(++next, callback)
    return next
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id)
  })
  return {
    frames,
    frame() {
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach((callback) => callback())
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("stream UI notification scheduling", () => {
  it.each(["provider-tuple", "nested-invalid"])(
    "publishes a reduced %s protection change immediately while RAF is suspended",
    async (kind) => {
      const clock = frameClock()
      const first = {
        id: "reply",
        type: "ai",
        content: "first",
        function_row: nativeStamp,
        provider_source_id: "P",
        provider_occurrence: 1
      }
      const changed = {
        id: "reply",
        type: "ai",
        content: " changed",
        ...(kind === "provider-tuple"
          ? { provider_source_id: "Q", provider_occurrence: 2 }
          : { additional_kwargs: { function_row_invalid: true } })
      }
      const held = heldTransport([
        { event: "messages", data: [first, {}] },
        delta(" pending"),
        { event: "messages", data: [changed, {}] }
      ])
      const stream = createElectronStream({ transport: held.transport, threadId: kind })
      const observed: unknown[] = []
      const unsubscribe = stream.subscribe(() => observed.push(stream.messages[0]))
      const running = stream.submit(null)
      try {
        await held.processed.promise
        const message = stream.messages[0] as Record<string, unknown>
        expect(message.function_row_invalid).toBe(true)
        expect(message).not.toHaveProperty("function_row")
        expect(observed.at(-1)).toBe(message)
        expect(clock.frames.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
        expect(stream.isLoading).toBe(true)
        expect(stream.error).toBeUndefined()
        expect(message.provider_source_id).toBe(kind === "provider-tuple" ? "Q" : "P")
      } finally {
        unsubscribe()
        held.finish.resolve()
        await running
      }
    }
  )

  it.each(["provider-tuple", "native-stamp"])(
    "still coalesces 200 deltas carrying the same %s",
    async (kind) => {
      const clock = frameClock()
      const held = heldTransport(
        Array.from({ length: 200 }, () => ({
          event: "messages",
          data: [
            {
              id: "reply",
              type: "ai",
              content: "x",
              provider_source_id: "P",
              provider_occurrence: 1,
              ...(kind === "native-stamp" ? { function_row: nativeStamp } : {})
            },
            {}
          ]
        }))
      )
      const stream = createElectronStream({ transport: held.transport, threadId: kind })
      const listener = vi.fn()
      const unsubscribe = stream.subscribe(listener)
      const running = stream.submit(null)
      try {
        await held.processed.promise
        expect(stream.messages[0]?.content).toBe("x".repeat(200))
        expect(listener).toHaveBeenCalledTimes(3)
        expect(clock.frames.size).toBe(1)
        held.finish.resolve()
        await running
        expect(listener).toHaveBeenCalledTimes(4)
        expect(clock.frames.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
        expect(stream.messages[0]).toMatchObject({
          provider_source_id: "P",
          provider_occurrence: 1,
          ...(kind === "native-stamp" ? { function_row: nativeStamp } : {})
        })
        expect(stream.messages[0]).not.toHaveProperty("function_row_invalid")
      } finally {
        unsubscribe()
        held.finish.resolve()
        await running
      }
    }
  )

  it("reduces all 200 deltas immediately and publishes the final state without a paint wait", async () => {
    const clock = frameClock()
    const held = heldTransport(Array.from({ length: 200 }, () => delta()))
    const stream = createElectronStream({ transport: held.transport, threadId: "burst" })
    const notifications: Array<{ loading: boolean; text: unknown }> = []
    const unsubscribe = stream.subscribe(() =>
      notifications.push({
        loading: stream.isLoading,
        text: stream.messages[0]?.content
      })
    )
    const running = stream.submit(null)
    try {
      await held.processed.promise
      expect(stream.messages[0]?.content).toBe("x".repeat(200))
      expect(stream.getSnapshot().isLoading).toBe(true)
      expect(notifications).toHaveLength(3)
      expect(notifications[2]).toEqual({ loading: true, text: "x" })
      expect(clock.frames.size).toBe(1)
      held.finish.resolve()
      await running
      expect(notifications).toHaveLength(4)
      expect(notifications.at(-1)).toEqual({ loading: false, text: "x".repeat(200) })
      expect(clock.frames.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      unsubscribe()
      held.finish.resolve()
      await running
    }
  })

  it("publishes cumulative live text once per frame while keeping getters current", async () => {
    const clock = frameClock()
    const held = heldTransport(Array.from({ length: 200 }, () => delta()))
    const stream = createElectronStream({ transport: held.transport, threadId: "frame" })
    const listener = vi.fn()
    const unsubscribe = stream.subscribe(listener)
    const running = stream.submit(null)
    try {
      await held.processed.promise
      expect(listener).toHaveBeenCalledTimes(3)
      clock.frame()
      expect(listener).toHaveBeenCalledTimes(4)
      expect(stream.messages[0]?.content).toBe("x".repeat(200))
      expect(vi.getTimerCount()).toBe(0)
      clock.frame()
      expect(listener).toHaveBeenCalledTimes(4)
    } finally {
      unsubscribe()
      held.finish.resolve()
      await running
    }
  })

  it.each(["absent", "stalled"])(
    "bounds background notification delivery with %s RAF",
    async (mode) => {
      frameClock()
      if (mode === "absent") {
        vi.stubGlobal("requestAnimationFrame", undefined)
        vi.stubGlobal("cancelAnimationFrame", undefined)
      }
      const held = heldTransport([delta("back"), delta("ground")])
      const stream = createElectronStream({ transport: held.transport, threadId: mode })
      const listener = vi.fn()
      const unsubscribe = stream.subscribe(listener)
      const running = stream.submit(null)
      try {
        await held.processed.promise
        expect(listener).toHaveBeenCalledTimes(3)
        vi.advanceTimersByTime(49)
        expect(listener).toHaveBeenCalledTimes(3)
        vi.advanceTimersByTime(1)
        expect(listener).toHaveBeenCalledTimes(4)
        expect(stream.messages[0]?.content).toBe("background")
      } finally {
        unsubscribe()
        held.finish.resolve()
        await running
      }
    }
  )

  it("delivers approval custom callbacks and flushes pending text without loading or error changes", async () => {
    const clock = frameClock()
    const order: string[] = []
    const approval = { type: "tool_approval_request", toolCallId: "review" }
    const held = heldTransport([
      delta("before "),
      delta("approval"),
      { event: "custom", data: approval }
    ])
    const onCustomEvent = vi.fn(() => order.push("approval"))
    const stream = createElectronStream({
      transport: held.transport,
      threadId: "approval",
      onCustomEvent
    })
    const unsubscribe = stream.subscribe(() => order.push(String(stream.messages[0]?.content)))
    const running = stream.submit(null)
    try {
      await held.processed.promise
      expect(onCustomEvent).toHaveBeenCalledExactlyOnceWith(approval, undefined)
      expect(order.slice(-2)).toEqual(["before approval", "approval"])
      expect(stream.isLoading).toBe(true)
      expect(stream.error).toBeUndefined()
      expect(clock.frames.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      unsubscribe()
      held.finish.resolve()
      await running
    }
  })

  it("publishes errors before the error callback and completes without RAF", async () => {
    const clock = frameClock()
    const error = new Error("transport failed")
    vi.spyOn(console, "error").mockImplementation(() => {})
    const held = heldTransport([delta("before "), delta("error")], error)
    const seenErrors: unknown[] = []
    const onError = vi.fn(() => {
      expect(seenErrors).toContain(error)
    })
    const stream = createElectronStream({ transport: held.transport, threadId: "error", onError })
    const unsubscribe = stream.subscribe(() => {
      seenErrors.push(stream.error)
    })
    const running = stream.submit(null)
    try {
      await held.processed.promise
      held.finish.resolve()
      await running
      expect(onError).toHaveBeenCalledExactlyOnceWith(error)
      expect(stream.isLoading).toBe(false)
      expect(stream.messages[0]?.content).toBe("before error")
      expect(clock.frames.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      unsubscribe()
      held.finish.resolve()
      await running
    }
  })

  it.each(["native-stamp", "tool", "values"])(
    "keeps %s state publication immediate",
    async (kind) => {
      const clock = frameClock()
      const immediate: Event =
        kind === "values"
          ? { event: "values", data: { __interrupt__: [{ value: "review" }] } }
          : {
              event: "messages",
              data: [
                kind === "tool"
                  ? { id: "tool-result", type: "tool", content: "result", tool_call_id: "tool" }
                  : { id: "native", type: "ai", content: "native", function_row_invalid: true },
                {}
              ]
            }
      const held = heldTransport([delta(), immediate])
      const stream = createElectronStream({ transport: held.transport, threadId: kind })
      const listener = vi.fn()
      const unsubscribe = stream.subscribe(listener)
      const running = stream.submit(null)
      try {
        await held.processed.promise
        expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3)
        expect(clock.frames.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        unsubscribe()
        held.finish.resolve()
        await running
      }
    }
  )

  it("cancels the last observer's work and never delivers it to a replacement scope", () => {
    const clock = frameClock()
    const notifications = new StreamUiNotifications()
    const old = vi.fn(),
      replacement = vi.fn()
    const unsubscribe = notifications.subscribe(old)
    notifications.notify(false)
    const oldFrame = [...clock.frames.values()][0]
    unsubscribe()
    expect(clock.frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const replace = notifications.subscribe(replacement)
    notifications.notify(false)
    oldFrame()
    expect(old).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
    clock.frame()
    expect(replacement).toHaveBeenCalledOnce()
    replace()
  })

  it("retains a shared frame until the last listener leaves and does not debounce its timer", () => {
    const clock = frameClock()
    const notifications = new StreamUiNotifications()
    const first = vi.fn(),
      second = vi.fn()
    const unsubscribeFirst = notifications.subscribe(first)
    const unsubscribeSecond = notifications.subscribe(second)
    notifications.notify(false)
    unsubscribeFirst()
    expect(clock.frames.size).toBe(1)
    for (let elapsed = 0; elapsed < 50; elapsed += 10) {
      notifications.notify(false)
      vi.advanceTimersByTime(10)
    }
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    expect(clock.frames.size).toBe(0)
    unsubscribeSecond()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("stop flushes already reduced text before awaiting the consumer's actual completion", async () => {
    const clock = frameClock()
    const held = heldTransport([delta("before"), delta(" stop")])
    const stream = createElectronStream({ transport: held.transport, threadId: "stop" })
    const listener = vi.fn()
    const unsubscribe = stream.subscribe(listener)
    const running = stream.submit(null)
    try {
      await held.processed.promise
      expect(listener).toHaveBeenCalledTimes(3)
      await stream.stop()
      expect(listener).toHaveBeenCalledTimes(4)
      expect(stream.messages[0]?.content).toBe("before stop")
      expect(clock.frames.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      held.finish.resolve()
      await running
      expect(stream.isLoading).toBe(false)
      expect(listener).toHaveBeenCalledTimes(5)
    } finally {
      unsubscribe()
      held.finish.resolve()
      await running
    }
  })

  it("unsubscribes without aborting reduction and keeps different thread scopes independent", async () => {
    const clock = frameClock()
    const a = heldTransport([delta("A"), delta(" tail")]),
      b = heldTransport([delta("B"), delta(" tail")])
    const streamA = createElectronStream({ transport: a.transport, threadId: "A" })
    const streamB = createElectronStream({ transport: b.transport, threadId: "B" })
    const listenerA = vi.fn(),
      listenerB = vi.fn()
    const unsubscribeA = streamA.subscribe(listenerA)
    const runningA = streamA.submit(null)
    await a.processed.promise
    const oldFrame = [...clock.frames.values()][0]
    unsubscribeA()
    const unsubscribeB = streamB.subscribe(listenerB)
    const runningB = streamB.submit(null)
    try {
      await b.processed.promise
      oldFrame()
      expect(listenerA).toHaveBeenCalledTimes(3)
      expect(listenerB).toHaveBeenCalledTimes(3)
      clock.frame()
      expect(listenerB).toHaveBeenCalledTimes(4)
      a.finish.resolve()
      await runningA
      expect(streamA.messages[0]?.content).toBe("A tail")
      expect(streamA.isLoading).toBe(false)
      expect(listenerA).toHaveBeenCalledTimes(3)
      expect(streamB.messages[0]?.content).toBe("B tail")
      expect(streamB.isLoading).toBe(true)
    } finally {
      unsubscribeA()
      unsubscribeB()
      a.finish.resolve()
      b.finish.resolve()
      await Promise.all([runningA, runningB])
    }
  })

  it("clear publishes immediately and cancels an older pending text notification", async () => {
    const clock = frameClock()
    const held = heldTransport([delta("clear"), delta(" me")])
    const stream = createElectronStream({ transport: held.transport, threadId: "clear" })
    const listener = vi.fn()
    const unsubscribe = stream.subscribe(listener)
    const running = stream.submit(null)
    try {
      await held.processed.promise
      stream.clear()
      expect(stream.messages).toEqual([])
      expect(stream.isLoading).toBe(false)
      expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(clock.frames.size).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      unsubscribe()
      held.finish.resolve()
      await running
    }
  })
})
