import { afterEach, describe, expect, it, vi } from "vitest"
import {
  UPLOAD_ERROR_RESPONSE_MAX_BYTES,
  UPLOAD_REQUEST_TIMEOUT_MS,
  uploadChatData
} from "./index"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function stubLocalStorage(): void {
  vi.stubGlobal("localStorage", { getItem: () => null })
}

function stalledErrorResponse(signal: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener(
        "abort",
        () => controller.error(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true }
      )
    }
  })
  return new Response(body, { status: 500, statusText: "Server Error" })
}

describe("bounded chat report uploads", () => {
  it("propagates a chat-surface abort to the active fetch", async () => {
    stubLocalStorage()
    let fetchSignal: AbortSignal | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        fetchSignal = init.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          fetchSignal?.addEventListener(
            "abort",
            () => reject(fetchSignal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true }
          )
        })
      })
    )
    const controller = new AbortController()
    const pending = uploadChatData("thread-a", [{ role: "user", content: "hello" }], controller.signal)
    await Promise.resolve()
    controller.abort(new DOMException("surface disposed", "AbortError"))

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(fetchSignal?.aborted).toBe(true)
  })

  it("times out a server that never responds", async () => {
    vi.useFakeTimers()
    stubLocalStorage()
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true }
          )
        })
      )
    )
    const pending = uploadChatData("thread-a", [{ role: "user", content: "hello" }])
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(UPLOAD_REQUEST_TIMEOUT_MS + 1)
    await rejected
  })

  it("keeps the timeout active while a received error body is stalled", async () => {
    vi.useFakeTimers()
    stubLocalStorage()
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(stalledErrorResponse(init.signal as AbortSignal))
      )
    )

    const pending = uploadChatData("thread-a", [{ role: "user", content: "hello" }])
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" })
    await vi.advanceTimersByTimeAsync(UPLOAD_REQUEST_TIMEOUT_MS + 1)
    await rejected
  })

  it("keeps caller cancellation active while a received error body is stalled", async () => {
    stubLocalStorage()
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(stalledErrorResponse(init.signal as AbortSignal))
      )
    )
    const controller = new AbortController()
    const pending = uploadChatData(
      "thread-a",
      [{ role: "user", content: "hello" }],
      controller.signal
    )
    await Promise.resolve()
    controller.abort(new DOMException("surface disposed", "AbortError"))

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("does not parse a success body and rejects oversized error bodies before buffering", async () => {
    stubLocalStorage()
    const cancel = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        body: { cancel }
      } as unknown as Response)
      .mockResolvedValueOnce(
        new Response("ignored", {
          status: 500,
          headers: {
            "content-length": String(UPLOAD_ERROR_RESPONSE_MAX_BYTES + 1)
          }
        })
      )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      uploadChatData("thread-a", [{ role: "assistant", content: "done" }])
    ).resolves.toBeUndefined()
    expect(cancel).toHaveBeenCalledTimes(1)
    await expect(
      uploadChatData("thread-b", [{ role: "assistant", content: "failed" }])
    ).rejects.toThrow("response body exceeded the error budget")
  })
})
