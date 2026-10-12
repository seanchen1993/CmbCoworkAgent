/** Matching native build only; not invoked on the current Mac. Takes a local
 * fixed-revision checkout, never downloads a runtime or modifies that checkout.
 * Produces a NEW private directory and independent manifest SHA for Main/build
 * provenance. Kernel capability is still acquired by actual runtime probes. */
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import {
  lstat,
  readFile,
  writeFile,
  mkdir,
  copyFile,
  open,
  realpath,
  readdir
} from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, join, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
export const REVISION = "954fa9057bf3a4521ea34dbd010ff291d5b39763"
const own = dirname(fileURLToPath(import.meta.url))
function command(executable, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true
    })
    child.once("error", reject)
    child.once("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`Native build failed: ${executable} (${code ?? signal})`))
    )
  })
}
async function capture(executable, args, cwd, maximum = 4096) {
  return new Promise((resolve, reject) => {
    const parts = []
    let bytes = 0,
      overflow = false
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    })
    child.stdout.on("data", (part) => {
      bytes += part.length
      if (bytes > maximum) {
        overflow = true
        child.kill()
        return
      }
      parts.push(part)
    })
    child.stderr.resume()
    child.once("error", reject)
    child.once("close", (code) =>
      code === 0 && !overflow
        ? resolve(Buffer.concat(parts).toString("utf8"))
        : reject(new Error("Native source identity command failed"))
    )
  })
}
async function digest(path) {
  const before = await lstat(path, { bigint: true })
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size > 512n * 1024n * 1024n
  )
    throw new Error("Native build artifact is unsafe or too large")
  const fd = await open(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
    ),
    hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const chunk = await fd.read(buffer, 0, buffer.length, null)
      if (!chunk.bytesRead) break
      hash.update(buffer.subarray(0, chunk.bytesRead))
    }
  } finally {
    await fd.close()
  }
  const after = await lstat(path, { bigint: true })
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs ||
    after.ctimeNs !== before.ctimeNs
  )
    throw new Error("Native artifact changed while hashing")
  return hash.digest("hex")
}
export async function buildNativeSandboxPackage({
  sourceCheckout,
  outputDirectory,
  csc,
  dotnet,
  repositoryLicense,
  rustTarget
}) {
  if (!["win32", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch))
    throw new Error("This build requires a matching Windows/Linux machine")
  // Capture one toolchain environment for both Cargo builds, before awaits.
  const cargoEnvironment = { ...process.env }
  // Ambient target settings move Cargo output without an API-visible target.
  // Keep this matching-machine build deterministic and use the explicit option.
  for (const name of ["CARGO_TARGET_DIR", "CARGO_BUILD_TARGET"])
    if (Object.hasOwn(cargoEnvironment, name))
      throw new Error(`Native build requires an explicit target; ${name} is not allowed`)
  const architecture = process.arch === "x64" ? "x86_64" : "aarch64"
  const supportedTargets =
    process.platform === "win32"
      ? [`${architecture}-pc-windows-msvc`]
      : [`${architecture}-unknown-linux-gnu`, `${architecture}-unknown-linux-musl`]
  if (rustTarget !== undefined && !supportedTargets.includes(rustTarget))
    throw new Error("Rust target must match the native build machine")
  // The shipped source archive and license describe the fixed vendored bwrap.
  // Upstream treats even an empty skip variable as enabled; reject presence
  // instead of silently building a stub or code outside that archived source.
  if (process.platform === "linux")
    for (const name of ["CODEX_SKIP_BWRAP_BUILD", "CODEX_BWRAP_SOURCE_DIR"])
      if (Object.hasOwn(cargoEnvironment, name))
        throw new Error(`Fixed Linux native build does not allow ${name}`)
  if (
    !isAbsolute(sourceCheckout) ||
    !isAbsolute(outputDirectory) ||
    (await realpath(sourceCheckout)) !== sourceCheckout
  )
    throw new Error("Native build paths must be canonical")
  if (
    (await capture("git", ["rev-parse", `${REVISION}^{commit}`], sourceCheckout)).trim() !==
    REVISION
  )
    throw new Error("Fixed Codex source revision is missing")
  await mkdir(outputDirectory, { mode: 0o700 }) // EEXIST fails; never replace a package/build.
  const source = join(outputDirectory, "source"),
    dist = join(outputDirectory, "distribution")
  await mkdir(source, { mode: 0o700 })
  await mkdir(dist, { mode: 0o700 })
  const targetDirectory = join(outputDirectory, "target")
  await mkdir(targetDirectory, { mode: 0o700 })
  cargoEnvironment.CARGO_TARGET_DIR = targetDirectory
  const cargoTargetArguments = rustTarget ? ["--target", rustTarget] : []
  const releaseDirectory = join(targetDirectory, ...(rustTarget ? [rustTarget] : []), "release")
  const archive = join(outputDirectory, "upstream.tar")
  await command("git", ["archive", "--format=tar", `--output=${archive}`, REVISION], sourceCheckout)
  await command("tar", ["-xf", archive, "-C", source], outputDirectory)
  const forkManifest = JSON.parse(
    await readFile(
      join(
        own,
        "codex-fork",
        process.platform === "win32" ? "source-manifest.json" : "linux-source-manifest.json"
      ),
      "utf8"
    )
  )
  let desktopSources
  const desktopRoot = join(own, "native-desktop")
  const desktopBuildRoot = join(outputDirectory, "desktop-build-source")
  if (dotnet !== undefined) {
    if (process.platform !== "win32" || !isAbsolute(dotnet) || (await realpath(dotnet)) !== dotnet)
      throw new Error(
        "Native desktop publish requires an explicit trusted Windows dotnet executable"
      )
    if ((await capture(dotnet, ["--version"], outputDirectory)).trim() !== "10.0.401")
      throw new Error("Native desktop build requires the existing fixed .NET 10.0.401 SDK")
    desktopSources = JSON.parse(await readFile(join(desktopRoot, "source-manifest.json"), "utf8"))
    if (
      desktopSources.protocol !== "cmb-native-desktop-v1" ||
      !Array.isArray(desktopSources.files) ||
      desktopSources.files.length < 4 ||
      desktopSources.files.length > 64
    )
      throw new Error("Native desktop source manifest is invalid")
    const names = new Set()
    for (const file of desktopSources.files) {
      if (
        typeof file.path !== "string" ||
        !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file.path) ||
        file.path.split("/").some((part) => part === "." || part === "..") ||
        names.has(file.path) ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        throw new Error("Native desktop source identity is invalid")
      names.add(file.path)
      if ((await digest(join(desktopRoot, file.path))) !== file.sha256)
        throw new Error("Native desktop source changed from its fixed input")
      const target = join(source, "cmb-native-desktop", file.path)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(desktopRoot, file.path), target)
      const buildTarget = join(desktopBuildRoot, file.path)
      await mkdir(dirname(buildTarget), { recursive: true })
      await copyFile(join(desktopRoot, file.path), buildTarget)
    }
    for (const required of [
      "worker/WindowKeyboardSequence.cs",
      "tests/keyboard-sequence/Program.cs",
      "tests/keyboard-sequence/WindowKeyboardSequence.Tests.csproj",
      "tests/keyboard-sequence/packages.lock.json"
    ])
      if (!names.has(required))
        throw new Error("Native keyboard cleanup regression is missing from the fixed inputs")
    await copyFile(
      join(desktopRoot, "source-manifest.json"),
      join(source, "cmb-native-desktop", "source-manifest.json")
    )
  }
  for (const file of forkManifest.files) {
    if (file.baseSha256 && (await digest(join(source, file.relative))) !== file.baseSha256)
      throw new Error("Codex fork base differs from fixed source")
    if ((await digest(join(own, "codex-fork", file.candidate))) !== file.sha256)
      throw new Error("Codex fork patch candidate changed")
    await copyFile(join(own, "codex-fork", file.candidate), join(source, file.relative))
  }
  const patchSha256 = createHash("sha256")
    .update(
      JSON.stringify(
        process.platform === "win32"
          ? {
              fork: forkManifest,
              nativeOwnerSha256: await digest(join(own, "native", "windows-bot-resource.cs")),
              ...(desktopSources ? { desktopSources } : {}),
              protocol: "cmb-atomic-windows-job-v2"
            }
          : forkManifest
      )
    )
    .digest("hex")
  if (process.platform === "win32") {
    if (!csc || !isAbsolute(csc) || !repositoryLicense)
      throw new Error("Windows native build requires an explicit trusted csc and CMB license path")
    const forkRoot = join(source, "codex-rs", "windows-sandbox-rs", "src")
    await copyFile(
      join(own, "native", "windows-bot-resource.cs"),
      join(forkRoot, "cmb-bot-resource.cs")
    )
    await copyFile(repositoryLicense, join(dist, "CMB-LICENSE"))
    await copyFile(repositoryLicense, join(source, "CMB-LICENSE"))
    await command(
      csc,
      [
        "/nologo",
        "/optimize+",
        "/target:exe",
        "/platform:anycpu",
        `/out:${join(dist, "bot-resource-owner.exe")}`,
        join(own, "native", "windows-bot-resource.cs")
      ],
      outputDirectory
    )
  }
  const desktopRuntimeAssets = []
  if (desktopSources) {
    // Keep restore intermediates and published binaries outside the shipped
    // source archive. Its bytes describe sources and locked dependencies only.
    // This bounded console regression links the exact helper just copied from
    // source-manifest.json. A failed cleanup/encoding contract blocks publish.
    // No Windows UI, physical input, native target or kernel capability is tested.
    const regression = join(
      desktopBuildRoot,
      "tests",
      "keyboard-sequence",
      "WindowKeyboardSequence.Tests.csproj"
    )
    const regressionArtifacts = join(outputDirectory, "keyboard-sequence-artifacts")
    const regressionOutput = join(outputDirectory, "keyboard-sequence-output")
    await command(
      dotnet,
      [
        "restore",
        regression,
        "--locked-mode",
        "--artifacts-path",
        regressionArtifacts,
        "--property:Configuration=Release",
        "--disable-build-servers"
      ],
      outputDirectory
    )
    await command(
      dotnet,
      [
        "build",
        regression,
        "--no-restore",
        "--configuration",
        "Release",
        "--artifacts-path",
        regressionArtifacts,
        "--output",
        regressionOutput,
        "--disable-build-servers",
        "--property:UseSharedCompilation=false",
        "--maxcpucount:1"
      ],
      outputDirectory
    )
    await command(
      dotnet,
      [join(regressionOutput, "WindowKeyboardSequence.Tests.dll")],
      outputDirectory
    )
    const project = join(desktopBuildRoot, "worker", "CMB.NativeDesktop.csproj")
    const rid = `win-${process.arch}`
    const publish = join(outputDirectory, "desktop-publish")
    await command(dotnet, ["restore", project, "--locked-mode", "--runtime", rid], outputDirectory)
    await command(
      dotnet,
      [
        "publish",
        project,
        "--no-restore",
        "--configuration",
        "Release",
        "--runtime",
        rid,
        "--self-contained",
        "true",
        "--output",
        publish
      ],
      outputDirectory
    )
    const workerName = "CMBDevClaw.NativeDesktop.exe"
    await copyFile(join(publish, workerName), join(dist, workerName))
    // Native runtime DLLs stay alongside the pinned worker in its read-only
    // installed code root. They must never be extracted into a Bot write root.
    for (const file of await readdir(publish, { withFileTypes: true })) {
      if (file.name === workerName) continue
      if (
        !file.isFile() ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(file.name) ||
        !/\.(dll|txt|xml)$/i.test(file.name) ||
        desktopRuntimeAssets.length >= 64
      )
        throw new Error("Native desktop publish contains an unsupported runtime member")
      await copyFile(join(publish, file.name), join(dist, file.name), constants.COPYFILE_EXCL)
      desktopRuntimeAssets.push({ name: file.name, sha256: await digest(join(dist, file.name)) })
    }
    if (!desktopRuntimeAssets.length) throw new Error("Native desktop runtime files are missing")
    desktopRuntimeAssets.sort((left, right) => left.name.localeCompare(right.name))
    await copyFile(join(desktopRoot, "vendor", "WINAPP-LICENSE"), join(dist, "WINAPP-LICENSE"))
  }
  // Ship source for the exact modified native provider (incl. LGPL bwrap),
  // excluding build outputs because this archive precedes Cargo invocation.
  const sources = join(dist, "native-sources.tgz")
  await command("tar", ["-czf", sources, "-C", source, "."], outputDirectory)
  const cargoRoot = join(source, "codex-rs")
  let bwrapDigest
  if (process.platform === "linux") {
    await command(
      "cargo",
      ["build", "--locked", "--release", ...cargoTargetArguments, "--bin", "bwrap"],
      cargoRoot,
      cargoEnvironment
    )
    await copyFile(join(releaseDirectory, "bwrap"), join(dist, "bwrap"))
    bwrapDigest = await digest(join(dist, "bwrap"))
  }
  await command(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      ...cargoTargetArguments,
      "-p",
      "codex-cli",
      "-p",
      process.platform === "win32" ? "codex-windows-sandbox" : "codex-linux-sandbox"
    ],
    cargoRoot,
    { ...cargoEnvironment, ...(bwrapDigest ? { CODEX_BWRAP_SHA256: bwrapDigest } : {}) }
  )
  const names =
    process.platform === "win32"
      ? ["codex.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe"]
      : ["codex", "codex-linux-sandbox"]
  for (const name of names) await copyFile(join(releaseDirectory, name), join(dist, name))
  await copyFile(join(source, "LICENSE"), join(dist, "CODEX-LICENSE"))
  await copyFile(join(source, "NOTICE"), join(dist, "CODEX-NOTICE"))
  if (process.platform === "linux")
    await copyFile(join(cargoRoot, "vendor", "bubblewrap", "COPYING"), join(dist, "BWRAP-LICENSE"))
  const artifact = async (name) => ({ name, sha256: await digest(join(dist, name)) })
  const licenses =
    process.platform === "win32"
      ? [
          "CODEX-LICENSE",
          "CODEX-NOTICE",
          "CMB-LICENSE",
          ...(desktopSources ? ["WINAPP-LICENSE"] : [])
        ]
      : ["CODEX-LICENSE", "CODEX-NOTICE", "BWRAP-LICENSE"]
  const manifest = {
    format: 1,
    platform: process.platform,
    arch: process.arch,
    revision: REVISION,
    protocol: "codex-cmb-owned-sandbox-v1",
    patchSha256,
    cli: await artifact(names[0]),
    helper: await artifact(names[1]),
    ...(process.platform === "win32"
      ? {
          ownerProtocol: "cmb-atomic-windows-job-v2",
          desktopOwnerProtocol: "cmb-native-desktop-owner-v1",
          ...(desktopSources
            ? {
                desktopWorker: {
                  ...(await artifact("CMBDevClaw.NativeDesktop.exe")),
                  runtimeMode: "readonly-installed",
                  assets: desktopRuntimeAssets
                }
              }
            : {}),
          setup: await artifact(names[2]),
          jobOwner: await artifact("bot-resource-owner.exe")
        }
      : { bwrap: await artifact("bwrap") }),
    licenses: await Promise.all(licenses.map(artifact)),
    sourceArchive: await artifact("native-sources.tgz")
  }
  const path = join(dist, "bot-native-sandbox.json")
  await writeFile(path, JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o600 })
  return {
    directory: dist,
    manifestSha256: await digest(path),
    manifest,
    kernelAcceptance: "not-tested"
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arguments_ = process.argv.slice(2)
  const targetOptions = arguments_.filter((value) => value.startsWith("--rust-target"))
  const desktopOptions = arguments_.filter((value) => value.startsWith("--dotnet"))
  if (
    desktopOptions.length > 1 ||
    desktopOptions.some((value) => !value.startsWith("--dotnet=") || value === "--dotnet=")
  )
    throw new Error("Expected one optional --dotnet=<trusted-Windows-executable>")
  if (
    targetOptions.length > 1 ||
    targetOptions.some((value) => !value.startsWith("--rust-target=") || value === "--rust-target=")
  )
    throw new Error("Expected one optional --rust-target=<matching-target>")
  const positional = arguments_.filter(
    (value) => !value.startsWith("--rust-target") && !value.startsWith("--dotnet")
  )
  if (positional.length > 4) throw new Error("Too many native build arguments")
  const [sourceCheckout, outputDirectory, csc, repositoryLicense] = positional
  const rustTarget = targetOptions[0]?.slice("--rust-target=".length)
  const result = await buildNativeSandboxPackage({
    sourceCheckout,
    outputDirectory,
    csc,
    dotnet: desktopOptions[0]?.slice("--dotnet=".length),
    repositoryLicense,
    rustTarget
  })
  process.stdout.write(
    JSON.stringify({
      directory: result.directory,
      manifestSha256: result.manifestSha256,
      kernelAcceptance: result.kernelAcceptance
    }) + "\n"
  )
}
