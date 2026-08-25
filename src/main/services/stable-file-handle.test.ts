import { mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openStableFileHandle } from "./stable-file-handle"

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
})
