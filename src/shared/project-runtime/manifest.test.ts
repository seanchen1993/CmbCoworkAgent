import { describe, expect, it } from "vitest"
import { parseProjectRuntimeManifest } from "./manifest"
import { PROJECT_RUNTIME_MAX_BYTES, type ProjectRuntimeManifest } from "./types"

export function runtimeFixture(): ProjectRuntimeManifest {
  return {
    apiVersion: "devclaw.project-runtime/v1",
    plugin: { id: "docs", version: "1.0.0" },
    mode: "host",
    stateOwner: "host",
    stages: [
      {
        id: "draft",
        title: "起草",
        skill: "skills/draft/SKILL.md",
        actionIds: [],
        artifactIds: ["document"],
        checkIds: ["exists"],
        approval: "none"
      },
      {
        id: "review",
        title: "验收",
        actionIds: [],
        artifactIds: ["document"],
        checkIds: ["exists"],
        approval: "human"
      }
    ],
    actions: [],
    artifacts: [{ id: "document", path: "draft.md", required: true }],
    checks: [{ id: "exists", kind: "file-exists", artifactId: "document", sideEffect: "read" }],
    environment: [],
    capabilities: {
      execution: true,
      conditionalTransition: true,
      idempotency: true,
      reconciliation: true,
      cancellation: true
    }
  }
}

describe("project runtime declaration", () => {
  it("preserves optional output approval without changing legacy input approval", () => {
    const fixture = runtimeFixture()
    fixture.stages[0].resultApproval = "human"
    const parsed = parseProjectRuntimeManifest(fixture)
    expect(parsed.stages[0].approval).toBe("none")
    expect(parsed.stages[0].resultApproval).toBe("human")
    expect(parsed.stages[1]).not.toHaveProperty("resultApproval")
    expect(() => parseProjectRuntimeManifest({
      ...fixture, mode: "legacy", stateOwner: "plugin"
    })).toThrow("PROJECT_RUNTIME_MANIFEST_INVALID")
    for (const resultApproval of [true, "approved", null]) {
      expect(() => parseProjectRuntimeManifest({
        ...fixture, stages: [{ ...fixture.stages[0], resultApproval }]
      })).toThrow("PROJECT_RUNTIME_MANIFEST_INVALID")
    }
  })
  it("keeps host linear stages and legacy ownership separate", () => {
    const fixture = runtimeFixture()
    expect(parseProjectRuntimeManifest(fixture)).toEqual(fixture)
    expect(
      parseProjectRuntimeManifest({ ...fixture, mode: "legacy", stateOwner: "plugin", stages: [] })
        .stages
    ).toEqual([])
    expect(() => parseProjectRuntimeManifest({ ...fixture, stateOwner: "plugin" })).toThrow()
    expect(() => parseProjectRuntimeManifest({ ...fixture, stages: [] })).toThrow()
    expect(() =>
      parseProjectRuntimeManifest({ ...fixture, apiVersion: "devclaw.project/v1" })
    ).toThrow()
  })
  it("rejects executable extras, duplicate IDs, paths outside the package and dangling checks", () => {
    const fixture = runtimeFixture()
    expect(() => parseProjectRuntimeManifest({ ...fixture, command: "execute" })).toThrow()
    expect(() =>
      parseProjectRuntimeManifest({ ...fixture, stages: [fixture.stages[0], fixture.stages[0]] })
    ).toThrow()
    for (const path of ["../secret", "/absolute", "C:/secret", "a\\b", "a/./b"])
      expect(() =>
        parseProjectRuntimeManifest({ ...fixture, artifacts: [{ ...fixture.artifacts[0], path }] })
      ).toThrow()
    expect(() => parseProjectRuntimeManifest({ ...fixture, checks: [] })).toThrow()
    expect(() =>
      parseProjectRuntimeManifest({
        ...fixture,
        checks: [{ ...fixture.checks[0], sideEffect: "external" }]
      })
    ).toThrow()
  })
  it("uses the existing exact action identity including package digest", () => {
    const fixture = runtimeFixture()
    const ref = { pluginId: "other", plugin: "other", actionId: "draft", digest: "a".repeat(64) }
    expect(
      parseProjectRuntimeManifest({ ...fixture, actions: [{ id: "draft", ref }] }).actions[0].ref
    ).toEqual(ref)
    expect(() =>
      parseProjectRuntimeManifest({
        ...fixture,
        actions: [{ id: "draft", ref: { ...ref, digest: "latest" } }]
      })
    ).toThrow()
    expect(() =>
      parseProjectRuntimeManifest({
        ...fixture,
        actions: [{ id: "draft", ref: { ...ref, shell: "run" } }]
      })
    ).toThrow()
  })
  it("bounds data and does not return caller-owned mutable declarations", () => {
    const fixture = runtimeFixture()
    expect(() =>
      parseProjectRuntimeManifest({
        ...fixture,
        plugin: { id: "x".repeat(PROJECT_RUNTIME_MAX_BYTES), version: "1" }
      })
    ).toThrow()
    const parsed = parseProjectRuntimeManifest(fixture)
    fixture.stages[0].artifactIds.push("changed")
    expect(parsed.stages[0].artifactIds).toEqual(["document"])
  })
})
