import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFile, lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  prepareBotNativeDistribution,
  verifyPackagedBotNativeDistribution
} from "../src/main/build/bot-native-distribution"
import { readPrivateJson } from "../src/main/bots/backup-io"
import { createWindowsNativeSetupService } from "../src/main/bots/windows-native-setup-service"
import { readBotOwnedShellArtifact } from "../src/main/bots/host-shell-factory"
import { inspectOwnedShellReceiptEntries } from "../src/main/bots/owned-shell-receipts"

/** A finite, explicit CI setup action. Never loaded by the app/model, never
 * requests UAC, and never writes the actual user's application home. */
export async function prepareWindowsNativeCi(
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  assert.equal(process.platform, "win32", "Windows native CI preparation requires real Windows")
  assert.equal(process.arch, "x64", "Windows native CI currently builds the matching x64 target")
  assert.equal(
    environment.GITHUB_ACTIONS,
    "true",
    "Use the explicitly authorized isolated CI runner"
  )
  assert.equal(environment.RUNNER_OS, "Windows")
  assert.equal(environment.CMB_BUILD_BOT_NATIVE_TARGET, "win32-x64")
  assert.ok(
    environment.RUNNER_TEMP && isAbsolute(environment.RUNNER_TEMP),
    "CI temporary scope missing"
  )
  assert.ok(
    environment.GITHUB_ENV && isAbsolute(environment.GITHUB_ENV),
    "CI environment output missing"
  )
  assert.ok(
    environment.SystemRoot && isAbsolute(environment.SystemRoot),
    "Windows system root missing"
  )
  const temporary = await realpath(environment.RUNNER_TEMP)
  assert.ok((await lstat(temporary)).isDirectory())
  // Fail before provisioning if the hosted/self-hosted runner does not have an
  // actual elevated administrator token. No interactive runas or UAC changes.
  execFileSync(
    join(environment.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }"
    ],
    { timeout: 10000, stdio: "ignore", windowsHide: true }
  )
  const prepared = await prepareBotNativeDistribution(environment)
  assert.ok(prepared && prepared.pin.platform === "win32" && prepared.pin.arch === "x64")
  const resources = await realpath(resolve("out/resources"))
  await verifyPackagedBotNativeDistribution(resources, prepared.pin, {
    platform: "win32",
    arch: "x64"
  })
  const packageDirectory = await realpath(join(resources, "bot-native-sandbox/win32-x64"))
  const helper = await readBotOwnedShellArtifact(
    await realpath(resolve("out/main/bot-shell-owner.js"))
  )
  const worker = await readBotOwnedShellArtifact(await realpath(resolve("out/main/bot-shell.js")))
  const seal = (
    await readPrivateJson(await realpath(resolve("out/main")), "bot-native-build.json", 256 * 1024)
  ).value as {
    nativeDistribution?: unknown
    members?: Array<{ name: string; sha256: string }>
  }
  assert.deepEqual(
    seal.nativeDistribution,
    prepared.pin,
    "Compiled build differs from independent native pin"
  )
  for (const [name, artifact] of [
    ["bot-shell-owner.js", helper],
    ["bot-shell.js", worker]
  ] as const) {
    const matches = seal.members?.filter((member) => member.name === name)
    assert.equal(matches?.length, 1, "Actual compiled command entry needs exactly one seal member")
    assert.equal(
      matches![0].sha256,
      artifact.sha256,
      "Actual compiled command entry differs from build seal"
    )
  }
  await prepared.package.assertCurrent()
  const home = await realpath(await mkdtemp(join(temporary, "cmb-windows-native-ci-")))
  const directory = join(home, "bot-host")
  await mkdir(directory, { mode: 0o700 })
  const service = createWindowsNativeSetupService({
    directory: async () => directory,
    configuration: () => ({ packageDirectory, manifestSha256: prepared.pin.manifestSha256 }),
    helperEntry: helper.entry
  })
  const report = join(temporary, "cmb-windows-native-acceptance.json")
  try {
    const before = await service.getStatus()
    assert.equal(before.state, "setup_available")
    assert.ok(before.scope)
    const result = await service.initialize({ nonce: randomUUID(), scope: before.scope })
    const remaining = await inspectOwnedShellReceiptEntries(join(directory, "shell-resources"))
    // Publish a small non-secret result only, never sandbox account passwords,
    // control databases, native-codex-home contents or full environment.
    await writeFile(
      report,
      JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          directory,
          manifestSha256: prepared.pin.manifestSha256,
          initialization: {
            success: result.success,
            definitive: result.definitive,
            state: result.status.state
          },
          remainingResources: remaining.length,
          kernelAcceptance: "not-tested"
        },
        null,
        2
      ) + "\n",
      { flag: "wx", mode: 0o600 }
    )
    assert.ok(
      result.success && result.definitive && result.status.state === "initialized",
      "Native setup did not complete definitively; isolated evidence retained"
    )
    assert.equal(remaining.length, 0, "Native setup closure unproven; isolated evidence retained")
    assert.equal((await service.getStatus()).state, "initialized")
    const values = {
      CMB_COWORK_AGENT_HOME: home,
      CMB_BOT_NATIVE_WINDOWS_TEST_HOST_DIRECTORY: directory,
      CMB_BOT_NATIVE_SANDBOX_DIRECTORY: packageDirectory,
      CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256: prepared.pin.manifestSha256,
      CMB_BOT_NATIVE_WINDOWS_TEST: "1"
    }
    for (const [name, value] of Object.entries(values)) {
      assert.ok(value && !/[\r\n\0]/.test(value), "Invalid CI native fixture value")
      await appendFile(environment.GITHUB_ENV!, `${name}=${value}\n`, "utf8")
    }
  } catch (error) {
    // Do not retry setup or delete its home after an ambiguous platform result.
    console.error("Windows native CI preparation failed; isolated scope retained", { directory })
    throw error
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await prepareWindowsNativeCi()
