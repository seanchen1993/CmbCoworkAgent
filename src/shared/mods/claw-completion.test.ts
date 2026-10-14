import { expect, it } from "vitest"
import { mergeClawCompletionPolicy, parseClawCompletionRules } from "./claw-completion"
import { DEFAULT_COMPLETION_POLICY } from "./v2/completion-policy-values"

const capability = { pluginId: "a", name: "review", digest: "a".repeat(64) }
const extra = {
  ...DEFAULT_COMPLETION_POLICY,
  mode: "check" as const,
  maxRepairs: 0 as const,
  checks: ["unit-test" as const]
}
const parse = (policy: unknown, capabilities = [capability]) =>
  parseClawCompletionRules([{ ...capability, policy }], capabilities)

it("requires whole-package identity and rejects duplicate rules", () => {
  expect(parse(extra)[0].policy).toEqual(extra)
  expect(() => parse(extra, [{ ...capability, digest: "b".repeat(64) }])).toThrow()
  expect(() =>
    parseClawCompletionRules(
      [{ ...capability, policy: extra }],
      [{ ...capability, components: { mode: "selected", ids: ["review"], config: {} } }]
    )
  ).toThrow()
  expect(() =>
    parseClawCompletionRules(Array(2).fill({ ...capability, policy: extra }), [capability])
  ).toThrow()
})
it.each([
  { ...extra, mode: "repair" },
  { ...extra, maxRepairs: 1 },
  { ...extra, autobizStartCheckpoint: "dev" },
  { ...extra, target: "../secret" },
  { ...extra, scope: "file" },
  { ...extra, checks: [] },
  { ...extra, timeoutMs: 0 }
])("rejects unauthorized or invalid additional policy %j", (policy) =>
  expect(() => parse(policy)).toThrow()
)
it.each(["check", "repair"] as const)(
  "preserves project %s floor without granting repair to report checks",
  (mode) => {
    const project = {
      ...DEFAULT_COMPLETION_POLICY,
      mode,
      checks: ["code-review" as const],
      timeoutMs: 2000
    }
    const result = mergeClawCompletionPolicy(project, { ...extra, mode: "report" })!
    expect(result).toMatchObject({ mode: "check", maxRepairs: 0, timeoutMs: 2000 })
    expect(result.checks).toEqual(["code-review", "unit-test"])
  }
)
it("rejects active scope conflicts but not off/default scope and cannot elevate budgets", () => {
  const added = { ...extra, scope: "diff" as const, timeoutMs: 999999, modelTokenBudget: 999999 }
  expect(() =>
    mergeClawCompletionPolicy({ ...DEFAULT_COMPLETION_POLICY, mode: "check" }, added)
  ).toThrow()
  expect(mergeClawCompletionPolicy(DEFAULT_COMPLETION_POLICY, added)).toMatchObject({
    scope: "diff",
    timeoutMs: 120000,
    modelTokenBudget: 8192,
    mode: "check"
  })
  expect(mergeClawCompletionPolicy(undefined, undefined)).toBeUndefined()
  expect(mergeClawCompletionPolicy(DEFAULT_COMPLETION_POLICY, undefined)).toBe(
    DEFAULT_COMPLETION_POLICY
  )
})
