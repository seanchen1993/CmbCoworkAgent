import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_SELFTEST_MANIFEST_FILE,
  DEFAULT_UPDATE_MANIFEST_FILE,
  resolveUpdateSourceFromConfig
} from "./channel-config"

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("resolveUpdateSourceFromConfig", () => {
  const now = new Date("2026-07-14T10:00:00.000Z")

  it("uses production source when config is missing or disabled", () => {
    expect(resolveUpdateSourceFromConfig(null, "https://updates.example.com/", { now })).toEqual({
      channel: "production",
      baseUrl: "https://updates.example.com",
      manifestFile: DEFAULT_UPDATE_MANIFEST_FILE
    })

    expect(
      resolveUpdateSourceFromConfig(
        { enabled: false, channel: "selftest" },
        "https://updates.example.com",
        { now }
      )
    ).toMatchObject({
      channel: "production",
      manifestFile: DEFAULT_UPDATE_MANIFEST_FILE
    })
  })

  it("enables selftest with the default selftest manifest and production baseUrl", () => {
    const source = resolveUpdateSourceFromConfig(
      {
        enabled: true,
        channel: "selftest",
        expiresAt: "2026-07-15T23:59:59+08:00"
      },
      "https://updates.example.com/",
      { configPath: "C:/Users/me/.cmbcoworkagent/update-channel.json", now }
    )

    expect(source).toEqual({
      channel: "selftest",
      baseUrl: "https://updates.example.com",
      manifestFile: DEFAULT_SELFTEST_MANIFEST_FILE,
      configPath: "C:/Users/me/.cmbcoworkagent/update-channel.json",
      expiresAt: "2026-07-15T23:59:59+08:00"
    })
  })

  it("allows a custom selftest manifest and local http baseUrl", () => {
    const source = resolveUpdateSourceFromConfig(
      {
        enabled: true,
        channel: "selftest",
        manifestFile: "cmbdevclaw-latest.selftest-1.4.8.json",
        baseUrl: "http://127.0.0.1:8787/",
        expiresAt: "2026-07-15T23:59:59+08:00"
      },
      "https://updates.example.com",
      { now }
    )

    expect(source).toMatchObject({
      channel: "selftest",
      baseUrl: "http://127.0.0.1:8787",
      manifestFile: "cmbdevclaw-latest.selftest-1.4.8.json"
    })
  })

  it("falls back to production after expiresAt", () => {
    const source = resolveUpdateSourceFromConfig(
      {
        enabled: true,
        channel: "selftest",
        expiresAt: "2026-07-13T23:59:59+08:00"
      },
      "https://updates.example.com",
      { now }
    )

    expect(source).toMatchObject({
      channel: "production",
      manifestFile: DEFAULT_UPDATE_MANIFEST_FILE
    })
  })

  it("rejects the production manifest name for selftest", () => {
    const source = resolveUpdateSourceFromConfig(
      {
        enabled: true,
        channel: "selftest",
        manifestFile: DEFAULT_UPDATE_MANIFEST_FILE,
        expiresAt: "2026-07-15T23:59:59+08:00"
      },
      "https://updates.example.com",
      { now }
    )

    expect(source.channel).toBe("production")
  })
})
