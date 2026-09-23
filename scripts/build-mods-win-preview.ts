import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { build, Platform, Arch } from "electron-builder"
import {
  assertFreshPackageOutput,
  collectProductionPackages,
  stageProductionPackages
} from "./mods-package-stage"

/** Build from a private dependency snapshot; never rebuild the shared development junction. */
async function main(): Promise<void> {
  const root = process.cwd()
  const destination = process.argv[2]
  if (!destination)
    throw Error(
      "Usage: tsx scripts/build-mods-win-preview.ts output/mods-v2-validation/<new-directory>"
    )
  const output = await assertFreshPackageOutput(root, destination)
  if (
    await stat(join(root, "out/main/mods-e2e.js")).then(
      () => true,
      () => false
    )
  )
    throw Error("MODS_PACKAGE_TEST_BRIDGE_PRESENT: restore the ordinary production build first")
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  const packages = await collectProductionPackages(root)
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  }).trim()
  const hash = async (path: string): Promise<string> =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex")
  const evidence = {
    head,
    startedAt: new Date().toISOString(),
    status: "preview; acceptance requires packaged E2E",
    mainSha256: await hash(join(root, "out/main/index.js")),
    preloadSha256: await hash(join(root, "out/preload/index.js")),
    packages: packages.map(({ relative, name, version }) => ({ path: relative, name, version }))
  }
  await mkdir(output, { recursive: true })
  const stage = join(output, "app-stage")
  await mkdir(stage)
  // No lifecycle scripts are run in this staging tree. Only installed runtime packages are copied.
  const appPackage = { ...pkg }
  delete appPackage.build
  delete appPackage.scripts
  delete appPackage.devDependencies
  await writeFile(join(stage, "package.json"), JSON.stringify(appPackage, null, 2))
  await cp(join(root, "out"), join(stage, "out"), { recursive: true })
  if (
    (await hash(join(stage, "out/main/index.js"))) !== evidence.mainSha256 ||
    (await hash(join(stage, "out/preload/index.js"))) !== evidence.preloadSha256
  )
    throw Error("MODS_PACKAGE_BUILD_CHANGED")
  console.log(`Staging ${packages.length} installed runtime packages`)
  await stageProductionPackages(stage, packages)
  const configPath = join(output, "builder-config.json")
  // A file config replaces package.json build config; a config object would merge resource arrays.
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...pkg.build,
        npmRebuild: false,
        nodeGypRebuild: false,
        electronDist: join(root, "node_modules/electron/dist"),
        artifactName: "CMBDevClaw-Mods-v2-${version}-preview-setup.${ext}",
        directories: { ...pkg.build.directories, app: stage, output },
        extraResources: pkg.build.extraResources.map(
          (resource: { from: string; filter?: string[] }) => ({
            ...resource,
            from: resolve(root, resource.from),
            ...(resource.from === "resources/bin" ? { filter: ["**/*", "!win32/codex.exe"] } : {})
          })
        )
      },
      null,
      2
    )
  )
  const paths = await build({
    targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
    publish: "never",
    config: configPath
  })
  const sha256: Record<string, string> = {}
  for (const path of paths) sha256[path] = await hash(path)
  await writeFile(
    join(output, "build-evidence.json"),
    JSON.stringify({ ...evidence, finishedAt: new Date().toISOString(), paths, sha256 }, null, 2)
  )
  console.log(JSON.stringify({ output, paths }))
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
