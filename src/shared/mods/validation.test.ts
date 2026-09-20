import { describe, expect, it } from "vitest"
import { encodeModJson, parseModJson, parseModManifest, parseModUi } from "./validation"

export const manifestFixture = {
  apiVersion: "cmb.mods/v1",
  id: "quality",
  name: "Quality",
  entry: "index.ts",
  events: ["tool.call"],
  tools: ["host:read_file"],
  activation: "project",
  permissions: { readTools: [], writeTools: [], context: [], store: false }
}

describe("Mod wire validation", () => {
  it("rejects prototype keys, non-finite numbers, getters and cycles", () => {
    expect(() => parseModJson('{"__proto__":{"polluted":true}}')).toThrow()
    expect(() => encodeModJson({ value: NaN })).toThrow()
    expect(() =>
      encodeModJson({
        get value() {
          throw new Error("must not run")
        }
      })
    ).toThrow("ACCESSOR")
    const value: Record<string, unknown> = {}
    value.self = value
    expect(() => encodeModJson(value)).toThrow("CYCLE")
  })
  it("bounds message size and depth", () => {
    expect(() => encodeModJson("x".repeat(1024 * 1024))).toThrow("SIZE")
    let value: unknown = 0
    for (let i = 0; i < 34; i++) value = { value }
    expect(() => encodeModJson(value)).toThrow("DEPTH")
  })
  it("rejects self-declared managed permissions and incompatible APIs", () => {
    expect(parseModManifest(manifestFixture).id).toBe("quality")
    expect(() => parseModManifest({ ...manifestFixture, managed: true })).toThrow("TRUST")
    expect(() => parseModManifest({ ...manifestFixture, apiVersion: "claude/mods" })).toThrow("API")
  })
  it("does not permit HTML or imported action handles", () => {
    expect(() => parseModUi([{ type: "html", html: "<script>evil()</script>" }])).toThrow()
    expect(
      parseModUi([
        { type: "button", label: "Run", command: "quality:check", args: {}, actionId: "stolen" }
      ])
    ).toEqual([{ type: "button", label: "Run", command: "quality:check", args: {} }])
  })
})
