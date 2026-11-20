import { afterEach, describe, expect, it, vi } from "vitest"

const managerMocks = vi.hoisted(() => {
  const sessions = new Map<
    string,
    {
      closed: boolean
      open: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      next: ReturnType<typeof vi.fn>
      nextResult?: {
        files: Array<{ path: string; is_dir: boolean }>
        done: boolean
        truncated: boolean
        continuation?: string
      }
    }
  >()
  return { sessions }
})

vi.mock("./client", () => ({
  WorkspaceFileScanSession: class {
    readonly record: {
      closed: boolean
      open: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      next: ReturnType<typeof vi.fn>
      nextResult?: {
        files: Array<{ path: string; is_dir: boolean }>
        done: boolean
        truncated: boolean
        continuation?: string
      }
    }

    constructor(readonly scanId: string) {
      this.record = {
        closed: false,
        open: vi.fn(async () => undefined),
        close: vi.fn(async () => {
          this.record.closed = true
        }),
        next: vi.fn(async () =>
          this.record.nextResult ?? { files: [], done: true, truncated: false }
        )
      }
      managerMocks.sessions.set(scanId, this.record)
    }

    async open(): Promise<void> {
      await this.record.open()
    }

    async next(): Promise<{
      files: Array<{ path: string; is_dir: boolean }>
      done: boolean
      truncated: boolean
      continuation?: string
    }> {
      return this.record.next()
    }

    async close(): Promise<void> {
      await this.record.close()
    }
  }
}))

describe("workspace file scan manager budgets", () => {
  afterEach(async () => {
    const manager = await import("./manager")
    await manager.closeAllWorkspaceFileScans()
    managerMocks.sessions.clear()
  })

  it("evicts the oldest owner scan instead of retaining unbounded workers", async () => {
    const manager = await import("./manager")
    const opened: Array<{ scanId: string; workspacePath: string }> = []
    for (let index = 0; index < 5; index += 1) {
      opened.push(await manager.openWorkspaceFileScan(7, `/workspace-${index}`))
    }

    expect(manager.getActiveWorkspaceFileScanCountForTests()).toBe(4)
    expect(managerMocks.sessions.get(opened[0].scanId)?.closed).toBe(true)
    await expect(manager.readWorkspaceFileScanPage(7, opened[0].scanId)).rejects.toThrow(
      "not available"
    )
  })

  it("keeps the aggregate scan-worker count hard bounded across owners", async () => {
    const manager = await import("./manager")
    const opened: Array<{ scanId: string; workspacePath: string }> = []
    for (let index = 0; index < 13; index += 1) {
      opened.push(await manager.openWorkspaceFileScan(index, `/workspace-${index}`))
    }

    expect(manager.getActiveWorkspaceFileScanCountForTests()).toBe(12)
    expect(managerMocks.sessions.get(opened[0].scanId)?.closed).toBe(true)
  })

  it("shares a live directory snapshot with the watcher at a segment boundary", async () => {
    const manager = await import("./manager")
    const opened = await manager.openWorkspaceFileScan(9, "/workspace-segmented")
    const session = managerMocks.sessions.get(opened.scanId)
    if (!session) throw new Error("missing scan session")
    session.nextResult = {
      files: [{ path: "/first-dir", is_dir: true }],
      done: false,
      truncated: true,
      continuation: "continue-directories"
    }

    const partial = await manager.readWorkspaceFileScanPage(9, opened.scanId)
    expect(partial.directories).toEqual(new Set(["first-dir"]))
    expect(manager.getActiveWorkspaceFileScanCountForTests()).toBe(1)

    session.nextResult = {
      files: [{ path: "/second-dir", is_dir: true }],
      done: true,
      truncated: false
    }
    const complete = await manager.readWorkspaceFileScanPage(
      9,
      opened.scanId,
      "continue-directories"
    )
    expect(complete.directories).toBe(partial.directories)
    expect(partial.directories).toEqual(new Set(["first-dir", "second-dir"]))
  })
})
