import { afterEach, expect, it } from "vitest"
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  captureBotDirectory,
  restoreBotDirectory,
  verifyBotDirectory
} from "./directory-checkpoint"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Windows restoration preserves read-only flags; remove them in owned fixtures.
    await chmod(join(root, "restored", "readonly.txt"), 0o600).catch(() => {})
    await chmod(join(root, "source", "readonly.txt"), 0o600).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-directory-checkpoint-")))
  roots.push(root)
  const source = join(root, "source"),
    saved = join(root, "saved"),
    restored = join(root, "restored")
  await mkdir(source)
  return { root, source, saved, restored }
}

it("round trips binary bytes, empty directories, executable permissions and modification times", async () => {
  const f = await fixture(),
    bytes = Buffer.from([0, 255, 128, 34, 0, 7])
  await mkdir(join(f.source, "empty"))
  await mkdir(join(f.source, "nested", "empty"), { recursive: true })
  await writeFile(join(f.source, "nested", "file.bin"), bytes)
  await writeFile(join(f.source, "run.sh"), "#!/bin/sh\nprintf verified", { mode: 0o750 })
  await writeFile(join(f.source, "readonly.txt"), "read only", { mode: 0o400 })
  const modified = new Date("2025-01-02T03:04:05.000Z")
  await utimes(join(f.source, "run.sh"), modified, modified)
  const entries = await captureBotDirectory(f.source, f.saved, () => {})
  await restoreBotDirectory(f.saved, f.restored, entries)
  expect(await readFile(join(f.restored, "nested", "file.bin"))).toEqual(bytes)
  expect((await stat(join(f.restored, "empty"))).isDirectory()).toBe(true)
  expect((await stat(join(f.restored, "nested", "empty"))).isDirectory()).toBe(true)
  const script = await stat(join(f.restored, "run.sh"))
  expect(script.mtimeMs).toBe(modified.getTime())
  if (process.platform !== "win32") expect(script.mode & 0o777).toBe(0o750)
  expect((await stat(join(f.restored, "readonly.txt"))).mode & 0o200).toBe(0)
  await verifyBotDirectory(f.restored, entries)
})

it.each(["altered", "extra", "missing", "hard-link", "symbolic-link"])(
  "rejects %s snapshot trees before creating the replacement",
  async (mode) => {
    const f = await fixture()
    await writeFile(join(f.source, "file.txt"), "original")
    const entries = await captureBotDirectory(f.source, f.saved, () => {})
    if (mode === "altered") await writeFile(join(f.saved, "file.txt"), "modified")
    if (mode === "extra") await writeFile(join(f.saved, "extra.txt"), "extra")
    if (mode === "missing") await rm(join(f.saved, "file.txt"))
    if (mode === "hard-link") await link(join(f.saved, "file.txt"), join(f.root, "alias"))
    if (mode === "symbolic-link") {
      await rm(join(f.saved, "file.txt"))
      await symlink(join(f.source, "file.txt"), join(f.saved, "file.txt"))
    }
    await expect(restoreBotDirectory(f.saved, f.restored, entries)).rejects.toThrow()
    await expect(stat(f.restored)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(f.source, "file.txt"), "utf8")).toBe("original")
  }
)

it("does not follow links, accept overlapping trees or continue after root revocation", async () => {
  const f = await fixture()
  await expect(captureBotDirectory(f.source, join(f.source, "copy"), () => {})).rejects.toThrow(
    "相互包含"
  )
  await expect(
    captureBotDirectory(f.source, f.saved, () => {
      throw new Error("REVOKED")
    })
  ).rejects.toThrow("REVOKED")
  await writeFile(join(f.root, "outside.txt"), "private")
  await link(join(f.root, "outside.txt"), join(f.source, "linked.txt"))
  await expect(captureBotDirectory(f.source, f.saved, () => {})).rejects.toThrow("链接")
  expect(await readFile(join(f.root, "outside.txt"), "utf8")).toBe("private")
})

it("rejects path traversal, inconsistent parents, duplicate files and byte budgets in restore manifests", async () => {
  const f = await fixture()
  await writeFile(join(f.source, "file.txt"), "data")
  const entries = await captureBotDirectory(f.source, f.saved, () => {})
  for (const invalid of [
    [{ ...entries[0], path: "../outside" }],
    [{ ...entries[0], path: "a/file.txt" }],
    [entries[0], entries[0]],
    [{ ...entries[0], size: 20 * 1024 ** 3 + 1 }],
    [{ ...entries[0], path: "C:/outside" }],
    [{ ...entries[0], path: "NUL.txt" }]
  ])
    await expect(restoreBotDirectory(f.saved, f.restored, invalid)).rejects.toThrow()
  await expect(stat(f.restored)).rejects.toMatchObject({ code: "ENOENT" })
})
