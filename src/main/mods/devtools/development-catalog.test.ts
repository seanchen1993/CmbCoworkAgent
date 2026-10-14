import { afterEach, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { developmentCatalog, developmentCatalogPage } from "./development-catalog"
import { analyzeAuthoringPreview } from "./authoring-preflight"
import { authoringCompileDiagnostics } from "./authoring-compile-diagnostics"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function source(invalid = false) {
  const root = await mkdtemp(join(tmpdir(), "cmb-development-catalog-test-"))
  roots.push(root)
  for (const [path, value] of Object.entries(developmentCatalog().package)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(
      join(root, path),
      typeof value === "string"
        ? invalid
          ? value + "\nconst broken = {"
          : value
        : JSON.stringify(value)
    )
  }
  return root
}

it("ships an example accepted by the actual compiler, SDK scanner and author declarations", async () => {
  const result = await analyzeAuthoringPreview(await source())
  expect(result.typecheck.diagnostics).toEqual([])
  expect(result.sdk.strictCompatible).toBe(true)
  expect(result.sdk.usages.map((item) => item.method)).toEqual(
    expect.arrayContaining(["ui.resolve", "ui.invalidate"])
  )
}, 15_000)

it("returns actionable source diagnostics for a real syntax error", async () => {
  const root = await source(true)
  let failure: unknown
  try {
    await analyzeAuthoringPreview(root)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeDefined()
  const diagnostics = authoringCompileDiagnostics(failure, root)
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "compile",
        file: "mods/main.ts",
        line: expect.any(Number),
        message: expect.any(String)
      })
    ])
  )
})

it("discovers the exact SDK in bounded pages without losing declarations", () => {
  expect(JSON.stringify(developmentCatalogPage()).length).toBeLessThan(8000)
  let cursor = 0
  let types = ""
  for (;;) {
    const page = developmentCatalogPage("types", cursor)
    expect(JSON.stringify(page).length).toBeLessThan(8000)
    if (!("content" in page)) throw Error("expected a discovery page")
    types += page.content
    if (!("nextCursor" in page) || page.nextCursor === undefined) break
    cursor = page.nextCursor
  }
  expect(types).toBe(developmentCatalog().types)
  expect(() => developmentCatalogPage("types", -1)).toThrow("DEVELOPMENT_CATALOG_CURSOR")
})
