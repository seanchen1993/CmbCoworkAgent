import assert from "node:assert/strict"
import { test } from "node:test"
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  statSync,
  existsSync,
  readFileSync,
  rmSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import builder from "electron-builder"
import afterPack from "./after-pack.js"

const { Arch } = builder

function fixture(t, platform = "darwin") {
  const root = mkdtempSync(join(tmpdir(), "after-pack-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const resources = join(root, "CMBDevClaw.app/Contents/Resources")
  const pty = join(resources, "app.asar.unpacked/node_modules/node-pty")
  const put = (file, contents = "fixture", mode = 0o644) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents, { mode })
    return file
  }
  const native = (directory, helper = true) => {
    put(join(pty, directory, "pty.node"))
    return helper ? put(join(pty, directory, "spawn-helper")) : null
  }
  const rg = put(join(resources, "bin/darwin/rg"))
  const context = {
    appOutDir: root,
    arch: Arch.arm64,
    electronPlatformName: platform,
    packager: { appInfo: { productFilename: "CMBDevClaw" } }
  }
  return { root, pty, put, native, rg, context }
}

test("makes ARM64 prebuilt helper and ripgrep executable", async (t) => {
  const f = fixture(t)
  const helper = f.native("prebuilds/darwin-arm64")
  await afterPack(f.context)
  for (const binary of [helper, f.rg]) assert.equal(statSync(binary).mode & 0o777, 0o755)
})

test("repairs rebuilt, debug and prebuilt helpers before signing", async (t) => {
  const f = fixture(t)
  const helpers = ["build/Release", "build/Debug", "prebuilds/darwin-arm64"].map((dir) =>
    f.native(dir)
  )
  await afterPack(f.context)
  for (const helper of helpers) assert.equal(statSync(helper).mode & 0o777, 0o755)
})

test("rejects a missing helper beside the module node-pty actually selects", async (t) => {
  const f = fixture(t)
  f.native("build/Release", false)
  f.native("prebuilds/darwin-arm64")
  await assert.rejects(afterPack(f.context), /spawn-helper missing beside active pty.node/)
})

test("rejects a package with only the wrong architecture", async (t) => {
  const f = fixture(t)
  f.native("prebuilds/darwin-x64")
  await assert.rejects(afterPack(f.context), /spawn-helper missing.*arm64/)
})

test("keeps the Linux binary and no-sandbox launcher behavior", async (t) => {
  const f = fixture(t, "linux")
  // Use distinct names so this regression also runs on case-insensitive macOS.
  f.context.packager.appInfo.productFilename = "LinuxFixture"
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0])
  f.put(join(f.root, "LinuxFixture"), elf)
  f.put(join(f.root, "chrome-sandbox"))
  await afterPack(f.context)
  assert.deepEqual(readFileSync(join(f.root, "cmbdevclaw")), elf)
  assert.match(readFileSync(join(f.root, "LinuxFixture"), "utf8"), /--no-sandbox/)
  assert.equal(existsSync(join(f.root, "chrome-sandbox")), false)
})

test("does not apply Linux or macOS handling to a Windows target", async (t) => {
  const f = fixture(t, "win32")
  await afterPack(f.context)
  assert.equal(existsSync(join(f.root, "CMBDevClaw")), false)
  assert.equal(statSync(f.rg).mode & 0o777, 0o644)
})
