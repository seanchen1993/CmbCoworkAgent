import { describe, expect, it } from "vitest"
import { parseFlowDefinition } from "./schema"
import { createReviewFlow } from "./templates"
import type { FlowStep } from "./types"

const source = { id: "host-source", name: "Review", digest: "a".repeat(64) }
const skill: FlowStep = {
  id: "skill",
  name: "Skill",
  enabled: true,
  kind: "skill",
  skill: source,
  prompt: "Review",
  modelId: "model",
  modelRole: "review"
}
const mcp: FlowStep = {
  id: "mcp",
  name: "MCP",
  enabled: true,
  kind: "mcp-tool",
  provider: source,
  toolName: "lookup",
  schemaDigest: "b".repeat(64),
  input: { tool: "allowed", agentId: "allowed" }
}
const action: FlowStep = {
  id: "action",
  name: "Action",
  enabled: true,
  kind: "plugin-action",
  pluginId: "plugin",
  plugin: "plugin",
  digest: "c".repeat(64),
  actionId: "publish",
  input: {},
  inputFrom: { stepId: "mcp", path: "/structuredContent" }
}
const check: FlowStep = {
  id: "check",
  name: "Check",
  enabled: true,
  kind: "check",
  check: "unit-test"
}
const parse = (steps: FlowStep[]) =>
  parseFlowDefinition({ ...createReviewFlow("owner", "native-flow"), steps })

describe("native flow steps", () => {
  it("round trips pinned identities, model choices and structured MCP output wiring", () => {
    expect(parse([skill, mcp, action]).steps).toEqual([skill, mcp, action])
    expect(
      parse(
        [action, { ...mcp, inputFrom: { stepId: "action" } }].map((step) =>
          step.id === "action" ? { ...step, inputFrom: undefined } : step
        )
      ).steps
    ).toHaveLength(2)
  })
  it("drops renderer paths, transport configuration and extra schema fields", () => {
    const parsed = parse([
      {
        ...mcp,
        transport: { credentials: "never" },
        inputSchema: {},
        provider: { ...source, path: "C:/private" }
      } as FlowStep
    ])
    expect(parsed.steps).toEqual([mcp])
  })
  it.each(["", "A".repeat(64), "x".repeat(64)])(
    "rejects invalid source/schema digest %s",
    (digest) => {
      expect(() => parse([{ ...skill, skill: { ...source, digest } }])).toThrow()
      expect(() => parse([{ ...mcp, schemaDigest: digest }])).toThrow()
    }
  )
  it("rejects arrays, executable paths and unsafe upstream pointers", () => {
    expect(() => parse([{ ...mcp, input: [] } as unknown as FlowStep])).toThrow()
    expect(() => parse([{ ...skill, skill: { ...source, id: "bad\nidentity" } }])).toThrow()
    expect(() =>
      parse([mcp, { ...action, inputFrom: { stepId: "mcp", path: "/__proto__" } }])
    ).toThrow()
  })
  it("only accepts previous enabled output-producing steps", () => {
    expect(() => parse([skill, { ...mcp, inputFrom: { stepId: "skill" } }])).toThrow()
    expect(() => parse([{ ...mcp, enabled: false }, action])).toThrow()
    expect(() => parse([action, mcp])).toThrow()
  })
  it("rejects MCP own routes and later retries crossing MCP even if conditional", () => {
    expect(() => parse([{ ...mcp, onFailure: { stepId: "mcp", maxRetries: 1 } }])).toThrow(/MCP/)
    expect(() =>
      parse([
        skill,
        { ...mcp, when: { stepId: "skill", outcome: "passed" } },
        { ...check, onFailure: { stepId: "skill", maxRetries: 1 } }
      ])
    ).toThrow(/MCP/)
    expect(() =>
      parse([skill, mcp, { ...check, onFailure: { stepId: "mcp", maxRetries: 1 } }])
    ).toThrow(/MCP/)
  })
  it("permits existing retries that do not replay an enabled MCP step", () => {
    expect(
      parse([mcp, skill, { ...check, onFailure: { stepId: "skill", maxRetries: 1 } }]).steps
    ).toHaveLength(3)
    expect(
      parse([
        skill,
        { ...mcp, enabled: false },
        { ...check, onFailure: { stepId: "skill", maxRetries: 1 } }
      ]).steps
    ).toHaveLength(3)
  })
})
