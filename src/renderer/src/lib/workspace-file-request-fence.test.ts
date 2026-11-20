import { afterEach, describe, expect, it, vi } from "vitest"
import { WorkspaceFileRequestFence } from "./workspace-file-request-fence"

afterEach(() => vi.unstubAllGlobals())

describe("WorkspaceFileRequestFence", () => {
  it("rejects a late A request after the same thread switches to B", () => {
    vi.stubGlobal("window", { electron: { process: { platform: "win32" } } })
    const fence = new WorkspaceFileRequestFence()
    const requestA = fence.begin("thread-1", "C:\\workspace-a")

    fence.observe("thread-1", "C:\\workspace-b")
    const requestB = fence.begin("thread-1", "C:\\workspace-b")

    expect(fence.isCurrent(requestA)).toBe(false)
    expect(fence.isCurrent(requestB)).toBe(true)
  })

  it("treats equivalent Windows paths as one workspace identity", () => {
    vi.stubGlobal("window", { electron: { process: { platform: "win32" } } })
    const fence = new WorkspaceFileRequestFence()
    const request = fence.begin("thread-1", "C:\\Workspace\\repo\\")

    fence.observe("thread-1", "c:/workspace/repo")

    expect(fence.isCurrent(request)).toBe(true)
  })
})
