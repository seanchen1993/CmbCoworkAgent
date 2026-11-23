import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ root: "" }))

vi.mock("electron", () => ({
  app: { getPath: () => state.root, getVersion: () => "1.0.0" },
  ipcMain: { on: vi.fn() }
}))

describe("idle model environment in settings.json", () => {
  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), "cmb-idle-settings-"))
    vi.stubEnv("CMB_COWORK_AGENT_HOME", state.root)
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(state.root, { recursive: true, force: true })
  })

  it("defaults to production when no settings file exists", async () => {
    const { getStoredIdleModelUseUat } = await import("./storage")
    expect(getStoredIdleModelUseUat()).toBe(false)
  })

  it.each([undefined, false, null, "true", 1, {}, []])(
    "keeps production for an absent or invalid switch %j",
    async (idleModelUseUat) => {
      writeFileSync(join(state.root, "settings.json"), JSON.stringify({ idleModelUseUat }))
      const { getStoredIdleModelUseUat } = await import("./storage")
      expect(getStoredIdleModelUseUat()).toBe(false)
    }
  )

  it("reads the UAT switch from the shared file without changing other settings", async () => {
    const path = join(state.root, "settings.json")
    const settings = { idleModelUseUat: true, defaultModel: "builtin:idle-ultra" }
    writeFileSync(path, JSON.stringify(settings))
    const { getStoredIdleModelUseUat } = await import("./storage")
    expect(getStoredIdleModelUseUat()).toBe(true)
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(settings)
  })

  it("defaults to production when settings cannot be parsed", async () => {
    writeFileSync(join(state.root, "settings.json"), "{invalid json")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { getStoredIdleModelUseUat } = await import("./storage")
    expect(getStoredIdleModelUseUat()).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("using production"),
      expect.any(Error)
    )
  })
})
