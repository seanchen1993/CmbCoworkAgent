import { mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openStableFileHandle } from "../services/stable-file-handle"
import {
  handleWorkspaceFilePreviewProtocolRequest,
  parseMediaByteRange
} from "./media-protocol"
import {
  WorkspaceFilePreviewMediaRegistry,
  mediaPreviewUrl
} from "./media-registry"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe("workspace media preview byte ranges", () => {
  it("supports full, bounded, open-ended and suffix requests", () => {
    expect(parseMediaByteRange(null, 1_000)).toBeNull()
    expect(parseMediaByteRange("bytes=10-19", 1_000)).toEqual({ start: 10, end: 19 })
    expect(parseMediaByteRange("bytes=990-", 1_000)).toEqual({ start: 990, end: 999 })
    expect(parseMediaByteRange("bytes=-20", 1_000)).toEqual({ start: 980, end: 999 })
  })

  it("rejects multi-range, reversed and out-of-bounds requests", () => {
    expect(parseMediaByteRange("bytes=0-1,4-5", 1_000)).toEqual({ invalid: true })
    expect(parseMediaByteRange("bytes=20-10", 1_000)).toEqual({ invalid: true })
    expect(parseMediaByteRange("bytes=1000-", 1_000)).toEqual({ invalid: true })
  })

  it("streams the authorized handle rather than a replacement at the same path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cmb-media-handle-"))
    tempDirectories.push(root)
    const filePath = path.join(root, "preview.bin")
    const movedPath = path.join(root, "preview-original.bin")
    await writeFile(filePath, "authorized-media")
    const opened = await openStableFileHandle(root, filePath)
    const registry = new WorkspaceFilePreviewMediaRegistry()
    const entry = registry.issue({
      ownerId: 1,
      lane: "media",
      requestToken: "generation-a",
      fileHandle: opened.handle,
      filePath: opened.filePath,
      fileName: "preview.bin",
      mimeType: "application/octet-stream",
      size: opened.size,
      modified_at: opened.modified_at
    })

    await rename(filePath, movedPath)
    await writeFile(filePath, "replacement-data")
    const response = await handleWorkspaceFilePreviewProtocolRequest(
      new Request(mediaPreviewUrl(entry)),
      registry
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("authorized-media")
    registry.clear()
  })
})
