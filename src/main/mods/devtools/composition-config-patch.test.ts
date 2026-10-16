import { describe, expect, it } from "vitest"
import { patchCompositionConfig } from "./composition-config-patch"

describe("composition config patches", () => {
  it("merges nested objects, replaces arrays, preserves literal null, and never mutates old values", () => {
    const old = {
      connection: { token: "secret", url: "https://example.invalid", timeout: 1000 },
      values: ["a", "b"],
      optional: "old"
    }
    expect(
      patchCompositionConfig(old, { connection: { timeout: 5000 }, values: ["c"], optional: null })
    ).toEqual({
      connection: { token: "secret", url: "https://example.invalid", timeout: 5000 },
      values: ["c"],
      optional: null
    })
    expect(old.connection.timeout).toBe(1000)
    expect(old.values).toEqual(["a", "b"])
  })
  it("deletes only explicit object paths, rejecting array edits, missing paths and prototype keys", () => {
    expect(
      patchCompositionConfig({ nested: { token: "secret", optional: true } }, {}, [
        "/nested/optional"
      ])
    ).toEqual({ nested: { token: "secret" } })
    for (const path of ["/values/0", "/missing", "/__proto__/key", "/bad~2path"])
      expect(() => patchCompositionConfig({ values: [1] }, {}, [path])).toThrow()
  })
})
