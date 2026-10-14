import { expect, it } from "vitest"
import {
  parseFunctionUserConfig,
  resolveFunctionUserConfig,
  ordinaryFunctionUserConfig
} from "./user-config"

const field = (extra = {}) => ({ type: "string", title: "Label", description: "Help", ...extra })
const parse = (value: unknown) => parseFunctionUserConfig(value)!

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
  const schema = parse({ list: field({ multiple: true, default: "a,b\nc" }),
    unset: field({ multiple: true }), required: field({ multiple: true, required: true }) })
  expect(resolveFunctionUserConfig(schema, { required: [] })).toEqual({
    list: "a,b\nc", unset: "", required: []
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
