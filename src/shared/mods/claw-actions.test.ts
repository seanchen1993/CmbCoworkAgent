import { describe, expect, it } from "vitest"
import {
  clawActionObject,
  parseClawActionExports,
  parseClawOutputPointer,
  resolveClawActionInput
} from "./claw-actions"
import { parseFlowDefinition } from "./flows/schema"

const identity = {
  pluginId: "source",
  plugin: "example",
  digest: "a".repeat(64),
  actionId: "produce"
}
const action = {
  id: "first",
  name: "First",
  kind: "plugin-action",
  enabled: true,
  ...identity,
  input: {}
}
const definition = {
  schemaVersion: 1,
  id: "flow",
  name: "Flow",
  plugin: "example",
  goal: "Test",
  timeoutMs: 1000,
  maxExecutions: 8
}

describe("explicit Claw action contract", () => {
  it("accepts exported actions and keeps provider identities and forward data flow", () => {
    expect(
      parseClawActionExports({
        actions: [
          { id: "produce", name: "Produce", command: "produce", inputSchema: { type: "object" } }
        ]
      })
    ).toHaveLength(1)
    const parsed = parseFlowDefinition({
      ...definition,
      steps: [
        action,
        {
          ...action,
          id: "second",
          pluginId: "other",
          plugin: "review",
          inputFrom: { stepId: "first", path: "/result" }
        }
      ]
    })
    expect(parsed.steps[1]).toMatchObject({
      plugin: "review",
      inputFrom: { stepId: "first", path: "/result" }
    })
    expect(
      resolveClawActionInput(
        { mode: "strict" },
        { result: { file: "a.ts", mode: "base" } },
        "/result"
      )
    ).toEqual({ file: "a.ts", mode: "strict" })
  })

  it("selects an object from an array without allowing array property reflection", () => {
    expect(resolveClawActionInput({}, { files: [{ path: "a.ts" }] }, "/files/0")).toEqual({
      path: "a.ts"
    })
    expect(() =>
      resolveClawActionInput({}, { files: [{ path: "a.ts" }] }, "/files/length")
    ).toThrow()
  })

  it.each(["/__proto__", "/constructor", "/prototype", "/bad~2escape", "arbitrary.code()"])(
    "rejects unsafe pointer %s",
    (path) => {
      expect(() => parseClawOutputPointer(path)).toThrow()
    }
  )

  it("rejects prototype pollution, oversized output and non-object references", () => {
    expect(() => clawActionObject(JSON.parse('{"__proto__":{}}'))).toThrow()
    expect(() => clawActionObject({ result: "a".repeat(28000) })).toThrow()
    expect(() => resolveClawActionInput({}, { result: 1 }, "/result")).toThrow()
    expect(() => resolveClawActionInput({}, {}, "/missing")).toThrow()
  })

  it.each(["future", "disabled", "non-action"])("rejects %s result sources", (kind) => {
    const source =
      kind === "non-action"
        ? { id: "first", name: "Agent", kind: "agent", enabled: true, prompt: "Review" }
        : { ...action, enabled: kind !== "disabled" }
    const target = { ...action, id: "second", inputFrom: { stepId: "first" } }
    expect(() =>
      parseFlowDefinition({
        ...definition,
        steps: kind === "future" ? [target, source] : [source, target]
      })
    ).toThrow()
  })

  it("keeps optional configSchema absent for old exports and copies explicit declarations", () => {
    const exported = { id: "run", name: "Run", command: "run", inputSchema: {} }
    expect(parseClawActionExports({ actions: [exported] })[0]).not.toHaveProperty("configSchema")
    const configSchema = { type: "object", properties: { mode: { type: "string" } } }
    const parsed = parseClawActionExports({ actions: [{ ...exported, configSchema }] })[0]
    expect(parsed.configSchema).toEqual(configSchema)
    expect(parsed.configSchema).not.toBe(configSchema)
    for (const invalid of [null, [], "schema"]) {
      expect(() =>
        parseClawActionExports({ actions: [{ ...exported, configSchema: invalid }] })
      ).toThrow()
    }
  })

  it("requires unique export IDs and bounded explicit schemas", () => {
    const exported = { id: "run", name: "Run", command: "run", inputSchema: {} }
    expect(() => parseClawActionExports({ actions: [exported, exported] })).toThrow()
    expect(() =>
      parseClawActionExports({ actions: [{ ...exported, inputSchema: "code" }] })
    ).toThrow()
  })
})
