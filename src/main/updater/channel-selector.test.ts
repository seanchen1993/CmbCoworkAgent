import { describe, it, expect, vi, beforeEach } from "vitest"

// checker.ts pulls in `electron.app` and the disk-backed storage layer at
// import time. Stub both before importing the SUT.
vi.mock("electron", () => ({
  app: { getVersion: () => "1.2.3" }
}))
vi.mock("../storage", () => ({
  getUserInfo: () => null
}))

import { selectChannelTarget, type LatestJson } from "./checker"
import type { UserInfoConfig } from "../storage"

const stableManifest: LatestJson = {
  version: "1.2.3",
  minVersion: "1.0.0",
  releaseNotes: "stable notes",
  mandatory: false,
  asar: { file: "stable.asar", sha256: "stable-asar-sha", size: 100 },
  full: { file: "stable-full.exe", sha256: "stable-full-sha", size: 9000 }
}

const user: UserInfoConfig = {
  ystId: "123456",
  sapId: "00012345",
  userName: "张三"
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("selectChannelTarget — stable channel basics", () => {
  it("returns null when current is already at the stable version", () => {
    const r = selectChannelTarget(
      { ...stableManifest, version: "1.2.3" },
      "1.2.3",
      user,
      "win32"
    )
    expect(r).toBeNull()
  })

  it("returns stable update when newer", () => {
    const r = selectChannelTarget(
      { ...stableManifest, version: "1.2.4" },
      "1.2.3",
      user,
      "win32"
    )
    expect(r).not.toBeNull()
    expect(r!.channel).toBe("stable")
    expect(r!.version).toBe("1.2.4")
    expect(r!.updateType).toBe("asar") // patch-level
  })
})

describe("selectChannelTarget — P1: mandatory stable wins over staging", () => {
  it("mandatory stable takes precedence even when user would hit staging", () => {
    const latest: LatestJson = {
      ...stableManifest,
      version: "1.2.4",
      mandatory: true,
      staging: {
        version: "1.2.5",
        rolloutPercent: 100,
        asar: { file: "gray.asar", sha256: "gray-sha", size: 200 }
      }
    }
    const r = selectChannelTarget(latest, "1.2.3", user, "win32")
    expect(r).not.toBeNull()
    expect(r!.channel).toBe("stable")
    expect(r!.version).toBe("1.2.4")
    expect(r!.mandatory).toBe(true)
  })
})

describe("selectChannelTarget — P1: staging ignored when stable >= staging.version", () => {
  it("ignores staging when stable has caught up", () => {
    const latest: LatestJson = {
      ...stableManifest,
      version: "1.2.5", // stable advanced past staging candidate
      staging: {
        version: "1.2.4",
        rolloutPercent: 100,
        asar: { file: "old-gray.asar", sha256: "x", size: 1 }
      }
    }
    const r = selectChannelTarget(latest, "1.2.3", user, "win32")
    expect(r!.channel).toBe("stable")
    expect(r!.version).toBe("1.2.5")
  })

  it("ignores staging when stable hotfix bumped equal-version", () => {
    const latest: LatestJson = {
      ...stableManifest,
      version: "1.2.4",
      staging: {
        version: "1.2.4", // not newer than stable → ignore
        rolloutPercent: 100,
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }
    const r = selectChannelTarget(latest, "1.2.3", user, "win32")
    expect(r!.channel).toBe("stable")
  })
})

describe("selectChannelTarget — staging happy path", () => {
  it("returns staging when hit and version is genuinely newer than stable", () => {
    const latest: LatestJson = {
      ...stableManifest,
      version: "1.2.4",
      staging: {
        version: "1.2.5",
        rolloutPercent: 100,
        asar: { file: "gray.asar", sha256: "gray-sha", size: 200 },
        releaseNotes: "gray notes"
      }
    }
    const r = selectChannelTarget(latest, "1.2.3", user, "win32")
    expect(r).not.toBeNull()
    expect(r!.channel).toBe("staging")
    expect(r!.version).toBe("1.2.5")
    expect(r!.releaseNotes).toBe("gray notes")
    expect(r!.downloadFile).toBe("gray.asar")
    expect(r!.mandatory).toBe(false)
  })

  it("staging release notes fall back to stable notes when omitted", () => {
    const latest: LatestJson = {
      ...stableManifest,
      version: "1.2.4",
      releaseNotes: "stable notes",
      staging: {
        version: "1.2.5",
        rolloutPercent: 100,
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }
    const r = selectChannelTarget(latest, "1.2.3", user, "win32")
    expect(r!.releaseNotes).toBe("stable notes")
  })
})

describe("selectChannelTarget — P2: broken staging manifest falls back to stable", () => {
  it("missing asar on patch-level staging → fall back to stable", () => {
    const latest: LatestJson = {
      ...stableManifest,
      version: "1.2.4",
      staging: {
        version: "1.2.5", // patch from current 1.2.3 → needs asar
        rolloutPercent: 100,
        // asar deliberately omitted
        full: { file: "x.exe", sha256: "y", size: 1 }
      }
    }
    const r = selectChannelTarget(latest, "1.2.3", user, "win32")
    expect(r).not.toBeNull()
    expect(r!.channel).toBe("stable")
    expect(r!.version).toBe("1.2.4")
  })

  it("missing full on minor-bump staging → fall back to stable", () => {
    const latest: LatestJson = {
      ...stableManifest,
      version: "1.2.4",
      staging: {
        version: "1.3.0", // minor bump → needs full installer
        rolloutPercent: 100,
        asar: { file: "useless.asar", sha256: "x", size: 1 }
        // no full, no platforms.win32.full
      }
    }
    const r = selectChannelTarget(latest, "1.2.3", user, "win32")
    expect(r!.channel).toBe("stable")
  })

  it("user not hit by staging → returns stable cleanly", () => {
    const latest: LatestJson = {
      ...stableManifest,
      version: "1.2.4",
      staging: {
        version: "1.2.5",
        rolloutPercent: 0, // and no whitelist hit
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }
    const r = selectChannelTarget(latest, "1.2.3", user, "win32")
    expect(r!.channel).toBe("stable")
    expect(r!.version).toBe("1.2.4")
  })
})

describe("selectChannelTarget — platform routing", () => {
  it("prefers platforms[platform].full over top-level full for full-update channels", () => {
    const latest: LatestJson = {
      ...stableManifest,
      version: "2.0.0",
      full: { file: "generic-full.exe", sha256: "generic", size: 1 },
      platforms: {
        win32: { full: { file: "win-full.exe", sha256: "win-sha", size: 2 } },
        linux: { full: { file: "linux-full.deb", sha256: "linux-sha", size: 3 } }
      }
    }
    const win = selectChannelTarget(latest, "1.2.3", user, "win32")
    expect(win!.downloadFile).toBe("win-full.exe")
    expect(win!.downloadSha256).toBe("win-sha")

    const lin = selectChannelTarget(latest, "1.2.3", user, "linux")
    expect(lin!.downloadFile).toBe("linux-full.deb")
  })
})
