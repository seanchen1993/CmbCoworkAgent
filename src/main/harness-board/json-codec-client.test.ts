import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import {
  createHarnessJsonCodecWorker,
  HarnessJsonCodecClient
} from "./json-codec-client"
import { HARNESS_WORKER_RESOURCE_LIMITS } from "./worker-limits"

class FakeJsonCodecWorker extends EventEmitter {
  readonly requests: Array<{ requestId: number; bytes: ArrayBuffer }> = []
  terminateCalls = 0

  postMessage(message: { requestId: number; bytes: ArrayBuffer }): void {
    this.requests.push(message)
  }

  unref(): this {
    return this
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1
    return Promise.resolve(0)
  }
}

describe("Harness JSON codec worker client", () => {
  it("parses a large payload off the caller loop with the shared worker resource limits", async () => {
    const workers: Worker[] = []
    const client = new HarnessJsonCodecClient(() => {
      const worker = createHarnessJsonCodecWorker()
      workers.push(worker)
      return worker
    })
    const payload = Buffer.from(JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) }))
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      const result = (await client.parse(payload, "large test store")) as { value: string }
      expect(result.value).toHaveLength(2 * 1024 * 1024)
      expect(workers[0]?.resourceLimits).toMatchObject(HARNESS_WORKER_RESOURCE_LIMITS)
      expect(ticks).toBeGreaterThan(0)
    } finally {
      clearInterval(ticker)
      await client.close()
    }
  })

  it("rejects pending work after a clean exit and recovers on the next request", async () => {
    const first = new FakeJsonCodecWorker()
    const replacement = new FakeJsonCodecWorker()
    let starts = 0
    const client = new HarnessJsonCodecClient(() => {
      starts += 1
      return (starts === 1 ? first : replacement) as unknown as Worker
    })

    const exited = client.parse(Buffer.from("{}"), "first store")
    await new Promise((resolve) => setTimeout(resolve, 0))
    first.emit("exit", 0)
    await expect(exited).rejects.toThrow("exited: 0")

    const retried = client.parse(Buffer.from("{}"), "second store")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const request = replacement.requests[0]!
    replacement.emit("message", { requestId: request.requestId, ok: true, value: { ok: true } })
    await expect(retried).resolves.toEqual({ ok: true })
    expect(starts).toBe(2)
    await client.close()
  })

  it("rejects pending work and terminates the worker during close", async () => {
    const worker = new FakeJsonCodecWorker()
    const client = new HarnessJsonCodecClient(() => worker as unknown as Worker)
    const pending = client.parse(Buffer.from("{}"), "pending store")
    await new Promise((resolve) => setTimeout(resolve, 0))

    await client.close()

    await expect(pending).rejects.toThrow("closing")
    expect(worker.terminateCalls).toBe(1)
  })

  it("does not register work after shutdown drains the pending table", async () => {
    const worker = new FakeJsonCodecWorker()
    const client = new HarnessJsonCodecClient(() => worker as unknown as Worker)

    const prime = client.parse(Buffer.from("{}"), "prime store")
    await new Promise<void>((resolve) => setImmediate(resolve))
    const primeRequest = worker.requests[0]!
    worker.emit("message", {
      requestId: primeRequest.requestId,
      ok: true,
      value: {}
    })
    await prime

    const raced = client.parse(Buffer.from("{}"), "closing store")
    const closeStarted = new Promise<Promise<void>>((resolve) => {
      queueMicrotask(() => resolve(client.close()))
    })

    await expect(raced).rejects.toThrow("closing")
    await (await closeStarted)
    expect(worker.requests).toHaveLength(1)
    expect(
      (client as unknown as { pending: Map<number, unknown> }).pending.size
    ).toBe(0)
  })

  it("bounds retained inputs while the worker is busy", async () => {
    const worker = new FakeJsonCodecWorker()
    const client = new HarnessJsonCodecClient(() => worker as unknown as Worker)
    const requests = Array.from({ length: 21 }, (_, index) =>
      client.parse(Buffer.from(`{"index":${index}}`), `store ${index}`)
    )
    const settlements = Promise.allSettled(requests)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Four messages may be in the worker and sixteen may retain input while
    // waiting. The twenty-first fails fast instead of growing an unbounded map.
    expect(worker.requests).toHaveLength(4)
    await expect(requests[20]).rejects.toThrow("capacity exceeded")

    await client.close()
    const results = await settlements
    expect(results).toHaveLength(21)
    expect(results.every((result) => result.status === "rejected")).toBe(true)
  })
})
