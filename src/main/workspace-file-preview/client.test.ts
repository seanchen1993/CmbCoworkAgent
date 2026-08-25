import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import { WORKSPACE_FILE_PREVIEW_CANCELLED } from "../../shared/workspace-file-preview"
import { WorkspaceFilePreviewClient } from "./client"

class FakeWorker extends EventEmitter {
  readonly messages: Array<Record<string, unknown>> = []
  terminated = false
  onPost?: (message: Record<string, unknown>) => void

  postMessage(message: Record<string, unknown>): void {
    this.messages.push(message)
    this.onPost?.(message)
  }

  unref(): this {
    return this
  }

  async terminate(): Promise<number> {
    this.terminated = true
    return 0
  }
}

const source = {
  externalFullPath: "C:/safe/large.log",
  trustedRootPath: "C:/safe"
} as const

function successResponse(requestId: number, content: string) {
  return {
    type: "read-text-result",
    requestId,
    ok: true,
    resolvedPath: source.externalFullPath,
    result: {
      success: true,
      content,
      contentBytes: content.length,
      size: content.length,
      modified_at: "2026-08-24T00:00:00.000Z",
      offset: 0,
      nextOffset: null,
      hasMore: false,
      hasPrevious: false,
      truncated: false,
      lineCount: 1
    }
  }
}

describe("workspace file preview client", () => {
  it("makes rapid A → B → C requests latest-wins on one sender lane", async () => {
    const worker = new FakeWorker()
    const client = new WorkspaceFilePreviewClient(async () => worker as unknown as Worker)
    const a = client.readText(source, undefined, 0, "sender-1:active-file-tab")
    await Promise.resolve()
    const aRejected = expect(a).rejects.toMatchObject({ name: WORKSPACE_FILE_PREVIEW_CANCELLED })
    const b = client.readText(source, undefined, 0, "sender-1:active-file-tab")
    await Promise.resolve()
    const bRejected = expect(b).rejects.toMatchObject({ name: WORKSPACE_FILE_PREVIEW_CANCELLED })
    const c = client.readText(source, undefined, 0, "sender-1:active-file-tab")
    await Promise.resolve()

    const readMessages = worker.messages.filter((message) => message.type === "read-text")
    const cMessage = readMessages.at(-1)
    worker.emit("message", successResponse(cMessage?.requestId as number, "C"))

    await aRejected
    await bRejected
    await expect(c).resolves.toMatchObject({ result: { content: "C" } })
    const firstCancellation = new Int32Array(
      readMessages[0].cancellationBuffer as SharedArrayBuffer
    )
    expect(Atomics.load(firstCancellation, 0)).toBe(1)
    await client.close()
  })

  it("cancels an unmounted lane and closes its reusable worker", async () => {
    const worker = new FakeWorker()
    const client = new WorkspaceFilePreviewClient(async () => worker as unknown as Worker)
    const pending = client.readText(source, undefined, 0, "sender-1:right-panel")
    await Promise.resolve()
    const rejected = expect(pending).rejects.toMatchObject({
      name: WORKSPACE_FILE_PREVIEW_CANCELLED
    })
    client.cancelLatest("sender-1:right-panel")
    await rejected
    await client.close()
    expect(worker.terminated).toBe(true)
  })

  it("keeps the caller ticker moving while the worker response is pending", async () => {
    const worker = new FakeWorker()
    worker.onPost = (message) => {
      if (message.type !== "read-text") return
      setTimeout(() => {
        worker.emit("message", successResponse(message.requestId as number, "done"))
      }, 80)
    }
    const client = new WorkspaceFilePreviewClient(async () => worker as unknown as Worker)
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    try {
      await client.readText(source, undefined, 0, "sender-1:active-file-tab")
    } finally {
      clearInterval(ticker)
      await client.close()
    }
    expect(ticks).toBeGreaterThan(2)
  })
})
