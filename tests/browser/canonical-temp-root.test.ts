import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, it } from "vitest"
import { snapshotDerivationSource } from "../../src/main/plugins/derivation-source"
import { canonicalTmpdir } from "../support/canonical-temp-dir"

it("creates source fixtures under the physical temporary root", async () => {
  const directory = await mkdtemp(join(canonicalTmpdir(), "mods-canonical-temp-"))
  try {
    expect(await realpath(directory)).toBe(directory)
    await writeFile(join(directory, "plugin.json"), JSON.stringify({ name: "temp", version: "1" }))
    expect((await snapshotDerivationSource(directory)).name).toBe("temp")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("canonicalizes a trusted temporary alias while still rejecting linked source directories", async () => {
  const directory = await mkdtemp(join(canonicalTmpdir(), "mods-temp-alias-"))
  try {
    const physical = join(directory, "physical")
    const alias = join(directory, "alias")
    await mkdir(physical)
    await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir")
    const source = await mkdtemp(join(canonicalTmpdir(alias), "source-"))
    await writeFile(join(source, "plugin.json"), JSON.stringify({ name: "temp", version: "1" }))
    expect((await snapshotDerivationSource(source)).name).toBe("temp")
    await expect(snapshotDerivationSource(alias)).rejects.toThrow("来源不能是链接")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
