import { build } from "esbuild"
import { createHash } from "node:crypto"
import { createRequire, isBuiltin } from "node:module"
import {
  closeSync,
  copyFileSync,
  fstatSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { BOT_PROCESS_ENTRIES, botBuildIdentity } from "../src/main/build/bot-build-inputs"
import { mirrorRequiredDirectorySync } from "../src/main/build/directory-mirror"
import { projectServiceLock } from "../src/main/build/service-lockfile"
import {
  prepareBotNativeDistribution,
  mirrorBotNativeDistribution
} from "../src/main/build/bot-native-distribution"

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  if (
    index !== process.argv.lastIndexOf(name) ||
    !process.argv[index + 1] ||
    process.argv[index + 1].startsWith("--")
  )
    throw new Error(`Invalid ${name}`)
  return process.argv[index + 1]
}

const root = realpathSync(
  resolve(argument("--source-root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."))
)
const destinationArgument = argument("--out-dir")
if (!destinationArgument) throw new Error("An explicit, new --out-dir is required.")
const requestedDestination = resolve(destinationArgument)
const parent = realpathSync(dirname(requestedDestination))
const destination = join(parent, basename(requestedDestination))
const inside = (directory: string, target: string): boolean => {
  const path = relative(directory, target)
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"))
  )
}
if (
  existsSync(destination) ||
  destination === root ||
  ["src", "resources", "skills", "node_modules"].some((part) =>
    inside(join(root, part), destination)
  )
)
  throw new Error("Output must be a new directory outside protected source directories.")
let sourceBuildId: string
const temporary = mkdtempSync(join(parent, ".cmb-bot-build-"))
const requireFromRoot = createRequire(join(root, "package.json"))

function packageIdentity(
  name: string,
  runtimeImport: string
): { version: string; license: unknown } {
  let cursor = dirname(requireFromRoot.resolve(runtimeImport))
  for (;;) {
    const candidate = join(cursor, "package.json")
    if (existsSync(candidate)) {
      const value = JSON.parse(readFileSync(candidate, "utf8"))
      if (value.name === name && typeof value.version === "string")
        return { version: value.version, license: value.license ?? null }
    }
    const next = dirname(cursor)
    if (next === cursor) throw new Error(`Cannot identify dependency ${name}`)
    cursor = next
  }
}

const resourceDirectories = [
  ["skills", "out/skills"],
  ["resources/mods", "out/resources/mods"],
  ["resources/bin", "out/resources/bin"]
] as const
const resourceFiles = [
  ["resources/mods-policy.json", "out/resources/mods-policy.json"],
  ["LICENSE", "LICENSE"],
  ...[
    "CODEX-LICENSE",
    "CODEX-NOTICE",
    "CODEX-PROVENANCE.json",
    "RAKAZO-LICENSE",
    "HERMES-LICENSE",
    "HERMES-PROVENANCE.json"
  ].map((name) => [`src/main/bots/upstream/${name}`, `licenses/bot-upstream/${name}`] as const)
] as const
const resourceInputs = [
  ...resourceDirectories.map(([source]) => source),
  ...resourceFiles.map(([source]) => source),
  "package.json",
  "scripts/bot-service-launcher.cjs"
]

/** Bound both the resource preflight and generated manifest without loading binaries into memory. */
function fileIdentities(directory: string, inputs: readonly string[], maximum = 512 * 1024 * 1024) {
  const files: { path: string; bytes: number; sha256: string }[] = []
  let total = 0
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const visit = (path: string): void => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error("Build resources must be physical files.")
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name))
      return
    }
    if (!stat.isFile()) throw new Error("Invalid build resource.")
    total += stat.size
    if (files.length >= 16384 || total > maximum)
      throw new Error("Independent service artifacts exceed their build limits.")
    const fd = openSync(path, "r")
    const hash = createHash("sha256")
    try {
      let bytes = 0,
        size: number
      while ((size = readSync(fd, buffer, 0, buffer.length, null))) {
        bytes += size
        if (bytes > stat.size) throw new Error("Build resource changed while reading.")
        hash.update(buffer.subarray(0, size))
      }
      const after = fstatSync(fd)
      if (
        bytes !== stat.size ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs
      )
        throw new Error("Build resource changed while reading.")
      files.push({
        path: relative(directory, path).split("\\").join("/"),
        bytes,
        sha256: hash.digest("hex")
      })
    } finally {
      closeSync(fd)
    }
  }
  for (const input of inputs) visit(join(directory, input))
  return files
}

async function main(): Promise<void> {
  try {
    const native = await prepareBotNativeDistribution(process.env)
    sourceBuildId = botBuildIdentity(root, native?.pin)
    const originalResources = JSON.stringify(fileIdentities(root, resourceInputs))
    const entryPoints = Object.fromEntries(
      Object.entries(BOT_PROCESS_ENTRIES).map(([name, entry]) => [name, join(root, entry)])
    )
    const result = await build({
      entryPoints,
      outdir: join(temporary, "out/main"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22.16",
      packages: "external",
      metafile: true,
      absWorkingDir: root,
      logLevel: "warning",
      define: {
        __BOT_BUILD_ID__: JSON.stringify(sourceBuildId),
        __BOT_NATIVE_DISTRIBUTION__: JSON.stringify(native?.pin ?? null),
        "import.meta.url": "__CMB_BOT_MODULE_URL__"
      },
      banner: {
        js: "const __CMB_BOT_MODULE_URL__ = require('node:url').pathToFileURL(__filename).href;"
      }
    })
    const imports = new Set([
      ...Object.values(result.metafile!.outputs).flatMap((output) =>
        output.imports.filter((item) => item.external).map((item) => item.path)
      ),
      // Tool search and Mods use createRequire; the bundler cannot discover these imports.
      "segment",
      "esbuild"
    ])
    const dependencies: Record<string, string> = {}
    const dependencyLicenses: Record<string, unknown> = {}
    for (const imported of [...imports].sort()) {
      if (isBuiltin(imported)) continue
      if (imported === "electron" || imported.startsWith("electron/"))
        throw new Error("Independent Host build unexpectedly imports Electron.")
      if (imported.startsWith(".") || imported.startsWith("/") || imported.includes("\\"))
        throw new Error(`Unresolved runtime import: ${imported}`)
      const parts = imported.split("/")
      const name = imported.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
      const identity = packageIdentity(name, imported)
      dependencies[name] = identity.version
      dependencyLicenses[name] = identity.license
    }
    for (const [source, output] of resourceDirectories)
      mirrorRequiredDirectorySync(join(root, source), join(temporary, output))
    for (const [source, output] of resourceFiles) {
      const path = join(root, source),
        stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`Invalid build resource ${source}`)
      mkdirSync(dirname(join(temporary, output)), { recursive: true })
      copyFileSync(path, join(temporary, output))
    }
    await mirrorBotNativeDistribution(native, join(temporary, "out/resources"))
    copyFileSync(join(root, "scripts/bot-service-launcher.cjs"), join(temporary, "run-host.cjs"))
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    const servicePackage = {
      name: `${pkg.name}-bot-host`,
      private: true,
      version: pkg.version,
      license: pkg.license,
      main: "out/main/bot-host.js",
      engines: { node: ">=22.16 <23" },
      scripts: { start: "node run-host.cjs" },
      dependencies
    }
    writeFileSync(join(temporary, "package.json"), JSON.stringify(servicePackage, null, 2) + "\n")
    writeFileSync(
      join(temporary, "package-lock.json"),
      JSON.stringify(
        projectServiceLock(
          JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")),
          servicePackage
        ),
        null,
        2
      ) + "\n"
    )
    const files = fileIdentities(temporary, [""], native ? 2 * 1024 ** 3 : 512 * 1024 ** 2)
    await native?.package.assertCurrent()
    if (
      botBuildIdentity(root, native?.pin) !== sourceBuildId ||
      JSON.stringify(fileIdentities(root, resourceInputs)) !== originalResources
    )
      throw new Error("Sources changed during build.")
    const manifest = {
      schemaVersion: 1,
      buildId: sourceBuildId,
      node: ">=22.16 <23",
      entries: BOT_PROCESS_ENTRIES,
      files,
      dependencies,
      dependencyLicenses,
      nativeDistribution: native?.pin ?? null,
      nativeCapabilitiesAccepted: false
    }
    writeFileSync(join(temporary, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
    if (existsSync(destination))
      throw new Error("Output appeared during build; refusing replacement.")
    renameSync(temporary, destination)
    console.log(
      JSON.stringify({
        output: destination,
        buildId: sourceBuildId,
        entries: Object.keys(entryPoints).length,
        files: files.length,
        dependencies: Object.keys(dependencies).length
      })
    )
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
