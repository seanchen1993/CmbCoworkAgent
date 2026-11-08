import { EventEmitter } from "node:events"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Page } from "playwright"
import { withChatRunningRendererProfile } from "../support/chat-running-renderer-profile"

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  open: vi.fn(() => 7),
  close: vi.fn(),
  chunk: vi.fn((_fd: number, _data: Buffer, _offset: number, length: number) => length),
  stopRows: vi.fn(async () => ({ diagnosticOnly: true }))
}))
vi.mock("node:fs", () => ({
  writeFileSync: mocks.write,
  openSync: mocks.open,
  closeSync: mocks.close,
  writeSync: mocks.chunk
}))
vi.mock("../support/chat-running-row-profile", () => ({
  startChatRunningRowProfile: async () => ({ stop: mocks.stopRows })
}))
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("CHAT_RUNNING_RENDERER_PROFILE", "1")
})
afterEach(() => {
  vi.unstubAllEnvs()
})

function fixture(options: { noComplete?: boolean; stopFailure?: Error; data?: string } = {}) {
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async (method: string) => {
      if (method === "Profiler.stop" && options.stopFailure) throw options.stopFailure
      if (method === "Tracing.end" && !options.noComplete)
        cdp.emit("Tracing.tracingComplete", { stream: "trace" })
      if (method === "IO.read") return { data: options.data ?? "{}", eof: true }
      return { profile: {} }
    }),
    detach: vi.fn(async () => {})
  })
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ newCDPSession: async () => cdp })
  }) as unknown as Page
  return { cdp, page }
}

it("preserves the business error while independently stopping trace, rows and CDP", async () => {
  const business = new Error("business failure"),
    diagnostic = new Error("CPU stop failure")
  const { cdp, page } = fixture({ stopFailure: diagnostic })
  const failure = await withChatRunningRendererProfile(page, "unused", async () => {
    throw business
  }).catch((error) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.cause).toBe(business)
  expect(failure.errors[0]).toBe(business)
  expect(failure.errors[1].cause).toBe(diagnostic)
  expect(cdp.send).toHaveBeenCalledWith("Tracing.end")
  expect(cdp.send).toHaveBeenCalledWith("IO.close", { handle: "trace" })
  expect(mocks.stopRows).toHaveBeenCalledOnce()
  expect(cdp.detach).toHaveBeenCalledOnce()
  expect(cdp.listenerCount("Tracing.tracingComplete")).toBe(0)
})

it("detaches and reports row cleanup failures instead of passing", async () => {
  const { cdp, page } = fixture()
  mocks.stopRows.mockRejectedValueOnce(new Error("renderer closed"))
  await expect(
    withChatRunningRendererProfile(page, "unused", async () => {})
  ).rejects.toBeInstanceOf(AggregateError)
  expect(cdp.detach).toHaveBeenCalledOnce()
  expect(mocks.close).toHaveBeenCalledWith(7)
})

it("bounds a missing trace completion event and still detaches", async () => {
  const { cdp, page } = fixture({ noComplete: true })
  await expect(
    withChatRunningRendererProfile(page, "unused", async () => {}, {
      traceBytes: 10,
      traceTimeoutMs: 5
    })
  ).rejects.toBeInstanceOf(AggregateError)
  expect(mocks.stopRows).toHaveBeenCalledOnce()
  expect(cdp.detach).toHaveBeenCalledOnce()
  expect(cdp.listenerCount("Tracing.tracingComplete")).toBe(0)
})

it("writes bounded chunks, records truncation and fails the diagnostic", async () => {
  const { cdp, page } = fixture({ data: "123456789" })
  await expect(
    withChatRunningRendererProfile(page, "unused", async () => {}, {
      traceBytes: 4,
      traceTimeoutMs: 100
    })
  ).rejects.toBeInstanceOf(AggregateError)
  expect(mocks.chunk.mock.calls[0][1].toString()).toBe("1234")
  expect(mocks.close).toHaveBeenCalledWith(7)
  expect(cdp.send).toHaveBeenCalledWith("IO.close", { handle: "trace" })
  const metadata = JSON.parse(
    mocks.write.mock.calls.find((call) =>
      String(call[0]).endsWith("running-renderer-console.json")
    )![1]
  )
  expect(metadata.trace).toEqual({ bytes: 4, truncated: true, byteLimit: 4 })
  expect(cdp.detach).toHaveBeenCalledOnce()
})

it("preserves the original error identity when diagnostic cleanup succeeds", async () => {
  const { page } = fixture()
  const business = new Error("original")
  await expect(
    withChatRunningRendererProfile(page, "unused", async () => {
      throw business
    })
  ).rejects.toBe(business)
})

it("closes the trace stream and detaches after a filesystem failure", async () => {
  const { cdp, page } = fixture()
  mocks.chunk.mockImplementationOnce(() => {
    throw new Error("disk full")
  })
  await expect(
    withChatRunningRendererProfile(page, "unused", async () => {})
  ).rejects.toBeInstanceOf(AggregateError)
  expect(mocks.close).toHaveBeenCalledWith(7)
  expect(cdp.send).toHaveBeenCalledWith("IO.close", { handle: "trace" })
  expect(mocks.stopRows).toHaveBeenCalledOnce()
  expect(cdp.detach).toHaveBeenCalledOnce()
})
