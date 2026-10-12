import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { join, resolve, isAbsolute } from "node:path"
import { createHash } from "node:crypto"
import { nativeShellPackage, type NativeShellPackage } from "./native-shell-contract"

export interface VerifiedNativeShellPackage {
  directory: string
  manifest: NativeShellPackage
  manifestSha256: string
  cli: { entry: string; sha256: string }
  nativeHelper: { entry: string; sha256: string }
  setup?: { entry: string; sha256: string }
  jobOwner?: { entry: string; sha256: string }
  desktopWorker?: { entry: string; sha256: string; runtimeMode: "readonly-installed"; assets: Array<{entry: string; sha256: string}> }
  bwrap?: { entry: string; sha256: string }
  artifactPins: Array<{
    entry: string
    dev: string
    ino: string
    size: string
    mtimeNs: string
    ctimeNs: string
  }>
  assertCurrent(signal?: AbortSignal): Promise<void>
}
async function stableFile(path: string, maximum: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const before = await lstat(path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    (process.platform !== "win32" && (before.mode & 0o022n) !== 0n) ||
    before.size > BigInt(maximum) ||
    (await realpath(path)) !== path
  )
    throw new Error("Bot 原生组件文件身份无效")
  const file = await open(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  )
  try {
    const stat = await file.stat({ bigint: true })
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size)
      throw new Error("Bot 原生组件读取期间变化")
    const hash = createHash("sha256"),
      buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytes = 0
    for (;;) {
      signal?.throwIfAborted()
      const part = await file.read(buffer, 0, buffer.length, null)
      if (!part.bytesRead) break
      bytes += part.bytesRead
      if (bytes > maximum) throw new Error("Bot 原生组件超过大小限制")
      hash.update(buffer.subarray(0, part.bytesRead))
    }
    const after = await lstat(path, { bigint: true })
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.nlink !== 1n ||
      bytes !== Number(before.size) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error("Bot 原生组件发生变化")
    return { pin: before, sha256: hash.digest("hex") }
  } finally {
    await file.close()
  }
}
/** Package location is installation-owned and supplied by Main/service startup.
 * Reading a user-authored manifest is not enough to authorize its own hashes:
 * expectedManifestSha256 is the build's independent pinned distribution digest. */
export async function verifyNativeShellPackage(
  directory: string,
  expectedManifestSha256: string,
  signal?: AbortSignal
): Promise<VerifiedNativeShellPackage> {
  return verifyNativeShellDistribution(
    directory,
    expectedManifestSha256,
    { platform: process.platform, arch: process.arch },
    signal
  )
}

/** Build-time cross-platform file verification only. The caller supplies a
 * separately pinned digest and explicit release target. This returns file
 * identity, never a kernel capability; runtime verification above always
 * fixes the target to the current process platform and architecture. */
export async function verifyNativeShellDistribution(
  directory: string,
  expectedManifestSha256: string,
  target: { platform: NodeJS.Platform; arch: string },
  signal?: AbortSignal
): Promise<VerifiedNativeShellPackage> {
  if (
    !/^[a-f0-9]{64}$/.test(expectedManifestSha256) ||
    !isAbsolute(directory) ||
    (await realpath(directory)) !== resolve(directory)
  )
    throw new Error("Bot 原生组件目录未核验")
  directory = await realpath(directory)
  const root = await lstat(directory, { bigint: true })
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (process.getuid && root.uid !== BigInt(process.getuid()) && root.uid !== 0n) ||
    (process.platform !== "win32" && (root.mode & 0o022n) !== 0n)
  )
    throw new Error("Bot 原生组件目录不安全")
  const manifestPath = join(directory, "bot-native-sandbox.json"),
    manifestFile = await stableFile(manifestPath, 64 * 1024, signal)
  if (manifestFile.sha256 !== expectedManifestSha256) throw new Error("Bot 原生组件分发摘要不匹配")
  const fd = await open(
    manifestPath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
  )
  let raw: string
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024 + 1)
    const read = await fd.read(buffer, 0, buffer.length, 0)
    const pin = await fd.stat({ bigint: true })
    if (
      read.bytesRead > 64 * 1024 ||
      BigInt(read.bytesRead) !== manifestFile.pin.size ||
      pin.dev !== manifestFile.pin.dev ||
      pin.ino !== manifestFile.pin.ino ||
      pin.size !== manifestFile.pin.size ||
      pin.mtimeNs !== manifestFile.pin.mtimeNs ||
      pin.ctimeNs !== manifestFile.pin.ctimeNs
    )
      throw new Error("Native manifest changed during its bounded second read")
    raw = buffer.subarray(0, read.bytesRead).toString("utf8")
  } finally {
    await fd.close()
  }
  if (createHash("sha256").update(raw).digest("hex") !== expectedManifestSha256)
    throw new Error("Bot 原生组件清单读取期间变化")
  const manifest = nativeShellPackage.parse(JSON.parse(raw))
  if (manifest.platform !== target.platform || manifest.arch !== target.arch)
    throw new Error("Bot 原生组件平台不匹配")
  const members = [
    manifest.cli,
    manifest.helper,
    ...(manifest.setup ? [manifest.setup] : []),
    ...(manifest.jobOwner ? [manifest.jobOwner] : []),
    ...(manifest.desktopWorker ? [manifest.desktopWorker] : []),
    ...(manifest.desktopWorker?.assets ?? []),
    ...(manifest.bwrap ? [manifest.bwrap] : []),
    manifest.sourceArchive,
    ...manifest.licenses
  ]
  const pins = new Map<string, Awaited<ReturnType<typeof stableFile>>>()
  for (const member of members) {
    const path = join(directory, member.name),
      value = await stableFile(
        path,
        member.name === "native-sources.tgz"
          ? 512 * 1024 * 1024
          : member.name.endsWith("LICENSE") || member.name.endsWith("NOTICE")
            ? 1024 * 1024
            : 256 * 1024 * 1024,
        signal
      )
    if (
      manifest.platform === "linux" &&
      ["codex", "codex-linux-sandbox", "bwrap"].includes(member.name) &&
      (value.pin.mode & 0o111n) === 0n
    )
      throw new Error("Native executable permission missing")
    if (value.sha256 !== member.sha256) throw new Error("Bot 原生组件内容摘要不匹配")
    pins.set(path, value)
  }
  const assertCurrent = async (currentSignal?: AbortSignal) => {
    currentSignal?.throwIfAborted()
    const now = await lstat(directory, { bigint: true })
    if (
      now.dev !== root.dev ||
      now.ino !== root.ino ||
      !now.isDirectory() ||
      now.isSymbolicLink() ||
      (process.platform !== "win32" && (now.mode & 0o022n) !== 0n) ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Bot 原生组件目录发生变化")
    for (const [path, { pin }] of [...pins, [manifestPath, manifestFile] as const]) {
      const stat = await lstat(path, { bigint: true })
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1n ||
        stat.dev !== pin.dev ||
        stat.ino !== pin.ino ||
        stat.size !== pin.size ||
        stat.mtimeNs !== pin.mtimeNs ||
        stat.ctimeNs !== pin.ctimeNs
      )
        throw new Error("Bot 原生组件文件发生变化")
    }
    currentSignal?.throwIfAborted()
  }
  await assertCurrent(signal)
  return {
    directory,
    artifactPins: [...pins, [manifestPath, manifestFile] as const].map(([entry, { pin }]) => ({
      entry,
      dev: String(pin.dev),
      ino: String(pin.ino),
      size: String(pin.size),
      mtimeNs: String(pin.mtimeNs),
      ctimeNs: String(pin.ctimeNs)
    })),
    manifest,
    manifestSha256: expectedManifestSha256,
    cli: {
      entry: join(directory, manifest.cli.name),
      sha256: manifest.cli.sha256
    },
    nativeHelper: {
      entry: join(directory, manifest.helper.name),
      sha256: manifest.helper.sha256
    },
    ...(manifest.jobOwner
      ? {
          jobOwner: {
            entry: join(directory, manifest.jobOwner.name),
            sha256: manifest.jobOwner.sha256
          }
        }
      : {}),
    ...(manifest.setup
      ? {
          setup: {
            entry: join(directory, manifest.setup.name),
            sha256: manifest.setup.sha256
          }
        }
      : {}),
    ...(manifest.desktopWorker
      ? {
          desktopWorker: {
            entry: join(directory, manifest.desktopWorker.name),
            sha256: manifest.desktopWorker.sha256,
            runtimeMode: manifest.desktopWorker.runtimeMode,
            assets: manifest.desktopWorker.assets.map((asset) => ({ entry: join(directory, asset.name), sha256: asset.sha256 }))
          }
        }
      : {}),
    ...(manifest.bwrap
      ? {
          bwrap: {
            entry: join(directory, manifest.bwrap.name),
            sha256: manifest.bwrap.sha256
          }
        }
      : {}),
    assertCurrent
  }
}
