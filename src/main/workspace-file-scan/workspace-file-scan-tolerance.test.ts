import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  openWorkspaceFileScanDirectory,
  readWorkspaceFileScanDirectoryEntry,
  statWorkspaceFileScanCandidate
} from "./workspace-file-scan-tolerance"

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe("workspace file scan entry tolerance", () => {
  it("skips a file deleted after discovery instead of failing the whole page", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "cmb-workspace-scan-volatile-"))
    const filePath = join(workspacePath, "removed-during-scan.ts")
    try {
      writeFileSync(filePath, "temporary")
      rmSync(filePath)

      await expect(
        statWorkspaceFileScanCandidate(filePath, "removed-during-scan.ts")
      ).resolves.toBeNull()
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it("skips an unreadable child directory but keeps a root open failure fatal", async () => {
    const rejectUnreadable = async (): Promise<never> => {
      throw errno("EACCES")
    }

    await expect(
      openWorkspaceFileScanDirectory("/workspace/private", false, rejectUnreadable)
    ).resolves.toBeNull()
    await expect(
      openWorkspaceFileScanDirectory("/workspace", true, rejectUnreadable)
    ).rejects.toMatchObject({ code: "EACCES" })
  })

  it("ends only the current frame when directory access changes after open", async () => {
    await expect(
      readWorkspaceFileScanDirectoryEntry(async () => {
        throw errno("EACCES")
      })
    ).resolves.toBeNull()

    await expect(
      readWorkspaceFileScanDirectoryEntry(async () => {
        throw errno("EIO")
      })
    ).rejects.toMatchObject({ code: "EIO" })
  })

  it.each(["ENOENT", "ENOTDIR", "EACCES", "EPERM"])(
    "skips only the bounded entry error %s",
    async (code) => {
      await expect(
        statWorkspaceFileScanCandidate("/workspace/item", "item", async () => {
          throw errno(code)
        })
      ).resolves.toBeNull()
    }
  )

  it("does not hide unexpected filesystem failures", async () => {
    await expect(
      statWorkspaceFileScanCandidate("/workspace/item", "item", async () => {
        throw errno("EIO")
      })
    ).rejects.toMatchObject({ code: "EIO" })
  })
})
