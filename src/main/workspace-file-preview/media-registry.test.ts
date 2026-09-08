import { describe, expect, it } from "vitest"
import type { FileHandle } from "node:fs/promises"
import {
  WORKSPACE_FILE_PREVIEW_MAX_MEDIA_TOKENS_PER_OWNER,
  WORKSPACE_FILE_PREVIEW_MEDIA_TOKEN_TTL_MS,
  WorkspaceFilePreviewMediaRegistry,
  mediaPreviewUrl
} from "./media-registry"

function issue(
  registry: WorkspaceFilePreviewMediaRegistry,
  ownerId: number,
  index: number,
  lane = "markdown",
  onClose?: () => void
) {
  return registry.issue({
    ownerId,
    lane,
    requestToken: "generation-a",
    fileHandle: {
      close: async () => onClose?.()
    } as unknown as FileHandle,
    filePath: `/workspace/image-${index}.png`,
    fileName: `image-${index}.png`,
    mimeType: "image/png",
    size: 1024,
    modified_at: "2026-08-24T00:00:00.000Z"
  })
}

describe("workspace media preview registry", () => {
  it("keeps 20+ Markdown images alive during one bounded generation", () => {
    const registry = new WorkspaceFilePreviewMediaRegistry()
    const entries = Array.from({ length: 24 }, (_, index) => issue(registry, 1, index))
    expect(WORKSPACE_FILE_PREVIEW_MAX_MEDIA_TOKENS_PER_OWNER).toBeGreaterThanOrEqual(24)
    expect(entries.every((entry) => registry.lookup(entry.token)?.filePath === entry.filePath)).toBe(
      true
    )
  })

  it("binds release to the owner and revokes a whole generation by lane", () => {
    const registry = new WorkspaceFilePreviewMediaRegistry()
    const first = issue(registry, 1, 1)
    issue(registry, 1, 2, "markdown:image-a")
    expect(registry.revokeUrl(2, mediaPreviewUrl(first))).toBe(false)
    expect(registry.lookup(first.token)).not.toBeNull()
    expect(registry.revokeLane(1, "markdown", "generation-a")).toBe(2)
    expect(registry.sizeForTests()).toBe(0)
  })

  it("expires idle bearer URLs and refreshes active ones", () => {
    let now = 100
    const registry = new WorkspaceFilePreviewMediaRegistry(() => now)
    const entry = issue(registry, 1, 1)
    now += WORKSPACE_FILE_PREVIEW_MEDIA_TOKEN_TTL_MS - 1
    expect(registry.lookup(entry.token)).not.toBeNull()
    now += WORKSPACE_FILE_PREVIEW_MEDIA_TOKEN_TTL_MS - 1
    expect(registry.lookup(entry.token)).not.toBeNull()
    now += WORKSPACE_FILE_PREVIEW_MEDIA_TOKEN_TTL_MS + 1
    expect(registry.lookup(entry.token)).toBeNull()
  })

  it("closes stable handles on release and expiry", async () => {
    let now = 100
    let closed = 0
    const registry = new WorkspaceFilePreviewMediaRegistry(() => now)
    const released = issue(registry, 1, 1, "markdown", () => {
      closed += 1
    })
    expect(registry.revokeUrl(1, mediaPreviewUrl(released))).toBe(true)
    await Promise.resolve()
    expect(closed).toBe(1)

    issue(registry, 1, 2, "markdown", () => {
      closed += 1
    })
    now += WORKSPACE_FILE_PREVIEW_MEDIA_TOKEN_TTL_MS + 1
    expect(registry.pruneExpired()).toBe(1)
    await Promise.resolve()
    expect(closed).toBe(2)
  })
})
