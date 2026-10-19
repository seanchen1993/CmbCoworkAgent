import { expect, it } from "vitest"
import type { BusinessModCatalog, BusinessModDefinition } from "../../shared/business-mods"
import {
  assertClosedBusinessModSelection,
  businessModSelectionPolicy,
  closeBusinessModSelection
} from "./business-mod-selection"

function mod(
  id: string,
  inputs: string[],
  outputs: string[],
  required: string[] = []
): BusinessModDefinition {
  return {
    id,
    title: id,
    node: {
      id,
      artifacts: {
        inputs: inputs.map((path) => ({ path, required: true })),
        outputs: outputs.map((path) => ({ path, required: true }))
      }
    },
    skill: { entry: `skills/${id}/SKILL.md`, resources: [] },
    resources: [],
    dependencies: { required, advisory: [] },
    checks: { validators: [], guards: [] }
  }
}
function catalog(modules: BusinessModDefinition[]): BusinessModCatalog {
  return {
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernelRef: { id: "autobiz.python-kernel", version: "1.0.0" },
    modules
  }
}

it("closes actual artifact and explicit business dependencies in frozen source order", () => {
  const policy = businessModSelectionPolicy(
    catalog([
      mod("prd", [], ["PRD.md"]),
      mod("specs", ["PRD.md"], ["specs/**/*.md"]),
      mod("extra-check", [], []),
      mod("model", ["specs/**/*.md"], ["MODEL.json"]),
      mod("sql", ["MODEL.json"], ["DATA.sqlite3"]),
      mod("quality", ["DATA.sqlite3"], ["QA.json"], ["extra-check"])
    ])
  )
  expect(closeBusinessModSelection(policy, ["quality"])).toEqual([
    "prd",
    "specs",
    "extra-check",
    "model",
    "sql",
    "quality"
  ])
  expect(closeBusinessModSelection(policy, ["prd"])).toEqual(["prd"])
  expect(() => assertClosedBusinessModSelection(policy, ["quality"])).toThrow("必需依赖")
})

it("never treats required input degrade guidance as permission to erase its contract", () => {
  const missing = mod("quality", ["missing.json"], ["QA.json"])
  missing.node.artifacts = {
    inputs: [
      { path: "missing.json", required: true, extract: { degrade: "Ask for earlier context" } }
    ],
    outputs: []
  }
  const policy = businessModSelectionPolicy(catalog([mod("prd", [], []), missing]))
  expect(closeBusinessModSelection(policy, ["prd"])).toEqual(["prd"])
  expect(() => closeBusinessModSelection(policy, ["quality"])).toThrow("missing.json")
})

it("keeps optional inputs optional and uses the latest preceding producer for updated artifacts", () => {
  const check = mod("check", ["state.json"], [])
  check.node.artifacts = {
    inputs: [
      { path: "state.json", required: true },
      { path: "optional.md", required: false }
    ],
    outputs: []
  }
  const policy = businessModSelectionPolicy(
    catalog([
      mod("create", [], ["state.json"]),
      mod("update", ["state.json"], ["state.json"]),
      check
    ])
  )
  expect(closeBusinessModSelection(policy, ["check"])).toEqual(["create", "update", "check"])
})

it("includes optional producers and their own required closure only when requested", () => {
  const check = mod("check", ["data.json"], [])
  check.node.artifacts = {
    inputs: [
      { path: "data.json", required: true },
      { path: "optional.md", required: false }
    ],
    outputs: []
  }
  const policy = businessModSelectionPolicy(
    catalog([
      mod("seed", [], ["source.json"]),
      mod("optional", ["source.json"], ["optional.md"]),
      mod("data", [], ["data.json"]),
      check
    ])
  )
  expect(closeBusinessModSelection(policy, ["check"], false)).toEqual(["data", "check"])
  expect(closeBusinessModSelection(policy, ["check"], true)).toEqual([
    "seed",
    "optional",
    "data",
    "check"
  ])
})

it("rejects unknown, duplicate, cyclic or backward required selections", () => {
  const policy = businessModSelectionPolicy(catalog([mod("first", [], []), mod("last", [], [])]))
  expect(() => closeBusinessModSelection(policy, ["unknown"])).toThrow("不存在")
  expect(() => closeBusinessModSelection(policy, ["first", "first"])).toThrow("无效")
  const cycle = businessModSelectionPolicy(
    catalog([mod("a", [], [], ["b"]), mod("b", [], [], ["a"])])
  )
  expect(() => closeBusinessModSelection(cycle, ["a"])).toThrow("循环")
  const backward = businessModSelectionPolicy(catalog([mod("a", [], [], ["b"]), mod("b", [], [])]))
  expect(() => closeBusinessModSelection(backward, ["a"])).toThrow("顺序")
})
