import { describe, expect, it } from "vitest"
import {
  capabilityUsageLabel,
  isCapabilityUsageAllowed,
  parseCapabilityUsage
} from "./capability-usage"

describe("capability usage", () => {
  it("preserves legacy applicability and labels all supported declarations", () => {
    expect(parseCapabilityUsage(undefined)).toBe("universal")
    expect(capabilityUsageLabel()).toBe("通用")
    expect(capabilityUsageLabel("chat")).toBe("仅限对话")
    expect(capabilityUsageLabel("project")).toBe("仅限项目")
    for (const context of ["chat", "project"] as const) {
      expect(isCapabilityUsageAllowed(undefined, context)).toBe(true)
      expect(isCapabilityUsageAllowed("universal", context)).toBe(true)
      expect(isCapabilityUsageAllowed(context, context)).toBe(true)
    }
    expect(isCapabilityUsageAllowed("chat", "project")).toBe(false)
    expect(isCapabilityUsageAllowed("project", "chat")).toBe(false)
  })
  it.each([null, "", "both", {}, 1])("rejects unknown usage %j", (value) => {
    expect(() => parseCapabilityUsage(value)).toThrow("CAPABILITY_USAGE_INVALID")
  })
  it("rejects malformed context rather than granting universal access", () => {
    expect(() => isCapabilityUsageAllowed("universal", "other" as never)).toThrow()
  })
})
