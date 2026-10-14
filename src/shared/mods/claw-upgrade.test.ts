import { describe, expect, it } from "vitest"
import { planClawUpgrade } from "./claw-upgrade"
import { clawChangeSummary } from "./claw-change-summary"
import type { ClawProfile } from "./claw"
import type { FunctionPluginStatus } from "./v2/commands"

const component = {
  id: "review",
  name: "Review",
  kind: "module" as const,
  entry: "review.ts",
  dependsOn: [],
  actionIds: ["review"]
}
const profile = (): ClawProfile => ({
  id: "p",
  name: "Claw",
  capabilities: [
    {
      pluginId: "a",
      name: "a",
      digest: "a".repeat(64),
      components: {
        mode: "selected",
        ids: ["review"],
        config: { review: { secret: "do-not-display", strict: false } }
      }
    }
  ]
})
const source = (): FunctionPluginStatus => ({
  pluginId: "a",
  name: "a",
  digest: "b".repeat(64),
  state: "ready",
  capabilities: [],
  components: [component]
})
describe("Claw upgrades and previews", () => {
  it("preserves the builtin snapshot and capability order when updating sources", () => {
    const before = profile()
    before.builtins = { contextMeter: true }
    const second = { pluginId: "z", name: "z", digest: "c".repeat(64) }
    before.capabilities.unshift(second)
    const plan = planClawUpgrade(
      before,
      [
        source(),
        {
          ...second,
          digest: "d".repeat(64),
          state: "ready",
          capabilities: []
        }
      ],
      [],
      () => undefined
    )
    expect(plan.issues).toEqual([])
    expect(plan.profile.builtins).toEqual({ contextMeter: true })
    expect(plan.profile.capabilities.map((item) => item.pluginId)).toEqual(["z", "a"])
    expect(plan.profile.capabilities.map((item) => item.digest)).toEqual([
      "d".repeat(64),
      "b".repeat(64)
    ])
  })
  it("preserves selection and opaque configuration, without altering the original", () => {
    const before = profile()
    const plan = planClawUpgrade(before, [source()], [], () => undefined)
    expect(plan.issues).toEqual([])
    expect(plan.profile.capabilities[0].digest).toBe("b".repeat(64))
    expect(plan.profile.capabilities[0].components).toEqual(before.capabilities[0].components)
    expect(before.capabilities[0].digest).toBe("a".repeat(64))
    expect(clawChangeSummary(null, plan.profile).join("\n")).not.toContain("do-not-display")
    expect(clawChangeSummary(null, plan.profile).join("\n")).toContain("secret")
  })
  it("does not upgrade an unapproved or renamed source", () => {
    const before = profile()
    for (const current of [
      { ...source(), state: "needs-approval" },
      { ...source(), name: "different" }
    ] as FunctionPluginStatus[]) {
      const plan = planClawUpgrade(before, [current], [], () => undefined)
      expect(plan.issues).toHaveLength(1)
      expect(plan.profile).toEqual(before)
    }
  })
  it("reports missing dependencies and rejected schema without silently changing selection", () => {
    const current = {
      ...source(),
      components: [
        { ...component, dependsOn: ["base"] },
        { ...component, id: "base", actionIds: [] }
      ]
    }
    const plan = planClawUpgrade(profile(), [current], [], () => undefined)
    expect(plan.issues.join()).toContain("DEPENDENCY")
    expect(plan.profile.capabilities[0].components?.ids).toEqual(["review"])
    const invalid = planClawUpgrade(profile(), [source()], [], () => "new required field")
    expect(invalid.issues.join()).toContain("new required field")
    expect(invalid.profile.capabilities[0].components?.config.review.strict).toBe(false)
  })
  it("returns a separate flow draft and never forges the saved flow digest", () => {
    const before = profile()
    before.flow = {
      revision: 3,
      digest: "c".repeat(64),
      updatedAt: 1,
      definition: {
        schemaVersion: 2,
        execution: { kind: "host" },
        id: "flow",
        name: "flow",
        goal: "review",
        timeoutMs: 10000,
        maxExecutions: 10,
        steps: [
          {
            id: "step",
            name: "review",
            enabled: true,
            kind: "plugin-action",
            pluginId: "a",
            plugin: "a",
            actionId: "review",
            digest: "a".repeat(64),
            input: {}
          }
        ]
      }
    }
    const plan = planClawUpgrade(
      before,
      [source()],
      [
        {
          pluginId: "a",
          plugin: "a",
          digest: "b".repeat(64),
          actionId: "review",
          name: "review",
          command: "review",
          inputSchema: {}
        }
      ],
      () => undefined
    )
    expect(plan.flow?.steps[0]).toMatchObject({ digest: "b".repeat(64) })
    expect(plan.profile.flow).toEqual(before.flow)
    expect(plan.profile.flow?.digest).toBe("c".repeat(64))
  })
  it("ignores object key ordering when comparing unchanged configuration", () => {
    const before = profile(),
      after = profile()
    after.capabilities[0].components!.config.review = { strict: false, secret: "do-not-display" }
    expect(clawChangeSummary(before, after)).toEqual([])
  })
})
