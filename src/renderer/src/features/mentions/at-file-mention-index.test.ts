import { describe, expect, it } from "vitest"
import type { FileInfo } from "@/types"
import {
  searchWorkspaceMentionFiles,
  searchWorkspaceMentionFilesProgressively
} from "./at-file-mention-index"

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

  it("includes common text files shown by the Files panel but still excludes media", async () => {
    const files: FileInfo[] = [
      { path: "/app/application.properties", is_dir: false },
      { path: "/scripts/build.ps1", is_dir: false },
      { path: "/events/output.jsonl", is_dir: false },
      { path: "/assets/logo.png", is_dir: false }
    ]

    await expect(searchWorkspaceMentionFiles(files, "properties")).resolves.toMatchObject([
      { workspaceFilePath: "/app/application.properties" }
    ])
    await expect(searchWorkspaceMentionFiles(files, "build.ps1")).resolves.toMatchObject([
      { workspaceFilePath: "/scripts/build.ps1" }
    ])
    await expect(searchWorkspaceMentionFiles(files, "output.jsonl")).resolves.toMatchObject([
      { workspaceFilePath: "/events/output.jsonl" }
    ])
    await expect(searchWorkspaceMentionFiles(files, "logo.png")).resolves.toEqual([])
  })

  it("finds a file in a later bounded workspace segment", async () => {
    const initialFiles = largeFixture(100)
    const laterFiles = [
      ...initialFiles,
      { path: "/packages/later/only-after-continuation.ts", is_dir: false }
    ]
    let loadCount = 0
    const updates: string[][] = []

    const result = await searchWorkspaceMentionFilesProgressively(
      initialFiles,
      "only-after-continuation",
      {
        loadMore: async () => {
          loadCount += 1
          return { files: laterFiles, continuationAvailable: false }
        },
        onUpdate: ({ suggestions }) => {
          updates.push(suggestions.map((suggestion) => suggestion.displayPath))
        }
      }
    )

    expect(loadCount).toBe(1)
    expect(updates[0]).toEqual([])
    expect(result.suggestions[0]?.displayPath).toBe(
      "packages/later/only-after-continuation.ts"
    )
  })

  it("does not continue a large scan for a bare @", async () => {
    const files = largeFixture(100)
    let loadCount = 0
    const loadMore = async () => {
      loadCount += 1
      return { files, continuationAvailable: true }
    }

    await searchWorkspaceMentionFilesProgressively(files, "", { loadMore })

    expect(loadCount).toBe(0)
  })

  it("keeps scanning unordered pages when a late exact match beats 15 local matches", async () => {
    const initialFiles: FileInfo[] = Array.from({ length: 10_000 }, (_, index) => ({
      path: `/packages/package-${index}/config.ts.backup-${index}.ts`,
      is_dir: false
    }))
    const laterFiles: FileInfo[] = [
      ...initialFiles,
      { path: "/packages/exact/config.ts", is_dir: false }
    ]
    let loadCount = 0

    const result = await searchWorkspaceMentionFilesProgressively(initialFiles, "config.ts", {
      limit: 15,
      loadMore: async () => {
        loadCount += 1
        return { files: laterFiles, continuationAvailable: false }
      }
    })

    expect(loadCount).toBe(1)
    expect(result.suggestions).toHaveLength(15)
    expect(result.suggestions[0]?.displayPath).toBe("packages/exact/config.ts")
  })

  it("cancels progressive loading before requesting a stale segment", async () => {
    const files = largeFixture(100)
    const controller = new AbortController()
    let loadCount = 0

    await expect(
      searchWorkspaceMentionFilesProgressively(files, "missing", {
        signal: controller.signal,
        loadMore: async () => {
          loadCount += 1
          return { files, continuationAvailable: false }
        },
        onUpdate: () => controller.abort()
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(loadCount).toBe(0)
  })
})
