import { describe, expect, it } from "vitest"
import { parseFlowDefinition } from "./schema"

const canonical =
  '{"schemaVersion":2,"id":"flow","name":"Flow","execution":{"kind":"host"},"goal":"Work","timeoutMs":1000,"maxExecutions":8,"steps":[{"id":"a","name":"A","enabled":true,"kind":"agent","prompt":"Write"},{"id":"b","name":"B","enabled":true,"kind":"agent","prompt":"Review"}]}'
function input() {
  return JSON.parse(canonical)
}
function profiled() {
  const flow = input()
  flow.execution.profile = "prompt-only-v1"
  return flow
}
describe("explicit prompt-only Flow profile", () => {
  it("preserves old host and legacy canonical bytes without inserting profile defaults", () => {
    expect(JSON.stringify(parseFlowDefinition(input()))).toBe(canonical)
    const legacy = canonical
      .replace('"schemaVersion":2', '"schemaVersion":1')
      .replace('"execution":{"kind":"host"}', '"plugin":"owner"')
    expect(JSON.stringify(parseFlowDefinition(JSON.parse(legacy)))).toBe(legacy)
  })
  it("round-trips only an explicit host prompt profile", () => {
    const flow = profiled()
    expect(parseFlowDefinition(flow)).toEqual(flow)
    expect(parseFlowDefinition(parseFlowDefinition(flow))).toEqual(flow)
    expect(() => parseFlowDefinition({ ...flow, schemaVersion: 1, plugin: "owner" })).toThrow()
    expect(() =>
      parseFlowDefinition({ ...flow, execution: { ...flow.execution, trusted: true } })
    ).toThrow()
  })
  it.each([null, undefined, "unknown", false, {}, []])(
    "rejects an explicitly invalid profile %j",
    (profile) => {
      const flow = input()
      flow.execution.profile = profile
      expect(() => parseFlowDefinition(flow)).toThrow("不支持的流程执行配置")
    }
  )
  it.each([
    { onSuccess: "b" },
    { onFailure: { stepId: "a", maxRetries: 1 } },
    { when: { stepId: "a", outcome: "passed" } }
  ])("rejects routing in the profile without changing normal flow routing", (route) => {
    const flow = profiled()
    Object.assign(flow.steps[route.when ? 1 : 0], route)
    expect(() => parseFlowDefinition(flow)).toThrow("无跳转")
    delete flow.execution.profile
    expect(() => parseFlowDefinition(flow)).not.toThrow()
  })
  it.each([
    {
      kind: "skill",
      skill: { id: "skill", name: "Skill", digest: "a".repeat(64) },
      prompt: "Read"
    },
    {
      kind: "mcp-tool",
      provider: { id: "mcp", name: "MCP", digest: "a".repeat(64) },
      toolName: "call",
      schemaDigest: "b".repeat(64),
      input: {}
    },
    { kind: "autobiz-stage" }
  ])("rejects unsupported step kind $kind even when disabled", (step) => {
    const flow = profiled()
    flow.steps.push({ id: "unsupported", name: "Unsupported", enabled: false, ...step })
    expect(() => parseFlowDefinition(flow)).toThrow()
  })
  it("keeps checks and approvals available without relaxing host check restrictions", () => {
    const flow = profiled()
    flow.steps.push(
      { id: "check", name: "Check", enabled: true, kind: "check", check: "unit-test" },
      { id: "approve", name: "Approve", enabled: true, kind: "approval", prompt: "Confirm" }
    )
    expect(parseFlowDefinition(flow).steps).toHaveLength(4)
    flow.steps[2].check = "autobiz-validator"
    expect(() => parseFlowDefinition(flow)).toThrow()
  })
})
