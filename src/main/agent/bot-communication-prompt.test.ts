import { describe, expect, it } from "vitest"
import { getSystemPrompt } from "./runtime"
import { BOT_COMMUNICATION_PROMPT } from "./bot-communication-prompt"
import { renderBaseSystemPrompt } from "./system-prompt"

describe("Bot communication role selection", () => {
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
