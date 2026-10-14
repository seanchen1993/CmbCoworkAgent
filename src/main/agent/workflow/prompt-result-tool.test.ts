import { describe, expect, it } from "vitest"
import {
  createPromptOnlyStructuredOutputTool,
  createStructuredOutputTool,
  readPromptOnlyStructuredOutputTool
} from "./subagent"

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["passed", "summary"],
  properties: { passed: { type: "boolean" }, summary: { type: "string" } }
}

describe("actual workflow result tool private identity", () => {
  it("reads only the actual factory object, invocation and host-owned accepted result", async () => {
    const invocation = Object.freeze({})
    const tool = createPromptOnlyStructuredOutputTool(schema, invocation)
    const reader = readPromptOnlyStructuredOutputTool(tool, invocation)!
    expect(reader.readAccepted()).toBeUndefined()
    await tool.invoke({ passed: true, summary: "actual" })
    expect(reader.readAccepted()?.value).toEqual({ passed: true, summary: "actual" })
    const returned = reader.readAccepted()!
    const local = returned.value as { summary: string }
    local.summary = "forged local copy"
    expect(reader.readAccepted()?.value).toEqual({ passed: true, summary: "actual" })
    expect(readPromptOnlyStructuredOutputTool(tool, Object.freeze({}))).toBeUndefined()
    expect(readPromptOnlyStructuredOutputTool({ ...tool }, invocation)).toBeUndefined()
    let traps = 0
    expect(
      readPromptOnlyStructuredOutputTool(
        new Proxy(tool, {
          get() {
            traps++
            throw Error("proxy must not execute")
          }
        }),
        invocation
      )
    ).toBeUndefined()
    expect(traps).toBe(0)
  })

  it("does not certify legacy or same-name tools, even with the exact schema", () => {
    const invocation = Object.freeze({})
    const ordinary = createStructuredOutputTool(schema, { value: undefined, called: false })
    expect(ordinary.name).toBe("structured_output")
    expect(readPromptOnlyStructuredOutputTool(ordinary, invocation)).toBeUndefined()
    expect(
      readPromptOnlyStructuredOutputTool(
        { name: ordinary.name, schema: ordinary.schema },
        invocation
      )
    ).toBeUndefined()
  })

  it.each(["invoke", "func"] as const)("rejects replacement of the original %s", (field) => {
    const invocation = Object.freeze({})
    const tool = createPromptOnlyStructuredOutputTool(schema, invocation)
    const reader = readPromptOnlyStructuredOutputTool(tool, invocation)!
    Object.defineProperty(tool, field, { value: async () => "forged", configurable: true })
    expect(() => reader.assertCurrent()).toThrow("FLOW_PROMPT_TOOL_IDENTITY")
  })

  it("rejects schema mutation and getters without evaluating them", () => {
    const invocation = Object.freeze({})
    const tool = createPromptOnlyStructuredOutputTool(schema, invocation)
    const reader = readPromptOnlyStructuredOutputTool(tool, invocation)!
    let getters = 0
    Object.defineProperty(tool.schema, "properties", {
      configurable: true,
      enumerable: true,
      get: () => {
        getters++
        throw Error("must not execute")
      }
    })
    expect(() => reader.assertCurrent()).toThrow("FLOW_PROMPT_TOOL_DATA")
    expect(getters).toBe(0)
  })

  it("never turns an invalid tool result into accepted evidence", async () => {
    const invocation = Object.freeze({})
    const tool = createPromptOnlyStructuredOutputTool(schema, invocation)
    const reader = readPromptOnlyStructuredOutputTool(tool, invocation)!
    await tool.invoke({ passed: "yes", summary: "invalid" }).catch(() => undefined)
    expect(reader.readAccepted()).toBeUndefined()
  })

  it("rejects proxied factory inputs before invoking their traps", () => {
    let traps = 0
    const value = new Proxy(schema, {
      ownKeys() {
        traps++
        return []
      }
    })
    expect(() => createPromptOnlyStructuredOutputTool(value, Object.freeze({}))).toThrow(
      "FLOW_PROMPT_TOOL_DATA"
    )
    expect(traps).toBe(0)
  })

  it.each(["invoke", "func"] as const)(
    "severs accepted input aliases at %s settlement",
    async (method) => {
      const invocation = Object.freeze({})
      const tool = createPromptOnlyStructuredOutputTool(schema, invocation)
      const reader = readPromptOnlyStructuredOutputTool(tool, invocation)!
      const input = { passed: true, summary: "original" }
      await tool[method](input)
      const settled = reader.readAccepted()!
      input.summary = "changed through old input"
      expect(reader.readAccepted()).toEqual(settled)
      expect(reader.readAccepted()?.value).toEqual({ passed: true, summary: "original" })
    }
  )
})
