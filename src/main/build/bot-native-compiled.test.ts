import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { createRequire } from "node:module"
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  readFile,
  writeFile,
  unlink,
  symlink,
  cp
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { finished } from "node:stream/promises"
import { createPackageWithOptions } from "@electron/asar"
import { BOT_NATIVE_COMPILED_SEAL, verifyPackagedBotNativeCompiled } from "./bot-native-compiled"
import {
  prepareBotNativeDistribution,
  mirrorBotNativeDistribution
} from "./bot-native-distribution"
import {
  nativeDesktopFixture as nativeFixture,
  compileMainHostFixture
} from "./native-distribution-fixture"
import { MAIN_GENERATED_SCRIPTS } from "./main-generated-scripts"

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cmb-native-compiled-")))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function pack(
  layout: "app" | "asar" | "unpacked-host" | "unpacked-generated",
  directory = root
) {
  if (layout !== "app") {
    const stream = await createPackageWithOptions(
      join(directory, "resources/app"),
      join(directory, "resources/app.asar"),
      layout === "unpacked-host"
        ? { unpack: "**/bot-host.js" }
        : layout === "unpacked-generated"
          ? { unpack: "**/generated/*.js" }
          : {}
    )
    await finished(stream)
    await rm(join(directory, "resources/app"), { recursive: true, force: true })
  }
}

test.each(["app", "asar", "unpacked-host"] as const)(
  "actual dual-entry compiled seal verifies %s and nullable native pin",
  async (layout) => {
    await compileMainHostFixture(root, null)
    await pack(layout)
    await verifyPackagedBotNativeCompiled(join(root, "resources"), null)
  }
)

test.each(["index.js", "bot-host.js"])(
  "actual afterPack rejects a changed compiled %s",
  async (member) => {
    const fixture = await nativeFixture(root)
    const main = await compileMainHostFixture(root, fixture.pin)
    await mirrorBotNativeDistribution(
      await prepareBotNativeDistribution(fixture.environment),
      join(root, "resources")
    )
    await writeFile(
      join(main, member),
      (await readFile(join(main, member), "utf8")) + "\n// changed emitted bytes\n"
    )
    await pack("asar")
    await withEnvironment(fixture.environment, async () => {
      await expect(
        actualVerifier()({
          appOutDir: root,
          electronPlatformName: "win32",
          arch: 1
        })
      ).rejects.toThrow("digest")
    })
  }
)

test("old compiled pin A and freshly sealed resource pin B are rejected by actual afterPack", async () => {
  const fixture = await nativeFixture(root)
  const old = { ...fixture.pin, manifestSha256: "f".repeat(64) }
  const main = await compileMainHostFixture(root, old)
  // These tiny fixtures read the actual compiled constant; never execute a product entry/native component.
  const require = createRequire(import.meta.url)
  expect(require(join(main, "index.js")).embeddedBotNativeDistribution()).toEqual(old)
  expect(require(join(main, "bot-host.js")).embeddedBotNativeDistribution()).toEqual(old)
  await mirrorBotNativeDistribution(
    await prepareBotNativeDistribution(fixture.environment),
    join(root, "resources")
  )
  await pack("asar")
  await withEnvironment(fixture.environment, async () => {
    await expect(
      actualVerifier()({
        appOutDir: root,
        electronPlatformName: "win32",
        arch: 1
      })
    ).rejects.toThrow("pin")
  })
})

test.each(["app", "asar"] as const)(
  "missing compiled seal in %s rejects before signing even with null-native inputs",
  async (layout) => {
    const main = await compileMainHostFixture(root, null)
    await unlink(join(main, BOT_NATIVE_COMPILED_SEAL))
    await mirrorBotNativeDistribution(null, join(root, "resources"))
    await pack(layout)
    await withEnvironment({}, async () => {
      await expect(
        actualVerifier()({
          appOutDir: root,
          electronPlatformName: "linux",
          arch: 1
        })
      ).rejects.toThrow(BOT_NATIVE_COMPILED_SEAL)
    })
  }
)

test.each(["app", "asar"] as const)(
  "same compiled pin and native bytes pass the actual %s afterPack verifier",
  async (layout) => {
    const fixture = await nativeFixture(root)
    await compileMainHostFixture(root, fixture.pin)
    await mirrorBotNativeDistribution(
      await prepareBotNativeDistribution(fixture.environment),
      join(root, "resources")
    )
    await pack(layout)
    await withEnvironment(fixture.environment, async () => {
      await actualVerifier()({
        appOutDir: root,
        electronPlatformName: "win32",
        arch: 1
      })
    })
  }
)

test.each(["extra", "seal-symlink", "member-link", "missing-host", "too-many"])(
  "rejects %s compiled inventory without executing bundles",
  async (kind) => {
    const main = await compileMainHostFixture(root, null)
    if (kind === "extra")
      await writeFile(join(main, "injected.js"), "throw new Error('must never execute')")
    if (kind === "seal-symlink") {
      const source = join(main, BOT_NATIVE_COMPILED_SEAL)
      await writeFile(join(main, "other-seal.json"), await readFile(source))
      await unlink(source)
      await symlink(join(main, "other-seal.json"), source)
    }
    if (kind === "member-link") {
      await writeFile(join(main, "original.data"), await readFile(join(main, "bot-host.js")))
      await unlink(join(main, "bot-host.js"))
      await symlink(join(main, "original.data"), join(main, "bot-host.js"))
    }
    if (kind === "missing-host" || kind === "too-many") {
      const seal = JSON.parse(await readFile(join(main, BOT_NATIVE_COMPILED_SEAL), "utf8"))
      if (kind === "missing-host")
        seal.members = seal.members.filter(
          (member: { name: string }) => member.name !== "bot-host.js"
        )
      else
        seal.members = Array.from({ length: 1025 }, (_, index) => ({
          name: `chunk${index}.js`,
          bytes: 1,
          sha256: "a".repeat(64)
        }))
      await writeFile(join(main, BOT_NATIVE_COMPILED_SEAL), JSON.stringify(seal))
    }
    await expect(verifyPackagedBotNativeCompiled(join(root, "resources"), null)).rejects.toThrow()
  }
)

test("a shared emitted chunk change is also rejected", async () => {
  const main = await compileMainHostFixture(root, null)
  const seal = JSON.parse(await readFile(join(main, BOT_NATIVE_COMPILED_SEAL), "utf8"))
  const shared = seal.members.find((member: { name: string }) => member.name.startsWith("shared-"))
  expect(shared).toBeDefined()
  await writeFile(join(main, shared.name), "throw new Error('must never execute')")
  await pack("asar")
  await expect(verifyPackagedBotNativeCompiled(join(root, "resources"), null)).rejects.toThrow(
    "digest"
  )
})

describe("final generated Main scripts", () => {
  const layouts = ["app", "asar", "unpacked-generated"] as const
  const fixtures = new Map<(typeof layouts)[number], { main: string; resources: string }>()
  let preparedRoot: string | undefined
  beforeAll(async () => {
    preparedRoot = await realpath(await mkdtemp(join(tmpdir(), "cmb-generated-seals-")))
    const template = join(preparedRoot, "template")
    const main = await compileMainHostFixture(template, null)
    for (const layout of layouts) {
      const directory = join(preparedRoot, layout)
      await cp(join(template, "resources"), join(directory, "resources"), {
        recursive: true,
        errorOnExist: true,
        force: false
      })
      await pack(layout, directory)
      fixtures.set(layout, { main, resources: join(directory, "resources") })
    }
  }, 30_000)
  afterAll(async () => {
    if (preparedRoot) await rm(preparedRoot, { recursive: true, force: true })
  }, 10_000)
  test.each(layouts)(
    "final %s seal includes both original generated Main scripts",
    async (layout) => {
      const fixture = fixtures.get(layout)
      if (!fixture) throw new Error("Prepared generated-script package is missing")
      const seal = JSON.parse(await readFile(join(fixture.main, BOT_NATIVE_COMPILED_SEAL), "utf8"))
      for (const name of MAIN_GENERATED_SCRIPTS) {
        expect(seal.members.some((member: { name: string }) => member.name === name)).toBe(true)
        expect(await readFile(join(fixture.main, name))).toEqual(
          await readFile(
            join(process.cwd(), "src/main/browser/record/common/playwright-codegen", name)
          )
        )
      }
      await verifyPackagedBotNativeCompiled(fixture.resources, null)
    }
  )
})

test("rejects changed physical generated bytes after ASAR unpacking", async () => {
  await compileMainHostFixture(root, null)
  await pack("unpacked-generated")
  const file = join(root, "resources/app.asar.unpacked/out/main", MAIN_GENERATED_SCRIPTS[0])
  const bytes = await readFile(file)
  bytes[0] ^= 1
  await writeFile(file, bytes)
  await expect(verifyPackagedBotNativeCompiled(join(root, "resources"), null)).rejects.toThrow(
    "digest"
  )
})

test.each(["app", "asar"] as const)(
  "rejects changed generated scripts in the actual %s inventory",
  async (layout) => {
    const main = await compileMainHostFixture(root, null)
    await writeFile(join(main, MAIN_GENERATED_SCRIPTS[0]), "updated generated script contents")
    await pack(layout)
    await expect(verifyPackagedBotNativeCompiled(join(root, "resources"), null)).rejects.toThrow(
      "digest"
    )
  }
)

test.each(["app", "asar"] as const)(
  "rejects missing and extra generated scripts in %s without loading Main",
  async (layout) => {
    const main = await compileMainHostFixture(root, null)
    await unlink(join(main, MAIN_GENERATED_SCRIPTS[1]))
    await writeFile(join(main, "generated/unexpected.js"), "unexpected generated contents")
    await pack(layout)
    await expect(verifyPackagedBotNativeCompiled(join(root, "resources"), null)).rejects.toThrow()
  }
)

test("unpacked Host physical symlink is rejected despite exact declared bytes", async () => {
  await compileMainHostFixture(root, null)
  await pack("unpacked-host")
  const main = join(root, "resources/app.asar.unpacked/out/main")
  await writeFile(join(main, "original.data"), await readFile(join(main, "bot-host.js")))
  await unlink(join(main, "bot-host.js"))
  await symlink(join(main, "original.data"), join(main, "bot-host.js"))
  await expect(verifyPackagedBotNativeCompiled(join(root, "resources"), null)).rejects.toThrow(
    "physical"
  )
})

test("oversized ASAR header is rejected before allocating/parsing header metadata", async () => {
  await mkdir(join(root, "resources"))
  const header = Buffer.alloc(8)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(32 * 1024 * 1024, 4)
  await writeFile(join(root, "resources/app.asar"), header)
  await expect(verifyPackagedBotNativeCompiled(join(root, "resources"), null)).rejects.toThrow(
    "header"
  )
})

function actualVerifier(): (context: unknown) => Promise<void> {
  return createRequire(import.meta.url)(
    join(process.cwd(), "scripts/bot-native-sandbox/verify-packaged.cjs")
  )
}
async function withEnvironment(env: Record<string, string>, callback: () => Promise<void>) {
  const keys = [
    "CMB_BUILD_BOT_NATIVE_DIRECTORY",
    "CMB_BUILD_BOT_NATIVE_MANIFEST_SHA256",
    "CMB_BUILD_BOT_NATIVE_TARGET"
  ]
  const previous = keys.map((key) => process.env[key])
  try {
    keys.forEach((key) => {
      delete process.env[key]
    })
    Object.assign(process.env, env)
    await callback()
  } finally {
    keys.forEach((key, i) =>
      previous[i] === undefined ? delete process.env[key] : (process.env[key] = previous[i])
    )
  }
}
