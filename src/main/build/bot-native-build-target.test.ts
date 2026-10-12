import { expect, test } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
async function decision(input: {
  platform?: "linux" | "win32"
  arch?: "x64" | "arm64"
  rustTarget?: unknown
  environment?: Record<string, string>
  cli?: string[]
}): Promise<{ error: string; files: string[] }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-native-target-")))
  const builder = await realpath(resolve("scripts/bot-native-sandbox/build-native-package.mjs"))
  const environment = { ...process.env }
  for (const key of [
    "CODEX_SKIP_BWRAP_BUILD",
    "CODEX_BWRAP_SOURCE_DIR",
    "CARGO_TARGET_DIR",
    "CARGO_BUILD_TARGET"
  ])
    delete environment[key]
  Object.assign(environment, input.environment)
  // A child Node only selects the relevant build-input branch. No native
  // compiler, platform syscall, or fully built native package is involved.
  const invocation = input.cli
    ? `process.argv = [process.execPath, ${JSON.stringify(builder)},
       ${JSON.stringify(join(root, "missing-source"))},
       ${JSON.stringify(join(root, "new-output"))}, ...${JSON.stringify(input.cli)}];
       await import(${JSON.stringify(pathToFileURL(builder).href)});`
    : `const { buildNativeSandboxPackage } = await import(${JSON.stringify(pathToFileURL(builder).href)});
       await buildNativeSandboxPackage({
         sourceCheckout: ${JSON.stringify(join(root, "missing-source"))},
         outputDirectory: ${JSON.stringify(join(root, "new-output"))},
         rustTarget: ${JSON.stringify(input.rustTarget) ?? "undefined"}
       });`
  const code = `
Object.defineProperty(process, "platform", {value:${JSON.stringify(input.platform ?? "linux")}});
Object.defineProperty(process, "arch", {value:${JSON.stringify(input.arch ?? "x64")}});
try {
 ${invocation}
 process.stdout.write(JSON.stringify({error:"unexpected build admission"}));
} catch(error) {
 process.stdout.write(JSON.stringify({error:error.message}));
}
`
  try {
    const result = await execute(process.execPath, ["--input-type=module", "-e", code], {
      env: environment,
      timeout: 10_000,
      maxBuffer: 4096
    })
    return { ...JSON.parse(result.stdout), files: await readdir(root) }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test.each([
  ["linux", "x64", "x86_64-unknown-linux-gnu"],
  ["linux", "x64", "x86_64-unknown-linux-musl"],
  ["linux", "arm64", "aarch64-unknown-linux-gnu"],
  ["linux", "arm64", "aarch64-unknown-linux-musl"],
  ["win32", "x64", "x86_64-pc-windows-msvc"],
  ["win32", "arm64", "aarch64-pc-windows-msvc"]
] as const)(
  "%s/%s accepts only its supported explicit target %s",
  async (platform, arch, rustTarget) => {
    const result = await decision({ platform, arch, rustTarget })
    expect(result.error).toContain("ENOENT")
    expect(result.files).toEqual([])
  }
)

test.each([
  ["linux", "x64", "aarch64-unknown-linux-gnu"],
  ["linux", "arm64", "x86_64-unknown-linux-musl"],
  ["linux", "x64", "x86_64-pc-windows-msvc"],
  ["win32", "x64", "x86_64-pc-windows-gnu"],
  ["win32", "arm64", "x86_64-pc-windows-msvc"],
  ["linux", "x64", ""],
  ["linux", "x64", null],
  ["linux", "x64", 1],
  ["linux", "x64", "x86_64-unknown-linux-gnu;touch /should-not-execute"]
] as const)(
  "%s/%s rejects mismatching or invalid target %j before output mutation",
  async (platform, arch, rustTarget) => {
    const result = await decision({ platform, arch, rustTarget })
    expect(result.error).toBe("Rust target must match the native build machine")
    expect(result.files).toEqual([])
  }
)

test.each([
  ["CARGO_TARGET_DIR", "/ambient-output"],
  ["CARGO_TARGET_DIR", ""],
  ["CARGO_BUILD_TARGET", "x86_64-unknown-linux-gnu"],
  ["CARGO_BUILD_TARGET", ""]
])("ambient %s presence (%j) is rejected before output mutation", async (key, value) => {
  const result = await decision({ environment: { [key]: value } })
  expect(result.error).toBe(`Native build requires an explicit target; ${key} is not allowed`)
  expect(result.files).toEqual([])
})

test.each(["linux", "win32"] as const)(
  "%s default retains the existing host target selection",
  async (platform) => {
    const result = await decision({ platform })
    expect(result.error).toContain("ENOENT")
    expect(result.files).toEqual([])
  }
)

test("CLI accepts an explicit matching --rust-target option", async () => {
  const result = await decision({ cli: ["--rust-target=x86_64-unknown-linux-musl"] })
  expect(result.error).toContain("ENOENT")
  expect(result.files).toEqual([])
})

test.each([
  ["--rust-target="],
  ["--rust-target"],
  ["--rust-target=x86_64-unknown-linux-gnu", "--rust-target=x86_64-unknown-linux-musl"],
  ["--rust-target-extra=x86_64-unknown-linux-gnu"]
])("CLI rejects malformed/duplicate explicit target options %j", async (...cli) => {
  const result = await decision({ cli })
  expect(result.error).toBe("Expected one optional --rust-target=<matching-target>")
  expect(result.files).toEqual([])
})
