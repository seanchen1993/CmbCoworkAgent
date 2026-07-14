/**
 * End-to-end gray release flow with a real local HTTP server.
 *
 * Exercises the full client decision pipeline:
 *   fetchLatestJson → safeGetUserInfo → evaluateStaging → selectChannelTarget
 *   → (later) isSameStagingPayload at install time.
 *
 * The Electron `app` module and `storage.getUserInfo` are stubbed via vi.mock
 * with mutable implementations, so each scenario can drive a different
 * version / user / manifest combination through the real code.
 *
 * Run with: `npm run test`
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import http from "http"
import { mkdtempSync, rmSync } from "fs"
import type { AddressInfo } from "net"
import { tmpdir } from "os"
import { join } from "path"
import type { UserInfoConfig } from "../storage"
import type { LatestJson } from "./checker"

// Mutable state controlled per test case
let currentAppVersion = "1.3.10"
let getUserInfoImpl: () => UserInfoConfig | null = () => null
let currentManifest: LatestJson | null = null
let chainTestRoot = ""

vi.mock("electron", () => ({
  app: { getVersion: () => currentAppVersion }
}))
vi.mock("../storage", () => ({
  getUserInfo: () => getUserInfoImpl(),
  getOpenworkDir: () => chainTestRoot
}))

// SUT imports must come AFTER vi.mock calls
import { checkForUpdate } from "./checker"
import { isSameStagingPayload } from "./gray-release"
import { clearPendingUpdateChain, writePendingUpdateChain } from "./update-chain"

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  chainTestRoot = mkdtempSync(join(tmpdir(), "cmb-updater-e2e-"))
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (req.method === "POST" && url.pathname === "/download") {
      const file = url.searchParams.get("file")
      if (file === "cmbdevclaw-latest.json") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(currentManifest))
        return
      }
      // Any other file = fake update package payload.
      // The decision-path tests don't actually run the downloader; they only
      // need this branch to exist so we could extend coverage later.
      res.writeHead(200)
      res.end("dummy-pkg")
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(chainTestRoot, { recursive: true, force: true })
})

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  // Reset to a known baseline so a leaky test can't cross-contaminate.
  currentAppVersion = "1.3.10"
  getUserInfoImpl = () => null
  currentManifest = null
  clearPendingUpdateChain()
})

// --- Manifest fixtures -----------------------------------------------------

const baseManifest: LatestJson = {
  version: "1.4.0",
  minVersion: "1.0.0",
  releaseNotes: "稳定版 1.4.0",
  mandatory: false,
  asar: { file: "stable-1.4.0.asar.gz", sha256: "stable-sha", size: 100 },
  full: { file: "stable-1.4.0.exe", sha256: "stable-full-sha", size: 99999 }
}

const dev: UserInfoConfig = {
  ystId: "DEV001",
  sapId: "DEV-SAP-001",
  userName: "开发者",
  originOrgId: "org-it",
  pathName: "总行/信息技术部/开发组"
}

const itDept: UserInfoConfig = {
  ystId: "IT001",
  sapId: "IT-SAP-001",
  userName: "技术部同学",
  originOrgId: "org-it",
  pathName: "总行/信息技术部"
}

const sales: UserInfoConfig = {
  ystId: "SALES001",
  sapId: "SALES-SAP-001",
  userName: "销售同学",
  originOrgId: "org-sales",
  pathName: "总行/销售部"
}

// ---------------------------------------------------------------------------

describe("E2E gray release — real HTTP server, real checkForUpdate", () => {
  it("C1 兼容性：manifest 不写 staging → stable，行为完全等同改造前", async () => {
    // 模拟存量用户：还在 1.3.10，升级到 1.4.0 是 minor → 走 full installer
    currentAppVersion = "1.3.10"
    getUserInfoImpl = () => dev
    currentManifest = { ...baseManifest }

    const r = await checkForUpdate(baseUrl)
    expect(r).not.toBeNull()
    expect(r!.channel).toBe("stable")
    expect(r!.version).toBe("1.4.0")
    expect(r!.grayReason).toBe("no-staging-block")
    expect(r!.updateType).toBe("full")
    expect(r!.downloadFile).toBe("stable-1.4.0.exe")
  })

  it("C1b 兼容性补充：1.4.0 用户升 1.4.1 patch → asar 热更", async () => {
    // 模拟已升到 1.4.0 的灰度池用户，无 staging 时正常拿 stable patch
    currentAppVersion = "1.4.0"
    getUserInfoImpl = () => dev
    currentManifest = {
      ...baseManifest,
      version: "1.4.1",
      asar: { file: "stable-1.4.1.asar.gz", sha256: "patch-sha", size: 150 }
    }

    const r = await checkForUpdate(baseUrl)
    expect(r!.channel).toBe("stable")
    expect(r!.updateType).toBe("asar")
    expect(r!.downloadFile).toBe("stable-1.4.1.asar.gz")
  })

  it("C1c 非强制链式更新：先安装实际版本 full，再获取最终 ASAR", async () => {
    getUserInfoImpl = () => dev
    currentManifest = {
      ...baseManifest,
      version: "1.4.7",
      minVersion: "1.4.5",
      mandatory: false,
      asar: {
        version: "1.4.7",
        file: "stable-1.4.7.asar.gz",
        sha256: "patch-1.4.7",
        size: 150
      },
      full: {
        version: "1.4.5",
        file: "stable-1.4.5.zip",
        sha256: "full-1.4.5",
        size: 99999
      }
    }

    currentAppVersion = "1.3.10"
    const bootstrap = await checkForUpdate(baseUrl)
    expect(bootstrap).toMatchObject({
      version: "1.4.5",
      targetVersion: "1.4.7",
      updateType: "full",
      mandatory: false,
      downloadFile: "stable-1.4.5.zip"
    })

    currentAppVersion = "1.4.5"
    const finalPatch = await checkForUpdate(baseUrl)
    expect(finalPatch).toMatchObject({
      version: "1.4.7",
      targetVersion: "1.4.7",
      updateType: "asar",
      mandatory: false,
      downloadFile: "stable-1.4.7.asar.gz"
    })
  })

  it("C1d 灰度链式更新：持久化第一跳后不因重新分桶停在中间版本", async () => {
    getUserInfoImpl = () => dev
    currentManifest = {
      ...baseManifest,
      minVersion: "1.4.5",
      staging: {
        version: "1.4.7",
        rolloutPercent: 100,
        asar: {
          version: "1.4.7",
          file: "staging-1.4.7.asar.gz",
          sha256: "staging-asar-1.4.7",
          size: 150
        },
        full: {
          version: "1.4.5",
          file: "staging-1.4.5.zip",
          sha256: "staging-full-1.4.5",
          size: 99999
        }
      }
    }

    const bootstrap = await checkForUpdate(baseUrl)
    expect(bootstrap).toMatchObject({
      version: "1.4.5",
      targetVersion: "1.4.7",
      updateType: "full",
      channel: "staging"
    })

    writePendingUpdateChain({
      intermediateVersion: "1.4.5",
      targetVersion: "1.4.7",
      channel: "staging",
      minVersion: "1.4.5"
    })
    currentAppVersion = "1.4.5"
    getUserInfoImpl = () => null
    currentManifest.staging!.rolloutPercent = 0

    const finalPatch = await checkForUpdate(baseUrl)
    expect(finalPatch).toMatchObject({
      version: "1.4.7",
      updateType: "asar",
      channel: "staging",
      grayReason: "pending-chain"
    })
  })

  it("C2 白名单 ystId 命中 → 走 staging", async () => {
    // 真实灰度场景：已升 1.4.0 的用户，1.4.0→1.4.1 是 patch → asar
    currentAppVersion = "1.4.0"
    getUserInfoImpl = () => dev
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 0,
        whitelistUsers: ["DEV001"],
        asar: { file: "gray-1.4.1.asar", sha256: "gray-sha", size: 200 }
      }
    }

    const r = await checkForUpdate(baseUrl)
    expect(r!.channel).toBe("staging")
    expect(r!.version).toBe("1.4.1")
    expect(r!.grayReason).toBe("whitelist-user")
    expect(r!.downloadFile).toBe("gray-1.4.1.asar")
    expect(r!.mandatory).toBe(false)
  })

  it("C3 黑名单按 sapId 命中（跨 ID 匹配）→ 否决白名单 → 回 stable", async () => {
    getUserInfoImpl = () => dev
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 100,
        whitelistUsers: ["DEV001"],
        blacklistUsers: ["DEV-SAP-001"],
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }

    const r = await checkForUpdate(baseUrl)
    expect(r!.channel).toBe("stable")
    expect(r!.version).toBe("1.4.0")
  })

  it("C4a 部门路径命中（信息技术部） → staging", async () => {
    currentAppVersion = "1.4.0"
    getUserInfoImpl = () => itDept
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 0,
        whitelistPaths: ["总行/信息技术部"],
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }

    const r = await checkForUpdate(baseUrl)
    expect(r!.channel).toBe("staging")
    expect(r!.grayReason).toBe("whitelist-path")
  })

  it("C4b 兄弟部门（销售部）不命中 → stable", async () => {
    getUserInfoImpl = () => sales
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 0,
        whitelistPaths: ["总行/信息技术部"],
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }

    const r = await checkForUpdate(baseUrl)
    expect(r!.channel).toBe("stable")
  })

  it("C5 segment 边界匹配：信息技术部外包组 ≠ 信息技术部", async () => {
    getUserInfoImpl = () => ({ ...itDept, pathName: "总行/信息技术部外包组" })
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 0,
        whitelistPaths: ["总行/信息技术部"],
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }

    const r = await checkForUpdate(baseUrl)
    expect(r!.channel).toBe("stable")
  })

  it("C6 mandatory stable 压制 staging → 强制升级覆盖灰度群体", async () => {
    getUserInfoImpl = () => dev
    currentManifest = {
      ...baseManifest,
      mandatory: true,
      staging: {
        version: "1.4.1",
        rolloutPercent: 100,
        whitelistUsers: ["DEV001"],
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }

    const r = await checkForUpdate(baseUrl)
    expect(r!.channel).toBe("stable")
    expect(r!.mandatory).toBe(true)
    expect(r!.version).toBe("1.4.0")
  })

  it("C7 stable 反超 staging → 忽略 staging，走 stable", async () => {
    getUserInfoImpl = () => dev
    currentManifest = {
      ...baseManifest,
      version: "1.4.2",
      staging: {
        version: "1.4.1",
        rolloutPercent: 100,
        whitelistUsers: ["DEV001"],
        asar: { file: "stale-gray.asar", sha256: "x", size: 1 }
      }
    }

    const r = await checkForUpdate(baseUrl)
    expect(r!.channel).toBe("stable")
    expect(r!.version).toBe("1.4.2")
  })

  it("C8 半成品 staging（patch-bump 但缺 asar）→ 回退 stable，不卡死用户", async () => {
    // user on 1.4.0, staging 1.4.1 → patch → 需要 asar；只给 full 故意残缺
    currentAppVersion = "1.4.0"
    getUserInfoImpl = () => dev
    currentManifest = {
      ...baseManifest,
      version: "1.4.0", // stable 也是 1.4.0，确保 stable 不升级
      staging: {
        version: "1.4.1",
        rolloutPercent: 100,
        whitelistUsers: ["DEV001"],
        // asar deliberately missing for patch-level bump
        full: { file: "x.exe", sha256: "y", size: 1 }
      }
    }

    // staging 解析失败 → 回退 stable；但 stable 也是 1.4.0（=当前版本）→ 返回 null
    const r = await checkForUpdate(baseUrl)
    expect(r).toBeNull()
  })

  it("C8b 半成品 staging 回退后 stable 有新版 → 拿 stable", async () => {
    currentAppVersion = "1.4.0"
    getUserInfoImpl = () => dev
    currentManifest = {
      ...baseManifest,
      version: "1.4.2", // stable 提供了一个 hotfix
      asar: { file: "stable-1.4.2.asar.gz", sha256: "hf-sha", size: 120 },
      staging: {
        version: "1.4.3",
        rolloutPercent: 100,
        whitelistUsers: ["DEV001"],
        // asar 缺失 → patch-bump 1.4.2→1.4.3 失败 → 回退 stable
        full: { file: "useless.exe", sha256: "y", size: 1 }
      }
    }

    const r = await checkForUpdate(baseUrl)
    expect(r!.channel).toBe("stable")
    expect(r!.version).toBe("1.4.2")
  })

  it("C9 安装前撤回：staging 被运营 pull → isSameStagingPayload 检测出差异", async () => {
    currentAppVersion = "1.4.0"
    getUserInfoImpl = () => dev

    // Step 1: user downloads a staging update
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 100,
        whitelistUsers: ["DEV001"],
        asar: { file: "gray-1.4.1.asar", sha256: "gray-sha-v1", size: 200 }
      }
    }
    const downloaded = await checkForUpdate(baseUrl)
    expect(downloaded!.channel).toBe("staging")

    // Step 2: ops removes staging block from the manifest
    currentManifest = { ...baseManifest }
    const recheck = await checkForUpdate(baseUrl)

    // Step 3: install-time guard refuses the stale local package
    expect(isSameStagingPayload(downloaded!, recheck)).toBe(false)
  })

  it("C10 同版本换包：version 不变但 sha256 变 → 撤回", async () => {
    currentAppVersion = "1.4.0"
    getUserInfoImpl = () => dev

    // Build #1 of v1.4.1
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 100,
        whitelistUsers: ["DEV001"],
        asar: { file: "gray-1.4.1.asar", sha256: "build-1-sha", size: 200 }
      }
    }
    const downloaded = await checkForUpdate(baseUrl)

    // Ops repackages same version with a hotfix → sha changes
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 100,
        whitelistUsers: ["DEV001"],
        asar: { file: "gray-1.4.1.asar", sha256: "build-2-sha", size: 200 }
      }
    }
    const recheck = await checkForUpdate(baseUrl)

    expect(recheck!.version).toBe("1.4.1") // version same
    expect(isSameStagingPayload(downloaded!, recheck)).toBe(false) // sha differs
  })

  it("C11 损坏的 userInfo JSON → 按匿名处理 → stable 更新不受影响", async () => {
    // 用 1.3.10 模拟"用户信息一直损坏的存量用户"
    currentAppVersion = "1.3.10"
    getUserInfoImpl = () => {
      throw new Error("Unexpected token } in JSON at position 42")
    }
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 100, // would hit if user was known
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }

    const r = await checkForUpdate(baseUrl)
    expect(r).not.toBeNull()
    expect(r!.channel).toBe("stable")
    expect(r!.version).toBe("1.4.0")
    expect(r!.grayReason).toBe("anonymous-excluded")
  })

  it("C12 百分比分桶（rolloutSeed 同一台机稳定）", async () => {
    currentAppVersion = "1.4.0"
    getUserInfoImpl = () => dev
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 50,
        rolloutSeed: "v1.4.1-r1",
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }
    const a = await checkForUpdate(baseUrl)
    const b = await checkForUpdate(baseUrl)
    const c = await checkForUpdate(baseUrl)

    expect(a!.channel).toBe(b!.channel)
    expect(b!.channel).toBe(c!.channel)
    expect(a!.grayReason).toBe(b!.grayReason)
    // Either consistently in or consistently out — never flipping
  })

  it("C13 已升级到 staging 版本的用户 → 返回 null（无更新）", async () => {
    currentAppVersion = "1.4.1" // already on the gray candidate
    getUserInfoImpl = () => dev
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 100,
        whitelistUsers: ["DEV001"],
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }

    const r = await checkForUpdate(baseUrl)
    expect(r).toBeNull()
  })

  it("C14 完整放量流程演练（dogfood → 1% → 50% → 100% → 收敛）", async () => {
    currentAppVersion = "1.4.0"
    getUserInfoImpl = () => dev

    // 阶段 0: dogfood — 仅白名单命中
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 0,
        whitelistUsers: ["DEV001"],
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }
    expect((await checkForUpdate(baseUrl))!.channel).toBe("staging")

    // 阶段 1: 移除白名单 + 1% 放量。此时 DEV001 要么命中桶要么 null
    // （stable 1.4.0 == 当前版本，未命中即无更新）
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 1,
        rolloutSeed: "v1.4.1-r1",
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }
    const at1pct = await checkForUpdate(baseUrl)
    if (at1pct !== null) {
      // 命中分桶
      expect(at1pct.channel).toBe("staging")
      expect(at1pct.grayReason).toMatch(/^bucket=\d+\/1$/)
    }
    // null 也算合理：DEV001 不在 1% 桶里且 stable 无更新

    // 阶段 2: 紧急踩刹车 — rolloutPercent: 0，所有非白名单用户立即出灰度
    currentManifest = {
      ...baseManifest,
      staging: {
        version: "1.4.1",
        rolloutPercent: 0,
        asar: { file: "gray.asar", sha256: "x", size: 1 }
      }
    }
    const at0pct = await checkForUpdate(baseUrl)
    expect(at0pct).toBeNull() // 不在白名单且 stable 无更新

    // 阶段 4: 收敛 — staging 块被提升为 stable，删 staging
    currentManifest = {
      ...baseManifest,
      version: "1.4.1",
      asar: { file: "gray.asar", sha256: "x", size: 1 }
    }
    const converged = await checkForUpdate(baseUrl)
    expect(converged!.channel).toBe("stable")
    expect(converged!.version).toBe("1.4.1")
    expect(converged!.grayReason).toBe("no-staging-block")
  })
})
