import { expect, it } from "vitest"
import { DEFAULT_COMPLETION_POLICY } from "../../../shared/mods/v2/completion-policy-values"
import {
  completionBusinessEvidencePaths,
  planCompletionApplicationEvidence,
  planCompletionBusiness,
  type CompletionBusinessEntry
} from "./completion-business-plan"

function entry(overrides: Partial<CompletionBusinessEntry> = {}): CompletionBusinessEntry {
  return {
    plugin: "plugin",
    active: true,
    policy: { ...DEFAULT_COMPLETION_POLICY, mode: "check", checks: ["autobiz-validator"] },
    application: undefined,
    ...overrides
  }
}

it("does not inspect inactive application or policy data", () => {
  const inactive = { plugin: "disabled", active: false } as CompletionBusinessEntry
  for (const key of ["application", "policy"])
    Object.defineProperty(inactive, key, {
      get: () => {
        throw Error("INACTIVE_ACCESS")
      }
    })
  expect(planCompletionBusiness([inactive])).toEqual({
    automaticStage: undefined,
    validatorFeatures: [],
    evidenceReferences: false
  })
})

it("preserves legacy providers without adding a validator or business evidence", () => {
  expect(planCompletionBusiness([entry({ policy: undefined })])).toEqual({
    automaticStage: undefined,
    validatorFeatures: [],
    evidenceReferences: false
  })
})

it("preserves selected validator feature order, including the unspecified feature", () => {
  const feature = (plugin: string, value?: string) =>
    entry({
      plugin,
      policy: {
        ...DEFAULT_COMPLETION_POLICY,
        mode: "report",
        feature: value,
        checks: ["autobiz-validator"]
      }
    })
  expect(
    planCompletionBusiness([
      feature("a", "one"),
      feature("b"),
      feature("c", "one"),
      feature("d", "two")
    ]).validatorFeatures
  ).toEqual(["one", undefined, "two"])
})

it.each(["report", "check", "repair"] as const)("keeps %s policy business selection", (mode) => {
  const plan = planCompletionBusiness([
    entry({
      policy: { ...DEFAULT_COMPLETION_POLICY, mode, checks: ["autobiz-validator"] },
      application: { feature: "feature", autobizStartCheckpoint: "start" }
    })
  ])
  expect(plan.automaticStage).toEqual({ plugin: "plugin", feature: "feature", start: "start" })
  expect(plan.evidenceReferences).toBe(true)
})

it("rejects different automatic stages and a conflicting explicitly requested stage", () => {
  const first = entry({ application: { feature: "a", autobizStartCheckpoint: "start" } })
  const second = entry({
    plugin: "other",
    application: { feature: "b", autobizStartCheckpoint: "start" }
  })
  expect(() => planCompletionBusiness([first, second])).toThrow("MODS_AUTOBIZ_STAGE_CONFLICT")
  expect(() => planCompletionBusiness([first], { feature: "a", start: "other" })).toThrow(
    "MODS_AUTOBIZ_STAGE_CONFLICT"
  )
  expect(
    planCompletionBusiness([first, { ...first, plugin: "same-stage" }]).automaticStage
  ).toEqual({ plugin: "plugin", feature: "a", start: "start" })
})

it("copies the requested stage and freezes every retained output", () => {
  const requested = { feature: "a", start: "start" }
  const plan = planCompletionBusiness([entry()], requested)
  requested.start = "changed"
  expect(plan.automaticStage?.start).toBe("start")
  expect(Object.isFrozen(plan)).toBe(true)
  expect(Object.isFrozen(plan.automaticStage)).toBe(true)
  expect(Object.isFrozen(plan.validatorFeatures)).toBe(true)
})

it("keeps application evidence opt-in separate from the merged active completion policy", () => {
  const plan = planCompletionApplicationEvidence([
    { plugin: "off", application: { mode: "off", feature: "a", autobizStartCheckpoint: "x" } },
    { plugin: "stage", application: { mode: "report", feature: "b", autobizStartCheckpoint: "y" } },
    { plugin: "none", application: undefined }
  ])
  expect(plan).toEqual({
    stages: [{ plugin: "stage", feature: "b", start: "y" }],
    evidenceReferences: true
  })
  expect(Object.isFrozen(plan.stages)).toBe(true)
  expect(Object.isFrozen(plan.stages[0])).toBe(true)
  expect(
    planCompletionApplicationEvidence([
      { plugin: "validator", application: { checks: ["autobiz-validator"] } }
    ]).evidenceReferences
  ).toBe(true)
})

it("preserves ordered file, feature and project evidence paths without widening diff scope", () => {
  const policies = [
    { mode: "off" as const, scope: "project" as const },
    { mode: "check" as const, scope: "file" as const, target: "first.txt" },
    { mode: "repair" as const, scope: "feature" as const, feature: "one", target: "second.txt" },
    { mode: "report" as const, scope: "project" as const },
    { mode: "check" as const, scope: "diff" as const }
  ].map((policy) => ({ policy: { ...DEFAULT_COMPLETION_POLICY, ...policy } }))
  const paths = completionBusinessEvidencePaths(policies)
  expect(paths).toEqual(["first.txt", ".autobizdevops/features/one", "second.txt", "."])
  expect(Object.isFrozen(paths)).toBe(true)
})

it("defers original evidence path validation until the capture boundary invokes it", () => {
  const entries = [
    entry({
      policy: {
        ...DEFAULT_COMPLETION_POLICY,
        mode: "check",
        scope: "feature",
        feature: "../outside"
      }
    })
  ]
  expect(() => planCompletionBusiness(entries)).not.toThrow()
  expect(() => completionBusinessEvidencePaths(entries)).toThrow("AUTOBIZ_FEATURE_INVALID")
})
