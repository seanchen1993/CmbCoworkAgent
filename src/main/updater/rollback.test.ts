import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const state = vi.hoisted(() => ({ root: "", version: "1.5.0", quit: vi.fn(), launch: vi.fn() }))
vi.mock("electron", () => ({ app: { getVersion: () => state.version, quit: state.quit } }))
vi.mock("../storage", () => ({ getOpenworkDir: () => state.root }))
vi.mock("./checker", () => ({ fetchLatestJson: vi.fn() }))
vi.mock("./installer", () => ({
  getExePath: () => join(state.root, "app", "CMBDevClaw.exe"),
  getMarkerPath: () => join(state.root, "app", "resources", "update-marker.json"),
  getBackupPath: () => join(state.root, "app", "resources", "app.asar.bak"),
  isWindows: true,
  writePowerShellScript: vi.fn(),
  launchDetachedPowerShellScript: state.launch
}))

import { runStartupSelfCheck } from "./rollback"

function markerPath(): string {
  return join(state.root, "app", "resources", "update-marker.json")
}

function logText(): string {
  return readFileSync(join(state.root, "updates", "updater.log"), "utf-8")
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "cmb-update-startup-"))
  mkdirSync(join(state.root, "app", "resources"), { recursive: true })
  mkdirSync(join(state.root, "app.bak"))
  state.quit.mockClear()
  state.launch.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("startup self-check diagnostics", () => {
  it.each(["stable", "staging"])(
    "logs a successful %s intermediate ZIP and preserves its chain",
    async (channel) => {
      writeFileSync(
        markerPath(),
        JSON.stringify({
          fromVersion: "1.4.10",
          toVersion: "1.5.0",
          releaseVersion: "1.5.1",
          channel,
          minVersion: "1.5.0",
          updateType: "full"
        })
      )
      expect(await runStartupSelfCheck()).toMatchObject({
        updatedTo: "1.5.0",
        retainedFullBackup: true
      })
      expect(state.launch).not.toHaveBeenCalled()
      expect(logText()).toContain("Self-check passed")
      expect(logText()).toContain('"expectedVersion":"1.5.0"')
      const chain = JSON.parse(
        readFileSync(join(state.root, "updates", "pending-update-chain.json"), "utf-8")
      )
      expect(chain).toMatchObject({ intermediateVersion: "1.5.0", targetVersion: "1.5.1", channel })
    }
  )

  it.each(["stable", "staging"])(
    "persists the mismatch before a %s rollback quits the app",
    async (channel) => {
      writeFileSync(
        markerPath(),
        JSON.stringify({
          fromVersion: "1.4.10",
          toVersion: "1.5.1",
          releaseVersion: "1.5.1",
          channel,
          minVersion: "1.5.0",
          updateType: "full"
        })
      )
      await runStartupSelfCheck()
      expect(state.launch).toHaveBeenCalledOnce()
      expect(state.quit).toHaveBeenCalledOnce()
      expect(logText()).toContain("Auto-rolling back")
      expect(logText()).toContain('"currentVersion":"1.5.0"')
      expect(logText()).toContain('"expectedVersion":"1.5.1"')
      expect(existsSync(`${markerPath()}.attempting`)).toBe(true)
    }
  )

  it("records why an old full marker waits for manifest validation", async () => {
    writeFileSync(
      markerPath(),
      JSON.stringify({
        fromVersion: "1.4.10",
        toVersion: "1.5.1",
        updateType: "full"
      })
    )
    expect(await runStartupSelfCheck()).toEqual({ retainedFullBackup: true })
    expect(state.launch).not.toHaveBeenCalled()
    expect(existsSync(markerPath())).toBe(true)
    expect(logText()).toContain("Legacy full bootstrap awaits manifest validation")
  })
})
