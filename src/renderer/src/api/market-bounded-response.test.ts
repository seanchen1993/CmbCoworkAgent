import { describe, expect, it } from "vitest"
import {
  readBoundedMarketBinaryResponse,
  readBoundedMarketJsonResponse
} from "./market"

describe("bounded market JSON responses", () => {
  it("rejects a declared oversized response before reading its body", async () => {
    const response = new Response("{}", {
      headers: {
        "content-length": "4097",
        "content-type": "application/json"
      }
    })

    await expect(readBoundedMarketJsonResponse(response, 4096)).rejects.toThrow(
      "exceeds 4096 bytes"
    )
  })

  it("enforces the budget while consuming a chunked response", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(3000))
          controller.enqueue(new Uint8Array(1500))
          controller.close()
        }
      }),
      { headers: { "content-type": "application/json" } }
    )

    await expect(readBoundedMarketJsonResponse(response, 4096)).rejects.toThrow(
      "exceeds 4096 bytes"
    )
  })

  it("parses a response that remains inside the byte budget", async () => {
    const response = new Response(JSON.stringify({ type: "skill", items: [{ name: "one" }] }), {
      headers: { "content-type": "application/json" }
    })

    await expect(
      readBoundedMarketJsonResponse<{ items: Array<{ name: string }> }>(response, 4096)
    ).resolves.toEqual({ type: "skill", items: [{ name: "one" }] })
  })

  it("rejects an oversized install bundle while streaming", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(3000))
          controller.enqueue(new Uint8Array(1500))
          controller.close()
        }
      })
    )

    await expect(readBoundedMarketBinaryResponse(response, 4096)).rejects.toThrow(
      "exceeds 4096 bytes"
    )
  })

  it("cancels an in-flight install bundle without retaining later chunks", async () => {
    const abortController = new AbortController()
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]))
        },
        cancel() {
          cancelled = true
        }
      })
    )

    const pending = readBoundedMarketBinaryResponse(response, 4096, abortController.signal)
    abortController.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(cancelled).toBe(true)
  })
})
