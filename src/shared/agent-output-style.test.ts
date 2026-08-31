import { describe, expect, it } from "vitest"
import {
  DEFAULT_AGENT_OUTPUT_STYLE,
  isAgentOutputStyle,
  resolveAgentOutputStyle,
  resolveThreadOutputStyle
} from "./agent-output-style"

describe("agent output style", () => {
  it("accepts only the four supported styles", () => {
    for (const style of ["default", "concise", "explanatory", "learning"]) {
      expect(isAgentOutputStyle(style)).toBe(true)
    }
    expect(isAgentOutputStyle("custom")).toBe(false)
    expect(isAgentOutputStyle(true)).toBe(false)
  })

  it("prefers an explicit valid style over the legacy concise flag", () => {
    expect(resolveAgentOutputStyle("learning", true)).toBe("learning")
    expect(resolveThreadOutputStyle({ outputStyle: "explanatory", conciseModeEnabled: true })).toBe(
      "explanatory"
    )
  })

  it("keeps old concise threads compatible and otherwise defaults safely", () => {
    expect(resolveThreadOutputStyle({ conciseModeEnabled: true })).toBe("concise")
    expect(resolveThreadOutputStyle({ outputStyle: "invalid", conciseModeEnabled: false })).toBe(
      DEFAULT_AGENT_OUTPUT_STYLE
    )
    expect(resolveThreadOutputStyle(null)).toBe(DEFAULT_AGENT_OUTPUT_STYLE)
  })
})
