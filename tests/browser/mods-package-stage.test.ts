import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import {
  assertFreshPackageOutput,
  collectProductionPackages,
  stageProductionPackages
} from "../../scripts/mods-package-stage"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mods-package-stage-test-"))
  roots.push(root)
  const app = join(root, "app")
  await mkdir(join(app, "node_modules"), { recursive: true })
  const pkg = async (path: string, value: object) => {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, "package.json"), JSON.stringify(value))
  }
  await pkg(app, { name: "app", dependencies: { outer: "1.0.0" }, devDependencies: { dev: "1" } })
  await pkg(join(app, "node_modules/outer"), {
    name: "outer",
    version: "1.0.0",
    dependencies: { inner: "2" },
    optionalDependencies: { "missing-platform": "1" },
    peerDependencies: { peer: "1" }
  })
  await pkg(join(app, "node_modules/outer/node_modules/inner"), { name: "inner", version: "2.0.0" })
  await pkg(join(app, "node_modules/inner"), { name: "inner", version: "1.0.0" })
  await pkg(join(app, "node_modules/peer"), {
    name: "peer",
    version: "1.0.0",
    dependencies: { outer: "1" }
  })
  await pkg(join(app, "node_modules/dev"), { name: "dev", version: "1.0.0" })
  return { root, app, pkg }
}

it("collects actual nested dependencies and peers without flattening versions or copying dev packages", async () => {
  const { app, root } = await fixture()
  const packages = await collectProductionPackages(app)
  expect(packages.map((item) => item.relative).sort()).toEqual([
    "outer",
    "outer/node_modules/inner",
    "peer"
  ])
  const stage = join(root, "stage")
  await stageProductionPackages(stage, packages)
  expect(
    JSON.parse(
      await readFile(join(stage, "node_modules/outer/node_modules/inner/package.json"), "utf8")
    ).version
  ).toBe("2.0.0")
  await expect(readFile(join(stage, "node_modules/dev/package.json"))).rejects.toThrow()
})

it("fails closed when a declared required runtime dependency is missing", async () => {
  const { app, pkg } = await fixture()
  await pkg(join(app, "node_modules/outer"), {
    name: "outer",
    version: "1",
    dependencies: { absent: "1" }
  })
  await expect(collectProductionPackages(app)).rejects.toThrow("MODS_PACKAGE_DEPENDENCY_MISSING")
})

it("refuses an existing staging dependency directory instead of mutating shared dependencies", async () => {
  const { app } = await fixture()
  const packages = await collectProductionPackages(app)
  await expect(stageProductionPackages(app, packages)).rejects.toThrow("MODS_PACKAGE_STAGE_EXISTS")
})

it("includes declared packages that also have a Node builtin name", async () => {
  const { app, pkg } = await fixture()
  await pkg(join(app, "node_modules/outer"), {
    name: "outer",
    version: "1",
    dependencies: { string_decoder: "1" }
  })
  await pkg(join(app, "node_modules/string_decoder"), { name: "string_decoder", version: "1.0.0" })
  expect((await collectProductionPackages(app)).map((item) => item.name).sort()).toEqual([
    "outer",
    "string_decoder"
  ])
})

it("does not let optional peer metadata waive a required production dependency", async () => {
  const { app, pkg } = await fixture()
  await pkg(join(app, "node_modules/outer"), {
    name: "outer",
    version: "1",
    dependencies: { missing: "1" },
    peerDependencies: { missing: "1" },
    peerDependenciesMeta: { missing: { optional: true } }
  })
  await expect(collectProductionPackages(app)).rejects.toThrow("MODS_PACKAGE_DEPENDENCY_MISSING")
})

it("rejects a junction in the output path and refuses an existing output", async () => {
  const { app, root } = await fixture()
  const allowed = join(app, "output/mods-v2-validation")
  const external = join(root, "external")
  await mkdir(allowed, { recursive: true })
  await mkdir(external)
  await symlink(
    external,
    join(allowed, "redirect"),
    process.platform === "win32" ? "junction" : "dir"
  )
  await expect(
    assertFreshPackageOutput(app, "output/mods-v2-validation/redirect/new")
  ).rejects.toThrow("MODS_PACKAGE_OUTPUT_LINK")
  await expect(
    assertFreshPackageOutput(app, "output/mods-v2-validation/redirect")
  ).rejects.toThrow()
  await expect(assertFreshPackageOutput(app, "output/mods-v2-validation/new")).resolves.toBe(
    join(allowed, "new")
  )
})

it("refuses dependency aliases through package junctions instead of losing their installed name", async () => {
  const { app } = await fixture()
  await writeFile(join(app, "package.json"), JSON.stringify({ dependencies: { alias: "1" } }))
  await symlink(
    join(app, "node_modules/outer"),
    join(app, "node_modules/alias"),
    process.platform === "win32" ? "junction" : "dir"
  )
  await expect(collectProductionPackages(app)).rejects.toThrow("MODS_PACKAGE_DEPENDENCY_LINK")
})

it("refuses package-local links rather than copying unrelated external files", async () => {
  const { app, root } = await fixture()
  const external = join(root, "outside")
  await mkdir(external)
  await writeFile(join(external, "private.txt"), "not a runtime dependency")
  await symlink(
    external,
    join(app, "node_modules/outer/linked"),
    process.platform === "win32" ? "junction" : "dir"
  )
  const packages = await collectProductionPackages(app)
  await expect(stageProductionPackages(join(root, "stage"), packages)).rejects.toThrow(
    "MODS_PACKAGE_CONTENT_LINK"
  )
})
