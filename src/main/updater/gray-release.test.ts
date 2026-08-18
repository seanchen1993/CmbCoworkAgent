import { describe, it, expect } from "vitest"
import { evaluateStaging, isSameStagingPayload } from "./gray-release"
import type { StagingBlock, UpdateCheckResult } from "./checker"
import type { UserInfoConfig } from "../storage"

const baseStaging: StagingBlock = {
  version: "1.2.4",
  rolloutPercent: 0,
  asar: { file: "patch.asar", sha256: "aa", size: 1 }
}

const u = (overrides: Partial<UserInfoConfig> = {}): UserInfoConfig => ({
  ystId: "123456",
  sapId: "00012345",
  userName: "张三",
  originOrgId: "org-it",
  pathName: "总行/信息技术部/开发组",
  ...overrides
})

describe("evaluateStaging — gating and version", () => {
  it("returns miss when no staging block", () => {
    const r = evaluateStaging({ userInfo: u(), currentVersion: "1.2.3", staging: undefined })
    expect(r.hit).toBe(false)
    expect(r.reason).toBe("no-staging-block")
  })

  it("returns miss when staging is expired", () => {
    const r = evaluateStaging({
      userInfo: u(),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: 100, expireAt: "2020-01-01T00:00:00Z" },
      now: new Date("2026-05-25T00:00:00Z")
    })
    expect(r.hit).toBe(false)
    expect(r.reason).toBe("staging-expired")
  })

  it("returns miss when current version is below staging.minVersion", () => {
    const r = evaluateStaging({
      userInfo: u(),
      currentVersion: "1.1.0",
      staging: { ...baseStaging, rolloutPercent: 100, minVersion: "1.2.0" }
    })
    expect(r.hit).toBe(false)
    expect(r.reason).toBe("below-staging-minVersion")
  })

  it("returns miss when current already at or beyond staging.version", () => {
    const r = evaluateStaging({
      userInfo: u(),
      currentVersion: "1.2.4",
      staging: { ...baseStaging, rolloutPercent: 100 }
    })
    expect(r.hit).toBe(false)
    expect(r.reason).toBe("staging-not-newer")
  })
})

describe("evaluateStaging — anonymous user", () => {
  it("misses anonymous by default", () => {
    const r = evaluateStaging({
      userInfo: null,
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: 100 }
    })
    expect(r.hit).toBe(false)
    expect(r.reason).toBe("anonymous-excluded")
    expect(r.bucketKey).toBeUndefined()
  })

  it("hits anonymous when includeAnonymous=true", () => {
    const r = evaluateStaging({
      userInfo: null,
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: 100, includeAnonymous: true }
    })
    expect(r.hit).toBe(true)
    expect(r.reason).toBe("anonymous-included")
  })

  it("treats missing userInfo same as empty userInfo with no ids", () => {
    const r = evaluateStaging({
      userInfo: { userName: "无号" } as UserInfoConfig,
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: 100 }
    })
    expect(r.hit).toBe(false)
    expect(r.reason).toBe("anonymous-excluded")
  })
})

describe("evaluateStaging — blacklist / whitelist match either ystId or sapId (P2 fix)", () => {
  it("blacklist by sapId stops a user that also has a ystId", () => {
    const r = evaluateStaging({
      userInfo: u({ ystId: "123456", sapId: "00012345" }),
      currentVersion: "1.2.3",
      staging: {
        ...baseStaging,
        rolloutPercent: 100,
        blacklistUsers: ["00012345"] // sapId only
      }
    })
    expect(r.hit).toBe(false)
    expect(r.reason).toBe("blacklisted")
    expect(r.bucketKey).toBe("123456") // bucket key still has fixed priority
  })

  it("whitelist by sapId works even when ystId is present", () => {
    const r = evaluateStaging({
      userInfo: u({ ystId: "999999", sapId: "00012345" }),
      currentVersion: "1.2.3",
      staging: {
        ...baseStaging,
        rolloutPercent: 0,
        whitelistUsers: ["00012345"]
      }
    })
    expect(r.hit).toBe(true)
    expect(r.reason).toBe("whitelist-user")
  })

  it("whitelist by ystId works when sapId is missing", () => {
    const r = evaluateStaging({
      userInfo: u({ ystId: "123456", sapId: "" }),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, whitelistUsers: ["123456"] }
    })
    expect(r.hit).toBe(true)
  })

  it("blacklist beats every whitelist", () => {
    const r = evaluateStaging({
      userInfo: u({ ystId: "123456", sapId: "00012345" }),
      currentVersion: "1.2.3",
      staging: {
        ...baseStaging,
        rolloutPercent: 100,
        whitelistUsers: ["123456"],
        whitelistOrgs: ["org-it"],
        blacklistUsers: ["00012345"]
      }
    })
    expect(r.hit).toBe(false)
    expect(r.reason).toBe("blacklisted")
  })

  it("empty id never accidentally matches an empty-string entry", () => {
    const r = evaluateStaging({
      userInfo: u({ ystId: "123456", sapId: "" }),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: 100, blacklistUsers: [""] }
    })
    expect(r.hit).toBe(true) // not blacklisted; falls through to rolloutPercent 100
    expect(r.reason).toBe("rollout-100")
  })
})

describe("evaluateStaging — org / path whitelist", () => {
  it("hits by org id", () => {
    const r = evaluateStaging({
      userInfo: u({ originOrgId: "org-it" }),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, whitelistOrgs: ["org-it"] }
    })
    expect(r.hit).toBe(true)
    expect(r.reason).toBe("whitelist-org")
  })

  it("hits by path prefix", () => {
    const r = evaluateStaging({
      userInfo: u({ pathName: "总行/信息技术部/开发组" }),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, whitelistPaths: ["总行/信息技术部"] }
    })
    expect(r.hit).toBe(true)
    expect(r.reason).toBe("whitelist-path")
  })

  it("misses when path is sibling, not prefix-match", () => {
    const r = evaluateStaging({
      userInfo: u({ pathName: "总行/零售业务部" }),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: 0, whitelistPaths: ["总行/信息技术部"] }
    })
    expect(r.hit).toBe(false)
  })

  it("does NOT match same-prefix sibling org (e.g. 信息技术部外包组 vs 信息技术部)", () => {
    const r = evaluateStaging({
      userInfo: u({ pathName: "总行/信息技术部外包组" }),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: 0, whitelistPaths: ["总行/信息技术部"] }
    })
    expect(r.hit).toBe(false)
  })

  it("matches exact path equality", () => {
    const r = evaluateStaging({
      userInfo: u({ pathName: "总行/信息技术部" }),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, whitelistPaths: ["总行/信息技术部"] }
    })
    expect(r.hit).toBe(true)
    expect(r.reason).toBe("whitelist-path")
  })

  it("tolerates trailing slash on whitelist entry", () => {
    const r = evaluateStaging({
      userInfo: u({ pathName: "总行/信息技术部/开发组" }),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, whitelistPaths: ["总行/信息技术部/"] }
    })
    expect(r.hit).toBe(true)
  })
})

describe("evaluateStaging — percentage bucket", () => {
  it("rolloutPercent=0 with no whitelist match → miss", () => {
    const r = evaluateStaging({
      userInfo: u(),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: 0 }
    })
    expect(r.hit).toBe(false)
    expect(r.reason).toBe("rollout-0")
  })

  it("rolloutPercent=100 → hit", () => {
    const r = evaluateStaging({
      userInfo: u(),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: 100 }
    })
    expect(r.hit).toBe(true)
    expect(r.reason).toBe("rollout-100")
  })

  it("same userKey + seed → same bucket (deterministic)", () => {
    const make = () =>
      evaluateStaging({
        userInfo: u({ ystId: "123456" }),
        currentVersion: "1.2.3",
        staging: { ...baseStaging, rolloutPercent: 50, rolloutSeed: "seed-a" }
      })
    const a = make()
    const b = make()
    expect(a.hit).toBe(b.hit)
    expect(a.reason).toBe(b.reason)
  })

  it("different seeds reshuffle assignments across population", () => {
    let diff = 0
    for (let i = 0; i < 100; i++) {
      const user = u({ ystId: String(100000 + i), sapId: "" })
      const a = evaluateStaging({
        userInfo: user,
        currentVersion: "1.2.3",
        staging: { ...baseStaging, rolloutPercent: 50, rolloutSeed: "seed-a" }
      })
      const b = evaluateStaging({
        userInfo: user,
        currentVersion: "1.2.3",
        staging: { ...baseStaging, rolloutPercent: 50, rolloutSeed: "seed-b" }
      })
      if (a.hit !== b.hit) diff++
    }
    // Bucket distribution should put ~half the users in different cohorts
    // after a reseed; allow a wide band to avoid flakiness.
    expect(diff).toBeGreaterThan(20)
    expect(diff).toBeLessThan(80)
  })

  it("clamps rolloutPercent below 0 to miss", () => {
    const r = evaluateStaging({
      userInfo: u(),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: -50 }
    })
    expect(r.hit).toBe(false)
    expect(r.reason).toBe("rollout-0")
  })

  it("clamps rolloutPercent above 100 to hit-all", () => {
    const r = evaluateStaging({
      userInfo: u(),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: 250 }
    })
    expect(r.hit).toBe(true)
    expect(r.reason).toBe("rollout-100")
  })

  it("bucketKey uses ystId when both ids present (fixed priority)", () => {
    const r = evaluateStaging({
      userInfo: u({ ystId: "123456", sapId: "00012345" }),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: 1 }
    })
    expect(r.bucketKey).toBe("123456")
  })

  it("bucketKey falls back to sapId when ystId is empty", () => {
    const r = evaluateStaging({
      userInfo: u({ ystId: "", sapId: "00012345" }),
      currentVersion: "1.2.3",
      staging: { ...baseStaging, rolloutPercent: 1 }
    })
    expect(r.bucketKey).toBe("00012345")
  })
})

describe("isSameStagingPayload — install-time guard (P1 fix)", () => {
  const baseResult: UpdateCheckResult = {
    version: "1.2.4",
    targetVersion: "1.2.4",
    minVersion: "1.0.0",
    updateType: "asar",
    releaseNotes: "x",
    mandatory: false,
    downloadFile: "patch-1.2.4.asar",
    downloadSha256: "sha-aaa",
    downloadSize: 12345,
    rollback: { version: "1.2.3", file: "rollback.asar", sha256: "rsha" },
    channel: "staging",
    grayReason: "bucket=7/10"
  }

  it("returns true when payload is identical", () => {
    expect(isSameStagingPayload(baseResult, { ...baseResult })).toBe(true)
  })

  it("returns false when recheck is null (staging withdrawn entirely)", () => {
    expect(isSameStagingPayload(baseResult, null)).toBe(false)
  })

  it("returns false when channel demoted to stable (user kicked out of cohort)", () => {
    expect(isSameStagingPayload(baseResult, { ...baseResult, channel: "stable" })).toBe(false)
  })

  it("returns false when same version but different sha256 (same-version repackage)", () => {
    expect(
      isSameStagingPayload(baseResult, { ...baseResult, downloadSha256: "sha-bbb" })
    ).toBe(false)
  })

  it("returns false when the final channel target changes during a chained update", () => {
    expect(isSameStagingPayload(baseResult, { ...baseResult, targetVersion: "1.2.5" })).toBe(false)
  })

  it("returns false when same version but different file name", () => {
    expect(
      isSameStagingPayload(baseResult, { ...baseResult, downloadFile: "patch-1.2.4-r2.asar" })
    ).toBe(false)
  })

  it("returns false when same version but different size", () => {
    expect(isSameStagingPayload(baseResult, { ...baseResult, downloadSize: 99999 })).toBe(false)
  })

  it("returns false when updateType swapped (asar ↔ full)", () => {
    expect(isSameStagingPayload(baseResult, { ...baseResult, updateType: "full" })).toBe(false)
  })

  it("returns false when rollback descriptor changed", () => {
    expect(
      isSameStagingPayload(baseResult, {
        ...baseResult,
        rollback: { version: "1.2.3", file: "rollback.asar", sha256: "different-rsha" }
      })
    ).toBe(false)
  })

  it("returns false when rollback dropped on recheck", () => {
    expect(isSameStagingPayload(baseResult, { ...baseResult, rollback: undefined })).toBe(false)
  })

  it("treats both missing rollbacks as equal", () => {
    const a = { ...baseResult, rollback: undefined }
    const b = { ...baseResult, rollback: undefined }
    expect(isSameStagingPayload(a, b)).toBe(true)
  })

  it("treats rollback equal regardless of JSON key order", () => {
    // Simulate a server-side serializer that emits fields in a different order.
    // Object literals below have different key order but identical content;
    // field-wise comparison must say "equal".
    const reordered: UpdateCheckResult = {
      ...baseResult,
      rollback: { sha256: "rsha", file: "rollback.asar", version: "1.2.3" }
    }
    expect(isSameStagingPayload(baseResult, reordered)).toBe(true)
  })
})
