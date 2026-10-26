import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { afterEach, expect, it } from "vitest"
import { adaptLegacyImport } from "../harness-board/project-runtime/legacy-import-adapter"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
import { businessInput } from "./autobiz-native-fixture.test-helper"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "autobiz-native-import-"))
  roots.push(root)
  const source = join(root, "source"),
    target = join(root, "target")
  mkdirSync(source)
  mkdirSync(target)
  const original = businessInput()
  const base = join(source, ".autobizdevops/features/orders")
  mkdirSync(base, { recursive: true })
  writeFileSync(
    join(source, ".autobizdevops/state.json"),
    JSON.stringify({ features: { orders: { checkpoint: "plan_done" } } })
  )
  for (const bundle of [original.prd, original.specs, original.design, original.plan]) {
    for (const [path, value] of Object.entries(bundle.files)) {
      mkdirSync(dirname(join(base, path)), { recursive: true })
      writeFileSync(join(base, path), String(value))
    }
  }
  // Old lineage is deliberately incompatible: the adapter must never invent a normalized marker.
  writeFileSync(
    join(base, "PRD.md"),
    original.prd.files["PRD.md"].replace("来源：NORMALIZED_REQUIREMENTS.json\n", "")
  )
  writeFileSync(
    join(target, "devclaw.legacy-import.json"),
    readFileSync("resources/native-compositions/autobiz-import/devclaw.legacy-import.json")
  )
  const sourceDefinition = JSON.parse(
    readFileSync("resources/native-compositions/autobiz/composition/source.json", "utf8")
  )
  const manifest = hostProjectFixture(target).manifest
  manifest.stages = sourceDefinition.modules
    .slice(0, 5)
    .map((module: { id: string; outputs: Array<{ id: string }> }) => ({
      ...manifest.stages[0],
      id: module.id,
      artifactIds: module.outputs.map((output) => output.id)
    }))
  manifest.artifacts = sourceDefinition.modules
    .slice(0, 5)
    .flatMap((module: { outputs: Array<{ id: string; path: string }> }) =>
      module.outputs.map((output) => ({ id: output.id, path: output.path, required: true }))
    )
  const adapted = adaptLegacyImport(
    { root: target, digest: "a".repeat(64), manifest },
    source,
    "autobiz-converted-requirements",
    {
      sourceProjectId: "registered-old",
      target: {
        projectId: "new",
        name: "Import",
        workspace: target,
        installedPluginId: "installed-target",
        goal: "Revalidate"
      },
      adapterId: "autobiz-documents",
      parameters: { feature: "orders" }
    }
  )
  return { original, adapted, source, base }
}
function check(input: unknown) {
  const checks = resolve("resources/native-compositions/autobiz-rules/checks")
  const child = spawnSync(
    "python",
    [
      "-I",
      "-B",
      "-X",
      "utf8",
      "-c",
      "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2],run_name='__main__')",
      checks,
      join(checks, "check.py")
    ],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 4000,
      windowsHide: true
    }
  )
  if (child.error) throw child.error
  expect(child.stderr).toBe("")
  const result = JSON.parse(child.stdout)
  expect(child.status).toBe(result.passed ? 0 : 1)
  return result
}
it("checks real AutoBiz bundles after adaptation without rewriting the original design lock or Plan", () => {
  const f = fixture()
  const design = JSON.parse(f.adapted.outputs.get("DESIGN.bundle.json")!.toString())
  const plan = JSON.parse(f.adapted.outputs.get("PLAN.bundle.json")!.toString())
  expect(design.files).toEqual(f.original.design.files)
  expect(plan.files).toEqual(f.original.plan.files)
  expect(f.adapted.adaptation.reexecuteStageIds).toEqual(["convert", "prd", "specs"])
  expect(f.adapted.outputs.has("PRD.bundle.json")).toBe(false)
  const material = JSON.parse(f.adapted.outputs.get(".devclaw/import-source.json")!.toString())
  expect(material.files[".autobizdevops/features/orders/PRD.md"]).not.toContain(
    "来源：NORMALIZED_REQUIREMENTS.json"
  )
  // These are the deterministic outputs of the required fresh upstream Skills, not imported approvals.
  const upstream = {
    normalized: f.original.normalized,
    prd: f.original.prd,
    specs: f.original.specs
  }
  expect(check({ ...upstream, stage: "design", current: design })).toMatchObject({ passed: true })
  expect(check({ ...upstream, stage: "plan", design, current: plan })).toMatchObject({
    passed: true
  })
  expect(readFileSync(join(f.base, ".design-contract.lock.json"), "utf8")).toBe(
    f.original.design.files[".design-contract.lock.json"]
  )
})
it("fails real target checks when preserved locks or Plan references are incompatible instead of repairing old evidence", () => {
  const f = fixture()
  const design = JSON.parse(f.adapted.outputs.get("DESIGN.bundle.json")!.toString())
  const plan = JSON.parse(f.adapted.outputs.get("PLAN.bundle.json")!.toString())
  const upstream = {
    normalized: f.original.normalized,
    prd: f.original.prd,
    specs: f.original.specs
  }
  const changedDesign = structuredClone(design)
  changedDesign.files["design.md"] += "Changed semantic decision\n"
  expect(check({ ...upstream, stage: "design", current: changedDesign })).toMatchObject({
    passed: false
  })
  const batch = JSON.parse(plan.files["plans/B001/plan.json"])
  batch.tasks[0].specRefs = ["specs/absent/spec.md#REQ-999"]
  plan.files["plans/B001/plan.json"] = JSON.stringify(batch)
  expect(check({ ...upstream, stage: "plan", design, current: plan })).toMatchObject({
    passed: false
  })
  expect(readFileSync(join(f.base, ".design-contract.lock.json"), "utf8")).toBe(
    f.original.design.files[".design-contract.lock.json"]
  )
  expect(readFileSync(join(f.base, "plans/B001/plan.json"), "utf8")).toBe(
    f.original.plan.files["plans/B001/plan.json"]
  )
})
