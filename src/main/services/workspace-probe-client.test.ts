import { EventEmitter } from "node:events"
import { resolve } from "node:path"
import type { Worker, WorkerOptions } from "node:worker_threads"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceProbeClient } from "./workspace-probe-client"
import type { WorkspaceProbeRequest, WorkspaceProbeResponse } from "./workspace-probe-protocol"

class HeldWorker extends EventEmitter {
  terminations = 0
  rejectTermination = false
  constructor(readonly request: WorkspaceProbeRequest) {
    super()
  }
  unref() {
    /* The fixture owns no native thread. */
  }
  terminate(): Promise<number> {
    this.terminations++
    return this.rejectTermination
      ? Promise.reject(Error("held termination"))
      : new Promise(() => {})
  }
  reply(overrides: Partial<Omit<WorkspaceProbeResponse, "result">> & { result?: unknown } = {}) {
    this.request.port.postMessage({
      id: this.request.id,
      generation: this.request.generation,
      nonce: this.request.nonce,
      workspace: this.request.workspace,
      completedAt: process.hrtime.bigint(),
      result: { canonical: resolve("workspace") },
      ...overrides
    })
  }
  exit() {
    this.request.port.close()
    this.emit("exit", 0)
  }
}
const workers: HeldWorker[] = []
const clients: WorkspaceProbeClient[] = []
function fixture(timeout = 3_000, maxWaiters = 1) {
  const factory = vi.fn((options: WorkerOptions) => {
    const worker = new HeldWorker(options.workerData as WorkspaceProbeRequest)
    workers.push(worker)
    return worker as unknown as Worker
  })
  const client = new WorkspaceProbeClient(factory, timeout, 1, maxWaiters)
  clients.push(client)
  return { client, factory }
}
afterEach(async () => {
  for (const worker of workers.splice(0)) worker.exit()
  await Promise.resolve()
  for (const client of clients.splice(0)) await client.close()
  vi.useRealTimers()
})

describe("workspace probe physical ownership", () => {
  it("drains an already-posted result before an exit callback without waiting for message dispatch", async () => {
    const { client } = fixture()
    const pending = client.probe(resolve("workspace"))
    workers[0].reply()
    workers[0].exit()
    await expect(pending).resolves.toBe(resolve("workspace"))
    await Promise.resolve()
    expect(client.status().active).toBe(0)
  })

  it.each(["nonce", "id", "generation", "workspace"] as const)(
    "rejects a foreign %s without admitting its canonical result",
    async (field) => {
      const { client } = fixture()
      const pending = client.probe(resolve("workspace"))
      const rejected = expect(pending).rejects.toMatchObject({ reason: "unavailable" })
      workers[0].reply(
        field === "id" || field === "generation" ? { [field]: -1 } : { [field]: "foreign" }
      )
      workers[0].exit()
      await rejected
    }
  )

  it("rejects late completion even when its packet is available before the main timer fires", async () => {
    const { client } = fixture()
    const pending = client.probe(resolve("workspace"))
    const rejected = expect(pending).rejects.toMatchObject({ reason: "timeout" })
    workers[0].reply({ completedAt: workers[0].request.deadline + 1n })
    workers[0].exit()
    await rejected
  })

  it.each([true, "not-an-object", 1, null])(
    "rejects malformed result %j without an uncaught callback error",
    async (result) => {
      const { client } = fixture()
      const pending = client.probe(resolve("workspace"))
      const rejected = expect(pending).rejects.toMatchObject({ reason: "unavailable" })
      workers[0].reply({ result })
      workers[0].exit()
      await rejected
    }
  )

  it("does not release an unknown physical worker when termination rejects or the caller times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { client, factory } = fixture(30, 0)
    const pending = client.probe(resolve("workspace"))
    workers[0].rejectTermination = true
    const rejected = expect(pending).rejects.toMatchObject({ reason: "timeout" })
    await vi.advanceTimersByTimeAsync(30)
    await rejected
    expect(client.status().active).toBe(1)
    await expect(client.probe(resolve("another"))).rejects.toMatchObject({ reason: "capacity" })
    expect(factory).toHaveBeenCalledTimes(1)
    await expect(client.close(0)).rejects.toThrow("cleanup remains unconfirmed")
    expect(client.status().active).toBe(1)
    workers[0].exit()
    await Promise.resolve()
    expect(client.status().active).toBe(0)
  })

  it("uses one deadline across queuing and worker birth rather than restarting the timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const { client } = fixture(30)
    const first = client.probe(resolve("first")).catch((error) => error)
    const second = client.probe(resolve("second"))
    const rejected = expect(second).rejects.toMatchObject({ reason: "timeout" })
    expect(client.status().queued).toBe(1)
    await vi.advanceTimersByTimeAsync(20)
    workers[0].exit()
    await first
    await vi.advanceTimersByTimeAsync(0)
    expect(workers).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(10)
    await rejected
    expect(workers[1].terminations).toBeGreaterThan(0)
  })

  it("includes asynchronous startup and retains a late factory until its exact thread exits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let birth!: (worker: Worker) => void
    let request!: WorkspaceProbeRequest
    const client = new WorkspaceProbeClient(
      (options) => {
        request = options.workerData as WorkspaceProbeRequest
        return new Promise((resolve) => {
          birth = resolve
        })
      },
      30,
      1,
      0
    )
    clients.push(client)
    const pending = client.probe(resolve("workspace"))
    const rejected = expect(pending).rejects.toMatchObject({ reason: "timeout" })
    await vi.advanceTimersByTimeAsync(30)
    await rejected
    expect(client.status().active).toBe(1)
    const worker = new HeldWorker(request)
    workers.push(worker)
    birth(worker as unknown as Worker)
    await Promise.resolve()
    expect(worker.terminations).toBeGreaterThan(0)
    expect(client.status().active).toBe(1)
    worker.exit()
    await Promise.resolve()
    expect(client.status().active).toBe(0)
  })

  it("does not create a worker for early abort and removes queued abort without borrowing another owner", async () => {
    const { client, factory } = fixture()
    const early = new AbortController()
    early.abort()
    await expect(client.probe(resolve("early"), early.signal)).rejects.toMatchObject({
      name: "AbortError"
    })
    expect(factory).not.toHaveBeenCalled()
    const first = client.probe(resolve("first"))
    const queued = new AbortController()
    const second = client.probe(resolve("second"), queued.signal)
    const rejected = expect(second).rejects.toMatchObject({ name: "AbortError" })
    queued.abort()
    await rejected
    expect(client.status()).toMatchObject({ active: 1, queued: 0 })
    workers[0].reply()
    workers[0].exit()
    await first
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("aborts a live caller without accepting its later result or releasing its physical slot", async () => {
    const { client } = fixture()
    const controller = new AbortController()
    const pending = client.probe(resolve("workspace"), controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    controller.abort()
    await rejected
    expect(client.status().active).toBe(1)
    workers[0].reply()
    await new Promise((resolve) => setImmediate(resolve))
    expect(client.status().active).toBe(1)
    workers[0].exit()
  })

  it("an old exit cannot release a replacement generation and close cannot admit another request", async () => {
    const { client, factory } = fixture()
    const first = client.probe(resolve("first"))
    const old = workers[0]
    old.reply()
    old.exit()
    await first
    const second = client.probe(resolve("second"))
    const rejected = expect(second).rejects.toMatchObject({ reason: "unavailable" })
    old.exit()
    await Promise.resolve()
    expect(client.status().active).toBe(1)
    await expect(client.close(0)).rejects.toThrow("cleanup remains unconfirmed")
    await rejected
    await expect(client.probe(resolve("third"))).rejects.toMatchObject({ reason: "unavailable" })
    expect(factory).toHaveBeenCalledTimes(2)
    workers[1].exit()
    await Promise.resolve()
    await client.close()
  })
})
