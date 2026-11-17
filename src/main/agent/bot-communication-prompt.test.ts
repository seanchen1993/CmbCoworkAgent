import { describe, expect, it, vi } from "vitest"
import { getSystemPrompt } from "./runtime"
import { BOT_COMMUNICATION_PROMPT } from "./bot-communication-prompt"
import { renderBaseSystemPrompt } from "./system-prompt"

describe("Bot communication role selection", () => {
  it("keeps the main Bot prefix stable across turns without changing ordinary runtime time policy", () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-11-17T01:00:00Z"))
      const main = getSystemPrompt("/workspace", "none", { botCommunication: true })
      const ordinary = getSystemPrompt("/workspace", "none")
      const project = getSystemPrompt("/workspace", "none", { includeCurrentTime: false })
      vi.setSystemTime(new Date("2026-11-17T02:00:00Z"))
      expect(getSystemPrompt("/workspace", "none", { botCommunication: true })).toBe(main)
      expect(main).not.toContain("- Current time:")
      expect(getSystemPrompt("/workspace", "none")).not.toBe(ordinary)
      expect(ordinary).toContain("- Current time:")
      expect(getSystemPrompt("/workspace", "none", { includeCurrentTime: false })).toBe(project)
      expect(project).not.toContain(BOT_COMMUNICATION_PROMPT)
    } finally { vi.useRealTimers() }
  })
  it("replaces the execution persona while retaining the environment and Shell contract", () => {
    const shared = { includeCurrentTime: false, includeMemory: false, includeSubagents: false }
    const main = getSystemPrompt("/workspace", "none", { ...shared, botCommunication: true })
    const executor = getSystemPrompt("/workspace", "none", shared)
    expect(main).toContain(BOT_COMMUNICATION_PROMPT)
    expect(executor).not.toContain(BOT_COMMUNICATION_PROMPT)
    expect(executor).toContain(renderBaseSystemPrompt({ includeSubagents: false }))
    expect(main).not.toContain(renderBaseSystemPrompt({ includeSubagents: false }))
    expect(main).toContain("/workspace")
    expect(main).toContain("run_in_background")
    expect(main).toContain("short Shell query")
    expect(main).toContain("An explicit request to work inline takes precedence")
  })
})
