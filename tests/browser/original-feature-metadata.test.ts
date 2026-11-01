import { expect, it } from "vitest"
import { assertOriginalFeatureMetadata } from "../support/live-original-feature-journey"

const valid = () => ({
  installed: {
    pluginId: "native-fixture",
    name: "fixture",
    version: "1.0.0",
    sourceDigest: "a".repeat(64)
  },
  project: {
    name: "Unicode 项目",
    code: "LIVE12345678901",
    systemId: "system",
    systemName: "System",
    folder: "native-project"
  },
  feature: { title: "Handoff 123", goal: "Complete original Feature handoff. ".repeat(20) }
})

it("accepts original metadata boundaries while retaining the complete long Feature goal", () => {
  const input = valid()
  const goal = input.feature.goal
  expect(() => assertOriginalFeatureMetadata(input)).not.toThrow()
  expect(input.feature.goal).toBe(goal)
  expect(() =>
    assertOriginalFeatureMetadata({
      ...input,
      project: { ...input.project, description: "🔧".repeat(100) }
    })
  ).not.toThrow()
})

it("rejects all original length, required and character boundaries before native work", () => {
  for (const [field, maximum] of [
    ["name", 50],
    ["code", 15],
    ["description", 100],
    ["folder", 30]
  ] as const) {
    const input = valid()
    expect(() =>
      assertOriginalFeatureMetadata({
        ...input,
        project: { ...input.project, [field]: "a".repeat(maximum + 1) }
      })
    ).toThrow(`ORIGINAL_FEATURE_METADATA_TOO_LONG:${field}`)
  }
  for (const field of ["name", "code", "folder", "systemId", "systemName"] as const) {
    const input = valid()
    expect(() =>
      assertOriginalFeatureMetadata({ ...input, project: { ...input.project, [field]: " " } })
    ).toThrow(`ORIGINAL_FEATURE_REQUIRED:${field}`)
  }
  for (const field of ["code", "folder"] as const) {
    const input = valid()
    expect(() =>
      assertOriginalFeatureMetadata({
        ...input,
        project: { ...input.project, [field]: "bad/path" }
      })
    ).toThrow(`ORIGINAL_FEATURE_METADATA_PATTERN:${field}`)
  }
})
