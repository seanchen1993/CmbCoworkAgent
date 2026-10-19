import assert from "node:assert/strict"
import { resolve } from "node:path"
import { test } from "node:test"
import AdmZip from "adm-zip"
import type { BusinessModCatalog } from "../src/shared/business-mods"
import { businessSmokeUiPlan, type BusinessSmokeUiSource } from "./support/business-smoke-ui-plan"

function source(name: string, manifest: BusinessModCatalog): BusinessSmokeUiSource {
  return {
    metadata: { name },
    manifest,
    inspection: {
      id: `${name}-actual-inspection`,
      sourceName: name,
      sourceDigest: "a".repeat(64),
      mods: [...manifest.modules, ...(manifest.extensions ?? [])].map((mod) => ({
        id: mod.id,
        title: mod.title,
        dependsOn: mod.dependencies.required,
        advisory: mod.dependencies.advisory,
        ...("kind" in mod ? { kind: mod.kind } : {})
      })),
      excluded: [],
      warnings: []
    }
  }
}
function catalog(ids: string[], dependencies: Record<string, string[]> = {}): BusinessModCatalog {
  return {
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    modules: ids.map((id) => ({
      id,
      title: id,
      node: {},
      skill: { entry: `skills/${id}/SKILL.md`, resources: [] },
      resources: [],
      dependencies: { required: dependencies[id] ?? [], advisory: [] },
      checks: { validators: [], guards: [] }
    }))
  }
}
const old = () => source("legacy-three", catalog(["one", "two", "three"]))

test("the actual v10410/12 ZIPs select their real PRD/Specs and retain knowledge/progress", () => {
  const library = resolve("output/deliveries/mods-creator-utest-library-20261018-v104")
  const read = (file: string) => {
    const zip = new AdmZip(resolve(library, file))
    return source(
      JSON.parse(zip.readAsText("plugin.json")).name,
      JSON.parse(zip.readAsText("mods/business/manifest.json"))
    )
  }
  const plan = businessSmokeUiPlan([
    read("10-完整AutoBiz+并行进度+知识版-1.0.4.zip"),
    read("12-数仓可验证产物导出版-1.0.4.zip")
  ])
  assert.deepEqual(
    plan.installed.map((row) => [row.business, row.extensions]),
    [
      [8, 2],
      [5, 2]
    ]
  )
  assert.equal(plan.assemblies.length, 2)
  for (const assembly of plan.assemblies) {
    assert.deepEqual(
      assembly.steps.map((mod) => mod.id),
      ["biz.prd", "dev.specs"]
    )
    assert.deepEqual(
      assembly.extensions.map((mod) => mod.id),
      ["autobiz.knowledge", "autobiz.worktree-progress"]
    )
    assert.equal(assembly.selected.length, 4)
  }
})
test("preserves the old two-module preference without requiring it for every library", () => {
  const plan = businessSmokeUiPlan([old(), source("legacy-two", catalog(["document", "review"]))])
  assert.equal(plan.assemblies[0].name, "legacy-two")
  assert.deepEqual(
    plan.assemblies[0].steps.map((mod) => mod.id),
    ["document", "review"]
  )
})
test("includes transitive required producers and extension dependencies", () => {
  const manifest = catalog(["consumer", "report", "producer"], { consumer: ["producer"] })
  manifest.extensions = [
    {
      id: "progress",
      title: "Progress",
      kind: "function",
      entry: "progress.ts",
      resources: [],
      dependencies: { required: ["report"], advisory: [] }
    }
  ]
  const plan = businessSmokeUiPlan([source("actual", manifest), old()]).assemblies[0]
  assert.deepEqual(
    plan.steps.map((mod) => mod.id),
    ["producer", "consumer", "report"]
  )
  assert.deepEqual(
    plan.extensions.map((mod) => mod.id),
    ["progress"]
  )
})
test("rejects a required dependency missing from the actual source", () => {
  assert.throws(
    () => businessSmokeUiPlan([source("broken", catalog(["a", "b"], { a: ["missing"] })), old()]),
    /Missing required dependency/
  )
})
test("rejects a forged inspection, including unknown extra modules or changed required edges", () => {
  const input = source("broken", catalog(["a", "b"]))
  input.inspection.mods.push({ id: "unknown", title: "Unknown", dependsOn: [], advisory: [] })
  assert.throws(() => businessSmokeUiPlan([input, old()]), /Inspection\/ZIP identities differ/)
  input.inspection.mods.pop()
  input.inspection.mods[0].dependsOn = ["b"]
  assert.throws(() => businessSmokeUiPlan([input, old()]), /Native dependency mismatch/)
})
test("rejects cycles in the selected dependency closure, as the original assembler does", () => {
  assert.throws(
    () =>
      businessSmokeUiPlan([
        source("broken", catalog(["a", "b", "c"], { a: ["b"], b: ["a"] })),
        old()
      ]),
    /Cyclic required dependency/
  )
})
