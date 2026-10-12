import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest"
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  readdir,
  stat,
  unlink,
  mkdir,
  rename
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import {
  prepareBotNativeDistribution,
  mirrorBotNativeDistribution,
  verifyPackagedBotNativeDistribution
} from "./bot-native-distribution"
import { verifyNativeShellPackage } from "../bots/native-shell-package"
import {
  nativeFixture,
  nativeDesktopFixture,
  compileMainHostFixture
} from "./native-distribution-fixture"
let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cmb-native-release-")))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const resources = () => join(root, "resources")

test.each(["win32", "linux"] as const)(
  "%s release uses independent target/digest, includes exactly pinned provenance",
  async (platform) => {
    const fixture = await nativeFixture(root, platform)
    const prepared = await prepareBotNativeDistribution(fixture.environment)
    expect(prepared?.pin).toEqual(fixture.pin)
    await writeFile(join(fixture.directory, "unlisted-note.txt"), "not shipped")
    await mirrorBotNativeDistribution(prepared, resources())
    await verifyPackagedBotNativeDistribution(resources(), fixture.pin, {
      platform,
      arch: "x64"
    })
    const installed = join(resources(), "bot-native-sandbox", `${platform}-x64`)
    expect(await readdir(installed)).not.toContain("unlisted-note.txt")
    expect((await stat(installed)).mode & 0o777).toBe(0o755)
    expect((await stat(join(installed, fixture.manifest.cli.name))).mode & 0o777).toBe(
      platform === "linux" ? 0o755 : 0o644
    )
    expect(
      (await stat(join(resources(), "bot-native-sandbox/distribution-pin.json"))).mode & 0o777
    ).toBe(0o644)
    if (process.platform !== platform || process.arch !== "x64")
      await expect(verifyNativeShellPackage(installed, fixture.pin.manifestSha256)).rejects.toThrow(
        "平台"
      )
  }
)
test("partial or empty build configuration never creates self-authorized default pins", async () => {
  expect(await prepareBotNativeDistribution({})).toBeNull()
  for (const value of [
    { CMB_BUILD_BOT_NATIVE_DIRECTORY: "" },
    { CMB_BUILD_BOT_NATIVE_MANIFEST_SHA256: "a".repeat(64) },
    { CMB_BUILD_BOT_NATIVE_TARGET: "win32-x64" }
  ])
    await expect(prepareBotNativeDistribution(value)).rejects.toThrow()
  const f = await nativeFixture(root)
  await expect(
    prepareBotNativeDistribution({
      ...f.environment,
      CMB_BUILD_BOT_NATIVE_MANIFEST_SHA256: "f".repeat(64)
    })
  ).rejects.toThrow("摘要")
  await expect(
    prepareBotNativeDistribution({
      ...f.environment,
      CMB_BUILD_BOT_NATIVE_TARGET: "linux-x64"
    })
  ).rejects.toThrow("平台")
})
test("null distribution removes stale components and seals a no-native release", async () => {
  const f = await nativeFixture(root)
  await mirrorBotNativeDistribution(await prepareBotNativeDistribution(f.environment), resources())
  await mirrorBotNativeDistribution(null, resources())
  expect(await readdir(join(resources(), "bot-native-sandbox"))).toEqual(["distribution-pin.json"])
  await verifyPackagedBotNativeDistribution(resources(), null, {
    platform: "darwin",
    arch: "arm64"
  })
  await expect(
    verifyPackagedBotNativeDistribution(resources(), f.pin, {
      platform: "win32",
      arch: "x64"
    })
  ).rejects.toThrow("pin")
})
test("changed pinned source rejects before replacing the last generated release", async () => {
  const f = await nativeFixture(root)
  const p = await prepareBotNativeDistribution(f.environment)
  await mirrorBotNativeDistribution(p, resources())
  const seal = await readFile(join(resources(), "bot-native-sandbox/distribution-pin.json"), "utf8")
  await writeFile(join(f.directory, "codex.exe"), "changed")
  await expect(mirrorBotNativeDistribution(p, resources())).rejects.toThrow("变化")
  expect(
    await readFile(join(resources(), "bot-native-sandbox/distribution-pin.json"), "utf8")
  ).toBe(seal)
})
test.each(["corrupt", "missing-license", "extra-member", "wrong-target", "changed-seal"])(
  "packaging rejects %s before signing",
  async (kind) => {
    const f = await nativeFixture(root)
    await mirrorBotNativeDistribution(
      await prepareBotNativeDistribution(f.environment),
      resources()
    )
    const dir = join(resources(), "bot-native-sandbox/win32-x64")
    if (kind === "corrupt") await writeFile(join(dir, "codex.exe"), "corruption")
    if (kind === "missing-license") await unlink(join(dir, "CODEX-NOTICE"))
    if (kind === "extra-member") await writeFile(join(dir, "injected.exe"), "unsealed")
    if (kind === "changed-seal")
      await writeFile(
        join(resources(), "bot-native-sandbox/distribution-pin.json"),
        JSON.stringify({ ...f.pin, manifestSha256: "f".repeat(64) })
      )
    await expect(
      verifyPackagedBotNativeDistribution(resources(), f.pin, {
        platform: kind === "wrong-target" ? "linux" : "win32",
        arch: "x64"
      })
    ).rejects.toThrow()
  }
)
test("real CJS afterPack verifier invokes the TS build contract and propagates native failure", async () => {
  const f = await nativeDesktopFixture(root)
  await compileMainHostFixture(root, f.pin)
  await mirrorBotNativeDistribution(await prepareBotNativeDistribution(f.environment), resources())
  const require = createRequire(import.meta.url)
  const verify = require("../../../scripts/bot-native-sandbox/verify-packaged.cjs") as (
    context: unknown
  ) => Promise<void>
  const keys = Object.keys(f.environment)
  const before = keys.map((key) => process.env[key])
  try {
    Object.assign(process.env, f.environment)
    await verify({ appOutDir: root, electronPlatformName: "win32", arch: 1 })
    await expect(
      verify({ appOutDir: root, electronPlatformName: "win32", arch: 3 })
    ).rejects.toThrow("target")
    await writeFile(join(resources(), "bot-native-sandbox/win32-x64/codex.exe"), "changed")
    await expect(
      verify({ appOutDir: root, electronPlatformName: "win32", arch: 1 })
    ).rejects.toThrow("摘要")
    const afterPack = require("../../../scripts/after-pack.js") as (
      context: unknown
    ) => Promise<void>
    // Verify the real hook rejects before the optional legacy catch.
    await expect(
      afterPack({ appOutDir: root, electronPlatformName: "win32", arch: 1 })
    ).rejects.toThrow("摘要")
  } finally {
    keys.forEach((key, i) =>
      before[i] === undefined ? delete process.env[key] : (process.env[key] = before[i])
    )
  }
})
test.each(["absent", "sealed-null"])(
  "Windows x64 installer rejects %s native resources despite an honest compiled null seal",
  async (layout) => {
    await compileMainHostFixture(root, null)
    if (layout === "sealed-null") await mirrorBotNativeDistribution(null, resources())
    await withNativeEnvironment({}, async () => {
      await expect(
        actualAfterPack()({
          appOutDir: root,
          electronPlatformName: "win32",
          arch: 1
        })
      ).rejects.toThrow("build-electron.yml")
    })
  }
)
describe("Windows arm64 installer", () => {
  let preparedRoot: string | undefined
  beforeAll(async () => {
    preparedRoot = await realpath(await mkdtemp(join(tmpdir(), "cmb-win-arm64-package-")))
    await compileMainHostFixture(preparedRoot, null)
    await mirrorBotNativeDistribution(null, join(preparedRoot, "resources"))
  }, 30_000)
  afterAll(async () => {
    if (preparedRoot) await rm(preparedRoot, { recursive: true, force: true })
  }, 10_000)
  test("rejects an honest null-native compiled package", async () => {
    if (!preparedRoot) throw new Error("Prepared arm64 package is missing")
    await withNativeEnvironment({}, async () => {
      await expect(
        actualAfterPack()({ appOutDir: preparedRoot, electronPlatformName: "win32", arch: 3 })
      ).rejects.toThrow("only x64 is currently supported")
    })
  })
})
test("Windows x64 installer rejects a fully sealed shell-only distribution", async () => {
  const fixture = await nativeFixture(root)
  const prepared = await prepareBotNativeDistribution(fixture.environment)
  expect(prepared?.package.jobOwner).toBeDefined()
  expect(prepared?.package.desktopWorker).toBeUndefined()
  await compileMainHostFixture(root, fixture.pin)
  await mirrorBotNativeDistribution(prepared, resources())
  // The generic shell distribution is valid; the complete desktop installer is not.
  await verifyPackagedBotNativeDistribution(resources(), fixture.pin, {
    platform: "win32",
    arch: "x64"
  })
  await withNativeEnvironment(fixture.environment, async () => {
    await expect(
      actualAfterPack()({
        appOutDir: root,
        electronPlatformName: "win32",
        arch: 1
      })
    ).rejects.toThrow("desktop worker")
  })
})
test.each(["CMBDevClaw.NativeDesktop.exe", "coreclr.dll", "bot-resource-owner.exe", "codex.exe"])(
  "Windows x64 afterPack rejects a missing pinned %s",
  async (member) => {
    const fixture = await nativeDesktopFixture(root)
    await compileMainHostFixture(root, fixture.pin)
    await mirrorBotNativeDistribution(
      await prepareBotNativeDistribution(fixture.environment),
      resources()
    )
    await unlink(join(resources(), "bot-native-sandbox/win32-x64", member))
    await withNativeEnvironment(fixture.environment, async () => {
      await expect(
        actualAfterPack()({
          appOutDir: root,
          electronPlatformName: "win32",
          arch: 1
        })
      ).rejects.toThrow()
    })
  }
)
test("actual Mac verifier preserves an honest null-native build", async () => {
  await compileMainHostFixture(root, null)
  await mirrorBotNativeDistribution(null, resources())
  const contents = join(root, "CMBDevClaw.app/Contents")
  await mkdir(contents, { recursive: true })
  await rename(resources(), join(contents, "Resources"))
  const require = createRequire(import.meta.url)
  const verify = require("../../../scripts/bot-native-sandbox/verify-packaged.cjs") as (
    context: unknown
  ) => Promise<void>
  await withNativeEnvironment({}, async () => {
    await verify({
      appOutDir: root,
      electronPlatformName: "darwin",
      arch: 3,
      packager: { appInfo: { productFilename: "CMBDevClaw" } }
    })
  })
})
test("electron-vite actual config embeds the verified local release pin without executing native files", async () => {
  const f = await nativeFixture(root)
  const keys = Object.keys(f.environment),
    before = keys.map((key) => process.env[key])
  try {
    Object.assign(process.env, f.environment)
    const { loadConfigFromFile } = await import("electron-vite")
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      join(process.cwd(), "electron.vite.config.ts"),
      process.cwd(),
      "silent"
    )
    expect(loaded?.config.main?.define?.__BOT_NATIVE_DISTRIBUTION__).toBe(JSON.stringify(f.pin))
    expect(loaded?.config.main?.define?.__BOT_BUILD_ID__).toMatch(/^"[a-f0-9]{24}"$/)
    const plugins = loaded?.config.main?.build?.rollupOptions?.plugins
    if (!Array.isArray(plugins)) throw new Error("Expected configured Main plugins")
    const resourcesPlugin = plugins
      .flat()
      .find(
        (plugin) =>
          plugin &&
          typeof plugin === "object" &&
          "name" in plugin &&
          plugin.name === "copy-resources"
      )
    expect(resourcesPlugin).toHaveProperty("closeBundle")
  } finally {
    keys.forEach((key, i) =>
      before[i] === undefined ? delete process.env[key] : (process.env[key] = before[i])
    )
  }
})
test("independent manifest pin participates in the shared Main/Host build identity", async () => {
  const { mkdir } = await import("node:fs/promises")
  const { botBuildIdentity } = await import("./bot-build-inputs")
  await mkdir(join(root, "src/main"), { recursive: true })
  await mkdir(join(root, "src/shared"), { recursive: true })
  await writeFile(join(root, "src/main/source.ts"), "fixed")
  await writeFile(join(root, "src/shared/source.ts"), "fixed")
  await writeFile(join(root, "package-lock.json"), "{}")
  await writeFile(join(root, "electron.vite.config.ts"), "fixed")
  const a = {
      format: 1 as const,
      platform: "win32" as const,
      arch: "x64" as const,
      manifestSha256: "a".repeat(64)
    },
    b = { ...a, manifestSha256: "b".repeat(64) }
  expect(botBuildIdentity(root, a)).not.toBe(botBuildIdentity(root, b))
  expect(botBuildIdentity(root, a)).toBe(botBuildIdentity(root, a))
  expect(botBuildIdentity(root)).not.toBe(botBuildIdentity(root, a))
})

function actualAfterPack(): (context: unknown) => Promise<void> {
  return createRequire(import.meta.url)("../../../scripts/after-pack.js")
}
async function withNativeEnvironment(
  environment: Record<string, string>,
  callback: () => Promise<void>
): Promise<void> {
  const keys = [
    "CMB_BUILD_BOT_NATIVE_DIRECTORY",
    "CMB_BUILD_BOT_NATIVE_MANIFEST_SHA256",
    "CMB_BUILD_BOT_NATIVE_TARGET"
  ]
  const before = keys.map((key) => process.env[key])
  try {
    keys.forEach((key) => delete process.env[key])
    Object.assign(process.env, environment)
    await callback()
  } finally {
    keys.forEach((key, index) =>
      before[index] === undefined ? delete process.env[key] : (process.env[key] = before[index])
    )
  }
}
