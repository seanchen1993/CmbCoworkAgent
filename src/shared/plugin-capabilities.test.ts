import { describe, expect, it } from "vitest"
import { parsePluginCapabilities, parsePluginCapabilitiesJson } from "./plugin-capabilities"

const skill = {
  id: "review",
  title: "Review",
  kind: "skill",
  usage: "universal",
  entry: "skills/review/SKILL.md"
}
const flow = {
  id: "delivery",
  title: "Delivery",
  kind: "flow",
  usage: "project",
  entry: "runtime/project.json",
  dependsOn: ["review"]
}
const manifest = (capabilities: unknown[]) => ({
  apiVersion: "devclaw.capabilities/v1",
  capabilities
})

describe("native static capabilities", () => {
  it("preserves absent legacy declaration and parses a generic skill/flow contract", () => {
    expect(parsePluginCapabilities(undefined)).toBeUndefined()
    expect(
      parsePluginCapabilitiesJson(JSON.stringify(manifest([skill, flow])))?.capabilities
    ).toEqual([{ ...skill, dependsOn: [] }, flow])
  })
  it.each([
    "../a",
    "/absolute",
    "C:/a",
    "a\\b",
    "a//b",
    "./a",
    "a/../b",
    "a%2fb",
    "a\n",
    "a/NUL.txt",
    "a/file. "
  ])("rejects unsafe entry %s", (entry) => {
    expect(() => parsePluginCapabilities(manifest([{ ...skill, entry }]))).toThrow("ENTRY_INVALID")
  })
  it("rejects unknown keys, oversized input, missing declarations and unsupported flows", () => {
    for (const value of [
      { ...manifest([skill]), extra: true },
      manifest([{ ...skill, extra: true }]),
      manifest([{ ...skill, usage: undefined }]),
      manifest([{ ...flow, usage: "chat" }]),
      manifest([{ ...skill, id: "constructor" }]),
      manifest([]),
      { ...manifest([skill]), apiVersion: "other" },
      manifest([{ ...skill, title: "x".repeat(129) }]),
      manifest(Array.from({ length: 65 }, (_, index) => ({ ...skill, id: `skill${index}` })))
    ])
      expect(() => parsePluginCapabilities(value)).toThrow()
    expect(() => parsePluginCapabilitiesJson(" ".repeat(65537))).toThrow("SIZE_LIMIT")
  })
  it("rejects duplicate identity and invalid dependency graphs", () => {
    for (const entries of [
      [skill, skill],
      [{ ...skill, dependsOn: null }],
      [flow],
      [{ ...skill, dependsOn: ["review"] }],
      [
        { ...skill, dependsOn: ["other"] },
        { ...skill, id: "other", dependsOn: ["review"] }
      ],
      [{ ...skill, usage: "chat" }, flow],
      [{ ...skill, dependsOn: ["delivery"] }, flow],
      [skill, { ...flow, dependsOn: ["review", "review"] }]
    ])
      expect(() => parsePluginCapabilities(manifest(entries))).toThrow()
  })
})

it("validates explicit hook/MCP dependencies without changing default hook semantics", () => {
  expect(
    parsePluginCapabilities(
      manifest([{ ...skill, requiredHooks: [], requiredMcpServers: ["docs"] }])
    )?.capabilities[0].requiredHooks
  ).toEqual([])
  for (const requiredMcpServers of [null, "docs", ["../"], ["docs", "docs"], Array(65).fill("x")])
    expect(() => parsePluginCapabilities(manifest([{ ...skill, requiredMcpServers }]))).toThrow()
})

it("accepts explicit flow input destinations and rejects ambiguous or unsafe contracts", () => {
  const input = {
    id: "prior",
    title: "Previous document",
    path: "incoming/document.md",
    required: true
  }
  expect(
    parsePluginCapabilities(manifest([{ ...flow, dependsOn: [], inputs: [input] }]))
      ?.capabilities[0].inputs
  ).toEqual([input])
  for (const inputs of [
    [{ ...input, path: "../outside" }],
    [input, input],
    [{ ...input, extra: true }],
    [{ ...input, required: "yes" }]
  ])
    expect(() => parsePluginCapabilities(manifest([{ ...flow, dependsOn: [], inputs }]))).toThrow()
  expect(() => parsePluginCapabilities(manifest([{ ...skill, inputs: [input] }]))).toThrow()
})
