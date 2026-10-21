import { afterEach, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { developmentCatalog, developmentCatalogPage } from "./development-catalog"
import { CREATOR_S1_SUPPORT } from "./creator-support"
import { analyzeAuthoringPreview } from "./authoring-preflight"
import { authoringCompileDiagnostics } from "./authoring-compile-diagnostics"
import { FUNCTION_UI_SITES } from "../../../shared/mods/v2/sites"
import { FUNCTION_SDK_METHODS } from "../v2/sdk-capabilities"
import { getFunctionEventSupport } from "../../../shared/mods/v2/compatibility-catalog"

const roots: string[] = []
it("freezes a discoverable S1 promise using real supported sites, events and SDK methods", () => {
  const page = developmentCatalogPage("support")
  if (!("content" in page) || typeof page.content !== "object" || Array.isArray(page.content))
    throw Error("expected support profile")
  const support = page.content
  expect(support.id).toBe("creator-s1-2026-10-16")
  expect(
    support.sites.every((site) =>
      FUNCTION_UI_SITES.includes(site as (typeof FUNCTION_UI_SITES)[number])
    )
  ).toBe(true)
  expect(
    [...support.localMethods, ...support.authorizedMethods].filter(
      (method) => !FUNCTION_SDK_METHODS.some((known) => known === method)
    )
  ).toEqual([])
  expect(
    support.events.every((event) => getFunctionEventSupport(event)?.availability === "bounded")
  ).toBe(true)
  expect(support.onUnsupported).toContain("保留当前运行版、草稿和可用组合")
  expect(support.unsupported).toContain("自动启动任意已保存 Flow")
  expect(JSON.stringify(page).length).toBeLessThan(8000)
})
it("reuses the support source in full catalog and bounded discovery instead of divergent prose", () => {
  const full = developmentCatalog()
  const support = developmentCatalogPage("support")
  const overview = developmentCatalogPage()
  expect(full.support).toBe(CREATOR_S1_SUPPORT)
  if (!("content" in support) || !overview.supportProfile) throw Error("expected discovery pages")
  expect(support.content).toEqual({
    ...full.support,
    conditionalCapabilities: full.support.conditionalCapabilities.slice(0, 2)
  })
  expect(full.deliveryGuidance).toContain(full.support.authoringConstraints.usageMetrics)
  expect(overview.supportProfile.scope).toBe(full.support.scope)
  expect(overview.supportProfile.conditionalCapabilities).toEqual(
    full.support.conditionalCapabilities.map(({ id, availability, nextDiscovery }) => ({
      id,
      availability,
      nextDiscovery
    }))
  )
  expect(JSON.stringify(support).length).toBeLessThan(8000)
  expect(JSON.stringify(overview).length).toBeLessThan(8000)
})

it("discovers every conditional capability through bounded support pages without losing native consent conditions", () => {
  const all: unknown[] = []
  let cursor: number | undefined = 0
  while (cursor !== undefined) {
    const page = developmentCatalogPage("support", cursor)
    if (!("content" in page) || typeof page.content !== "object" || Array.isArray(page.content))
      throw Error("expected support page")
    expect(JSON.stringify(page).length).toBeLessThan(8000)
    expect(page.content.scope).toBe(CREATOR_S1_SUPPORT.scope)
    all.push(...page.content.conditionalCapabilities)
    cursor = "nextCursor" in page ? page.nextCursor : undefined
  }
  expect(all).toEqual(CREATOR_S1_SUPPORT.conditionalCapabilities)
  for (const invalid of [
    -1,
    0.5,
    Number.NaN,
    CREATOR_S1_SUPPORT.conditionalCapabilities.length + 1
  ])
    expect(() => developmentCatalogPage("support", invalid)).toThrow("DEVELOPMENT_CATALOG_CURSOR")
})

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

it("typechecks the first-release authorized discovery and document actions against the shipped contract", async () => {
  const root = await source()
  await writeFile(
    join(root, "mods/main.ts"),
    `import type {Register} from "claude-code"
export const register:Register=(on)=>{
  on("command.run",{command:"review"},async($)=>{
    const entries=await $.fs.list(".")
    if(await $.fs.exists("review.md")) await $.fs.stat("review.md",{resolve:true})
    const text=await $.fs.read("review.md")
    const tools=await $.tool.list()
    const check=await $.tool.check({tool:"Read",input:{file_path:"review.md"}})
    if(check.decision==="allow") await $.tool.call({tool:"Read",file_path:"review.md"})
    const answer=await $.model.complete({model:"default",prompt:text})
    return{text:answer.isAnswered?answer.text:String(entries.length+tools.length)}
  })
}`
  )
  const result = await analyzeAuthoringPreview(root)
  expect(result.typecheck.diagnostics).toEqual([])
  expect(result.sdk.strictCompatible).toBe(true)
}, 15_000)

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
