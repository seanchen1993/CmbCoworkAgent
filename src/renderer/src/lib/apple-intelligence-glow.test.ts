import { afterEach, describe, expect, it, vi } from "vitest"
import {
  getAppleIntelligenceGlowEnabled,
  setAppleIntelligenceGlowEnabled,
  subscribeAppleIntelligenceGlow
} from "./apple-intelligence-glow"

function installFakeWindow(): Map<string, string> {
  const values = new Map<string, string>()
  const target = new EventTarget()
  Object.defineProperty(target, "localStorage", {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  })
  vi.stubGlobal("window", target)
  return values
}

describe("Apple Intelligence glow preference", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("defaults to disabled when no preference has been saved", () => {
    installFakeWindow()
    expect(getAppleIntelligenceGlowEnabled()).toBe(false)
  })

  it("persists enablement and notifies subscribers", () => {
    const values = installFakeWindow()
    const listener = vi.fn()
    const unsubscribe = subscribeAppleIntelligenceGlow(listener)

    setAppleIntelligenceGlowEnabled(true)

    expect(getAppleIntelligenceGlowEnabled()).toBe(true)
    expect(values.size).toBe(1)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it("returns to the default by removing the saved preference", () => {
    const values = installFakeWindow()
    setAppleIntelligenceGlowEnabled(true)
    setAppleIntelligenceGlowEnabled(false)

    expect(getAppleIntelligenceGlowEnabled()).toBe(false)
    expect(values.size).toBe(0)
  })
})
