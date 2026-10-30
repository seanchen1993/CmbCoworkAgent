import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compileMod, resolveModFile } from "./loader"

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("cmb-mods-loader-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(folder, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cmb-mods-loader-"))
  folders.push(root)
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v1",
      id: "sample",
      name: "Sample",
      entry: "index.ts",
      activation: "project",
      events: [],
      tools: [],
      permissions: { readTools: [], writeTools: [], context: [], store: false }
    })
  )
  writeFileSync(join(root, "index.ts"), "export default { register() {} }")
  return root
}
describe("Mod source isolation", () => {
  it("captures code and changes digest with transitive source or plugin ownership", async () => {
    const root = fixture()
    writeFileSync(
      join(root, "index.ts"),
      'import { value } from "./value"; export default { register() { return value } }'
    )
    writeFileSync(join(root, "value.ts"), "export const value = 1")
    const first = await compileMod("a", root, "manifest.json")
    expect((await compileMod("a", root, "manifest.json")).digest).toBe(first.digest)
    expect((await compileMod("b", root, "manifest.json")).digest).not.toBe(first.digest)
    writeFileSync(join(root, "value.ts"), "export const value = 2")
    expect((await compileMod("a", root, "manifest.json")).digest).not.toBe(first.digest)
    expect(first.code).toContain("value = 1")
  })
  it("rejects escape, ADS and junction paths", () => {
    const root = fixture()
    for (const name of ["../outside.ts", "index.ts:secret", "C:/outside.ts", "index.ts."])
      expect(() => resolveModFile(root, name)).toThrow()
    const target = join(root, "target")
    mkdirSync(target)
    writeFileSync(join(target, "file.ts"), "")
    symlinkSync(target, join(root, "link"), "junction")
    expect(() => resolveModFile(root, "link/file.ts")).toThrow("PATH_LINK")
  })
  it.each(['import fs from "node:fs"; export default fs', 'export default import("./value.ts")'])(
    "rejects import: %s",
    async (code) => {
      const root = fixture()
      writeFileSync(join(root, "index.ts"), code)
      await expect(compileMod("a", root, "manifest.json")).rejects.toThrow("IMPORT_DENIED")
    }
  )
})
