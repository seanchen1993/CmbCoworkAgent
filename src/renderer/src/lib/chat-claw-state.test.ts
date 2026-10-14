import { describe, expect, it } from "vitest"
import type { ClawView } from "../../../shared/mods/claw"
import { chatClawDefaultModel, chatClawEnabled } from "./chat-claw-state"

const binding: Pick<ClawView, "enabled" | "applicable" | "active"> = {
  enabled: true,
  applicable: true,
  active: {
    id: "applied",
    name: "Applied B",
    capabilities: [],
    models: {
      default: "custom:b",
      roles: {}
    }
  }
}

describe("chat Claw execution scope", () => {
  it("does not infer an applied model before the binding is known", () => {
    expect(chatClawEnabled(true)).toBe(true)
    expect(chatClawDefaultModel(true)).toBeUndefined()
  })

  it.each([
    [false, binding],
    [true, { ...binding, enabled: false }],
    [true, { ...binding, applicable: false }]
  ])("stops new execution without treating a retained B as active (%j)", (enabled, view) => {
    expect(chatClawEnabled(enabled, view)).toBe(false)
    expect(chatClawDefaultModel(enabled, view)).toBeUndefined()
    expect(view.active?.models?.default).toBe("custom:b")
  })

  it("resumes the applied snapshot without using an edited saved model", () => {
    const savedC = { ...binding.active!, models: { default: "custom:c", roles: {} } }
    expect(chatClawDefaultModel(true, { ...binding, enabled: false })).toBeUndefined()
    expect(chatClawDefaultModel(true, binding)).toBe("custom:b")
    expect(savedC.models.default).toBe("custom:c")
  })

  it("keeps an enabled flow available without inventing its default model", () => {
    expect(chatClawEnabled(true, { ...binding, active: null })).toBe(true)
    expect(chatClawDefaultModel(true, { ...binding, active: null })).toBeUndefined()
  })
})
