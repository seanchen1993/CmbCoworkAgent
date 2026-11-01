import type { Worker } from "node:worker_threads"
import { describe, expect, it, vi } from "vitest"
import {
  isWorkspaceWatcherCancelled,
  WORKSPACE_WATCHER_MAX_PATH_LENGTH,
  WorkspaceWatcherWorkerClient
} from "./client"
import type { WorkspaceWatcherWorkerResponse } from "./protocol"

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

class FakeWorker {
  readonly postMessage = vi.fn()
  readonly terminate = vi.fn(async () => 0)
  readonly unref = vi.fn()
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>()

  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  emitMessage(response: WorkspaceWatcherWorkerResponse): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener(response as never)
    }
  }

  emitError(error: Error): void {
    for (const listener of this.listeners.get("error") ?? []) {
      listener(error as never)
    }
  }
}

describe("WorkspaceWatcherWorkerClient", () => {
  it("rejects an oversized path before creating a Worker", async () => {
    const factory = vi.fn(async () => new FakeWorker() as unknown as Worker)
    const client = new WorkspaceWatcherWorkerClient(
      "x".repeat(WORKSPACE_WATCHER_MAX_PATH_LENGTH + 1),
      vi.fn(),
      vi.fn(),
      factory
    )

    await expect(client.start()).rejects.toThrow(/hard limit/)
    expect(factory).not.toHaveBeenCalled()
  })

  it("starts, forwards events, and terminates the owning worker on close", async () => {
    const worker = new FakeWorker()
    const onEvent = vi.fn()
    const onError = vi.fn()
    const client = new WorkspaceWatcherWorkerClient(
      "//server/workspace",
      onEvent,
      onError,
      async () => worker as unknown as Worker
    )

    const start = client.start()
    await vi.waitFor(() =>
      expect(worker.postMessage).toHaveBeenCalledWith({
        type: "start",
        requestId: 1,
        workspacePath: "//server/workspace"
      })
    )
    const observation = {
      canonicalPath: "//server/workspace",
      rootIdentity: "999999999999999999:777777777777777777"
    }
    worker.emitMessage({ type: "start-result", requestId: 1, ok: true, observation })
    await expect(start).resolves.toBeUndefined()
    expect(client.observation).toEqual(observation)
    const copy = client.observation!
    copy.rootIdentity = "0:0"
    expect(client.observation?.rootIdentity).toBe(observation.rootIdentity)
    worker.emitMessage({
      type: "event-batch",
      events: [{ eventType: "change", filename: "src/file.ts" }]
    })
    expect(onEvent).toHaveBeenCalledWith({
      eventType: "change",
      filename: "src/file.ts"
    })

    client.close()
    worker.emitMessage({ type: "start-result", requestId: 1, ok: true, observation })
    expect(client.observation).toBeUndefined()
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "shutdown" })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("cancels a worker that resolves after its coordinator was closed", async () => {
    const worker = new FakeWorker()
    const factory = deferred<Worker>()
    const client = new WorkspaceWatcherWorkerClient(
      "/workspace-a",
      vi.fn(),
      vi.fn(),
      () => factory.promise
    )

    const start = client.start()
    client.close()
    factory.resolve(worker as unknown as Worker)

    await expect(start).rejects.toSatisfy(isWorkspaceWatcherCancelled)
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledTimes(1))
    expect(worker.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "start" }))
  })

  it("surfaces a worker failure after the watcher has started", async () => {
    const worker = new FakeWorker()
    const onError = vi.fn()
    const client = new WorkspaceWatcherWorkerClient(
      "/workspace-restart",
      vi.fn(),
      onError,
      async () => worker as unknown as Worker
    )
    const start = client.start()
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled())
    worker.emitMessage({
      type: "start-result",
      requestId: 1,
      ok: true,
      observation: { canonicalPath: "/workspace-restart", rootIdentity: "1:2" }
    })
    await start
    expect(client.observation?.rootIdentity).toBe("1:2")

    worker.emitError(new Error("worker disconnected"))
    expect(client.observation).toBeUndefined()
    worker.emitMessage({
      type: "start-result",
      requestId: 1,
      ok: true,
      observation: { canonicalPath: "/workspace-restart", rootIdentity: "1:2" }
    })
    expect(client.observation).toBeUndefined()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "worker disconnected" })
    )
    client.close()
  })

  it("keeps legacy startup working but provides no invented directory evidence", async () => {
    const worker = new FakeWorker()
    const client = new WorkspaceWatcherWorkerClient(
      "/workspace",
      vi.fn(),
      vi.fn(),
      async () => worker as unknown as Worker
    )
    const start = client.start()
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled())
    worker.emitMessage({ type: "start-result", requestId: 1, ok: true })
    await expect(start).resolves.toBeUndefined()
    expect(client.observation).toBeUndefined()
    client.close()
  })
})
