import { describe, expect, it } from "vitest"
import type { ClawCapability, ClawProfile, ClawView } from "../../../shared/mods/claw"
import { parseClawCompletionRules } from "../../../shared/mods/claw-completion"
import { proposeSparksExampleSelection, sparksExampleBaseline } from "./sparks-example-selection"

const identity = { id: "new-copy", name: "示例组合" }
const capability = (
  name: string,
  pluginId = `${name}-uuid`
): Pick<ClawCapability, "name" | "pluginId" | "digest"> => ({
  name,
  pluginId,
  digest: "a".repeat(64)
})
const view = (active: ClawProfile | null): Pick<ClawView, "active" | "capabilities"> => ({
  active,
  capabilities: []
})
const profile = (...capabilities: ClawCapability[]): ClawProfile => ({
  id: "original",
  name: "原组合",
  capabilities
})

describe("Sparks example selection", () => {
  it.each([
    ["token-weather", "replay-theater"],
    ["replay-theater", "token-weather"]
  ])("replaces only the reviewed peer of %s", (name, peer) => {
    const other = capability("other"),
      old = capability(peer)
    const base = profile(old, other, capability("blast-radius"))
    const result = proposeSparksExampleSelection(view(base), capability(name), identity)
    expect(result.removed).toEqual([old])
    expect(result.profile.capabilities.map((item) => item.name)).toEqual([
      "other",
      "blast-radius",
      name
    ])
    expect(base.capabilities).toEqual([old, other, capability("blast-radius")])
  })

  it("preserves every unrelated profile field and existing component settings without aliasing", () => {
    const target = {
      ...capability("blast-radius"),
      components: {
        mode: "selected" as const,
        ids: ["panel"],
        config: { panel: { tone: "quiet" } }
      }
    }
    const base: ClawProfile = {
      ...profile(capability("token-weather"), capability("replay-theater"), target),
      builtins: { contextMeter: true },
      skills: { mode: "selected", items: [] },
      mcp: { mode: "all", items: [] },
      models: { default: "chosen", roles: { Explore: "fast" } },
      completionRules: [],
      flow: {
        revision: 1,
        digest: "b".repeat(64),
        updatedAt: 1,
        definition: {
          schemaVersion: 2,
          id: "flow",
          name: "流程",
          goal: "保持",
          execution: { kind: "host" },
          timeoutMs: 1000,
          maxExecutions: 1,
          steps: []
        }
      }
    }
    const result = proposeSparksExampleSelection(view(base), capability("blast-radius"), identity)
    expect(result.alreadySelected).toBe(true)
    expect(result.removed).toEqual([])
    expect(result.profile).toEqual({ ...base, ...identity })
    result.profile.models!.roles.Explore = "changed"
    result.profile.capabilities[2].components!.config.panel.tone = "changed"
    expect(base.models!.roles.Explore).toBe("fast")
    expect(target.components.config.panel.tone).toBe("quiet")
  })

  it("snapshots only ready defaults and never borrows a saved profile", () => {
    const source = {
      active: null,
      capabilities: [
        { ...capability("ready"), state: "ready" as const, capabilities: [] },
        { ...capability("pending"), state: "needs-approval" as const, capabilities: [] },
        { ...capability("off"), state: "disabled" as const, capabilities: [] }
      ]
    }
    expect(sparksExampleBaseline(source, identity)).toEqual({
      ...identity,
      capabilities: [capability("ready")]
    })
  })

  it("rejects capacity overflow and same-name identity changes", () => {
    const base = profile(...Array.from({ length: 8 }, (_, index) => capability(`other-${index}`)))
    expect(() =>
      proposeSparksExampleSelection(view(base), capability("blast-radius"), identity)
    ).toThrow("上限")
    expect(() =>
      proposeSparksExampleSelection(
        view(profile(capability("token-weather"))),
        capability("token-weather", "different-uuid"),
        identity
      )
    ).toThrow("身份已变化")
  })

  it("refuses to discard a conflicting provider referenced by a flow", () => {
    const base = profile(capability("token-weather"))
    base.flow = {
      revision: 1,
      digest: "b".repeat(64),
      updatedAt: 1,
      definition: {
        schemaVersion: 1,
        plugin: "token-weather",
        id: "flow",
        name: "流程",
        goal: "保持",
        timeoutMs: 1000,
        maxExecutions: 1,
        steps: []
      }
    }
    expect(() =>
      proposeSparksExampleSelection(view(base), capability("replay-theater"), identity)
    ).toThrow("流程或完成规则引用")
    expect(base.flow.definition.plugin).toBe("token-weather")
  })

  it("refuses to discard a conflicting completion rule", () => {
    const provider = capability("token-weather")
    const base = profile(provider)
    base.completionRules = parseClawCompletionRules(
      [{ ...provider, policy: { mode: "report" } }],
      base.capabilities
    )
    expect(() =>
      proposeSparksExampleSelection(view(base), capability("replay-theater"), identity)
    ).toThrow("流程或完成规则引用")
    expect(base.completionRules).toHaveLength(1)
  })
})
