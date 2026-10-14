import { describe, expect, it } from "vitest"
import { validateClawActionConfig } from "./action-config"

const schema = {
  type: "object",
  properties: { count: { type: "integer", minimum: 1, default: 2 } },
  required: ["count"],
  additionalProperties: false
}

describe("approved action configuration", () => {
  it.each([{}, { count: "2" }, { count: 0 }, { count: 2, extra: true }, null, []])(
    "rejects invalid configuration without applying defaults or coercion: %j",
    (value) => {
      expect(() => validateClawActionConfig(value, schema)).toThrow("动作配置不符合声明")
    }
  )

  it("keeps bounded arbitrary legacy objects and clones accepted values", () => {
    const config = { arbitrary: { enabled: false } }
    expect(validateClawActionConfig(config)).toEqual(config)
    expect(validateClawActionConfig(config)).not.toBe(config)
    expect(validateClawActionConfig({ count: 2 }, schema)).toEqual({ count: 2 })
  })

  it("does not expose invalid configuration values in errors", () => {
    expect(() => validateClawActionConfig({ count: "secret-credential" }, schema)).toThrow(
      expect.objectContaining({
        code: "CLAW_ACTION_CONFIG_INVALID",
        message: expect.not.stringContaining("secret-credential")
      })
    )
  })
})
