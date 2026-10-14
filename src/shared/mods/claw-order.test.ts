import { expect, it } from "vitest"
import { parseClawProfile } from "./claw"
import { clawChangeSummary } from "./claw-change-summary"
import { moveClawCapability } from "./claw-order"

const profile = parseClawProfile({
  id: "order",
  name: "Order",
  capabilities: [
    {
      pluginId: "a",
      name: "A",
      digest: "a".repeat(64),
      components: {
        mode: "selected",
        ids: ["review"],
        config: { review: { opaque: "private" } }
      }
    },
    { pluginId: "z", name: "Z", digest: "b".repeat(64) }
  ]
})

it("moves one capability without mutating configuration, identities or builtin settings", () => {
  const original = { ...profile, builtins: { contextMeter: true } }
  const moved = moveClawCapability(original, "z", -1)
  expect(moved.capabilities.map((item) => item.pluginId)).toEqual(["z", "a"])
  expect(original.capabilities.map((item) => item.pluginId)).toEqual(["a", "z"])
  expect(moved.capabilities[1]).toEqual(original.capabilities[0])
  expect(moved.builtins).toEqual(original.builtins)
  expect(moveClawCapability(original, "a", -1)).toBe(original)
  expect(moveClawCapability(original, "z", 1)).toBe(original)
  expect(moveClawCapability(original, "missing", 1)).toBe(original)
  expect(clawChangeSummary(original, moved)).toEqual(["调整插件顺序：Z → A"])
})

it("defaults absent builtin settings off and previews explicit enable/disable without exposing values", () => {
  const enabled = parseClawProfile({ ...profile, builtins: { contextMeter: true } })
  expect(clawChangeSummary(profile, enabled)).toEqual(["启用聊天容量提示"])
  expect(clawChangeSummary(enabled, profile)).toEqual(["关闭聊天容量提示"])
  expect(clawChangeSummary(profile, { ...profile, builtins: { contextMeter: false } })).toEqual([])
  expect(parseClawProfile(profile).builtins).toBeUndefined()
})

it.each([null, [], {}, { contextMeter: 1 }, { contextMeter: true, tier: "builtin" }])(
  "rejects malformed or arbitrary builtin configuration %j",
  (builtins) => {
    expect(() => parseClawProfile({ ...profile, builtins })).toThrow("内置模组")
  }
)
