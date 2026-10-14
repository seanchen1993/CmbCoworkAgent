import { describe, expect, it } from "vitest"
import {
  actionForStep,
  objectOutputPaths,
  parameterError,
  parameterFields,
  parameterNumber,
  parseParameterObject,
  toolForStep
} from "./flow-parameter-form"
import type { ModObject } from "../../../shared/mods/types"
import type { FlowStep } from "../../../shared/mods/flows/types"

it("waives only the host evidence destination field, not other required inputs", () => {
  const inputSchema: ModObject = {
    type: "object",
    required: ["text", "format"],
    properties: { text: { type: "string" }, format: { type: "string" } }
  }
  expect(parameterError({}, inputSchema, undefined, ["text"])).toContain("format")
  expect(parameterError({ format: "brief" }, inputSchema, undefined, ["text"])).toBeUndefined()
  expect(parameterError({ text: 3, format: "brief" }, inputSchema, undefined, ["text"])).toContain(
    "类型"
  )
})

const schema: ModObject = {
  type: "object",
  required: ["feature"],
  properties: {
    feature: { type: "string", title: "Feature", minLength: 1 },
    strict: { type: "boolean", default: true },
    retries: { type: "integer", minimum: 0 },
    note: { type: "string" },
    choice: { type: "number", enum: [0, 1] },
    nested: { type: "object" },
    union: { type: ["string", "null"] }
  }
}

describe("lossless parameter forms", () => {
  it("preserves false, zero, empty text, nested and unknown fields without filling defaults", () => {
    const value = { feature: "x", strict: false, retries: 0, note: "", extra: { list: [null, 1] } }
    expect(parseParameterObject(JSON.stringify(value))).toEqual(value)
    expect(parseParameterObject("{}")).toEqual({})
    expect(parameterError(value, schema, undefined)).toBeUndefined()
    expect(Object.hasOwn(parseParameterObject("{}")!, "strict")).toBe(false)
    expect(parameterFields(schema).map((field) => field.key)).toEqual([
      "feature",
      "strict",
      "retries",
      "note",
      "choice"
    ])
    expect(parameterFields(schema).find((field) => field.key === "choice")?.enum).toEqual([0, 1])
  })
  it.each(["", "-", "1.", "1e", "+1", "01", "Infinity", "1e999", " 2 "])(
    "does not silently convert unfinished number %j",
    (text) => {
      expect(parameterNumber(text, false)).toBeUndefined()
      expect(
        parameterError({ feature: "x", retries: 2 }, schema, { numbers: { retries: text } })
      ).toContain("完整")
    }
  )
  it("keeps finite decimals distinct from safe integers", () => {
    expect(parameterNumber("-2.5e2", false)).toBe(-250)
    expect(parameterNumber("0", true)).toBe(0)
    expect(parameterNumber("2.5", true)).toBeUndefined()
    expect(parameterNumber("9007199254740992", true)).toBeUndefined()
  })
  it("retains unresolved numeric draft errors after its provider schema disappears", () => {
    expect(
      parameterError({ retries: 2 }, undefined, {
        numbers: { retries: "-" },
        numberErrors: { retries: "retries：数字草稿尚未完成" }
      })
    ).toContain("尚未完成")
  })
  it("skips execution schema validation for disabled steps without dropping unparsed drafts", () => {
    expect(parameterError({}, schema, undefined, false, false)).toBeUndefined()
    expect(
      parameterError({ feature: 3, retries: -1 }, schema, undefined, false, false)
    ).toBeUndefined()
    expect(parameterError({}, schema, undefined)).toContain("必填")
    expect(parameterError({}, schema, { json: "{" }, false, false)).toContain("JSON")
    expect(parameterError({}, schema, { json: "{}" }, false, false)).toBeUndefined()
    expect(
      parameterError({ retries: 2 }, schema, { numbers: { retries: "-" } }, false, false)
    ).toContain("完整")
    expect(
      parameterError({ retries: 2 }, schema, { numbers: { retries: "2.5" } }, false, false)
    ).toContain("安全整数")
    expect(parameterError({}, undefined, { numbers: { removed: "1e" } }, false, false)).toContain(
      "完整"
    )
    expect(parameterError({}, schema, { numberErrors: { retries: "未完成" } }, false, false)).toBe(
      "未完成"
    )
  })
  it("keeps invalid JSON a blocking draft even when the underlying value is valid", () => {
    for (const text of ["{", "[]", "null", '{"x":1e999}', `{"x":"${"x".repeat(28000)}"}`]) {
      expect(parseParameterObject(text)).toBeUndefined()
      expect(parameterError({ feature: "old" }, schema, { json: text })).toContain("JSON")
    }
  })
  it("permits required input from upstream while checking constants and independent config", () => {
    expect(parameterError({}, schema, undefined, true)).toBeUndefined()
    expect(parameterError({}, schema, undefined, false)).toContain("必填")
    expect(parameterError({ strict: "false" }, schema, undefined, true)).toContain("类型")
    expect(parameterError({ retries: -1 }, schema, undefined, true)).toContain("minimum")
    expect(parameterError({ choice: "0" }, schema, undefined, true)).toContain("类型")
  })
  it("does not infer forms for references, unions or root composition", () => {
    expect(parameterFields({ ...schema, allOf: [] })).toEqual([])
    expect(parameterFields({ properties: schema.properties })).toEqual([])
    expect(
      parameterFields({ type: "object", properties: { x: { type: "string", enum: [0, "a"] } } })
    ).toEqual([])
  })
})

describe("pinned form source lookup", () => {
  const action = {
    pluginId: "p",
    plugin: "plugin",
    digest: "a".repeat(64),
    actionId: "act",
    name: "Act",
    command: "act",
    inputSchema: schema
  }
  const step: FlowStep = {
    id: "s",
    enabled: true,
    kind: "plugin-action",
    ...action,
    input: {}
  }
  it("never borrows a same-name newer action schema", () => {
    expect(actionForStep(step, [action])).toBe(action)
    for (const patch of [
      { digest: "b".repeat(64) },
      { plugin: "other" },
      { pluginId: "other" },
      { actionId: "other" }
    ])
      expect(actionForStep(step, [{ ...action, ...patch }])).toBeUndefined()
  })
  it("requires the complete provider identity and tool digest", () => {
    const tool = {
      provider: { id: "server", name: "Server", digest: "b".repeat(64) },
      toolName: "lookup",
      schemaDigest: "c".repeat(64),
      inputSchema: schema
    }
    const mcp: FlowStep = {
      id: "m",
      name: "M",
      kind: "mcp-tool",
      enabled: true,
      ...tool,
      input: {}
    }
    expect(toolForStep(mcp, [tool])).toBe(tool)
    for (const patch of [{ digest: "d".repeat(64) }, { name: "Other" }, { id: "other" }])
      expect(
        toolForStep(mcp, [{ ...tool, provider: { ...tool.provider, ...patch } }])
      ).toBeUndefined()
    expect(toolForStep(mcp, [{ ...tool, schemaDigest: "e".repeat(64) }])).toBeUndefined()
    expect(toolForStep(mcp, [{ ...tool, unavailableReason: "unsupported" }])).toBeUndefined()
  })
})

describe("object output path suggestions", () => {
  it("lists only explicit object paths with proper pointer escaping", () => {
    expect(
      objectOutputPaths({
        type: "object",
        properties: {
          "a/b~c": { type: "object", properties: { child: { type: "object" } } },
          list: { type: "array", items: { type: "object" } },
          scalar: { type: "string" },
          union: { type: "object", anyOf: [] },
          constructor: { type: "object" }
        }
      })
    ).toEqual([
      { path: "/a~1b~0c", label: "/a~1b~0c" },
      { path: "/a~1b~0c/child", label: "/a~1b~0c/child" }
    ])
    expect(objectOutputPaths()).toEqual([])
  })
  it("bounds wide schemas", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`p${index}`, { type: "object" }])
    )
    expect(objectOutputPaths({ type: "object", properties })).toHaveLength(64)
  })
})
