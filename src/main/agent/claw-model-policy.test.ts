import { expect, it } from "vitest"
import { createClawModelGuard } from "./claw-model-policy"
import type { ResolvedModelConfig } from "../models/registry"
import type { ClawProfile } from "../../shared/mods/claw"

const model = (ref: `custom:${string}`, publicName = "same-name"): ResolvedModelConfig =>
  ({
    ref,
    id: ref,
    name: ref,
    source: "custom",
    model: publicName,
    baseUrl: "https://example.test/v1",
    apiKey: "fixture-only"
  }) as ResolvedModelConfig

it("restricts routing by provider reference even when names match", () => {
  const a = model("custom:a"),
    b = model("custom:b"),
    c = model("custom:c")
  const models = new Map([a, b, c].map((value) => [String(value.ref), value]))
  const guard = createClawModelGuard(
    {
      id: "p",
      name: "Profile",
      capabilities: [],
      models: { default: a.ref, roles: { review: b.ref } }
    },
    a,
    (ref) => models.get(ref) ?? null
  )!
  expect(() => guard(a)).not.toThrow()
  expect(() => guard(b)).not.toThrow()
  expect(() => guard(c)).toThrow("CLAW_MODEL_NOT_ALLOWED")
  models.set(b.ref, { ...b, baseUrl: "https://changed.test/v1" })
  expect(() => guard(a)).toThrow("CLAW_MODEL_CONFIGURATION_CHANGED")
})
it("retains legacy routing without a Claw model policy and rejects credential revocation", () => {
  const a = model("custom:a")
  let current = a
  expect(createClawModelGuard(null, a, () => current)).toBeUndefined()
  const guard = createClawModelGuard(
    { id: "p", name: "Profile", capabilities: [], models: { roles: {} } },
    a,
    () => current
  )!
  current = { ...a, apiKey: "" }
  expect(() => guard(a)).toThrow("CLAW_MODEL_CONFIGURATION_CHANGED")
})

it("excludes disabled flow providers while requiring enabled providers", () => {
  const a = model("custom:a")
  const profile: ClawProfile = {
    id: "p",
    name: "Profile",
    capabilities: [],
    models: { roles: {} },
    flow: {
      revision: 1,
      updatedAt: 1,
      digest: "a".repeat(64),
      definition: {
        schemaVersion: 1,
        id: "flow",
        name: "Flow",
        plugin: "p",
        goal: "Work",
        timeoutMs: 1000,
        maxExecutions: 3,
        steps: [
          {
            id: "missing",
            name: "Missing",
            kind: "agent",
            enabled: false,
            prompt: "Work",
            modelId: "custom:missing"
          }
        ]
      }
    }
  }
  const lookup = (ref: string) => (ref === a.ref ? a : null)
  const guard = createClawModelGuard(profile, a, lookup)!
  expect(() => guard(a)).not.toThrow()
  expect(() => guard(model("custom:missing"))).toThrow("CLAW_MODEL_NOT_ALLOWED")
  profile.flow!.definition.steps[0].enabled = true
  expect(() => createClawModelGuard(profile, a, lookup)).toThrow("CLAW_MODEL_UNAVAILABLE")
})
