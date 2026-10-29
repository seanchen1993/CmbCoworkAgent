import { expect, it } from "vitest"
import { patchProjectComposition } from "./project-source-patch"

const original = {
  modules: [{ id: "first" }, { id: "middle" }],
  resources: ["retained.md"],
  context: { "a/b": { "~key": [1, 2] }, "~1": "retained" }
}
const text = JSON.stringify(original)

it("applies sequential object/array edits with strict escaped pointers to an independent clone", () => {
  const output = JSON.parse(
    patchProjectComposition(text, [
      { op: "test", path: "/modules/0", value: { id: "first" } },
      { op: "add", path: "/modules/-", value: { id: "last" } },
      { op: "replace", path: "/modules/1", value: { id: "replacement" } },
      { op: "add", path: "/context/a~1b/~0key/1", value: 3 },
      { op: "remove", path: "/context/a~1b/~0key/0" },
      { op: "replace", path: "/context/~01", value: "literal tilde-one" },
      { op: "add", path: "/resources/-", value: "new.md" }
    ])
  )
  expect(output).toEqual({
    modules: [{ id: "first" }, { id: "replacement" }, { id: "last" }],
    resources: ["retained.md", "new.md"],
    context: { "a/b": { "~key": [3, 2] }, "~1": "literal tilde-one" }
  })
  expect(JSON.stringify(original)).toBe(text)
  expect(() =>
    patchProjectComposition('{"value":{"a":1,"b":2}}', [
      { op: "test", path: "/value", value: { b: 2, a: 1 } }
    ])
  ).not.toThrow()
})

it.each([
  "",
  "modules/0",
  "/modules/~2",
  "/modules/~",
  "/__proto__/x",
  "/constructor/x",
  "/context/prototype",
  "/context/..",
  "/context/.",
  "/context/\\x"
])("rejects root, malformed, traversing and unsafe pointer %j", (path) => {
  expect(() => patchProjectComposition(text, [{ op: "add", path, value: 1 }])).toThrow(
    "PROJECT_SOURCE_PATCH"
  )
})

it.each(["01", "-1", "+1", "1.0", "1e0", "9007199254740992", "3"])(
  "rejects noncanonical, unsafe or sparse array index %j",
  (index) => {
    expect(() =>
      patchProjectComposition(text, [{ op: "add", path: `/modules/${index}`, value: {} }])
    ).toThrow("PROJECT_SOURCE_PATCH")
  }
)

it.each([
  { op: "move", path: "/modules/0", from: "/modules/1" },
  { op: "copy", path: "/modules/-", from: "/modules/0" },
  { op: "add", path: "/modules/-" },
  { op: "replace", path: "/modules/0" },
  { op: "test", path: "/modules/0" },
  { op: "remove", path: "/modules/0", value: null },
  { op: "add", path: "/modules/-", value: null, file: "another.json" }
])("rejects unsupported or ambiguous operation %j", (operation) => {
  expect(() => patchProjectComposition(text, [operation])).toThrow("PROJECT_SOURCE_PATCH_OPERATION")
})

it.each([
  { op: "test", path: "/modules/0/id", value: "different" },
  { op: "replace", path: "/missing", value: null },
  { op: "remove", path: "/toString" },
  { op: "add", path: "/missing/child", value: true },
  { op: "replace", path: "/modules/-", value: {} },
  { op: "remove", path: "/modules/2" },
  { op: "add", path: "/modules/-/id", value: "invalid" }
])("rejects failed tests and missing paths without parent creation: %j", (operation) => {
  expect(() =>
    patchProjectComposition(text, [
      { op: "add", path: "/resources/-", value: "never-saved.md" },
      operation
    ])
  ).toThrow("PROJECT_SOURCE_PATCH")
  expect(original.resources).toEqual(["retained.md"])
})

it("rejects non-JSON data and unsafe value keys without invoking accessors or proxies", () => {
  let touched = 0
  const accessor = {
    get content() {
      touched++
      return 1
    }
  }
  const proxy = new Proxy([], {
    get() {
      touched++
      throw Error("UNSAFE_GET")
    }
  })
  const cycle: { nested?: unknown } = {}
  cycle.nested = cycle
  const sparse = [1, 2, 3]
  Reflect.deleteProperty(sparse, "1")
  for (const value of [
    undefined,
    NaN,
    Infinity,
    () => {},
    new Date(),
    accessor,
    proxy,
    cycle,
    sparse,
    JSON.parse('{"__proto__":{"polluted":true}}'),
    { constructor: 1 },
    { prototype: 1 }
  ])
    expect(() =>
      patchProjectComposition(text, [{ op: "add", path: "/context/value", value }])
    ).toThrow("PROJECT_SOURCE_PATCH")
  expect(() => patchProjectComposition(text, proxy)).toThrow("PROJECT_SOURCE_PATCH")
  expect(touched).toBe(0)
  expect(Object.prototype).not.toHaveProperty("polluted")
})

it("enforces operation, byte, path and nesting limits before returning changed text", () => {
  expect(() => patchProjectComposition(text, [])).toThrow("LIMIT")
  expect(() =>
    patchProjectComposition(
      text,
      Array.from({ length: 17 }, () => ({ op: "add", path: "/resources/-", value: "x" }))
    )
  ).toThrow("LIMIT")
  expect(() =>
    patchProjectComposition(text, [{ op: "add", path: "/context/large", value: "漢".repeat(6000) }])
  ).toThrow("LIMIT")
  expect(() =>
    patchProjectComposition(
      text,
      Array.from({ length: 3 }, () => ({
        op: "add",
        path: "/context/large",
        value: "x".repeat(11000)
      }))
    )
  ).toThrow("LIMIT")
  expect(() =>
    patchProjectComposition(text, [{ op: "add", path: "/" + "a".repeat(512), value: 1 }])
  ).toThrow("POINTER")
  let value: unknown = null
  for (let level = 0; level < 34; level++) value = { nested: value }
  expect(() =>
    patchProjectComposition(text, [{ op: "add", path: "/context/deep", value }])
  ).toThrow("LIMIT")
})
