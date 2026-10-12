import { afterEach, expect, it, vi } from "vitest"
import { createRetryingFetch } from "./retrying-fetch"

afterEach(() => vi.restoreAllMocks())

it("returns explicit quota exhaustion on the first response, keeps the SDK body and sanitizes diagnostics", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  const key = "opaque-quota-credential"
  const raw = JSON.stringify({
    error: { message: `Token Plan usage limit reached. (2056) ${key}` }
  })
  const response = new Response(raw, { status: 429, headers: { "x-request-id": "quota-request" } })
  const send = vi.fn<typeof fetch>().mockResolvedValue(response)
  const onRetry = vi.fn(),
    onFetchError = vi.fn()
  const result = await createRetryingFetch(
    { knownSecrets: [key], onRetry, onFetchError },
    6,
    send
  )("https://fixture.invalid")
  expect(result).toBe(response)
  expect(send).toHaveBeenCalledOnce()
  expect(onRetry).not.toHaveBeenCalled()
  expect(onFetchError).toHaveBeenCalledOnce()
  expect(onFetchError.mock.calls[0]![0]).toMatchObject({ status: 429, requestId: "quota-request" })
  expect(JSON.stringify(onFetchError.mock.calls)).not.toContain(key)
  expect(await result.text()).toBe(raw)
})

it("retains backoff for ordinary HTTP 429 and cancels the rejected response", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(Math, "random").mockReturnValue(0)
  vi.useFakeTimers()
  try {
    const first = new Response(JSON.stringify({ error: { message: "rate limit (1002)" } }), {
      status: 429
    })
    const second = new Response("ok")
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const onRetry = vi.fn()
    const pending = createRetryingFetch({ onRetry }, 2, send)("https://fixture.invalid")
    await vi.advanceTimersByTimeAsync(1001)
    expect(await pending).toBe(second)
    expect(send).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it("stops immediately when cancelled while inspecting a stalled HTTP 429 body", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.useFakeTimers()
  try {
    const controller = new AbortController()
    const response = new Response(new ReadableStream<Uint8Array>(), { status: 429 })
    const send = vi.fn<typeof fetch>().mockResolvedValue(response)
    const onRetry = vi.fn()
    const pending = createRetryingFetch(
      { onRetry },
      6,
      send
    )("https://fixture.invalid", {
      signal: controller.signal
    })
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    await rejected
    expect(send).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await response.body!.cancel()
  } finally {
    vi.useRealTimers()
  }
})

it("bounds an unending provider error body and gives the SDK its original response without a tee-cancel deadlock", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  let pulls = 0
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new TextEncoder().encode("x".repeat(8192)))
      }
    }),
    { status: 485, headers: { "x-request-id": "gateway-request" } }
  )
  const captured = vi.fn()
  const result = await createRetryingFetch(
    { onFetchError: captured },
    1,
    async () => response
  )("https://fixture.invalid")
  expect(result).toBe(response)
  expect(captured).toHaveBeenCalledOnce()
  expect(captured.mock.calls[0]![0]).toMatchObject({ status: 485, requestId: "gateway-request" })
  expect(captured.mock.calls[0]![0].rawBody.length).toBeLessThanOrEqual(16 * 1024)
  expect(pulls).toBeLessThan(8)
  await response.body!.cancel()
})

it("returns a stalled diagnostic prefix by deadline and ignores diagnostic sink failure", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.useFakeTimers()
  try {
    const response = new Response(new ReadableStream<Uint8Array>(), { status: 485 })
    const capture = vi.fn(() => {
      throw new Error("diagnostic sink closed")
    })
    const pending = createRetryingFetch(
      { onFetchError: capture },
      1,
      async () => response
    )("https://fixture.invalid")
    await vi.advanceTimersByTimeAsync(2001)
    expect(await pending).toBe(response)
    expect(capture).toHaveBeenCalledOnce()
    await response.body!.cancel()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it("cancels a rejected retry response without draining or awaiting its infinite body", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(Math, "random").mockReturnValue(0)
  vi.useFakeTimers()
  try {
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const first = new Response(new ReadableStream({ cancel }), { status: 500 })
    const second = new Response("ok")
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const pending = createRetryingFetch(undefined, 2, send)("https://fixture.invalid")
    await vi.advanceTimersByTimeAsync(1001)
    expect(await pending).toBe(second)
    expect(cancel).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it("filters unsafe response headers and known credentials before logs or UI hooks", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {})
  const key = "opaque-credential-private"
  const captured = vi.fn()
  const response = new Response(`gateway rejected ${key}`, {
    status: 485,
    headers: { "x-request-id": key, "content-type": `unknown/${key}` }
  })
  await createRetryingFetch(
    { knownSecrets: [key], onFetchError: captured },
    1,
    async () => response
  )("https://fixture.invalid")
  expect(JSON.stringify(log.mock.calls)).not.toContain(key)
  expect(JSON.stringify(captured.mock.calls)).not.toContain(key)
  expect(captured.mock.calls[0]![0]).not.toHaveProperty("requestId", key)
  expect(await response.text()).toContain(key) // Model SDK still receives the untouched response.
})
