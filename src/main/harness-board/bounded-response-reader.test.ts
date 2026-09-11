import { describe, expect, it } from "vitest"
import {
  HarnessResponseTooLargeError,
  readBoundedResponseBody
} from "./bounded-response-reader"

describe("bounded Harness response reader", () => {
  it("accepts an exact byte budget and rejects the first overflowing chunk", async () => {
    const exact = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          controller.enqueue(new Uint8Array([3, 4]))
          controller.close()
        }
      })
    )
    await expect(readBoundedResponseBody(exact, 4, "exact")).resolves.toEqual(
      Buffer.from([1, 2, 3, 4])
    )

    let cancelled = false
    const overflowing = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
          controller.enqueue(new Uint8Array([4, 5]))
        },
        cancel() {
          cancelled = true
        }
      })
    )
    await expect(readBoundedResponseBody(overflowing, 4, "overflowing")).rejects.toBeInstanceOf(
      HarnessResponseTooLargeError
    )
    expect(cancelled).toBe(true)
  })

  it("rejects an oversized content-length before consuming the body", async () => {
    let pulled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled = true
          controller.enqueue(new Uint8Array([1]))
        }
      }),
      { headers: { "content-length": "1000" } }
    )
    await expect(readBoundedResponseBody(response, 10, "declared-large")).rejects.toMatchObject({
      code: "HARNESS_ENTERPRISE_RESPONSE_TOO_LARGE",
      maxBytes: 10
    })
    expect(pulled).toBe(false)
  })

  it("cancels a pending stream when its request signal aborts", async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined)
        },
        cancel() {
          cancelled = true
        }
      })
    )
    const controller = new AbortController()
    const pending = readBoundedResponseBody(response, 10, "cancelled", controller.signal)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const reason = new Error("superseded")
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(cancelled).toBe(true)
  })
})
