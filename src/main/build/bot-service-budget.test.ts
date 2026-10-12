import { afterEach, beforeEach, expect, test } from "vitest"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeFixture } from "./native-distribution-fixture"
import {
  mirrorBotNativeDistribution,
  prepareBotNativeDistribution
} from "./bot-native-distribution"

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cmb-service-budget-")))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
type Artifact = { path: string; bytes: number; sha256: string }
type Manifest = {
  schemaVersion: number
  buildId: string
  files: Artifact[]
  nativeDistribution?: unknown
}
async function service(native: boolean) {
  const files: Artifact[] = []
  const add = async (relative: string) => {
    const bytes = await readFile(join(root, relative))
    files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) })
  }
  await mkdir(join(root, "out/main"), { recursive: true })
  await writeFile(
    join(root, "out/main/bot-host.js"),
    "throw new Error('Host must never execute in the verifier fixture')"
  )
  await add("out/main/bot-host.js")
  let pin: unknown = null
  if (native) {
    const fixture = await nativeFixture(root)
    await mirrorBotNativeDistribution(
      await prepareBotNativeDistribution(fixture.environment),
      join(root, "out/resources")
    )
    pin = fixture.pin
    if (!("setup" in fixture.manifest) || !("jobOwner" in fixture.manifest))
      throw new Error("Windows metadata fixture is incomplete")
    const namespace = "out/resources/bot-native-sandbox"
    await add(namespace + "/distribution-pin.json")
    for (const member of [
      fixture.manifest.cli,
      fixture.manifest.helper,
      fixture.manifest.setup!,
      fixture.manifest.jobOwner!,
      fixture.manifest.sourceArchive,
      ...fixture.manifest.licenses
    ])
      await add(`${namespace}/win32-x64/${member.name}`)
    await add(`${namespace}/win32-x64/bot-native-sandbox.json`)
  }
  const manifest: Manifest = {
    schemaVersion: 1,
    buildId: "a".repeat(24),
    files,
    nativeDistribution: pin
  }
  await save(manifest)
  return manifest
}
async function save(manifest: Manifest) {
  await writeFile(join(root, "build-manifest.json"), JSON.stringify(manifest))
}
async function verifier() {
  const path = join(process.cwd(), "scripts/bot-service-launcher.cjs")
  const module = { exports: {} as { verifyService(root: string): unknown } }
  // Exercise the production CJS reader/filesystem unchanged. Only its Node
  // version input is isolated for portable unit workers; separate audit runs
  // the >512MiB input on actual Node22, without this fixture/version injection.
  runInNewContext(
    await readFile(path, "utf8"),
    {
      require: createRequire(path),
      module,
      exports: module.exports,
      Buffer,
      process: { versions: { node: "22.16.0" } }
    },
    { filename: path }
  )
  return module.exports.verifyService
}

test.each([true, false])(
  "accepts honest %s native metadata with unchanged artifact hashing",
  async (native) => {
    const manifest = await service(native)
    expect((await verifier())(root)).toMatchObject(manifest)
  }
)
test("old missing nativeDistribution remains a bounded ordinary service", async () => {
  const manifest = await service(false)
  delete manifest.nativeDistribution
  await save(manifest)
  expect((await verifier())(root)).toMatchObject(manifest)
})
test.each(["string", "partial", "unknown-field"])(
  "cannot widen reads with %s unverified native metadata",
  async (kind) => {
    const manifest = await service(false)
    manifest.nativeDistribution =
      kind === "string"
        ? "native"
        : kind === "partial"
          ? { format: 1, platform: "win32", arch: "x64" }
          : {
              format: 1,
              platform: "win32",
              arch: "x64",
              manifestSha256: "a".repeat(64),
              extra: true
            }
    await save(manifest)
    const verify = await verifier()
    expect(() => verify(root)).toThrow("distribution pin")
  }
)
test.each(["missing-seal", "missing-manifest", "duplicate-seal"])(
  "requires exact persisted %s metadata before selecting native budget",
  async (kind) => {
    const manifest = await service(true)
    const seal = "out/resources/bot-native-sandbox/distribution-pin.json"
    const native = "out/resources/bot-native-sandbox/win32-x64/bot-native-sandbox.json"
    if (kind === "duplicate-seal")
      manifest.files.push({ ...manifest.files.find((member) => member.path === seal)! })
    else
      manifest.files = manifest.files.filter(
        (member) => member.path !== (kind === "missing-seal" ? seal : native)
      )
    await save(manifest)
    const verify = await verifier()
    expect(() => verify(root)).toThrow("metadata")
  }
)
test("a self-consistently rewritten resource seal cannot select a different native pin", async () => {
  const manifest = await service(true),
    relative = "out/resources/bot-native-sandbox/distribution-pin.json"
  const replacement = Buffer.from(
    JSON.stringify({ ...(manifest.nativeDistribution as object), manifestSha256: "f".repeat(64) })
  )
  await writeFile(join(root, relative), replacement)
  Object.assign(manifest.files.find((member) => member.path === relative)!, {
    bytes: replacement.length,
    sha256: sha(replacement)
  })
  await save(manifest)
  const verify = await verifier()
  expect(() => verify(root)).toThrow("seal differs")
})
test("changed pinned native manifest rejects before broader artifact reads", async () => {
  await service(true)
  const file = join(root, "out/resources/bot-native-sandbox/win32-x64/bot-native-sandbox.json")
  const bytes = await readFile(file)
  bytes[0] = bytes[0] ^ 1
  await writeFile(file, bytes)
  const verify = await verifier()
  expect(() => verify(root)).toThrow("metadata")
})
test.each([true, false])(
  "preserves original 512MiB per-file bound with native=%s",
  async (native) => {
    const manifest = await service(native)
    manifest.files[0].bytes = 512 * 1024 * 1024 + 1
    await save(manifest)
    const verify = await verifier()
    expect(() => verify(root)).toThrow("artifact identity")
  }
)
test("changed worker bytes still fail the original artifact digest check", async () => {
  await service(true)
  const file = join(root, "out/main/bot-host.js"),
    bytes = await readFile(file)
  bytes[0] = bytes[0] ^ 1
  await writeFile(file, bytes)
  const verify = await verifier()
  expect(() => verify(root)).toThrow("artifact digest")
})
