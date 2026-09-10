import { EventEmitter } from "node:events"
import { Worker } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import type { HarnessWatchRef } from "../../shared/harness-board-types"
import { HarnessWatchRefWorkerClient } from "./watch-ref-client"
import {
  HARNESS_WATCH_REF_MAX_REFS,
  type HarnessWatchRefWorkerResponse
} from "./watch-ref-protocol"

class FakeWatchRefWorker extends EventEmitter {
  readonly requests: Array<Record<string, unknown>> = []

  postMessage(message: Record<string, unknown>): void {
    this.requests.push(message)
  }

  unref(): this {
    return this
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

const clients: HarnessWatchRefWorkerClient[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

function refs(count: number): HarnessWatchRef[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `path-${index}`,
    purpose: "artifacts"
  }))
}

describe("Harness watch-ref worker client", () => {
  it("keeps the main ticker moving while a worker performs a slow install", async () => {
    const worker = new Worker(
      `
        const { parentPort } = require("node:worker_threads")
        parentPort.on("message", (message) => {
          if (message.type === "start") {
            const until = Date.now() + 150
            while (Date.now() < until) {}
            parentPort.postMessage({
              type: "installed",
              scopeKey: message.scopeKey,
              generation: message.generation,
              watcherCount: message.refs.length,
              cancelled: false
            })
          }
        })
      `,
      { eval: true }
    )
    let installedResolve!: (event: Extract<HarnessWatchRefWorkerResponse, { type: "installed" }>) => void
    const installed = new Promise<
      Extract<HarnessWatchRefWorkerResponse, { type: "installed" }>
    >((resolve) => {
      installedResolve = resolve
    })
    const client = new HarnessWatchRefWorkerClient(
      {
        onChanged: () => undefined,
        onDirty: () => undefined,
        onInstalled: installedResolve
      },
      async () => worker
    )
    clients.push(client)

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      client.start("project:a", "C:\\workspace", refs(1_000))
      const result = await installed
      expect(result.watcherCount).toBe(HARNESS_WATCH_REF_MAX_REFS)
    } finally {
      clearInterval(ticker)
    }
    expect(ticks).toBeGreaterThan(10)
  })

  it("cancels A when the same scope installs B and ignores stale worker events", async () => {
    const worker = new FakeWatchRefWorker()
    const changed: string[] = []
    const client = new HarnessWatchRefWorkerClient(
      {
        onChanged: (event) => changed.push(event.workspacePath),
        onDirty: () => undefined
      },
      async () => worker as unknown as Worker
    )
    clients.push(client)

    client.start("run:a", "C:\\workspace-a", refs(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const firstStart = worker.requests.find((request) => request.type === "start")!

    client.start("run:a", "C:\\workspace-b", refs(100))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const starts = worker.requests.filter((request) => request.type === "start")
    const secondStart = starts[1]
    expect(new Int32Array(firstStart.cancelBuffer as SharedArrayBuffer)[0]).toBe(1)
    expect(secondStart.refs).toHaveLength(HARNESS_WATCH_REF_MAX_REFS)

    worker.emit("message", {
      type: "changed",
      scopeKey: "run:a",
      generation: firstStart.generation as number,
      workspacePath: "C:\\workspace-a",
      ref: refs(1)[0],
      at: "2026-08-24T00:00:00.000Z"
    } satisfies HarnessWatchRefWorkerResponse)
    worker.emit("message", {
      type: "changed",
      scopeKey: "run:a",
      generation: secondStart.generation as number,
      workspacePath: "C:\\workspace-b",
      ref: refs(1)[0],
      at: "2026-08-24T00:00:01.000Z"
    } satisfies HarnessWatchRefWorkerResponse)

    expect(changed).toEqual(["C:\\workspace-b"])
    client.stopAll()
    expect(new Int32Array(secondStart.cancelBuffer as SharedArrayBuffer)[0]).toBe(1)
    expect(worker.requests.at(-1)).toMatchObject({ type: "stop-all" })
  })

  it("reinstalls desired scopes after a clean unexpected worker exit", async () => {
    const firstWorker = new FakeWatchRefWorker()
    const replacement = new FakeWatchRefWorker()
    let starts = 0
    const client = new HarnessWatchRefWorkerClient(
      { onChanged: () => undefined, onDirty: () => undefined },
      async () => {
        starts += 1
        return (starts === 1 ? firstWorker : replacement) as unknown as Worker
      }
    )
    clients.push(client)

    client.start("project:recover", "C:\\workspace", refs(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(firstWorker.requests).toHaveLength(1)
    firstWorker.emit("exit", 0)
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(starts).toBe(2)
    expect(replacement.requests).toHaveLength(1)
    expect(replacement.requests[0]).toMatchObject({
      type: "start",
      scopeKey: "project:recover",
      workspacePath: "C:\\workspace"
    })
  })
})
