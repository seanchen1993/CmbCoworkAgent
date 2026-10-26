import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { projectSourceSetSchema, readProjectSourceSet } from "./project-source-set"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "source-set-reader-"))
  roots.push(root)
  await cp(resolve("tests/fixtures/native-compositions/vendor"), join(root, "project"), {
    recursive: true
  })
  const declaration = {
    protocol: "devclaw.project-source-set/v1",
    title: "Independent vendor",
    goal: "Review vendor",
    project: "project",
    dependencies: []
  }
  await writeFile(join(root, "devclaw.source-set.json"), JSON.stringify(declaration))
  return { root, declaration }
}
it("reads the actual portable AutoBiz sources without pure authoring size/schema relaxation", async () => {
  const value = await readProjectSourceSet(resolve("resources/native-compositions"), () => {})
  expect(value.dependencies.map((row) => row.name)).toEqual([
    "autobiz-native-rules",
    "autobiz-native-knowledge"
  ])
  expect(
    value.dependencies[0].snapshot.files.find((file) => file.path === "mods/rules-bundle.ts")!.bytes
      .length
  ).toBeGreaterThan(256 * 1024)
  expect(
    value.dependencies[1].snapshot.files.some((file) => file.path === "mods/frontmatter.cjs")
  ).toBe(true)
  expect(value.project.bundle.files.some((file) => file.path === "composition/source.json")).toBe(
    true
  )
})
it.each(["../outside", "C:/outside", "/outside", "a/../../outside", "https://example.test/plugin"])(
  "rejects uncontrolled path %s",
  (project) => {
    expect(() =>
      projectSourceSetSchema.parse({
        protocol: "devclaw.project-source-set/v1",
        title: "x",
        goal: "x",
        project,
        dependencies: []
      })
    ).toThrow()
  }
)
it("reads an independent project with no dependency and preserves bytes", async () => {
  const value = await fixture()
  const result = await readProjectSourceSet(value.root, () => {})
  expect(result.dependencies).toEqual([])
  expect(result.project.bundle.files.length).toBeGreaterThan(1)
})
it("rejects a project junction outside the selected root before reading its files", async () => {
  const value = await fixture()
  const outside = await mkdtemp(join(tmpdir(), "source-set-outside-"))
  roots.push(outside)
  await symlink(
    outside,
    join(value.root, "linked"),
    process.platform === "win32" ? "junction" : "dir"
  )
  await writeFile(
    join(value.root, "devclaw.source-set.json"),
    JSON.stringify({ ...value.declaration, project: "linked" })
  )
  await expect(readProjectSourceSet(value.root, () => {})).rejects.toThrow("PATH_UNSAFE")
})
it("rejects local connection configuration without reading its contents", async () => {
  const value = await fixture()
  await mkdir(join(value.root, "project", ".mcp.json"))
  await expect(readProjectSourceSet(value.root, () => {})).rejects.toThrow(
    "LOCAL_CONFIGURATION_FORBIDDEN"
  )
})
it("rejects overlapping source roots rather than copying a project as its own dependency", async () => {
  const value = await fixture()
  await writeFile(
    join(value.root, "devclaw.source-set.json"),
    JSON.stringify({ ...value.declaration, dependencies: ["project/subdir"] })
  )
  await expect(readProjectSourceSet(value.root, () => {})).rejects.toThrow("PATH_COLLISION")
})
