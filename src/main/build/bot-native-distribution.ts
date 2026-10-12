import { chmod, lstat, mkdir, opendir, realpath, rm } from "node:fs/promises"
import { join, isAbsolute, relative } from "node:path"
import {
  botNativeDistributionPin,
  type BotNativeDistributionPin
} from "../bots/native-shell-release"
import {
  verifyNativeShellDistribution,
  type VerifiedNativeShellPackage
} from "../bots/native-shell-package"
import { copyBackupFile, readPrivateJson, writePrivateJson } from "../bots/backup-io"

export interface PreparedBotNativeDistribution {
  pin: BotNativeDistributionPin
  package: VerifiedNativeShellPackage
}
export const BOT_NATIVE_DISTRIBUTION_DIRECTORY = "bot-native-sandbox"
const buildKeys = [
  "CMB_BUILD_BOT_NATIVE_DIRECTORY",
  "CMB_BUILD_BOT_NATIVE_MANIFEST_SHA256",
  "CMB_BUILD_BOT_NATIVE_TARGET"
] as const

/** Explicit local release inputs only. Cross-platform builders verify files
 * for their selected target; no executable, Cargo, download or OS probe runs. */
export async function prepareBotNativeDistribution(
  environment: NodeJS.ProcessEnv
): Promise<PreparedBotNativeDistribution | null> {
  if (buildKeys.every((key) => environment[key] === undefined)) return null
  const directory = environment.CMB_BUILD_BOT_NATIVE_DIRECTORY
  const target = /^(win32|linux)-(x64|arm64)$/.exec(environment.CMB_BUILD_BOT_NATIVE_TARGET ?? "")
  if (!directory || !isAbsolute(directory) || !target)
    throw new Error("Native release requires an absolute local directory and explicit target")
  const pin = botNativeDistributionPin.parse({
    format: 1,
    platform: target[1],
    arch: target[2],
    manifestSha256: environment.CMB_BUILD_BOT_NATIVE_MANIFEST_SHA256
  })
  const pkg = await verifyNativeShellDistribution(directory, pin.manifestSha256, pin)
  return { pin, package: pkg }
}

/** Generated build output only. The seal is written last and packaging must
 * verify it before signing. An interrupted copy cannot be packaged; the next
 * build replaces this complete generated namespace, including stale files. */
export async function mirrorBotNativeDistribution(
  distribution: PreparedBotNativeDistribution | null,
  resourcesDirectory: string
): Promise<void> {
  if (!isAbsolute(resourcesDirectory)) throw new Error("Build resource path must be absolute")
  await mkdir(resourcesDirectory, { recursive: true })
  const resources = await realpath(resourcesDirectory)
  const output = join(resources, BOT_NATIVE_DISTRIBUTION_DIRECTORY)
  if (distribution) {
    const part = relative(output, distribution.package.directory)
    if (
      part === "" ||
      (!isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\"))
    )
      throw new Error("Native build output cannot contain its source distribution")
    await distribution.package.assertCurrent()
  }
  try {
    const previous = await lstat(output)
    if (!previous.isDirectory() || previous.isSymbolicLink())
      throw new Error("Generated native resource namespace must be a physical directory")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { mode: 0o755 })
  if (distribution) {
    const { pin, package: pkg } = distribution
    const directory = join(output, `${pin.platform}-${pin.arch}`)
    await mkdir(directory, { mode: 0o755 })
    const members = [
      pkg.manifest.cli,
      pkg.manifest.helper,
      ...(pkg.manifest.setup ? [pkg.manifest.setup] : []),
      ...(pkg.manifest.jobOwner ? [pkg.manifest.jobOwner] : []),
      ...(pkg.manifest.desktopWorker ? [pkg.manifest.desktopWorker] : []),
      ...(pkg.manifest.desktopWorker?.assets ?? []),
      ...(pkg.manifest.bwrap ? [pkg.manifest.bwrap] : []),
      pkg.manifest.sourceArchive,
      ...pkg.manifest.licenses
    ]
    const hashes = new Map(members.map((member) => [member.name as string, member.sha256]))
    hashes.set("bot-native-sandbox.json", pin.manifestSha256)
    for (const member of pkg.artifactPins) {
      const name = relative(pkg.directory, member.entry)
      if (!name || name.includes("/") || name.includes("\\") || isAbsolute(name))
        throw new Error("Native package member must be a direct file")
      const hash = hashes.get(name)
      if (!hash) throw new Error("Native build member lacks its independent digest")
      await copyBackupFile(
        pkg.directory,
        name,
        directory,
        { size: Number(member.size), sha256: hash },
        name === "native-sources.tgz" ? 512 * 1024 * 1024 : 256 * 1024 * 1024
      )
      // Installed components contain no secrets. Keep a root-owned Linux
      // installation readable to its users without allowing group/world writes.
      await chmod(
        join(directory, name),
        pin.platform === "linux" && ["codex", "codex-linux-sandbox", "bwrap"].includes(name)
          ? 0o755
          : 0o644
      )
    }
    await pkg.assertCurrent()
    await verifyNativeShellDistribution(directory, pin.manifestSha256, pin)
  }
  await writePrivateJson(join(output, "distribution-pin.json"), distribution?.pin ?? null)
  await chmod(join(output, "distribution-pin.json"), 0o644)
}

/** Must run before installer signing, outside an optional hook catch block.
 * The expected pin comes from the same independent build inputs used for the
 * compiled Main/Host constant. A copied JSON file cannot authorize itself. */
async function exactMembers(directory: string, expected: readonly string[]): Promise<void> {
  const names = new Set(expected)
  let found = 0
  const entries = await opendir(directory, { bufferSize: 16 })
  for await (const entry of entries) {
    if (!names.has(entry.name) || ++found > expected.length)
      throw new Error("Packaged native namespace contains an unsealed member")
  }
  if (found !== expected.length) throw new Error("Packaged native namespace is incomplete")
}

export async function verifyPackagedBotNativeDistribution(
  resourcesDirectory: string,
  expected: BotNativeDistributionPin | null,
  target: { platform: NodeJS.Platform; arch: string }
): Promise<void> {
  const output = join(await realpath(resourcesDirectory), BOT_NATIVE_DISTRIBUTION_DIRECTORY)
  const raw = (await readPrivateJson(output, "distribution-pin.json", 4096)).value
  const pin = raw === null ? null : botNativeDistributionPin.parse(raw)
  if (JSON.stringify(pin) !== JSON.stringify(expected))
    throw new Error("Native package differs from the compiled release pin")
  await exactMembers(
    output,
    pin ? ["distribution-pin.json", `${pin.platform}-${pin.arch}`] : ["distribution-pin.json"]
  )
  if (!pin) return
  if (pin.platform !== target.platform || pin.arch !== target.arch)
    throw new Error("Native package does not match the installer target")
  const directory = join(output, `${pin.platform}-${pin.arch}`)
  const pkg = await verifyNativeShellDistribution(directory, pin.manifestSha256, target)
  await exactMembers(
    directory,
    pkg.artifactPins.map((member) => relative(directory, member.entry))
  )
  await pkg.assertCurrent()
}
