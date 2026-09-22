import { afterEach, describe, expect, it } from "vitest"
import {
  configureAgentToolStrategy,
  getAgentToolStrategy,
  isAgentToolStrategy,
  normalizeAgentToolStrategy
} from "../../shared/agent-runtime-limits"
import {
  getToolStrategyReminder,
  SHELL_FIRST_TOOL_DESCRIPTIONS,
  resolveEffectiveToolStrategy
} from "./tool-strategy"
import { BASE_SYSTEM_PROMPT, renderBaseSystemPrompt } from "./system-prompt"

const tools = ["execute", "read_file", "edit_file", "write_file"].map((name) => ({ name }))

afterEach(() => configureAgentToolStrategy("standard"))

describe("tool strategy settings", () => {
  it("defaults to standard and rejects invalid input", () => {
    for (const value of [undefined, null, "", "strict", true, {}, ["shell-first"]]) {
      expect(isAgentToolStrategy(value)).toBe(false)
      expect(normalizeAgentToolStrategy(value)).toBe("standard")
    }
    for (const value of ["standard", "shell-first", "shell-first-relaxed"]) {
      expect(isAgentToolStrategy(value)).toBe(true)
      expect(normalizeAgentToolStrategy(value)).toBe(value)
    }
    expect(getAgentToolStrategy()).toBe("standard")
  })

  it("leaves a captured runtime value unchanged when the setting changes", () => {
    configureAgentToolStrategy("shell-first")
    const captured = getAgentToolStrategy()
    configureAgentToolStrategy("standard")
    expect(captured).toBe("shell-first")
    expect(getAgentToolStrategy()).toBe("standard")
  })
})

describe("tool strategy capability gate", () => {
  it("keeps standard inert and needs execute plus a file writer", () => {
    expect(resolveEffectiveToolStrategy("standard", tools)).toBe("standard")
    for (const strategy of ["shell-first", "shell-first-relaxed"] as const) {
      expect(resolveEffectiveToolStrategy(strategy, tools)).toBe(strategy)
      expect(resolveEffectiveToolStrategy(strategy, [{ name: "execute" }])).toBe("standard")
      expect(resolveEffectiveToolStrategy(strategy, [{ name: "edit_file" }])).toBe("standard")
      expect(
        resolveEffectiveToolStrategy(strategy, [{ name: "execute" }, { name: "write_file" }])
      ).toBe(strategy)
      expect(
        resolveEffectiveToolStrategy(strategy, [{ name: "mcp__execute" }, { name: "edit_file" }])
      ).toBe("standard")
    }
  })

  it("does not steer restricted roles or mutate their tools/policy", () => {
    for (const access of [
      { shellAccess: "none" as const },
      { shellAccess: "read_only" as const },
      { workload: "read_only" as const },
      { workload: "verify" as const },
      { ownedFiles: ["/workspace/a.ts"] }
    ]) {
      const before = JSON.stringify({ tools, access })
      expect(resolveEffectiveToolStrategy("shell-first", tools, access)).toBe("standard")
      expect(JSON.stringify({ tools, access })).toBe(before)
    }
  })
})

describe("tool strategy prompt contract", () => {
  it("preserves the default base prompt exactly", () => {
    expect(renderBaseSystemPrompt()).toBe(BASE_SYSTEM_PROMPT)
    expect(renderBaseSystemPrompt({ toolStrategy: "standard" })).toBe(BASE_SYSTEM_PROMPT)
    expect(getToolStrategyReminder("standard")).toBe("")
    expect(BASE_SYSTEM_PROMPT).toContain("Avoid using shell for file reading")
  })

  it.each(["shell-first", "shell-first-relaxed"] as const)(
    "%s removes only owned conflicting guidance, preserving safety",
    (toolStrategy) => {
      const prompt = renderBaseSystemPrompt({ toolStrategy })
      expect(prompt).not.toContain("Avoid using shell for file reading")
      expect(prompt).not.toContain("Avoid using shell for file searching")
      expect(prompt).not.toContain("Default read: `read_file")
      expect(prompt).toContain("prevent context overflow")
      expect(prompt).toContain("All execute commands require user approval")
      expect(prompt).toContain("create a commit only when the user explicitly requests it")
      const reminder = getToolStrategyReminder(toolStrategy)
      expect(reminder).toContain("execute")
      expect(reminder).toContain("read_file")
      expect(reminder).toContain("SKILL.md")
      expect(reminder).toContain("not permission")
      expect(reminder).toContain("Do not retry a denied action through another tool")
      expect(reminder).toContain("operating system and shell")
      expect(reminder).toContain("read_file before falling back to edit_file")
    }
  )

  it("uses distinct strength text without making tools unavailable", () => {
    expect(getToolStrategyReminder("shell-first")).toContain("Fall back")
    expect(getToolStrategyReminder("shell-first-relaxed")).toContain("clearly simpler")
    expect(getToolStrategyReminder("shell-first-relaxed")).toContain("No preliminary failed")
    expect(SHELL_FIRST_TOOL_DESCRIPTIONS.execute).not.toContain("MUST avoid")
    expect(SHELL_FIRST_TOOL_DESCRIPTIONS.execute).not.toContain("DO NOT use newlines")
    expect(SHELL_FIRST_TOOL_DESCRIPTIONS.execute).toContain("approval")
    expect(SHELL_FIRST_TOOL_DESCRIPTIONS.execute).toContain("cwd")
    expect(SHELL_FIRST_TOOL_DESCRIPTIONS.ls).not.toContain("ALWAYS")
    expect(Object.keys(SHELL_FIRST_TOOL_DESCRIPTIONS).sort()).toEqual(["execute", "ls"])
  })
})
