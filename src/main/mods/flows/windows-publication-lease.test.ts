import { expect, it } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rename, rm, writeFile, open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  acquireWindowsPublicationLease,
  publicationDirectoryAncestors
} from "./windows-publication-lease"

const windows = process.platform === "win32" ? it : it.skip
windows(
  "holds real Windows directory/file handles, blocks external writers and renames exact owned handle",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "virtual-publication-lock-"))
    try {
      const path = join(directory, "input.txt"),
        backup = join(directory, "backup.txt")
      await writeFile(path, "initial")
      const lease = await acquireWindowsPublicationLease({
        directories: publicationDirectoryAncestors([directory]),
        files: [{ path, backup, digest: createHash("sha256").update("initial").digest("hex") }],
        signal: AbortSignal.timeout(10000),
        assertCurrent: () => {}
      })
      try {
        await expect(writeFile(path, "external")).rejects.toBeDefined()
        await expect(rename(directory, directory + "-replaced")).rejects.toBeDefined()
        await lease.backup(0)
        expect(await readdir(directory)).toEqual(["backup.txt"])
        expect(await readFile(backup, "utf8")).toBe("initial")
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
        await writeFile(path, "new content", { flag: "wx" })
      } finally {
        await lease.close()
      }
      await writeFile(backup, "released")
      expect(await readFile(path, "utf8")).toBe("new content")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000
)

windows(
  "refuses an already active external writer before renaming any file",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "virtual-publication-lock-"))
    try {
      const path = join(directory, "input.txt")
      await writeFile(path, "initial")
      const writer = await open(path, "r+")
      try {
        await expect(
          acquireWindowsPublicationLease({
            directories: [directory],
            files: [{ path, digest: createHash("sha256").update("initial").digest("hex") }],
            signal: AbortSignal.timeout(10000),
            assertCurrent: () => {}
          })
        ).rejects.toThrow("LOCK_FAILED")
      } finally {
        await writer.close()
      }
      expect(await readFile(path, "utf8")).toBe("initial")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000
)
