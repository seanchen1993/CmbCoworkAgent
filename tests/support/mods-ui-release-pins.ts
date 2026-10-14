import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import type { ElectronApplication } from "playwright"

export type ModsUiRelease = "old157" | "new158" | "new159"
interface FrozenReleaseDefinition {
  version: "1.5.7" | "1.5.8" | "1.5.9"
  directory: string
  manifest: string
  manifestSha256: string
  executableSha256: string
  asarSha256: string
  installerSha256: string
}

const old157: FrozenReleaseDefinition = {
  version: "1.5.7",
  directory: "output/stage39-main-release-win-20261008/win-unpacked",
  manifest: "output/stage39-main-package-freeze.json",
  manifestSha256: "b8865a197ce63aa0ccbcab620bb94a39bb945dbd3301c01dde8c1ed4c3aad3e8",
  executableSha256: "eef4111ab3504c9c5a492a6fe73dd19b1c9f37c0cb41a3b5475713c2e8dec758",
  asarSha256: "50b01168d0365a2b11f0336ea8f41bf079be6465c6c54dce16df28c7cacf43ae",
  installerSha256: "c86d21b71eaef418c756d26c14b20da5af6bfd46e80efdf985aca25f7af3d438"
}

// Fixed only after root's real build and freeze; runtime manifests cannot authorize other bytes.
const new158: FrozenReleaseDefinition | null = {
  version: "1.5.8",
  directory: "output/stage42-main-release-win-native-20261008/win-unpacked",
  manifest: "output/stage42-main-package-freeze.json",
  manifestSha256: "7f7d2231111063c58e3eba6beb2245e892d948ce08c204d3479ad0fc7c7a4152",
  executableSha256: "3ca8e1f29c44d02105543a100f3d66aee1e6a6e3d88866920a5f0afb77eb46f4",
  asarSha256: "6de5dc095e5bafeb7eb77a28d536d0ab7e20334fbdb2c03f09993e371ba18b03",
  installerSha256: "ba7e32ac6b71f036ea2f7946f7df6f7aa944258801d2430ca6cd87537960ab62"
}

const new159: FrozenReleaseDefinition | null = {
  version: "1.5.9",
  directory: "output/stage43-main-release-win-native-20261008/win-unpacked",
  manifest: "output/stage43-main-package-freeze.json",
  manifestSha256: "fe38a6e37bbf0972355e5b296b6b5a046981018dc10dc417e42784bb3f66d035",
  executableSha256: "01404102f806222bcfd6a72e199ed08b2488491bf83e249e7f12eb07bb2b357b",
  asarSha256: "7bf548265bb71583294ac8c9045ff050d71a0b0beaa6a0cde96603f2bdae3046",
  installerSha256: "8511491d209d3f61ccc175773a7a36f0989271eeb98e1db2e121a2c94334fd13"
}

export const MODS_UI_STARTER_PACKAGES = [
  {
    name: "mods-composition-board",
    file: "mods-composition-board.zip",
    sha256: "a94444e10b62b672a413d1c47c354a3261165803d3f375c3d8967782f9a177cf"
  },
  {
    name: "mods-composition-style",
    file: "mods-composition-style.zip",
    sha256: "b354bca9dee8dc58b397bbd88b74e30fb4f1ea5b6caeb110b671e7172869196f"
  },
  {
    name: "component-review-kit",
    file: "component-review-kit.zip",
    sha256: "5b4966131122a65bd3edc0a76cccf36e1a1bba932931b48cdffdf6a0f2099f1f"
  }
] as const

export function modsUiFileHash(path: string): string {
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

export function selectModsUiRelease(root: string, selected = process.env.CMB_MODS_UI_RELEASE) {
  const release = selected ?? "old157"
  assert(
    release === "old157" || release === "new158" || release === "new159",
    "Unknown fixed Mods UI release"
  )
  const pin = release === "old157" ? old157 : release === "new158" ? new158 : new159
  assert(pin, "Requested release is not frozen; package validation is deliberately disabled")
  const packageDirectory = resolve(root, pin.directory)
  const requested = process.env.CMB_MODS_PACKAGED_DIR
  assert(requested && requested.trim(), "An explicit frozen production package is required")
  assert.equal(realpathSync(resolve(root, requested)), realpathSync(packageDirectory))
  const manifestPath = resolve(root, pin.manifest)
  const starter = resolve(root, "output/stage39-main-release-win-20261008/DIY示例")
  const packageFiles = [
    { path: join(packageDirectory, "CMBDevClaw.exe"), sha256: pin.executableSha256 },
    { path: join(packageDirectory, "resources/app.asar"), sha256: pin.asarSha256 },
    {
      path: join(dirname(packageDirectory), `CMBDevClaw Setup ${pin.version}.exe`),
      sha256: pin.installerSha256
    }
  ]
  function verify(): void {
    for (const file of [{ path: manifestPath, sha256: pin!.manifestSha256 }, ...packageFiles]) {
      const stat = lstatSync(file.path)
      assert(stat.isFile() && !stat.isSymbolicLink(), "Frozen input must be a regular file")
      assert.equal(modsUiFileHash(file.path), file.sha256, file.path)
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version: string
      directory: string
      files: Array<{ path: string; sha256: string }>
    }
    assert.equal(manifest.version, pin!.version)
    assert.equal(realpathSync(manifest.directory), realpathSync(dirname(packageDirectory)))
    for (const file of packageFiles) {
      const expectedPath = file.path.slice(dirname(packageDirectory).length + 1).replace(/\\/g, "/")
      assert.equal(manifest.files.find((item) => item.path === expectedPath)?.sha256, file.sha256)
    }
    const starterManifest = join(starter, "packages.json")
    assert.equal(
      modsUiFileHash(starterManifest),
      "2964ef19d56fd71b283b0ea69c13c97b1e19022a217f45d7f73d6175ea381872"
    )
    const packages = JSON.parse(readFileSync(starterManifest, "utf8")) as {
      schemaVersion: number
      packages: Array<{ name: string; file: string; sha256: string }>
    }
    assert.equal(packages.schemaVersion, 1)
    assert.deepEqual(
      packages.packages.map(({ name, file, sha256 }) => ({ name, file, sha256 })),
      MODS_UI_STARTER_PACKAGES
    )
    for (const item of MODS_UI_STARTER_PACKAGES) {
      const path = join(starter, item.file)
      assert(!lstatSync(path).isSymbolicLink())
      assert.equal(modsUiFileHash(path), item.sha256)
      const candidate = join(dirname(packageDirectory), "DIY示例", item.file)
      assert(!lstatSync(candidate).isSymbolicLink())
      assert.equal(
        modsUiFileHash(candidate),
        item.sha256,
        "Candidate starter ZIP must match old157"
      )
    }
  }
  async function verifyBoot(application: ElectronApplication) {
    verify()
    const actual = await application.evaluate(({ app }) => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
      executable: process.execPath,
      asar: app.getAppPath(),
      pid: process.pid
    }))
    assert.equal(actual.version, pin!.version)
    assert.equal(actual.packaged, true)
    assert.equal(realpathSync(actual.executable), realpathSync(packageFiles[0].path))
    assert.equal(realpathSync(actual.asar), realpathSync(packageFiles[1].path))
    const asar = createRequire(join(root, "package.json"))("@electron/asar") as {
      listPackage(path: string): string[]
    }
    const files = asar.listPackage(actual.asar).map((file) => file.replace(/\\/g, "/"))
    assert(files.some((file) => file.endsWith("/out/main/index.js")))
    assert(files.some((file) => file.endsWith("/out/main/function-mod-host.js")))
    assert(!files.some((file) => file.endsWith("/mods-e2e.js")))
    return actual
  }
  verify()
  return {
    release: release as ModsUiRelease,
    version: pin.version,
    packageDirectory,
    manifestPath,
    manifestSha256: pin.manifestSha256,
    starter,
    packageFiles,
    verify,
    verifyBoot
  }
}
