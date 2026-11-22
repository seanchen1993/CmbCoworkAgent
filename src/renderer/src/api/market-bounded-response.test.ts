import { describe, expect, it, vi } from "vitest"
import {
  MARKET_SKILL_LIST_MAX_ITEMS,
  marketApi,
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

describe("legacy market skill catalog in Electron", () => {
  it("uses the shared IPC and aborts only the requesting consumer", async () => {
    const total = MARKET_SKILL_LIST_MAX_ITEMS + 1
    const items = [{ name: "one" }]
    let finish!: (page: { items: typeof items; total: number }) => void
    const catalog = new Promise<{ items: typeof items; total: number }>((resolve) => {
      finish = resolve
    })
    const marketCatalog = vi.fn(() => catalog)
    const fetch = vi.fn()
    vi.stubEnv("VITE_API_BASE_URL", "https://market.invalid.test")
    vi.stubGlobal("window", { api: { skills: { marketCatalog } } })
    vi.stubGlobal("fetch", fetch)
    try {
      const controller = new AbortController()
      const aborted = marketApi.getSkills({ signal: controller.signal })
      const other = marketApi.getSkills()
      controller.abort()
      await expect(aborted).rejects.toMatchObject({ name: "AbortError" })
      await expect(marketApi.getSkills({ signal: controller.signal })).rejects.toMatchObject({
        name: "AbortError"
      })
      finish({ items, total })
      await expect(other).resolves.toEqual({ success: true, data: items, total, hasNextPage: true })
      expect(marketCatalog).toHaveBeenCalledTimes(2)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })

  it("preserves the missing-backend result before requesting the IPC catalog", async () => {
    const marketCatalog = vi.fn()
    vi.stubEnv("VITE_API_BASE_URL", "")
    vi.stubGlobal("location", { protocol: "file:" })
    vi.stubGlobal("window", { api: { skills: { marketCatalog } } })
    try {
      await expect(marketApi.getSkills()).resolves.toMatchObject({
        success: false,
        errorCode: "BACKEND_NOT_CONFIGURED"
      })
      expect(marketCatalog).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    }
  })
})
