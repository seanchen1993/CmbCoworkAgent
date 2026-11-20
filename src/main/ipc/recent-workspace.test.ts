import { describe, expect, it, vi } from "vitest"
import { resolveRecentWorkspacePath } from "./recent-workspace"

describe("resolveRecentWorkspacePath", () => {
  it("times out a slow UNC probe without starving the main-event-loop ticker", async () => {
    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 1)
    const accessWorkspace = vi.fn(() => new Promise<void>(() => undefined))

    try {
      await expect(
        resolveRecentWorkspacePath(() => "\\\\offline-host\\workspace", {
          accessWorkspace,
          timeoutMs: 25
        })
      ).resolves.toBeNull()
      expect(ticks).toBeGreaterThan(0)
      expect(accessWorkspace).toHaveBeenCalledOnce()
    } finally {
      clearInterval(ticker)
    }
  })

  it("retries once and never publishes a workspace setting from an older generation", async () => {
    let current = "C:\\old-workspace"
    let resolveOld!: () => void
    const oldProbe = new Promise<void>((resolve) => {
      resolveOld = resolve
    })
    const accessWorkspace = vi.fn(async (workspacePath: string) => {
      if (workspacePath === "C:\\old-workspace") await oldProbe
    })

    const pending = resolveRecentWorkspacePath(() => current, {
      accessWorkspace,
      timeoutMs: 100
    })
    current = "C:\\new-workspace"
    resolveOld()

    await expect(pending).resolves.toBe("C:\\new-workspace")
    expect(accessWorkspace.mock.calls.map(([workspacePath]) => workspacePath)).toEqual([
      "C:\\old-workspace",
      "C:\\new-workspace"
    ])
  })
})
