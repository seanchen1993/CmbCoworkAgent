import { describe, expect, it, vi } from "vitest"
import { canonicalRowFingerprint } from "./canonical-row-fingerprint"

describe("complete ephemeral SQL row identity", () => {
  it("ignores column enumeration order while retaining column names and types", () => {
    expect(canonicalRowFingerprint({ b: 2, a: "x" })).toBe(
      canonicalRowFingerprint({ a: "x", b: 2 })
    )
    const rows = [
      { a: null },
      { a: "null;" },
      { a: 0 },
      { a: -0 },
      { a: "0" },
      { a: "", b: "" },
      { "a:0:string": "" },
      { a: "string:0:key:1:b" }
    ]
    expect(new Set(rows.map(canonicalRowFingerprint)).size).toBe(rows.length)
  })

  it("distinguishes UTF-16 values that UTF-8 would collapse, and delimiter-like text", () => {
    const values = [
      "\ud800",
      "\ud801",
      "\ufffd",
      "😀",
      "汉字",
      "a\u0000b",
      "number:0;key:1:bstring:0:",
      "",
      "null;",
      "string:5:null;"
    ]
    expect(new Set(values.map((value) => canonicalRowFingerprint({ value }))).size).toBe(
      values.length
    )
  })

  it("rejects executable and unsupported fields without calling them", () => {
    const getter = vi.fn(() => "hidden")
    const ownKeys = vi.fn(() => [])
    const proxy = new Proxy({}, { ownKeys })
    for (const row of [
      proxy,
      Object.defineProperty({}, "a", { get: getter, enumerable: true }),
      Object.defineProperty({}, "a", { value: 1 }),
      { [Symbol("a")]: 1 },
      { a: undefined },
      { a: NaN },
      { a: Infinity },
      { a: {} },
      { a: false }
    ]) {
      expect(() => canonicalRowFingerprint(row)).toThrow("MODS_CONVERSATION_PROJECTION_CONFLICT")
    }
    expect(getter).not.toHaveBeenCalled()
    expect(ownKeys).not.toHaveBeenCalled()
  })
})
