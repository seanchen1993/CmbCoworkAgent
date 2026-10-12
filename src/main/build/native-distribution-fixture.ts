import { build } from "esbuild"
import { rollup } from "rollup"
import { botNativeCompiledSealPlugin } from "./bot-native-compiled"
import { mainGeneratedScriptsPlugin } from "./main-generated-scripts"
import type { BotNativeDistributionPin } from "../bots/native-shell-release"
import { createHash } from "node:crypto"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PINNED_CODEX_REVISION } from "../bots/bot-strict-platform"
export const sha = (value: string): string => createHash("sha256").update(value).digest("hex")
export async function nativeFixture(root: string, platform: "win32" | "linux" = "win32") {
  const directory = join(root, `source-${platform}`)
  await mkdir(directory, { mode: 0o700 })
  const member = async (name: string) => {
    const content = `Opaque fixture ${name}: metadata only, never executable.`
    await writeFile(join(directory, name), content, { mode: 0o600 })
    if (platform === "linux" && ["codex", "codex-linux-sandbox", "bwrap"].includes(name))
      await chmod(join(directory, name), 0o755)
    return { name, sha256: sha(content) }
  }
  const manifest = {
    format: 1,
    platform,
    arch: "x64",
    revision: PINNED_CODEX_REVISION,
    protocol: "codex-cmb-owned-sandbox-v1",
    patchSha256: sha("fixed provenance"),
    ...(platform === "win32"
      ? {
          ownerProtocol: "cmb-atomic-windows-job-v2",
          jobOwner: await member("bot-resource-owner.exe"),
          setup: await member("codex-windows-sandbox-setup.exe")
        }
      : { bwrap: await member("bwrap") }),
    cli: await member(platform === "win32" ? "codex.exe" : "codex"),
    helper: await member(platform === "win32" ? "codex-command-runner.exe" : "codex-linux-sandbox"),
    sourceArchive: await member("native-sources.tgz"),
    licenses: await Promise.all(
      ["CODEX-LICENSE", "CODEX-NOTICE", platform === "win32" ? "CMB-LICENSE" : "BWRAP-LICENSE"].map(
        member
      )
    )
  }
  const raw = JSON.stringify(manifest)
  await writeFile(join(directory, "bot-native-sandbox.json"), raw, {
    mode: 0o600
  })
  const environment = {
    CMB_BUILD_BOT_NATIVE_DIRECTORY: directory,
    CMB_BUILD_BOT_NATIVE_MANIFEST_SHA256: sha(raw),
    CMB_BUILD_BOT_NATIVE_TARGET: `${platform}-x64`
  }
  return {
    directory,
    manifest,
    environment,
    pin: {
      format: 1 as const,
      platform,
      arch: "x64" as const,
      manifestSha256: sha(raw)
    }
  }
}

/** Opaque package metadata only; native fixtures are never executed. */
export async function nativeDesktopFixture(root: string) {
  const fixture = await nativeFixture(root)
  const member = async (name: string) => {
    const content = `Opaque desktop fixture ${name}: metadata only, never executable.`
    await writeFile(join(fixture.directory, name), content, { mode: 0o600 })
    return { name, sha256: sha(content) }
  }
  const manifest = {
    ...fixture.manifest,
    desktopOwnerProtocol: "cmb-native-desktop-owner-v1",
    desktopWorker: {
      ...(await member("CMBDevClaw.NativeDesktop.exe")),
      runtimeMode: "readonly-installed",
      assets: await Promise.all(
        [
          "coreclr.dll",
          "DOTNET-RUNTIME-LICENSE.TXT",
          "DOTNET-RUNTIME-THIRD-PARTY-NOTICES.TXT",
          "DOTNET-WINDOWSDESKTOP-LICENSE.TXT"
        ].map(member)
      )
    },
    licenses: [...fixture.manifest.licenses, await member("WINAPP-LICENSE")]
  }
  const raw = JSON.stringify(manifest)
  await writeFile(join(fixture.directory, "bot-native-sandbox.json"), raw, {
    mode: 0o600
  })
  return {
    ...fixture,
    manifest,
    environment: {
      ...fixture.environment,
      CMB_BUILD_BOT_NATIVE_MANIFEST_SHA256: sha(raw)
    },
    pin: { ...fixture.pin, manifestSha256: sha(raw) }
  }
}

export async function compileMainHostFixture(
  directory: string,
  pin: BotNativeDistributionPin | null
): Promise<string> {
  const sources = join(directory, "compiled-input"),
    main = join(directory, "resources/app/out/main")
  await mkdir(sources, { recursive: true })
  const release = join(process.cwd(), "src/main/bots/native-shell-release.ts")
  await build({
    stdin: {
      contents: `export {embeddedBotNativeDistribution} from ${JSON.stringify(release)};`,
      resolveDir: process.cwd(),
      sourcefile: "native-release.ts"
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: join(sources, "native-release.mjs"),
    define: { __BOT_NATIVE_DISTRIBUTION__: JSON.stringify(pin) },
    logLevel: "silent"
  })
  for (const entry of ["index", "bot-host"]) {
    await writeFile(
      join(sources, `${entry}.mjs`),
      `export {embeddedBotNativeDistribution} from "./native-release.mjs"; export const marker = ${JSON.stringify(entry)};`
    )
  }
  const bundle = await rollup({
    input: {
      index: join(sources, "index.mjs"),
      "bot-host": join(sources, "bot-host.mjs")
    },
    plugins: [mainGeneratedScriptsPlugin(), botNativeCompiledSealPlugin(pin, "a".repeat(24))]
  })
  try {
    await bundle.write({
      dir: main,
      format: "cjs",
      entryFileNames: "[name].js",
      chunkFileNames: "shared-[hash].js"
    })
  } finally {
    await bundle.close()
  }
  return main
}
