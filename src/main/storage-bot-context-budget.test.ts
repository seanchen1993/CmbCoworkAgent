import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Use the real electron-store and its file reader; only Electron's shell is absent.
vi.mock("electron", () => ({ app: {} }))

describe("Bot budget in the application-data settings.json", () => {
  let root: string
  let file: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bot-budget-settings-"))
    file = join(root, "settings.json")
    vi.stubEnv("CMB_COWORK_AGENT_HOME", root)
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it("reads hand edits through the real store without modifying other settings", async () => {
    const { getStoredBotContextBudget } = await import("./storage")
    for (const budget of [undefined, 400000, 600000, 16000]) {
      const text = JSON.stringify({
        defaultModel: "custom:fixture",
        botContextBudgetTokens: budget
      })
      writeFileSync(file, text)
      expect(getStoredBotContextBudget()).toBe(budget ?? 500000)
      expect(readFileSync(file, "utf8")).toBe(text)
    }
  })

  it("uses the default for invalid values, reports them, and preserves the file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { getStoredBotContextBudget } = await import("./storage")
    for (const budget of [0, 500, -1, "500000", 500000.5, null]) {
      const text = JSON.stringify({ botContextBudgetTokens: budget })
      writeFileSync(file, text)
      expect(getStoredBotContextBudget()).toBe(500000)
      expect(readFileSync(file, "utf8")).toBe(text)
    }
    expect(warn).toHaveBeenCalledTimes(6)
  })

  it("recovers after a malformed file is repaired and reads the value after a module reload", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const storage = await import("./storage")
    writeFileSync(file, "{invalid json")
    expect(storage.getStoredBotContextBudget()).toBe(500000)
    expect(readFileSync(file, "utf8")).toBe("{invalid json")
    writeFileSync(file, JSON.stringify({ botContextBudgetTokens: 300000 }))
    expect(storage.getStoredBotContextBudget()).toBe(300000)
    vi.resetModules()
    const restarted = await import("./storage")
    expect(restarted.getStoredBotContextBudget()).toBe(300000)
  })
})
