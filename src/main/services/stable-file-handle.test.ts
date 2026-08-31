import { appendFile, mkdtemp, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "./stable-file-handle"

const tempDirectories: string[] = []

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
  vi.restoreAllMocks()
})

describe("stable file handle", () => {
  it("keeps reading the authorized inode after its path is replaced", async () => {
    const root = await tempDirectory("cmb-stable-file-")
    const filePath = path.join(root, "preview.txt")
    const movedPath = path.join(root, "preview-original.txt")
    await writeFile(filePath, "authorized")

    const opened = await openStableFileHandle(root, filePath)
    try {
      await rename(filePath, movedPath)
      await writeFile(filePath, "replacement")
      const bytes = await opened.handle.readFile()
      expect(bytes.toString("utf8")).toBe("authorized")
    } finally {
      await opened.handle.close()
    }
  })

  it("rejects a candidate outside the trusted root", async () => {
    const root = await tempDirectory("cmb-stable-root-")
    const outside = await tempDirectory("cmb-stable-outside-")
    const filePath = path.join(outside, "outside.txt")
    await writeFile(filePath, "outside")

    await expect(openStableFileHandle(root, filePath)).rejects.toThrow(
      "outside the trusted root"
    )
  })

  it("reads a file exactly at the configured byte cap", async () => {
    const root = await tempDirectory("cmb-stable-bounded-exact-")
    const filePath = path.join(root, "exact.txt")
    await writeFile(filePath, "0123456789")

    const opened = await openStableFileHandle(root, filePath)
    try {
      const bytes = await readStableFileHandleBounded(opened, 10)
      expect(bytes.toString("utf8")).toBe("0123456789")
    } finally {
      await opened.handle.close()
    }
  })

  it("allocates from the initial file size instead of a large caller cap", async () => {
    const root = await tempDirectory("cmb-stable-bounded-small-")
    const filePath = path.join(root, "small.txt")
    await writeFile(filePath, "tiny")
    const allocation = vi.spyOn(Buffer, "allocUnsafe")

    const opened = await openStableFileHandle(root, filePath)
    try {
      const bytes = await readStableFileHandleBounded(opened, 128 * 1024 * 1024)
      expect(bytes.toString("utf8")).toBe("tiny")
      expect(allocation).toHaveBeenCalledWith(5)
    } finally {
      await opened.handle.close()
    }
  })

  it("rejects a file one byte beyond the configured cap", async () => {
    const root = await tempDirectory("cmb-stable-bounded-large-")
    const filePath = path.join(root, "large.txt")
    await writeFile(filePath, "01234567890")

    const opened = await openStableFileHandle(root, filePath)
    try {
      await expect(readStableFileHandleBounded(opened, 10)).rejects.toMatchObject({
        failure: "initial-too-large",
        observedSize: 11
      })
    } finally {
      await opened.handle.close()
    }
  })

  it("detects growth beyond the cap after the stable handle opens", async () => {
    const root = await tempDirectory("cmb-stable-bounded-grown-")
    const filePath = path.join(root, "grown.txt")
    await writeFile(filePath, "0123456789")

    const opened = await openStableFileHandle(root, filePath)
    try {
      await appendFile(filePath, "x")
      await expect(readStableFileHandleBounded(opened, 10)).rejects.toMatchObject({
        failure: "grew-too-large",
        observedSize: 11
      })
    } finally {
      await opened.handle.close()
    }
  })

  it("rejects a pathname replacement during a bounded read", async () => {
    const root = await tempDirectory("cmb-stable-bounded-replaced-")
    const filePath = path.join(root, "profile.md")
    const movedPath = path.join(root, "profile-original.md")
    await writeFile(filePath, "authorized")

    const opened = await openStableFileHandle(root, filePath)
    try {
      await rename(filePath, movedPath)
      await writeFile(filePath, "replacement")
      await expect(readStableFileHandleBounded(opened, 32)).rejects.toMatchObject({
        failure: "changed"
      })
    } finally {
      await opened.handle.close()
    }
  })

  it("rejects same-size in-place mutation even when mtime is restored", async () => {
    const root = await tempDirectory("cmb-stable-bounded-mutated-")
    const filePath = path.join(root, "script.js")
    await writeFile(filePath, "0123456789")
    const originalTimes = await stat(filePath)

    const opened = await openStableFileHandle(root, filePath)
    try {
      // Keep size and restore the user-controlled mtime. ctime still records the
      // mutation, so the final bigint identity comparison must reject it.
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      await writeFile(filePath, "abcdefghij")
      await utimes(filePath, originalTimes.atime, originalTimes.mtime)
      await expect(readStableFileHandleBounded(opened, 10)).rejects.toMatchObject({
        failure: "changed"
      })
    } finally {
      await opened.handle.close()
    }
  })
})
