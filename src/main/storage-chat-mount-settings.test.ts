import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("chat mount settings isolation", () => {
  it("bounds and caches the filesystem-backed settings read by every chat mount", () => {
    const source = readFileSync(new URL("./storage.ts", import.meta.url), "utf8")
    const memoryStart = source.indexOf("function readMemorySettings")
    const memoryEnd = source.indexOf("function writeMemorySettings", memoryStart)
    const hookStart = source.indexOf("export function getHookLoggingConfig")
    const hookEnd = source.indexOf("export function saveHookLoggingConfig", hookStart)
    const sandboxStart = source.indexOf("function readSandboxSettings")
    const sandboxEnd = source.indexOf("function updateSandboxSettings", sandboxStart)
    const memoryReader = source.slice(memoryStart, memoryEnd)
    const hookReader = source.slice(hookStart, hookEnd)
    const sandboxReader = source.slice(sandboxStart, sandboxEnd)

    expect(memoryReader).toContain("CHAT_MOUNT_SETTINGS_MAX_BYTES")
    expect(memoryReader).toContain("memorySettingsCache")
    expect(hookReader).toContain("CHAT_MOUNT_SETTINGS_MAX_BYTES")
    expect(hookReader).toContain("_hookLoggingCache")
    expect(sandboxReader).toContain("CHAT_MOUNT_SETTINGS_MAX_BYTES")
    expect(sandboxReader).toContain("sandboxSettingsCache")
  })
})
