import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import type { ElectronApplication } from "playwright"

export type ModelIntentPackageRelease = "old158" | "new159"

export interface ModelIntentPackagePin {
  version: string
  directory: string
  manifest: string
  manifestSha256: string
  executableSha256: string
  asarSha256: string
  installerSha256: string
}

const old158: ModelIntentPackagePin = {
  version: "1.5.8",
  directory: "output/stage42-main-release-win-native-20261008/win-unpacked",
  manifest: "output/stage42-main-package-freeze.json",
  manifestSha256: "7f7d2231111063c58e3eba6beb2245e892d948ce08c204d3479ad0fc7c7a4152",
  executableSha256: "3ca8e1f29c44d02105543a100f3d66aee1e6a6e3d88866920a5f0afb77eb46f4",
  asarSha256: "6de5dc095e5bafeb7eb77a28d536d0ab7e20334fbdb2c03f09993e371ba18b03",
  installerSha256: "ba7e32ac6b71f036ea2f7946f7df6f7aa944258801d2430ca6cd87537960ab62"
}

// The root executor fills this only from the new candidate's actual immutable freeze.
const new159: ModelIntentPackagePin | null = {
  version: "1.5.9",
  directory: "output/stage43-main-release-win-native-20261008/win-unpacked",
  manifest: "output/stage43-main-package-freeze.json",
  manifestSha256: "fe38a6e37bbf0972355e5b296b6b5a046981018dc10dc417e42784bb3f66d035",
  executableSha256: "01404102f806222bcfd6a72e199ed08b2488491bf83e249e7f12eb07bb2b357b",
  asarSha256: "7bf548265bb71583294ac8c9045ff050d71a0b0beaa6a0cde96603f2bdae3046",
  installerSha256: "8511491d209d3f61ccc175773a7a36f0989271eeb98e1db2e121a2c94334fd13"
}

export function modelIntentFileHash(path: string): string {
  const hash = createHash("sha256")
  const buffer = Buffer.alloc(1024 * 1024)
  const fd = openSync(path, "r")
  try {
    let length: number
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, length))
    return hash.digest("hex")
  } finally {
    closeSync(fd)
  }
}

export function selectModelIntentPackage(root: string) {
  const selected = process.env.CMB_MODEL_INTENT_PACKAGE_RELEASE
  assert(selected === "old158" || selected === "new159", "Select an explicit fixed release")
  const pin = selected === "old158" ? old158 : new159
  assert(pin, "The new candidate pin is absent; package execution is disabled")
  assert.equal(pin.version, selected === "old158" ? "1.5.8" : "1.5.9")
  const packageDirectory = resolve(root, pin.directory)
  const manifestPath = resolve(root, pin.manifest)
  const requested = process.env.CMB_MODS_PACKAGED_DIR
  assert(requested && requested.trim(), "An explicit frozen packaged directory is required")
  assert.equal(realpathSync(resolve(root, requested)), realpathSync(packageDirectory))
  const files = [
    { path: join(packageDirectory, "CMBDevClaw.exe"), sha256: pin.executableSha256 },
    { path: join(packageDirectory, "resources/app.asar"), sha256: pin.asarSha256 },
    {
      path: join(dirname(packageDirectory), `CMBDevClaw Setup ${pin.version}.exe`),
      sha256: pin.installerSha256
    }
  ]
  function verify(): void {
    for (const directory of [packageDirectory, join(packageDirectory, "resources")]) {
      const stat = lstatSync(directory)
      assert(stat.isDirectory() && !stat.isSymbolicLink(), "Use regular frozen directories")
    }
    for (const file of [{ path: manifestPath, sha256: pin!.manifestSha256 }, ...files]) {
      const stat = lstatSync(file.path)
      assert(stat.isFile() && !stat.isSymbolicLink(), "Frozen inputs must be regular files")
      assert.equal(modelIntentFileHash(file.path), file.sha256, file.path)
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version: string
      directory: string
      files: Array<{ path: string; sha256: string }>
    }
    assert.equal(manifest.version, pin!.version)
    assert.equal(realpathSync(manifest.directory), realpathSync(dirname(packageDirectory)))
    for (const file of files) {
      const path = file.path.slice(dirname(packageDirectory).length + 1).replace(/\\/g, "/")
      assert.equal(manifest.files.find((item) => item.path === path)?.sha256, file.sha256)
    }
  }
  async function verifyBoot(application: ElectronApplication) {
    verify()
    const identity = await application.evaluate(({ app }) => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
      executable: process.execPath,
      asar: app.getAppPath(),
      pid: process.pid
    }))
    assert.equal(identity.version, pin!.version)
    assert.equal(identity.packaged, true)
    assert(Number.isInteger(identity.pid) && identity.pid > 0)
    assert.equal(realpathSync(identity.executable), realpathSync(files[0].path))
    assert.equal(realpathSync(identity.asar), realpathSync(files[1].path))
    const asar = createRequire(join(root, "package.json"))("@electron/asar") as {
      listPackage(path: string): string[]
    }
    const entries = asar.listPackage(identity.asar).map((path) => path.replace(/\\/g, "/"))
    assert(entries.some((path) => path.endsWith("/out/main/index.js")))
    assert(entries.some((path) => path.endsWith("/out/main/function-mod-host.js")))
    assert(!entries.some((path) => path.endsWith("/mods-e2e.js")))
    return identity
  }
  verify()
  return {
    selected: selected as ModelIntentPackageRelease,
    version: pin.version,
    packageDirectory,
    manifestPath,
    manifestSha256: pin.manifestSha256,
    files,
    verify,
    verifyBoot
  }
}
