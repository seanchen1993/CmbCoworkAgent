import { describe, expect, it } from "vitest"
import type { FileInfo } from "@/types"
import { searchWorkspaceMentionFiles } from "./at-file-mention-index"

function largeFixture(count: number): FileInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `/packages/package-${Math.floor(index / 100)}/source/file-${index}.ts`,
    is_dir: false,
    size: index
  }))
}

describe("workspace @ mention index", () => {
  it("builds and searches 50k files without monopolizing the renderer task", async () => {
    const files = largeFixture(50_000)
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 1)
    const suggestions = await searchWorkspaceMentionFiles(files, "file-49999", { limit: 15 })
    clearInterval(timer)

    expect(ticks).toBeGreaterThan(5)
    expect(suggestions[0]?.displayPath).toContain("file-49999.ts")
    expect(suggestions).toHaveLength(1)
  })

  it("reuses the projection and selects only the bounded best matches", async () => {
    const files = largeFixture(20_000)
    await searchWorkspaceMentionFiles(files, "file-19999")
    const suggestions = await searchWorkspaceMentionFiles(files, "file-1", { limit: 15 })

    expect(suggestions).toHaveLength(15)
    expect(suggestions[0]?.filename).toBe("file-1.ts")
    expect(suggestions.every((suggestion) => suggestion.filename.includes("file-1"))).toBe(true)
  })

  it("cancels a superseded query between bounded batches", async () => {
    const files = largeFixture(10_000)
    const controller = new AbortController()
    controller.abort()

    await expect(
      searchWorkspaceMentionFiles(files, "file", { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" })
  })
})
