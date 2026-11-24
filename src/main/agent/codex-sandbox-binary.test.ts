import { mkdtemp, readFile, writeFile, readdir, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { afterEach, describe, expect, it } from "vitest"
import { ensureCodexExe } from "./codex-sandbox-binary"

const folders: string[] = []
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cmb-mods-binary-"))
  folders.push(directory)
  return { directory, executable: join(directory, "codex.exe") }
}
afterEach(async () => {
  for (const directory of folders.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("cmb-mods-binary-")
    )
      throw Error("Unexpected cleanup path")
    await rm(directory, { recursive: true, force: true })
  }
})
describe("sandbox binary preparation", () => {
  it("deduplicates concurrent cold starts and installs complete bytes", async () => {
    const f = await fixture()
    await writeFile(`${f.executable}.gz`, gzipSync("fixture-binary"))
    await Promise.all(Array.from({ length: 8 }, () => ensureCodexExe(f.executable)))
    expect(await readFile(f.executable, "utf8")).toBe("fixture-binary")
    expect((await readdir(f.directory)).sort()).toEqual(["codex.exe", "codex.exe.gz"])
  })
  it("keeps the previous binary if decompression fails and cleans its temporary file", async () => {
    const f = await fixture()
    await writeFile(f.executable, "working-binary")
    await utimes(f.executable, new Date(0), new Date(0))
    await writeFile(`${f.executable}.gz`, "invalid-gzip")
    await expect(ensureCodexExe(f.executable)).rejects.toThrow()
    expect(await readFile(f.executable, "utf8")).toBe("working-binary")
    expect((await readdir(f.directory)).sort()).toEqual(["codex.exe", "codex.exe.gz"])
  })
})
