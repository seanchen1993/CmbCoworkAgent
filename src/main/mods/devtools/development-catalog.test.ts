import { describeFunctionDisplayRouting } from "../v2/display-routing"
import { afterEach, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { developmentCatalog, developmentCatalogPage, DEVELOPMENT_SKILL_LIFECYCLE_EXAMPLE } from "./development-catalog"
import { CREATOR_S1_SUPPORT } from "./creator-support"
import { analyzeAuthoringPreview } from "./authoring-preflight"
import { authoringCompileDiagnostics } from "./authoring-compile-diagnostics"
import { FUNCTION_UI_SITES } from "../../../shared/mods/v2/sites"
import { FUNCTION_SDK_METHODS } from "../v2/sdk-capabilities"
import { getFunctionEventSupport } from "../../../shared/mods/v2/compatibility-catalog"

const roots: string[] = []
it("discovers exact event overloads and referenced result-v1 types without dumping the SDK", () => {
  const result = developmentCatalogPage("events", 0, "tool.call")
  if (!("query" in result)) throw Error("Expected targeted discovery")
  expect(result.events).toEqual([expect.objectContaining({ name: "tool.call" })])
  expect(result.sdkMethods).toEqual([])
  expect(result.matched).toBe(true)
  expect(result.declarationAvailable).toBe(true)
  expect(result.content).toContain('event:"tool.call"')
  expect(result.content).toContain("Next<ToolEvent,Json>")
  expect(result.content).toContain("export interface ToolEvent")
  expect(result.content).not.toContain('event:"process.spawn"')
  expect(result.content).not.toContain("export interface SDKBase")
  expect(result.content.length).toBeLessThan(developmentCatalog().types.length / 3)
  expect(JSON.stringify({ ok: true, result }).length).toBeLessThan(8000)
  expect(result).toMatchObject({ scope: "static-authoring-contract", grantsAuthority: false })
})

it("extracts a real SDK method and UI element contracts, with exact independent paging", () => {
  let cursor = 0
  let content = ""
  for (;;) {
    const page = developmentCatalogPage("sdk", cursor, "ui.resolve")
    if (!("query" in page)) throw Error("Expected targeted discovery")
    expect(page.sdkMethods).toEqual(["ui.resolve"])
    expect(page.events).toEqual([])
    expect(JSON.stringify(page).length).toBeLessThan(8000)
    content += page.content
    if (!("nextCursor" in page) || page.nextCursor === undefined) {
      expect(page.complete).toBe(true)
      expect(content.length).toBe(page.totalCharacters)
      break
    }
    expect(page.complete).toBe(false)
    cursor = page.nextCursor
  }
  expect(content).toContain("resolve(event:UiEvent):UiElements")
  expect(content).toContain("export interface UiElements")
  expect(content).toContain("Text(props:")
  expect(content).not.toContain("PlatformDescriptor")
})

it("keeps overlapping event and SDK names explicit and unsupported declarations honest", () => {
  const both = developmentCatalogPage("overview", 0, "tool.call")
  if (!("query" in both)) throw Error("Expected targeted discovery")
  expect(both.events).toHaveLength(1)
  expect(both.sdkMethods).toEqual(["tool.call"])
  for (const query of ["not-real.method", "tool", "native.project-runtime", "install-private-action"]) {
    const missing = developmentCatalogPage("overview", 0, query)
    expect(missing).toMatchObject({ matched: false, declarationAvailable: false,
      content: "", events: [], sdkMethods: [], complete: true, grantsAuthority: false })
    expect(JSON.stringify(missing)).not.toContain("pluginId")
  }
  const runtimeOnly = developmentCatalogPage("sdk", 0, "fs.ancestors")
  expect(runtimeOnly).toMatchObject({ matched: true, declarationAvailable: false, content: "" })
})

it("retains unfiltered events and SDK pages and rejects ambiguous query sections/cursors", () => {
  expect(developmentCatalogPage("events")).toMatchObject({
    content: developmentCatalog().events.slice(0, 12), nextCursor: 12
  })
  expect(developmentCatalogPage("sdk")).toMatchObject({
    content: developmentCatalog().sdkMethods.slice(0, 60)
  })
  expect(() => developmentCatalogPage("types", 0, "tool.call"))
    .toThrow("DEVELOPMENT_CATALOG_QUERY_SECTION")
  expect(() => developmentCatalogPage("support", 0, "tool.call"))
    .toThrow("DEVELOPMENT_CATALOG_QUERY_SECTION")
  for (const cursor of [-1, 0.5, Number.NaN, 100000])
    expect(() => developmentCatalogPage("events", cursor, "tool.call"))
      .toThrow("DEVELOPMENT_CATALOG_CURSOR")
  for (const query of ["", " ", "x".repeat(121)])
    expect(() => developmentCatalogPage("sdk", 0, query)).toThrow("DEVELOPMENT_CATALOG_QUERY")
})

it("makes draft persistence, complete source and exact revision semantics available in overview", () => {
  const catalog = developmentCatalog()
  const overview = developmentCatalogPage()
  if (!("draftWorkflow" in overview) || !overview.draftWorkflow)
    throw Error("Expected overview draft workflow")
  expect(overview.draftWorkflow).toEqual(catalog.draftWorkflow)
  expect(overview.draftWorkflow.newDraft).toContain("revision=0")
  expect(overview.draftWorkflow.scaffold).toMatchObject({ saved: false })
  expect(overview.draftWorkflow.scaffold.next).toContain("result.files 完整数组")
  expect(overview.draftWorkflow.edit).toContain("read(id)")
  expect(overview.draftWorkflow.submitValid).toContain("结束本轮")
  expect(JSON.stringify(overview).length).toBeLessThan(8000)
  expect(JSON.stringify({ ok: true, result: overview }).length).toBeLessThan(8000)
})
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
  if (!("content" in support) || !("supportProfile" in overview) || !overview.supportProfile)
    throw Error("expected discovery pages")
  expect(support.content).toEqual({
    ...full.support,
    conditionalCapabilities: full.support.conditionalCapabilities.slice(0,
      "nextCursor" in support ? support.nextCursor : full.support.conditionalCapabilities.length)
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

it.each(
  CREATOR_S1_SUPPORT.conditionalCapabilities.map((capability, cursor) => ({ capability, cursor }))
)("keeps $capability.id discoverable from its exact cursor", ({ capability, cursor }) => {
  const page = developmentCatalogPage("support", cursor)
  if (!("content" in page) || typeof page.content !== "object" || Array.isArray(page.content))
    throw Error("expected support page")
  expect(JSON.stringify(page).length).toBeLessThan(8000)
  expect(page.content.conditionalCapabilities[0]).toEqual(capability)
  expect(page.content.authoringConstraints).toEqual(CREATOR_S1_SUPPORT.authoringConstraints)
})

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it("exposes and compiles a real typed skill lifecycle example with source-bound trial discovery", async () => {
  const root = await source()
  await writeFile(join(root, "mods/main.ts"), DEVELOPMENT_SKILL_LIFECYCLE_EXAMPLE)
  const preview = await analyzeAuthoringPreview(root)
  expect(preview.typecheck.diagnostics).toEqual([])
  expect(preview.sdk.strictCompatible).toBe(true)
  expect(preview.sdk.registrationEvents).toEqual(["classic.PostSkillUse", "classic.PreSkillUse"])
  expect(developmentCatalog().examples.skillLifecycle).toBe(DEVELOPMENT_SKILL_LIFECYCLE_EXAMPLE)
  const overview = developmentCatalogPage()
  if (!("examples" in overview) || !overview.examples) throw Error("Expected discoverable examples")
  expect(overview.examples.skillLifecycle).toBe(DEVELOPMENT_SKILL_LIFECYCLE_EXAMPLE)
  const events: unknown[] = []
  let cursor: number | undefined = 0
  while (cursor !== undefined) {
    const page = developmentCatalogPage("events", cursor)
    if (!("content" in page) || !Array.isArray(page.content)) throw Error("Expected events page")
    events.push(...page.content)
    cursor = "nextCursor" in page ? page.nextCursor : undefined
  }
  for (const name of ["classic.PreSkillUse", "classic.PostSkillUse"])
    expect(events).toContainEqual(expect.objectContaining({ name, availability: "bounded" }))
  for (const invalid of [
    DEVELOPMENT_SKILL_LIFECYCLE_EXAMPLE.replace('skill_name: "review"', 'skillName: "review"'),
    DEVELOPMENT_SKILL_LIFECYCLE_EXAMPLE.replace("return next(event)", "return { passed: true }")
  ]) {
    await writeFile(join(root, "mods/main.ts"), invalid)
    expect((await analyzeAuthoringPreview(root)).typecheck.diagnostics.length).toBeGreaterThan(0)
  }
}, 15_000)
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


it("discovers the bounded native display contract through the existing catalog overview", () => {
  const full = developmentCatalog(), overview = developmentCatalogPage()
  expect(full.hostDisplay).toEqual(describeFunctionDisplayRouting())
  if (!("hostDisplay" in overview)) throw Error("Native display contract must be discoverable")
  expect(overview.hostDisplay).toEqual(full.hostDisplay)
  expect(full.hostDisplay.grantsAuthority).toBe(false)
  expect(full.hostDisplay.claimsCompleteSdkCompatibility).toBe(false)
  expect(full.sdkMethods.some(method => /^(display|rollout|snapshot)\./.test(method))).toBe(false)
})
