import { describe, expect, it } from "vitest"
import type { UseStreamTransport } from "@langchain/langgraph-sdk/react"
import { createElectronStream } from "./electron-stream"

// The baseline can execute without importing the not-yet-implemented registry.
// These finite extensions exercise the proposed renderer-only callback contract.
type TestModelSelectionIntent = Readonly<{
  threadId: string
  lifetime: object
  intent: object
}>
type ExistingStreamOptions = Parameters<typeof createElectronStream>[0]
type ExistingSubmitOptions = NonNullable<
  Parameters<ReturnType<typeof createElectronStream>["submit"]>[1]
>
type IntentStreamOptions = ExistingStreamOptions & {
  captureModelSelectionIntent?: () => TestModelSelectionIntent
  onCustomEvent?: (data: unknown, receipt?: TestModelSelectionIntent) => void
}
type IntentSubmitOptions = ExistingSubmitOptions & {
  modelSelectionIntent?: TestModelSelectionIntent
}
type TransportPayload = Parameters<UseStreamTransport["stream"]>[0]
type CustomEvent = { event: "custom"; data: Record<string, unknown> }
type ObservedCustom = { data: unknown; receipt: TestModelSelectionIntent | undefined }

function intent(threadId: string, lifetime = {}): TestModelSelectionIntent {
  return Object.freeze({ threadId, lifetime, intent: Object.freeze({}) })
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function route(modelId = "custom:b"): CustomEvent {
  return {
    event: "custom",
    data: {
      type: "routing_result",
      resolvedModelId: modelId,
      resolvedTier: "premium",
      routeReason: "controlled route"
    }
  }
}

function heldTransport(event: CustomEvent, onEnter?: () => void) {
  const entered = deferred()
  const released = deferred()
  const payloads: TransportPayload[] = []
  const transport: UseStreamTransport = {
    async stream(payload) {
      payloads.push(payload)
      onEnter?.()
      entered.release()
      await released.promise
      return (async function* () {
        yield event
      })()
    }
  }
  return { transport, payloads, entered, released }
}

describe("Electron stream model intent boundary", () => {
  it("retains the explicit preflight receipt after the transport wait", async () => {
    const oldReceipt = intent("explicit")
    let latestReceipt = oldReceipt
    let captureCalls = 0
    const received: ObservedCustom[] = []
    const errors: unknown[] = []
    const held = heldTransport(route())
    const options: IntentStreamOptions = {
      threadId: "explicit",
      transport: held.transport,
      captureModelSelectionIntent: () => {
        captureCalls += 1
        return latestReceipt
      },
      onCustomEvent: (data, receipt) => received.push({ data, receipt }),
      onError: (error) => errors.push(error)
    }
    const stream = createElectronStream(options)
    const submitOptions: IntentSubmitOptions = {
      modelSelectionIntent: oldReceipt,
      context: { testContext: "preserved" },
      config: { configurable: { model_id: "custom:b" } }
    }
    const input = { messages: [{ type: "human", content: "explicit receipt" }] }
    const pending = stream.submit(input, submitOptions)
    try {
      await held.entered.promise
      latestReceipt = intent("explicit", oldReceipt.lifetime)
    } finally {
      held.released.release()
      await pending
    }

    expect(errors).toEqual([])
    expect(stream.error).toBeUndefined()
    expect(received).toHaveLength(1)
    expect(received[0].data).toEqual(route().data)
    expect(received[0].receipt).toBe(oldReceipt)
    expect(received[0].receipt).not.toBe(latestReceipt)
    expect(captureCalls).toBe(0)
    expect(held.payloads).toHaveLength(1)
    expect(held.payloads[0].input).toEqual(input)
    expect(held.payloads[0].context).toEqual({ testContext: "preserved" })
    expect(held.payloads[0].config).toEqual({
      configurable: { thread_id: "explicit", model_id: "custom:b" }
    })
    expect(Object.keys(held.payloads[0]).sort()).toEqual(
      ["command", "config", "context", "input", "signal"].sort()
    )
    expect(JSON.stringify(held.payloads[0])).not.toContain("modelSelectionIntent")
  })

  it("captures an implicit receipt before entering asynchronous transport work", async () => {
    const oldReceipt = intent("implicit")
    let latestReceipt = oldReceipt
    const order: string[] = []
    const received: ObservedCustom[] = []
    const held = heldTransport(route(), () => order.push("transport"))
    const options: IntentStreamOptions = {
      threadId: "implicit",
      transport: held.transport,
      captureModelSelectionIntent: () => {
        order.push("capture")
        return latestReceipt
      },
      onCustomEvent: (data, receipt) => received.push({ data, receipt })
    }
    const stream = createElectronStream(options)
    const pending = stream.submit(null)
    let orderAtTransport: string[] = []
    try {
      await held.entered.promise
      orderAtTransport = order.slice()
      latestReceipt = intent("implicit", oldReceipt.lifetime)
    } finally {
      held.released.release()
      await pending
    }

    expect(stream.error).toBeUndefined()
    expect(orderAtTransport).toEqual(["capture", "transport"])
    expect(order).toEqual(["capture", "transport"])
    expect(received).toHaveLength(1)
    expect(received[0].receipt).toBe(oldReceipt)
    expect(received[0].receipt).not.toBe(latestReceipt)
  })

  it("uses the latest callback while retaining that submission's original receipt", async () => {
    const oldReceipt = intent("callback")
    const initial: ObservedCustom[] = []
    const replacement: ObservedCustom[] = []
    const held = heldTransport(route())
    const options: IntentStreamOptions = {
      threadId: "callback",
      transport: held.transport,
      onCustomEvent: (data, receipt) => initial.push({ data, receipt })
    }
    const stream = createElectronStream(options)
    const submitOptions: IntentSubmitOptions = { modelSelectionIntent: oldReceipt }
    const pending = stream.submit(null, submitOptions)
    try {
      await held.entered.promise
      const nextCallbacks: Pick<IntentStreamOptions, "onCustomEvent" | "onError"> = {
        onCustomEvent: (data, receipt) => replacement.push({ data, receipt })
      }
      stream.setCallbacks(nextCallbacks)
    } finally {
      held.released.release()
      await pending
    }

    expect(stream.error).toBeUndefined()
    expect(initial).toEqual([])
    expect(replacement).toHaveLength(1)
    expect(replacement[0].data).toEqual(route().data)
    expect(replacement[0].receipt).toBe(oldReceipt)
  })

  it("keeps the receipt for each completed submission on a reused stream", async () => {
    const lifetime = {}
    const firstReceipt = intent("reused", lifetime)
    const nextReceipt = intent("reused", lifetime)
    const received: ObservedCustom[] = []
    let requestIndex = 0
    const transport: UseStreamTransport = {
      async stream() {
        const event = route(requestIndex++ === 0 ? "custom:b" : "custom:d")
        return (async function* () {
          yield event
        })()
      }
    }
    const options: IntentStreamOptions = {
      threadId: "reused",
      transport,
      onCustomEvent: (data, receipt) => received.push({ data, receipt })
    }
    const stream = createElectronStream(options)
    const firstOptions: IntentSubmitOptions = { modelSelectionIntent: firstReceipt }
    const nextOptions: IntentSubmitOptions = { modelSelectionIntent: nextReceipt }
    await stream.submit(null, firstOptions)
    await stream.submit(null, nextOptions)

    expect(stream.error).toBeUndefined()
    expect(requestIndex).toBe(2)
    expect(received.map((event) => event.data)).toEqual([route().data, route("custom:d").data])
    expect(received[0].receipt).toBe(firstReceipt)
    expect(received[1].receipt).toBe(nextReceipt)
  })

  it("preserves a legacy one-argument custom callback without receipt support", async () => {
    const event = route("custom:d")
    const received: unknown[] = []
    const payloads: TransportPayload[] = []
    const stream = createElectronStream({
      threadId: "legacy",
      transport: {
        async stream(payload) {
          payloads.push(payload)
          return (async function* () {
            yield event
          })()
        }
      },
      onCustomEvent: (data) => received.push(data)
    })
    await stream.submit(null, { config: { configurable: { model_id: "custom:d" } } })

    expect(stream.error).toBeUndefined()
    expect(received).toEqual([event.data])
    expect(payloads).toHaveLength(1)
    expect(payloads[0].config?.configurable).toEqual({
      thread_id: "legacy",
      model_id: "custom:d"
    })
    expect(JSON.stringify(payloads[0])).not.toContain("modelSelectionIntent")
  })
})
