import { afterEach, describe, expect, it, vi } from "vitest"
import { createKnowledgePreviewGrantResolver } from "./knowledge-preview-grant"

afterEach(() => vi.useRealTimers())
const preview = {
  adapterId: "a",
  adapterName: "A",
  configured: true,
  exists: true,
  path: "/plugin/knowledge",
  files: []
}

describe("knowledge preview grant renewal", () => {
  it("renews an expired grant once for concurrent reads and reuses the renewed capability", async () => {
    vi.useFakeTimers()
    const refresh = vi.fn(async () => ({
      ...preview,
      previewGrant: "new",
      previewGrantExpiresAt: Date.now() + 300_000
    }))
    const resolve = createKnowledgePreviewGrantResolver(
      { ...preview, previewGrant: "old", previewGrantExpiresAt: Date.now() - 1 },
      refresh
    )
    expect(await Promise.all([resolve(), resolve()])).toEqual(["new", "new"])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(await resolve()).toBe("new")
    vi.advanceTimersByTime(300_000)
    expect(await resolve()).toBe("new")
    expect(refresh).toHaveBeenCalledTimes(2)
  })
  it("rejects a changed knowledge root or missing capability", async () => {
    const changed = createKnowledgePreviewGrantResolver(preview, async () => ({
      ...preview,
      path: "/other",
      previewGrant: "new"
    }))
    await expect(changed()).rejects.toThrow("目录已变化")
    const denied = createKnowledgePreviewGrantResolver(preview, async () => ({
      ...preview,
      error: "denied"
    }))
    await expect(denied()).rejects.toThrow("denied")
  })
})
