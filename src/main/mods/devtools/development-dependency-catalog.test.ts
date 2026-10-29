import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createAuthoringSourceBundle } from "./authoring-bundle"
import { developmentCatalogPage } from "./development-catalog"
import {
  bundledDependencySourcesRoot,
  developmentDependencyCatalogPage,
  PROJECT_DEPENDENCY_AUTHORING,
  PROJECT_DEPENDENCY_SOURCE_PAGE_BYTES,
  readDevelopmentDependencySource
} from "./development-dependency-catalog"
import { validateClassicInput } from "../../../shared/mods/v2/classic"

const temporary: string[] = []
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-dependency-catalog-"))
  temporary.push(root)
  const mainDirectory = join(root, "out/main")
  const directory = join(bundledDependencySourcesRoot(mainDirectory), "record-validator")
  const files = [
    {
      path: "plugin.json",
      text: JSON.stringify({
        name: "record-validator",
        version: "2.0.0",
        description: "Independent record validator",
        mods: "mods/manifest.json"
      })
    },
    {
      path: "mods/manifest.json",
      text: JSON.stringify({
        apiVersion: "cmb.mods/v2",
        id: "record-validator",
        entry: "main.ts",
        claw: {
          actions: [
            {
              id: "verify",
              name: "Verify records",
              inputSchema: { type: "object" },
              platform: { id: "records", version: "2.0.0", action: "verify" }
            }
          ]
        }
      })
    },
    { path: "mods/main.ts", text: "// Public source data 😀\n".repeat(400) },
    { path: "workflows/verify.workflow.js", text: "// Original workflow source\n" }
  ]
  for (const file of files) {
    await mkdir(dirname(join(directory, file.path)), { recursive: true })
    await writeFile(join(directory, file.path), file.text)
  }
  return { mainDirectory, directory, files }
}

it("discovers uninstalled public source separately from installed identities and native grants", async () => {
  const f = await fixture()
  const page = developmentDependencyCatalogPage({ mainDirectory: f.mainDirectory })
  expect(page).toMatchObject({
    section: "project-dependencies",
    sources: [
      {
        sourceId: "record-validator",
        plugin: "record-validator",
        version: "2.0.0",
        installed: false,
        grantsAuthority: false,
        actions: [{ actionId: "verify", name: "Verify records" }],
        schemaAssetPath: "record-validator/mods/manifest.json"
      }
    ]
  })
  expect(JSON.stringify(page)).not.toContain("pluginId")
  expect(JSON.stringify({ ok: true, result: page }).length).toBeLessThan(8000)
  expect(PROJECT_DEPENDENCY_AUTHORING.prepare).toEqual([
    "dependency_prepare(sourceId) for unchanged bundled source",
    "end the turn for original native confirmation"
  ])
  expect(PROJECT_DEPENDENCY_AUTHORING.businessValidation).toMatchObject({
    discoverInstalled: { action: "project_actions", query: "evidence-validation" },
    bundledSourceId: "evidence-validation"
  })
  expect(PROJECT_DEPENDENCY_AUTHORING.businessValidation.scope).toContain("no truth")
  expect(PROJECT_DEPENDENCY_AUTHORING.businessValidation.confirmation).toContain("end the turn")
  expect(PROJECT_DEPENDENCY_AUTHORING.businessValidation.proof).toContain("native gate")
  const overview = developmentCatalogPage()
  if (!("discovery" in overview)) throw Error("expected overview")
  expect(overview.discovery).toContain("project-dependencies")
})

it("round trips all real source bytes with pinned digest and bounded file pages", async () => {
  const f = await fixture()
  const index = developmentDependencyCatalogPage({
    mainDirectory: f.mainDirectory,
    assetPath: "record-validator"
  })
  if (!("files" in index) || !index.files || !("sourceDigest" in index))
    throw Error("expected files")
  expect(index.totalFiles).toBe(f.files.length)
  expect(index).toMatchObject({
    nextStep: {
      action: "dependency_prepare",
      sourceId: "record-validator",
      sourceDigest: index.sourceDigest,
      requiredFields: ["sourceId"]
    }
  })
  const read: Array<{ path: string; text: string }> = []
  for (const file of index.files) {
    let text = ""
    let cursor: number | undefined = 0
    do {
      const page = developmentDependencyCatalogPage({
        mainDirectory: f.mainDirectory,
        assetPath: file.assetPath,
        cursor,
        expectedDigest: index.sourceDigest
      })
      if (!("text" in page) || page.text === undefined) throw Error("expected source text")
      expect(Buffer.byteLength(JSON.stringify({ ok: true, result: page }))).toBeLessThanOrEqual(
        PROJECT_DEPENDENCY_SOURCE_PAGE_BYTES
      )
      if (file.path === "mods/main.ts" && cursor === 0)
        expect(page.text.length).toBeGreaterThan(2800)
      text += page.text
      cursor = "nextCursor" in page ? page.nextCursor : undefined
    } while (cursor !== undefined)
    read.push({ path: file.path, text })
  }
  expect(createAuthoringSourceBundle(read)).toEqual(createAuthoringSourceBundle(f.files))
  expect(() =>
    developmentDependencyCatalogPage({
      mainDirectory: f.mainDirectory,
      assetPath: "record-validator/mods/main.ts",
      expectedDigest: "0".repeat(64)
    })
  ).toThrow("DEVELOPMENT_DEPENDENCY_SOURCE_CHANGED")
})

it("bounds escaped and multibyte source pages while preserving the native hook input envelope", async () => {
  const f = await fixture()
  const original = "漢字".repeat(6000) + '\n😀\\"'.repeat(1000)
  await writeFile(join(f.directory, "mods/main.ts"), original)
  let text = "",
    cursor: number | undefined = 0
  do {
    const page = developmentDependencyCatalogPage({
      mainDirectory: f.mainDirectory,
      assetPath: "record-validator/mods/main.ts",
      cursor
    })
    if (!("text" in page) || page.text === undefined) throw Error("expected source text")
    const result = { ok: true, result: page }
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      PROJECT_DEPENDENCY_SOURCE_PAGE_BYTES
    )
    expect(() =>
      validateClassicInput("classic.PostToolUse", {
        hook_event_name: "PostToolUse",
        session_id: "creator",
        transcript_path: "",
        cwd: "isolated",
        tool_name: "mod_authoring",
        tool_use_id: "source-read",
        tool_input: { action: "catalog" },
        tool_response: JSON.stringify(result)
      })
    ).not.toThrow()
    expect(page.text).not.toMatch(/[\uD800-\uDBFF]$/)
    text += page.text
    cursor = "nextCursor" in page ? page.nextCursor : undefined
  } while (cursor !== undefined)
  expect(text).toBe(original)
})

it("reads an entire pinned source unchanged in one operation and rejects stale or foreign selections", async () => {
  const f = await fixture()
  const expected = createAuthoringSourceBundle(f.files)
  expect(
    readDevelopmentDependencySource({
      mainDirectory: f.mainDirectory,
      sourceId: "record-validator",
      expectedDigest: expected.digest
    })
  ).toEqual(expected)
  expect(readDevelopmentDependencySource({
    mainDirectory: f.mainDirectory, sourceId: "record-validator"
  })).toEqual(expected)
  for (const sourceId of ["missing", "../record-validator", "record-validator/mods/main.ts"])
    expect(() =>
      readDevelopmentDependencySource({
        mainDirectory: f.mainDirectory,
        sourceId,
        expectedDigest: expected.digest
      })
    ).toThrow("DEVELOPMENT_DEPENDENCY_SOURCE_UNAVAILABLE")
  expect(() =>
    readDevelopmentDependencySource({
      mainDirectory: f.mainDirectory,
      sourceId: "record-validator",
      expectedDigest: "not-a-digest"
    })
  ).toThrow("DEVELOPMENT_DEPENDENCY_DIGEST_REQUIRED")
  await writeFile(join(f.directory, "mods/main.ts"), "// changed source")
  expect(() =>
    readDevelopmentDependencySource({
      mainDirectory: f.mainDirectory,
      sourceId: "record-validator",
      expectedDigest: expected.digest
    })
  ).toThrow("DEVELOPMENT_DEPENDENCY_SOURCE_CHANGED")
})

it("rejects traversal, unknown assets, wrong cursors and incomplete source snapshots", async () => {
  const f = await fixture()
  for (const path of [
    "../record-validator",
    "record-validator/../plugin.json",
    "record-validator/.env"
  ])
    expect(() =>
      developmentDependencyCatalogPage({ mainDirectory: f.mainDirectory, assetPath: path })
    ).toThrow()
  expect(() =>
    developmentDependencyCatalogPage({ mainDirectory: f.mainDirectory, cursor: 99 })
  ).toThrow("DEVELOPMENT_CATALOG_CURSOR")
  await writeFile(join(f.directory, "native.bin"), new Uint8Array([1, 2]))
  expect(() =>
    developmentDependencyCatalogPage({
      mainDirectory: f.mainDirectory,
      assetPath: "record-validator"
    })
  ).toThrow("DEVELOPMENT_DEPENDENCY_SOURCE_INCOMPLETE")
})
