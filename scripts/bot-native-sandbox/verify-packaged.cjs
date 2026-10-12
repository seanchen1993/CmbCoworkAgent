/* eslint-disable @typescript-eslint/no-require-imports */
const { lstat, realpath } = require("node:fs/promises")
const { basename, join } = require("node:path")
const { require: requireTypeScript } = require("tsx/cjs/api")
const { prepareBotNativeDistribution, verifyPackagedBotNativeDistribution } = requireTypeScript(
  "../../src/main/build/bot-native-distribution.ts",
  __filename
)
const { verifyPackagedBotNativeCompiled } = requireTypeScript(
  "../../src/main/build/bot-native-compiled.ts",
  __filename
)

/** Release verification only: never downloads or executes a native component.
 * Failure is fatal before signing, outside the optional legacy Linux hook. */
module.exports = async function verifyNativeRelease(context) {
  const prepared = await prepareBotNativeDistribution(process.env)
  if (!context || !context.appOutDir || !context.electronPlatformName) {
    if (prepared) throw new Error("Native release requires an explicit installer target")
    return
  }
  const arch = { 0: "ia32", 1: "x64", 2: "arm", 3: "arm64", 4: "universal" }[context.arch]
  if (!arch) throw new Error("Unknown installer architecture")
  if (context.electronPlatformName === "win32" && arch !== "x64")
    throw new Error(
      "Unsupported Windows installer target: only x64 is currently supported. " +
        "Use .github/workflows/build-electron.yml with the Windows x64 target."
    )
  // A Windows installer is a complete Bot delivery, unlike a generic build or
  // independently verified shell-only service. Never sign a silent partial app.
  if (
    context.electronPlatformName === "win32" &&
    arch === "x64" &&
    (!prepared ||
      prepared.pin.platform !== "win32" ||
      prepared.pin.arch !== "x64" ||
      !prepared.package.desktopWorker ||
      prepared.package.manifest.desktopOwnerProtocol !== "cmb-native-desktop-owner-v1")
  )
    throw new Error(
      "Windows x64 installer requires the complete sealed Bot native distribution " +
        "(Codex, resource owner and desktop worker). Use .github/workflows/build-electron.yml " +
        "or supply its verified CMB_BUILD_BOT_NATIVE_DIRECTORY, " +
        "CMB_BUILD_BOT_NATIVE_MANIFEST_SHA256 and CMB_BUILD_BOT_NATIVE_TARGET=win32-x64 " +
        "inputs before building."
    )
  const output = await realpath(context.appOutDir)
  let resources = join(output, "resources")
  if (context.electronPlatformName === "darwin") {
    const product = context.packager?.appInfo?.productFilename
    if (!product || basename(product) !== product)
      throw new Error("Invalid application bundle name")
    resources = join(output, product + ".app", "Contents", "Resources")
  }
  // The actual compiled Main/Host seal is mandatory, including null-native
  // development builds. Rebuild old output; packaging never invents a seal.
  await verifyPackagedBotNativeCompiled(resources, prepared?.pin ?? null)
  // Other platforms may omit an unconfigured namespace. A configured native
  // release must always contain its sealed independently pinned bytes.
  try {
    await lstat(join(resources, "bot-native-sandbox"))
  } catch (error) {
    if (error.code === "ENOENT" && !prepared) return
    throw error
  }
  await verifyPackagedBotNativeDistribution(resources, prepared?.pin ?? null, {
    platform: context.electronPlatformName,
    arch
  })
}
