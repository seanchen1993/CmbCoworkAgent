import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { dependencySourceIndex } from "./dependency-source-index"
import {
  bundledDependencySourcesRoot,
  developmentDependencyCatalogPage,
  readDevelopmentDependencySource
} from "./development-dependency-catalog"

const temporary: string[] = []
function sources(mainDirectory: string) {
  const page = developmentDependencyCatalogPage({ mainDirectory })
  if (!("sources" in page)) throw Error("EXPECTED_SOURCE_DIRECTORY")
  return page.sources
}
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "source-index-"))
  temporary.push(directory)
  const mainDirectory = join(directory, "out/main")
  const root = bundledDependencySourcesRoot(mainDirectory)
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }
  const declaration = {
    protocol: "devclaw.project-source-set/v1",
    title: "Independent sources",
    goal: "Reuse one provider",
    project: "project",
    dependencies: ["capabilities/knowledge"]
  }
  await write("example/devclaw.source-set.json", JSON.stringify(declaration))
  await write(
    "example/capabilities/knowledge/plugin.json",
    JSON.stringify({
      name: "independent-knowledge",
      version: "1.0.0",
      mods: "mods/manifest.json"
    })
  )
  await write(
    "example/capabilities/knowledge/mods/manifest.json",
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "independent-knowledge",
      claw: {
        actions: [
          {
            id: "context",
            name: "Knowledge",
            platform: { id: "knowledge", version: "1.0.0", action: "context" },
            inputSchema: { type: "object" },
            outputSchema: { type: "object" }
          }
        ]
      }
    })
  )
  await write("example/capabilities/knowledge/mods/main.ts", "// small provider")
  return { directory, mainDirectory, root, write, declaration }
}

it("discovers only declared nested providers with stable opaque IDs and prepares exact bytes", async () => {
  const f = await fixture()
  const entries = sources(f.mainDirectory)
  expect(entries).toHaveLength(1)
  const source = entries[0]
  expect(source.sourceId).toMatch(/^source-set-[a-f0-9]{32}$/)
  expect(source).toMatchObject({
    plugin: "independent-knowledge",
    availability: "authoring-prepare"
  })
  const first = readDevelopmentDependencySource({
    mainDirectory: f.mainDirectory,
    sourceId: source.sourceId
  })
  expect(first.files).toHaveLength(3)
  await f.write("example/capabilities/knowledge/mods/main.ts", "// changed")
  expect(sources(f.mainDirectory)[0].sourceId).toBe(source.sourceId)
  expect(() =>
    readDevelopmentDependencySource({
      mainDirectory: f.mainDirectory,
      sourceId: source.sourceId,
      expectedDigest: first.digest
    })
  ).toThrow("SOURCE_CHANGED")
  await f.write(
    "example/devclaw.source-set.json",
    JSON.stringify({ ...f.declaration, dependencies: [] })
  )
  expect(() =>
    readDevelopmentDependencySource({ mainDirectory: f.mainDirectory, sourceId: source.sourceId })
  ).toThrow("SOURCE_UNAVAILABLE")
})

it("returns an accurate native import route for oversized source without reading/transcribing it", async () => {
  const f = await fixture()
  await f.write("example/capabilities/knowledge/mods/main.ts", "x".repeat(65537))
  const source = sources(f.mainDirectory)[0]
  expect(source).toMatchObject({
    availability: "native-source-set-required",
    nextStep: {
      kind: "native",
      sourceSet: "example/devclaw.source-set.json"
    }
  })
  expect(source.nextStep).not.toHaveProperty("action")
  expect(() =>
    readDevelopmentDependencySource({ mainDirectory: f.mainDirectory, sourceId: source.sourceId })
  ).toThrow("SOURCE_NATIVE_IMPORT_REQUIRED")
})

it("keeps old top-level IDs when a root source-set also declares them", async () => {
  const f = await fixture()
  await f.write("standalone/plugin.json", "{}")
  await f.write(
    "devclaw.source-set.json",
    JSON.stringify({ ...f.declaration, dependencies: ["standalone"] })
  )
  const entries = dependencySourceIndex(f.root)
  expect(entries.filter((entry) => entry.relative === "standalone")).toMatchObject([
    { sourceId: "standalone", sourceSet: "devclaw.source-set.json" }
  ])
})

it("rejects undeclared paths, traversal and junctions at dependency ancestors", async () => {
  const f = await fixture()
  expect(() =>
    readDevelopmentDependencySource({
      mainDirectory: f.mainDirectory,
      sourceId: "example/capabilities/knowledge"
    })
  ).toThrow("SOURCE_UNAVAILABLE")
  await f.write(
    "example/devclaw.source-set.json",
    JSON.stringify({ ...f.declaration, dependencies: ["../foreign"] })
  )
  expect(() => dependencySourceIndex(f.root)).toThrow()
  await f.write(
    "example/devclaw.source-set.json",
    JSON.stringify({ ...f.declaration, dependencies: ["linked/knowledge"] })
  )
  await symlink(join(f.root, "example/capabilities"), join(f.root, "example/linked"), "junction")
  expect(() => dependencySourceIndex(f.root)).toThrow("SOURCE_UNSAFE")
})
