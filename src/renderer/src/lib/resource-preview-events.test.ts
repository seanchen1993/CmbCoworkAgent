import { afterEach, describe, expect, it, vi } from "vitest"
import {
  emitOpenResourcePreview,
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

    emitOpenResourcePreview({ threadId: "thread-1", filePath: "/tmp/report.md" })

    expect(received).toMatchObject({
      filePath: "/tmp/report.md",
      workspacePathKind: "absolute"
    })
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
})
