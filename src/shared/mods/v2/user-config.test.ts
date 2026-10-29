import { expect, it } from "vitest"
import {
  FunctionUserConfigDeclarationError,
  parseFunctionUserConfig,
  resolveFunctionUserConfig,
  ordinaryFunctionUserConfig
} from "./user-config"
import { ModFunctionError } from "./contracts"

const field = (extra = {}) => ({ type: "string", title: "Label", description: "Help", ...extra })
const parse = (value: unknown) => parseFunctionUserConfig(value)!
function declarationError(value: unknown): FunctionUserConfigDeclarationError {
  try {
    parse(value)
  } catch (error) {
    expect(error).toBeInstanceOf(ModFunctionError)
    expect(error).toBeInstanceOf(FunctionUserConfigDeclarationError)
    return error as FunctionUserConfigDeclarationError
  }
  throw Error("Expected an invalid declaration")
}

it.each(["minimum", "maximum"])(
  "diagnoses unsupported %s without accepting aliases or values",
  (key) => {
    const error = declarationError({
      e2eTimeoutMs: field({
        type: "number",
        [key]: 0,
        default: 123456789,
        title: "PRIVATE_TITLE",
        description: "PRIVATE_DESCRIPTION"
      })
    })
    expect(error.code).toBe("MODS_USER_CONFIG_INVALID")
    expect(error.diagnostic).toEqual({
      path: "/e2eTimeoutMs",
      reason: "unsupported-key",
      message: "Remove unsupported field properties; numeric bounds use min and max.",
      allowedKeys: [
        "type",
        "title",
        "description",
        "required",
        "default",
        "options",
        "multiple",
        "sensitive",
        "min",
        "max"
      ]
    })
    expect(Object.isFrozen(error.diagnostic)).toBe(true)
    expect(Object.isFrozen(error.diagnostic.allowedKeys)).toBe(true)
    expect(() => Object.assign(error, { diagnostic: { message: "PRIVATE_REPLACEMENT" } })).toThrow()
    const diagnostic = JSON.stringify(error.diagnostic)
    expect(diagnostic).not.toMatch(/PRIVATE_|123456789|minimum|maximum/)
  }
)

it("locates missing description and an invalid sensitive default without including their data", () => {
  const missing = declarationError({ e2eTimeoutMs: { type: "number", title: "Timeout" } })
  expect(missing.diagnostic).toMatchObject({
    path: "/e2eTimeoutMs/description",
    reason: "invalid-description"
  })
  const invalid = declarationError({
    credential: field({
      type: "number",
      sensitive: true,
      default: "PRIVATE_DEFAULT"
    })
  })
  expect(invalid.diagnostic).toMatchObject({
    path: "/credential/default",
    reason: "invalid-default"
  })
  expect(`${invalid.message}${JSON.stringify(invalid.diagnostic)}`).not.toContain("PRIVATE_DEFAULT")
  expect(
    parse({ e2eTimeoutMs: field({ type: "number", min: 0, max: 5, default: 1 }) })
  ).toMatchObject({ e2eTimeoutMs: { min: 0, max: 5, default: 1 } })
})

it("bounds diagnostics and does not reflect unsafe fields, unknown properties or rejected JSON", () => {
  const inputs: [unknown, string][] = [
    [{ ["PRIVATE_FIELD/".repeat(100)]: field() }, "invalid-field-name"],
    [{ valid: field({ PRIVATE_UNKNOWN_PROPERTY: "PRIVATE_VALUE" }) }, "unsupported-key"],
    [JSON.parse('{"__proto__":{"default":"PRIVATE_PROTO_VALUE"}}'), "invalid-json"],
    [
      Object.assign(Object.create({ inherited: "PRIVATE_PROTOTYPE" }), { valid: field() }),
      "invalid-json"
    ],
    [{ valid: field({ description: "PRIVATE_OVERSIZE".repeat(5000) }) }, "schema-limit"],
    [
      Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, field()])),
      "schema-limit"
    ]
  ]
  for (const [input, reason] of inputs) {
    const error = declarationError(input)
    expect(error.diagnostic.reason).toBe(reason)
    const result = `${error.message}${JSON.stringify(error.diagnostic)}`
    expect(result).not.toContain("PRIVATE_")
    expect(result.length).toBeLessThan(600)
  }
  let accessed = false
  const accessor = Object.defineProperty({}, "PRIVATE_ACCESSOR", {
    enumerable: true,
    get() {
      accessed = true
      return "PRIVATE_VALUE"
    }
  })
  expect(declarationError(accessor).diagnostic).toMatchObject({ path: "", reason: "invalid-json" })
  expect(accessed).toBe(false)
})

it("keeps stored-value failures compatible without labeling them declaration errors", () => {
  const schema = parse({ count: field({ type: "number", min: 0 }) })
  try {
    resolveFunctionUserConfig(schema, { count: "PRIVATE_STORED_VALUE" })
    throw Error("Expected an invalid stored value")
  } catch (error) {
    expect(error).toBeInstanceOf(ModFunctionError)
    expect(error).not.toBeInstanceOf(FunctionUserConfigDeclarationError)
    expect(error).toMatchObject({ code: "MODS_USER_CONFIG_INVALID" })
    expect((error as Error).message).not.toContain("PRIVATE_STORED_VALUE")
  }
})

it("keeps absent schema distinct from an empty declared schema and copies defaults", () => {
  expect(parseFunctionUserConfig(undefined)).toBeUndefined()
  expect(parseFunctionUserConfig({})).toEqual({})
  const raw = { values: { ...field(), multiple: true, default: ["a"] } }
  const schema = parse(raw)
  raw.values.default.push("b")
  expect(resolveFunctionUserConfig(schema, {})).toEqual({ values: ["a"] })
})

it("retains false, zero and optional unset instead of manufacturing required defaults", () => {
  const schema = parse({ flag: field({ type: "boolean" }), number: field({ type: "number" }) })
  expect(resolveFunctionUserConfig(schema, {})).toEqual({ flag: "", number: "" })
  expect(resolveFunctionUserConfig(schema, { flag: false, number: 0 })).toEqual({
    flag: false,
    number: 0
  })
  expect(() =>
    resolveFunctionUserConfig(parse({ flag: field({ type: "boolean", required: true }) }), {})
  ).toThrow("flag")
  expect(() =>
    resolveFunctionUserConfig(parse({ name: field({ required: true }) }), { name: "" })
  ).toThrow("name")
})

it("retains upstream scalar and optional unset compatibility for multiple declarations", () => {
  const schema = parse({
    list: field({ multiple: true, default: "a,b\nc" }),
    unset: field({ multiple: true }),
    required: field({ multiple: true, required: true })
  })
  expect(resolveFunctionUserConfig(schema, { required: [] })).toEqual({
    list: "a,b\nc",
    unset: "",
    required: []
  })
  expect(() => resolveFunctionUserConfig(schema, {})).toThrow("required")
  expect(resolveFunctionUserConfig(schema, { list: "legacy", required: "one" }).list).toBe("legacy")
})

it("falls back from an invalid stored choice, strips undeclared stored keys and applies numeric bounds", () => {
  const schema = parse({
    tone: field({ options: ["warm", "formal"], default: "warm" }),
    budget: field({ type: "number", min: 0, max: 3, default: 0 })
  })
  expect(resolveFunctionUserConfig(schema, { tone: "gone", ignored: true })).toEqual({
    tone: "warm",
    budget: 0
  })
  expect(() => resolveFunctionUserConfig(schema, { budget: 4 })).toThrow("budget")
  expect(() => resolveFunctionUserConfig(schema, { budget: "1" })).toThrow("budget")
})

it.each([
  { "1bad": field() },
  { key: field({ unknown: true }) },
  { key: field({ type: "object" }) },
  { key: field({ type: ["number"], default: "not-a-number" }) },
  { key: field({ required: "yes" }) },
  { key: field({ type: "number", multiple: true }) },
  { key: field({ options: [""] }) },
  { key: field({ options: ["a", "a"] }) },
  { key: field({ options: ["a"] }) },
  { key: field({ options: ["a"], default: "" }) },
  { key: field({ options: ["a"], required: true, default: "" }) },
  { key: field({ options: ["a"], sensitive: true }) },
  { key: field({ options: ["a"], multiple: true }) },
  { key: field({ min: 0 }) },
  { key: field({ type: "number", min: 2, max: 1 }) },
  { key: field({ type: "boolean", default: 1 }) },
  { key: field({ type: "number", default: Infinity }) }
])("refuses a malformed immutable declaration %# without reporting its value", (input) => {
  expect(() => parse(input)).toThrow(/^Invalid plugin configuration field:/)
})

it("validates dialog-only declarations without publishing them as ordinary config rows", () => {
  const schema = parse({
    secret: field({ sensitive: true }),
    list: field({ multiple: true }),
    file: field({ type: "file" }),
    directory: field({ type: "directory" }),
    plain: field()
  })
  expect(
    Object.entries(schema)
      .filter(([, value]) => ordinaryFunctionUserConfig(value))
      .map(([key]) => key)
  ).toEqual(["file", "directory", "plain"])
  expect(resolveFunctionUserConfig(schema, { list: ["a", "b"] }).list).toEqual(["a", "b"])
  expect(() => resolveFunctionUserConfig(schema, { list: ["a", 1] })).toThrow("list")
})

it("retains the existing shared JSON boundary for unsafe prototype keys", () => {
  expect(() =>
    parse(
      JSON.parse(
        '{"__proto__":{"type":"string","title":"Label","description":"Help","default":"own"}}'
      )
    )
  ).toThrow(/^Invalid plugin configuration field:/)
})

it("a choice without a default requires an actual configured value before loading", () => {
  const schema = parse({ tone: field({ options: ["warm"], required: true }) })
  expect(() => resolveFunctionUserConfig(schema, {})).toThrow("tone")
  expect(resolveFunctionUserConfig(schema, { tone: "warm" })).toEqual({ tone: "warm" })
})