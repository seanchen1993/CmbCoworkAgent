import { describe, expect, it } from "vitest"
import { normalizeFunctionInput } from "./pinned-input"
import {
  validateFunctionPluginRegisterInput,
  validateFunctionPluginRegisterResult,
  type FunctionPluginRegisterInput
} from "./plugin-register"

const candidate: FunctionPluginRegisterInput = {
  name: "review-kit",
  tier: "user",
  root: "/workspace/review-kit",
  version: "1.0.0",
  provenance: "review-kit@local",
  uses: {
    events: ["plugin.register", "command.run"],
    calls: ["env.get", "fs.read", "state.set"],
    env: { reads: ["PROJECT_STAGE"], writes: [] },
    state: { reads: [], writes: [{ plugin: "review-kit", key: "checked" }] }
  }
}

describe("native module admission contract", () => {
  it("accepts literal scanned facts, including Windows roots, without changing the snapshot", () => {
    const before = JSON.stringify(candidate)
    expect(() => validateFunctionPluginRegisterInput(candidate)).not.toThrow()
    expect(() =>
      validateFunctionPluginRegisterInput({ ...candidate, root: "C:\\plugins\\kit" })
    ).not.toThrow()
    expect(JSON.stringify(candidate)).toBe(before)
  })

  it("pins every admission fact and optional version presence through middleware", () => {
    const original = JSON.parse(JSON.stringify(candidate))
    expect(normalizeFunctionInput("plugin.register", {}, original)).toEqual(original)
    for (const field of Object.keys(original))
      expect(() =>
        normalizeFunctionInput("plugin.register", { [field]: "forged" }, original)
      ).toThrow("MODS_PINNED_INPUT")
    const withoutVersion = { ...original }
    delete withoutVersion.version
    expect(() =>
      normalizeFunctionInput("plugin.register", { version: "2" }, withoutVersion)
    ).toThrow("MODS_PINNED_INPUT")
    expect(() =>
      normalizeFunctionInput(
        "plugin.register",
        {
          uses: { ...original.uses, calls: [] }
        },
        original
      )
    ).toThrow("MODS_PINNED_INPUT")
  })

  it.each([
    { ...candidate, tier: "core" },
    { ...candidate, root: "relative" },
    { ...candidate, moduleIndex: 2 },
    { ...candidate, uses: { events: ["*", "*"], calls: [] } },
    { ...candidate, uses: { events: new Array(1), calls: [] } },
    { ...candidate, uses: { events: [], calls: ["fs[read]"] } },
    { ...candidate, uses: { events: [], calls: [], env: { reads: ["A=B"], writes: [] } } },
    {
      ...candidate,
      uses: {
        events: [],
        calls: [],
        state: {
          reads: [{ plugin: "other", key: "key", id: "not-a-scanned-family" }],
          writes: []
        }
      }
    }
  ])("rejects ambiguous or untrusted module facts %#", (value) => {
    expect(() => validateFunctionPluginRegisterInput(value)).toThrow("MODS_PLUGIN_REGISTER_INPUT")
  })

  it("bounds the total UTF-8 payload and per-family declarations", () => {
    expect(() =>
      validateFunctionPluginRegisterInput({
        ...candidate,
        uses: {
          events: Array.from({ length: 256 }, (_, index) => `${index}${"字".repeat(250)}`),
          calls: []
        }
      })
    ).toThrow("MODS_PLUGIN_REGISTER_INPUT")
    expect(() =>
      validateFunctionPluginRegisterInput({
        ...candidate,
        uses: {
          events: [],
          calls: [],
          state: {
            reads: Array.from({ length: 129 }, (_, index) => ({
              plugin: "review-kit",
              key: String(index)
            })),
            writes: []
          }
        }
      })
    ).toThrow("MODS_PLUGIN_REGISTER_INPUT")
  })

  it("accepts only a genuine allow or a bounded explicit refusal", () => {
    expect(() => validateFunctionPluginRegisterResult({ allow: true })).not.toThrow()
    expect(() => validateFunctionPluginRegisterResult({ refuse: "禁止此模块" })).not.toThrow()
    for (const value of [
      {},
      { allow: false },
      { allow: true, refuse: "no" },
      { refuse: " " },
      { refuse: "x".repeat(4097) },
      { allow: true, tools: ["extra"] }
    ])
      expect(() => validateFunctionPluginRegisterResult(value)).toThrow(
        "MODS_PLUGIN_REGISTER_RESULT"
      )
  })
})
