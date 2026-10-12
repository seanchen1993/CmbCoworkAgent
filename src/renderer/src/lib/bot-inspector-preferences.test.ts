import { describe, expect, it } from "vitest"
import {
  botInspectorPreferenceScope,
  createBotInspectorPreferences,
  resolveBotInspectorPreference
} from "./bot-inspector-preferences"

function fixture(raw: string | null = null) {
  let reads = 0
  let writes = 0
  let failing = false
  const storage = {
    getItem() {
      reads++
      if (failing) throw new Error("storage unavailable")
      return raw
    },
    setItem(_key: string, value: string) {
      if (failing) throw new Error("quota")
      writes++
      raw = value
    }
  }
  return {
    prefs: createBotInspectorPreferences(() => storage),
    restart: () => createBotInspectorPreferences(() => storage),
    raw: () => raw,
    reads: () => reads,
    writes: () => writes,
    fail: () => {
      failing = true
    }
  }
}
const scope = "/private/bot-host.workspace/064018d5-1639-45f9-9399-57440aaab520"

describe("Bot Inspector client layout preferences", () => {
  it("starts on details and keeps unknown Hosts memory-only", () => {
    const f = fixture()
    const empty = f.prefs.read(null)
    expect(empty.fallback).toBe("details")
    const next = f.prefs.remember(null, empty, "bot-a", "computer")
    expect(resolveBotInspectorPreference(next, "bot-a")).toBe("computer")
    expect(f.reads()).toBe(0)
    expect(f.writes()).toBe(0)
  })
  it("writes per-Bot choice and global fallback together, preserving older Bot preferences", () => {
    const f = fixture()
    let current = f.prefs.read(scope)
    current = f.prefs.remember(scope, current, "bot-a", "computer")
    current = f.prefs.remember(scope, current, "bot-b", "library")
    expect(resolveBotInspectorPreference(current, "bot-a")).toBe("computer")
    expect(resolveBotInspectorPreference(current, "bot-b")).toBe("library")
    expect(resolveBotInspectorPreference(current, "new-bot")).toBe("library")
    expect(f.restart().read(scope)).toEqual(current)
    const writes = f.writes()
    expect(f.prefs.remember(scope, current, "bot-b", "library")).toBe(current)
    expect(f.writes()).toBe(writes)
  })
  it("reads/navigation/reveals cannot persist another choice, and threads share their Bot ID", () => {
    const f = fixture()
    const current = f.prefs.remember(scope, f.prefs.read(scope), "same-bot", "library")
    const reads = f.reads(),
      writes = f.writes()
    // Thread addresses never enter the preference key: all views resolve their Bot ID.
    expect(resolveBotInspectorPreference(current, "same-bot")).toBe("library")
    expect(resolveBotInspectorPreference(current, "same-bot")).toBe("library")
    expect(f.prefs.read(scope)).toEqual(current)
    expect(f.reads()).toBe(reads + 1)
    expect(f.writes()).toBe(writes)
  })
  it("scopes layout by the stable workspace path, not a process identity", () => {
    const f = fixture()
    const second = "/private/another-host.workspace/other-id"
    const first = f.prefs.remember(scope, f.prefs.read(scope), "bot-a", "computer")
    expect(f.prefs.read(second).fallback).toBe("details")
    f.prefs.remember(second, f.prefs.read(second), "bot-a", "library")
    expect(f.restart().read(scope)).toEqual(first)
    expect(resolveBotInspectorPreference(f.restart().read(second), "bot-a")).toBe("library")
  })
  it("retains live choices after a failed storage write", () => {
    const f = fixture()
    const previous = f.prefs.read(scope)
    f.fail()
    const next = f.prefs.remember(scope, previous, "bot-a", "computer")
    expect(next).not.toBe(previous)
    expect(resolveBotInspectorPreference(next, "bot-a")).toBe("computer")
    expect(f.writes()).toBe(0)
  })
  it.each([
    "{broken",
    JSON.stringify({ version: 2, scopes: [] }),
    JSON.stringify({ version: 1, scopes: [{ scope, fallback: "bogus", tabs: [] }] }),
    "x".repeat(256 * 1024 + 1)
  ])("never repairs invalid or oversized storage during a read", (raw) => {
    const f = fixture(raw)
    expect(f.prefs.read(scope)).toEqual({ fallback: "details", tabs: [] })
    expect(f.raw()).toBe(raw)
    expect(f.writes()).toBe(0)
  })
  it("validates the existing workspace scope without inventing an account domain", () => {
    expect(botInspectorPreferenceScope(scope)).toBe(scope)
    for (const value of [undefined, null, "", "x\0y", "x".repeat(4097)])
      expect(botInspectorPreferenceScope(value)).toBeNull()
  })
  it("keeps at most eight workspace scopes and 128 Bot choices per scope", () => {
    const f = fixture()
    let current = f.prefs.read(scope)
    for (let i = 0; i < 140; i++)
      current = f.prefs.remember(scope, current, `bot-${i}`, i % 2 ? "computer" : "library")
    expect(current.tabs).toHaveLength(128)
    expect(current.tabs[0][0]).toBe("bot-12")
    expect(current.tabs.at(-1)?.[0]).toBe("bot-139")
    expect(f.prefs.read(scope)).toEqual(current)
    for (let i = 0; i < 10; i++)
      f.prefs.remember(`/workspace-${i}`, f.prefs.read(`/workspace-${i}`), "bot", "computer")
    const raw = JSON.parse(f.raw()!) as { scopes: { scope: string }[] }
    expect(raw.scopes).toHaveLength(8)
    expect(raw.scopes[0].scope).toBe("/workspace-2")
    expect(f.prefs.read(scope).fallback).toBe("details")
  })
  it("prunes only explicit confirmed deleted IDs, writes once and leaves other scopes untouched", () => {
    const f = fixture()
    let current = f.prefs.remember(scope, f.prefs.read(scope), "bot-a", "computer")
    current = f.prefs.remember(scope, current, "bot-b", "library")
    const other = f.prefs.remember(
      "/other-workspace",
      f.prefs.read("/other-workspace"),
      "bot-a",
      "details"
    )
    const writes = f.writes()
    const next = f.prefs.prune(scope, current, new Set(["bot-b"]))
    expect(next.tabs).toEqual([["bot-b", "library"]])
    expect(next.fallback).toBe("library")
    expect(f.writes()).toBe(writes + 1)
    expect(f.prefs.prune(scope, next, new Set(["bot-b"]))).toBe(next)
    expect(f.writes()).toBe(writes + 1)
    expect(f.prefs.read("/other-workspace")).toEqual(other)
  })
})
