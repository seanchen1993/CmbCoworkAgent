import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { copyBackupFile, hashBackupFile } from "./backup-io"
import { withBackupIoObserver } from "./backup-io-observer"
import {
  captureBotDirectory,
  restoreBotDirectory,
  verifyBotDirectory
} from "./directory-checkpoint"
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-io-progress-")))
  roots.push(root)
  const source = join(root, "source")
  await mkdir(source)
  const bytes = Buffer.alloc(3 * 1024 ** 2 + 7, 71)
  await writeFile(join(source, "large.bin"), bytes)
  return { root, source, bytes }
}
it("observes real MiB chunks through capture, both verification loops and restore without counting timers", async () => {
  const f = await fixture(),
    reads: number[] = [],
    guard = () => {}
  await withBackupIoObserver(
    {
      assertCurrent: guard,
      worked(bytes) {
        reads.push(bytes)
      }
    },
    async () => {
      const copied = await copyBackupFile(f.source, "large.bin", join(f.root, "copy"))
      expect(reads.filter(Boolean)).toEqual([1024 ** 2, 1024 ** 2, 1024 ** 2, 7])
      reads.length = 0
      await hashBackupFile(f.source, "large.bin", copied)
      expect(reads).toEqual([1024 ** 2, 1024 ** 2, 1024 ** 2, 7])
      const entries = await captureBotDirectory(f.source, join(f.root, "saved"), guard)
      reads.length = 0
      await verifyBotDirectory(f.source, entries)
      expect(reads.filter(Boolean)).toEqual([1024 ** 2, 1024 ** 2, 1024 ** 2, 7])
      reads.length = 0
      await restoreBotDirectory(join(f.root, "saved"), join(f.root, "restored"), entries)
      expect(reads.filter(Boolean).length).toBeGreaterThanOrEqual(12)
    }
  )
  expect((await readFile(join(f.root, "restored", "large.bin"))).equals(f.bytes)).toBe(true)
})
it.each(["copy", "hash", "verify"] as const)(
  "revokes %s within a large single file and cleans an unpublished copy",
  async (action) => {
    const f = await fixture(),
      entries = await captureBotDirectory(f.source, join(f.root, "saved"), () => {}),
      stop = new Error("REVOKED")
    let chunks = 0,
      revoked = false
    const observer = {
      assertCurrent() {
        if (revoked) throw stop
      },
      worked(bytes: number) {
        if (bytes) {
          ++chunks
          revoked = true
        }
      }
    }
    await expect(
      withBackupIoObserver(observer, async () => {
        if (action === "copy") await copyBackupFile(f.source, "large.bin", join(f.root, "copy"))
        else if (action === "hash") await hashBackupFile(f.source, "large.bin")
        else await verifyBotDirectory(f.source, entries)
      })
    ).rejects.toThrow("REVOKED")
    expect(chunks).toBe(1)
    if (action === "copy")
      await expect(readFile(join(f.root, "copy", "large.bin"))).rejects.toMatchObject({
        code: "ENOENT"
      })
  }
)
