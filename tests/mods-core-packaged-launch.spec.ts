/** Launch selection only; real package/ASAR identity and business flows are tested in Electron. */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { modsCoreLaunchOptions } from "./support/mods-core-packaged-launch"

const fixture = mkdtempSync(join(tmpdir(), "cmb-mods-core-launch-test-"))
const isolated = join(fixture, "profile")
const env = {
  PATH: "fixture-path",
  CMB_E2E_ELECTRON_BIN: "original-electron",
  HTTP_PROXY: "fixture"
}
const checks: string[] = []
function pass(name: string) {
  checks.push(name)
  console.log("PASS " + name)
}
function packageFixture(name: string) {
  const directory = join(fixture, name)
  mkdirSync(join(directory, "resources"), { recursive: true })
  writeFileSync(join(directory, "CMBDevClaw.exe"), "selection fixture, not an executable")
  writeFileSync(join(directory, "resources/app.asar"), "selection fixture, not an ASAR")
  return directory
}

try {
  const ordinary = modsCoreLaunchOptions(fixture, isolated, env, undefined)
  assert.equal(ordinary.packaged, undefined)
  assert.equal(ordinary.options.env, env)
  assert.deepEqual(ordinary.options.args, [
    join(fixture, "out/main/index.js"),
    `--user-data-dir=${join(isolated, "electron")}`
  ])
  pass("Absent package preserves the ordinary entry, environment and private profile")

  for (const value of ["", "   "])
    assert.throws(() => modsCoreLaunchOptions(fixture, isolated, env, value), /PATH_EMPTY/)
  pass("Explicit empty package is rejected before launch rather than falling back")

  const directory = packageFixture("valid-selection")
  const selected = modsCoreLaunchOptions(fixture, isolated, env, directory)
  assert.deepEqual(selected.options.args, [`--user-data-dir=${join(isolated, "electron")}`])
  assert.equal(selected.packaged?.asar, realpathSync(join(directory, "resources/app.asar")))
  assert.equal(selected.packaged?.executable, realpathSync(join(directory, "CMBDevClaw.exe")))
  assert.equal(selected.options.env.CMB_E2E_ELECTRON_BIN, selected.packaged?.executable)
  assert.equal(selected.options.env.CMB_MODS_E2E, "0")
  assert.equal(env.CMB_E2E_ELECTRON_BIN, "original-electron")
  assert.deepEqual(
    Object.keys(selected.options.env).sort(),
    [...Object.keys(env), "CMB_MODS_E2E"].sort()
  )
  pass("Explicit package pins canonical paths without an entry or parent environment merge")

  assert.throws(() => modsCoreLaunchOptions(fixture, isolated, env, join(fixture, "missing")))
  pass("Missing package does not select the ordinary entry")

  const missingExe = packageFixture("missing-exe")
  rmSync(join(missingExe, "CMBDevClaw.exe"))
  assert.throws(() => modsCoreLaunchOptions(fixture, isolated, env, missingExe))
  pass("Missing executable is rejected before launch")

  const missingAsar = packageFixture("missing-asar")
  rmSync(join(missingAsar, "resources/app.asar"))
  assert.throws(() => modsCoreLaunchOptions(fixture, isolated, env, missingAsar))
  pass("Missing ASAR is rejected before launch")

  const directoryExe = packageFixture("directory-exe")
  rmSync(join(directoryExe, "CMBDevClaw.exe"))
  mkdirSync(join(directoryExe, "CMBDevClaw.exe"))
  assert.throws(() => modsCoreLaunchOptions(fixture, isolated, env, directoryExe), /FILE_INVALID/)
  pass("Directory masquerading as an executable is rejected")

  const packageLink = join(fixture, "package-link")
  symlinkSync(directory, packageLink, process.platform === "win32" ? "junction" : "dir")
  assert.throws(() => modsCoreLaunchOptions(fixture, isolated, env, packageLink), /FILE_INVALID/)
  const resourcesLink = join(fixture, "resources-link")
  mkdirSync(resourcesLink)
  symlinkSync(
    join(directory, "resources"),
    join(resourcesLink, "resources"),
    process.platform === "win32" ? "junction" : "dir"
  )
  assert.throws(() => modsCoreLaunchOptions(fixture, isolated, env, resourcesLink), /FILE_INVALID/)
  pass("Package and resources directory links are rejected")

  assert.equal(checks.length, 8)
} finally {
  // Only remove the mkdtemp tree created by this test, including links to its own fixtures.
  assert.equal(dirname(resolve(fixture)), resolve(tmpdir()))
  assert(basename(fixture).startsWith("cmb-mods-core-launch-test-"))
  rmSync(fixture, { recursive: true, force: true })
}
