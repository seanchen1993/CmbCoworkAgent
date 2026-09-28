import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("./wal-checkpoint-worker?nodeWorker", () => ({ default: mocks.create }))
import { checkpointWalInBackground } from "./wal-checkpoint"

describe("deletion WAL maintenance", () => {
  beforeEach(() => {
    mocks.create.mockReset()
  })

  it("coalesces overlapping requests and releases the entry after worker exit", async () => {
    const worker = new EventEmitter()
    mocks.create.mockReturnValue(worker)
    const first = checkpointWalInBackground("coalesced.sqlite")
    expect(checkpointWalInBackground("coalesced.sqlite")).toBe(first)
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    worker.emit("exit", 0)
    await first
    const second = checkpointWalInBackground("coalesced.sqlite")
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2))
    worker.emit("exit", 0)
    await second
  })

  it("does not reject an already committed deletion when worker startup fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      mocks.create.mockImplementation(() => {
        throw new Error("worker unavailable")
      })
      await expect(checkpointWalInBackground("failed.sqlite")).resolves.toBeUndefined()
      expect(warning).toHaveBeenCalledOnce()
    } finally {
      warning.mockRestore()
    }
  })

  it("does not turn a worker crash into a retryable deletion", async () => {
    const worker = new EventEmitter()
    mocks.create.mockReturnValue(worker)
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const checkpoint = checkpointWalInBackground("crashed.sqlite")
      await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
      worker.emit("exit", 1)
      await expect(checkpoint).resolves.toBeUndefined()
      expect(warning).toHaveBeenCalledOnce()
    } finally {
      warning.mockRestore()
    }
  })

  it("bounds stalled maintenance and terminates the worker", async () => {
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 1) })
    mocks.create.mockReturnValue(worker)
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    vi.useFakeTimers()
    try {
      const checkpoint = checkpointWalInBackground("stalled.sqlite")
      await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(checkpoint).resolves.toBeUndefined()
      expect(worker.terminate).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      warning.mockRestore()
    }
  })
})
