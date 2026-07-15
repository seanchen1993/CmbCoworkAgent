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

  it("supports a versioned full bootstrap followed by the final ASAR update", () => {
    const latest: LatestJson = {
      ...stableManifest,
      version: "1.4.7",
      minVersion: "1.4.5",
      asar: {
        version: "1.4.7",
        file: "stable-1.4.7.asar.gz",
        sha256: "asar-1.4.7",
        size: 100
      },
      full: {
        version: "1.4.5",
        file: "stable-1.4.5.zip",
        sha256: "full-1.4.5",
        size: 9000
      }
    }

    const bootstrap = selectChannelTarget(latest, "1.3.9", user, "win32")
    expect(bootstrap).toMatchObject({
      version: "1.4.5",
      targetVersion: "1.4.7",
      updateType: "full",
      downloadFile: "stable-1.4.5.zip"
    })

    const finalPatch = selectChannelTarget(latest, "1.4.5", user, "win32")
    expect(finalPatch).toMatchObject({
      version: "1.4.7",
      targetVersion: "1.4.7",
      updateType: "asar",
      downloadFile: "stable-1.4.7.asar.gz"
    })
  })

  it("rejects a full bootstrap that cannot advance the current client", () => {
    const latest: LatestJson = {
      ...stableManifest,
      version: "1.4.7",
      minVersion: "1.4.6",
      full: {
        version: "1.4.5",
        file: "stable-1.4.5.zip",
        sha256: "full-1.4.5",
        size: 9000
      }
    }

    expect(() => selectChannelTarget(latest, "1.4.5", user, "win32")).toThrow(
      "full 包版本 1.4.5 必须高于当前版本 1.4.5"
    )
  })

  it("rejects an intermediate full package that would require full again", () => {
    const latest: LatestJson = {
      ...stableManifest,
      version: "2.0.7",
      minVersion: "1.4.5",
      asar: {
        file: "stable-2.0.7.asar.gz",
        sha256: "asar-2.0.7",
        size: 100
      },
      full: {
        version: "1.4.5",
        file: "stable-1.4.5.zip",
        sha256: "full-1.4.5",
        size: 9000
      }
    }

    expect(() => selectChannelTarget(latest, "1.3.9", user, "win32")).toThrow(
      "full 包版本 1.4.5 安装后无法通过 asar 升级到目标版本 2.0.7"
    )
  })
})

describe("selectChannelTarget — chained staging continuation", () => {
  const chainedStaging: LatestJson = {
    ...stableManifest,
    version: "1.4.4",
    minVersion: "1.4.5",
    asar: { file: "stable-1.4.4.asar", sha256: "stable-1.4.4", size: 100 },
    staging: {
      version: "1.4.7",
      rolloutPercent: 0,
      asar: {
        version: "1.4.7",
        file: "staging-1.4.7.asar",
        sha256: "staging-1.4.7",
        size: 200
      },
      full: {
        version: "1.4.5",
        file: "staging-1.4.5.zip",
        sha256: "staging-1.4.5",
        size: 9000
      }
    }
  }

  it("finishes a persisted staging chain after the user no longer matches the cohort", () => {
    const r = selectChannelTarget(chainedStaging, "1.4.5", null, "linux", {
      intermediateVersion: "1.4.5",
      targetVersion: "1.4.7",
      channel: "staging",
      minVersion: "1.4.5",
      createdAt: "2026-07-13T00:00:00.000Z"
    })

    expect(r).toMatchObject({
      version: "1.4.7",
      targetVersion: "1.4.7",
      updateType: "asar",
      channel: "staging",
      grayReason: "pending-chain"
    })
  })

  it("does not let a persisted chain bypass a raised global minVersion", () => {
    const r = selectChannelTarget(
      { ...chainedStaging, minVersion: "1.4.6" },
      "1.4.5",
      null,
      "linux",
      {
        intermediateVersion: "1.4.5",
        targetVersion: "1.4.7",
        channel: "staging",
        minVersion: "1.4.5",
        createdAt: "2026-07-13T00:00:00.000Z"
      }
    )

    expect(r).toBeNull()
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
      version: "2.0.7",
      full: { file: "generic-full.exe", sha256: "generic", size: 1 },
      platforms: {
        win32: {
          full: { version: "2.0.0", file: "win-full.exe", sha256: "win-sha", size: 2 }
        },
        linux: { full: { file: "linux-full.deb", sha256: "linux-sha", size: 3 } }
      }
    }
    const win = selectChannelTarget(latest, "1.2.3", user, "win32")
    expect(win!.downloadFile).toBe("win-full.exe")
    expect(win!.downloadSha256).toBe("win-sha")
    expect(win!.version).toBe("2.0.0")
    expect(win!.targetVersion).toBe("2.0.7")

    const lin = selectChannelTarget(latest, "1.2.3", user, "linux")
    expect(lin!.downloadFile).toBe("linux-full.deb")
  })
})
