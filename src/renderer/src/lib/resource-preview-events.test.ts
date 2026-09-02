import { afterEach, describe, expect, it, vi } from "vitest"
import {
  beginOpenResourcePreviewIntent,
  emitOpenResourcePreview,
  isCurrentOpenResourcePreviewIntent,
  onOpenResourcePreview,
  type OpenResourcePreviewDetail
} from "./resource-preview-events"

function installWindow(platform: NodeJS.Platform): void {
  const fakeWindow = Object.assign(new EventTarget(), {
    electron: { process: { platform } }
  })
  vi.stubGlobal("window", fakeWindow)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("resource preview events", () => {
  it("carries POSIX tool absolute intent through the event", () => {
    installWindow("linux")
    let received: OpenResourcePreviewDetail | null = null
    const cleanup = onOpenResourcePreview((detail) => {
      received = detail
    })

    emitOpenResourcePreview({
      threadId: "thread-1",
      filePath: "/tmp/report.md",
      toolCallId: "call-1"
    })

    expect(received).toMatchObject({
      filePath: "/tmp/report.md",
      intentId: expect.any(Number),
      toolCallId: "call-1",
      workspacePathKind: "absolute"
    })
    cleanup()
  })

  it("preserves an intent reserved before asynchronous authorization", () => {
    installWindow("linux")
    const received: OpenResourcePreviewDetail[] = []
    const cleanup = onOpenResourcePreview((detail) => received.push(detail))
    const earlierIntent = beginOpenResourcePreviewIntent("thread-1")
    const laterIntent = beginOpenResourcePreviewIntent("thread-1")

    emitOpenResourcePreview({
      threadId: "thread-1",
      filePath: "/tmp/later.md",
      intentId: laterIntent
    })
    emitOpenResourcePreview({
      threadId: "thread-1",
      filePath: "/tmp/earlier.md",
      intentId: earlierIntent
    })

    expect(received.map((detail) => detail.intentId)).toEqual([laterIntent, earlierIntent])
    expect(isCurrentOpenResourcePreviewIntent("thread-1", laterIntent, 0)).toBe(true)
    expect(isCurrentOpenResourcePreviewIntent("thread-1", earlierIntent, 0)).toBe(false)
    beginOpenResourcePreviewIntent("thread-1")
    expect(isCurrentOpenResourcePreviewIntent("thread-1", laterIntent, 0)).toBe(false)
    cleanup()
  })

  it("preserves explicit file-tree-relative intent", () => {
    installWindow("linux")
    let received: OpenResourcePreviewDetail | null = null
    const cleanup = onOpenResourcePreview((detail) => {
      received = detail
    })

    emitOpenResourcePreview({
      threadId: "thread-1",
      filePath: "/src/index.ts",
      workspacePathKind: "relative"
    })

    expect(received).toMatchObject({
      filePath: "/src/index.ts",
      workspacePathKind: "relative"
    })
    cleanup()
  })

  it("does not let an unissued numeric intent poison later preview ordering", () => {
    installWindow("linux")
    let received: OpenResourcePreviewDetail | null = null
    const cleanup = onOpenResourcePreview((detail) => {
      received = detail
    })

    emitOpenResourcePreview({
      threadId: "thread-poison",
      filePath: "/tmp/report.md",
      intentId: Number.MAX_SAFE_INTEGER
    })

    expect(received).not.toBeNull()
    expect((received as OpenResourcePreviewDetail | null)?.intentId).not.toBe(
      Number.MAX_SAFE_INTEGER
    )
    cleanup()
  })
})
