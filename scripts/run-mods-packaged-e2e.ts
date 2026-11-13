import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createReadStream } from "node:fs"
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertFreshPackageOutput } from "./mods-package-stage"

interface PackagedValidationOptions {
  root: string
  packageDirectory: string
  outputDirectory: string
  timeoutMs?: number
}

async function fingerprint(path: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined)
  if (!info?.isFile()) throw Error("MODS_PACKAGED_FILE_MISSING")
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function completedChecks(output: string): Promise<number> {
  try {
    const file = join(output, "result.json")
    const info = await lstat(file)
    if (!info.isFile() || info.size > 1024 * 1024) throw Error("Invalid receipt size")
    const value = JSON.parse(await readFile(file, "utf8")) as { checks?: unknown }
    if (
      !Array.isArray(value.checks) ||
      value.checks.length < 9 ||
      !value.checks.every((item) => typeof item === "string") ||
      !value.checks.includes(
        "production ASAR starts without a test entry and contains the isolated runtime"
      ) ||
      value.checks.at(-1) !==
        "packaged preload and React settings retain project grants after reload"
    )
      throw Error("Incomplete packaged receipt")
    return value.checks.length
  } catch {
    throw Error("MODS_PACKAGED_RECEIPT_INVALID")
  }
}

async function completedDisplayCancellation(file: string, asar: string, sha256: string) {
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.size > 1024 * 1024) throw Error("Invalid cancellation receipt size")
    const value = JSON.parse(await readFile(file, "utf8"))
    if (
      value.passed !== true ||
      value.candidate?.execution !== "packaged-asar" ||
      resolve(value.candidate.path) !== resolve(asar) ||
      value.candidate.sha256 !== sha256 ||
      typeof value.switchMs !== "number" ||
      !Number.isFinite(value.switchMs) ||
      value.switchMs < 0 ||
      value.switchMs >= 1500 ||
      value.cancelledReads !== 4 ||
      value.hostClockCalls !== 4 ||
      value.observedCancelledNativeTimers !== 4 ||
      !Number.isInteger(value.physicalPeak) ||
      value.physicalPeak < 1 ||
      value.physicalPeak > 4 ||
      value.ui?.slow !== false
    )
      throw Error("Incomplete cancellation receipt")
    return {
      switchMs: value.switchMs,
      physicalPeak: value.physicalPeak,
      cancelledReads: value.cancelledReads,
      hostClockCalls: value.hostClockCalls,
      observedCancelledNativeTimers: value.observedCancelledNativeTimers
    }
  } catch {
    throw Error("MODS_PACKAGED_DISPLAY_CANCEL_RECEIPT_INVALID")
  }
}

/** Launch an existing Windows production package. Never build, install, rebuild or delete it. */
export async function runPackagedModsValidation(
  options: PackagedValidationOptions
): Promise<number> {
  const root = resolve(options.root)
  const packageDirectory = resolve(root, options.packageDirectory)
  const output = await assertFreshPackageOutput(root, options.outputDirectory)
  const timeout = options.timeoutMs ?? 960000
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 960000)
    throw Error("MODS_PACKAGED_TIMEOUT_INVALID")
  await mkdir(output, { recursive: true })
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    packageDirectory,
    passed: false,
    scope:
      "Existing Windows production ASAR/Electron regression; not an installer installation or external business acceptance"
  }
  try {
    const started = performance.now()
    const executable = join(packageDirectory, "CMBDevClaw.exe")
    const asar = join(packageDirectory, "resources/app.asar")
    const fingerprints = {
      executable: await fingerprint(executable),
      asar: await fingerprint(asar)
    }
    report.fingerprints = fingerprints
    const env = { ...process.env }
    for (const key of Object.keys(env))
      if (
        /^(?:CMB_MODS_(?:E2E(?:_|$)|PACKAGED_DIR$|SOAK_SMOKE$)|COMPOSITION_E2E_|CMB_CHAT_DISPLAY_CANCEL_)/i.test(
          key
        )
      )
        delete env[key]
    Object.assign(env, {
      CMB_MODS_PACKAGED_DIR: packageDirectory,
      CMB_MODS_E2E_ARTIFACTS: output,
      CMB_MODS_E2E: "0"
    })
    const child = spawnSync(
      process.execPath,
      [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "tests/mods-e2e.spec.ts")],
      { cwd: root, env, stdio: "inherit", windowsHide: true, timeout }
    )
    report.childExitCode = child.status
    report.childSignal = child.signal
    report.childError = (child.error as NodeJS.ErrnoException | undefined)?.code
    if (child.error || child.status !== 0)
      return child.status && child.status > 0 ? child.status : 1
    report.checks = await completedChecks(output)
    if (
      (await fingerprint(executable)) !== fingerprints.executable ||
      (await fingerprint(asar)) !== fingerprints.asar
    )
      throw Error("MODS_PACKAGED_CHANGED")
    // Sequential and pinned to this exact downloaded package, never a source candidate.
    const cancellationReceipt = join(output, "display-cancel-result.json")
    const remaining = timeout - (performance.now() - started)
    if (remaining <= 0) throw Error("MODS_PACKAGED_TIMEOUT_EXHAUSTED")
    const cancellation = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/tsx/dist/cli.mjs"),
        join(root, "tests/chat-display-cancel-e2e.spec.ts")
      ],
      {
        cwd: root,
        env: {
          ...env,
          COMPOSITION_E2E_PACKAGED_DIR: packageDirectory,
          COMPOSITION_E2E_ARTIFACT_ROOT: join(output, "display-cancel-profiles"),
          CMB_CHAT_DISPLAY_CANCEL_RECEIPT: cancellationReceipt
        },
        stdio: "inherit",
        windowsHide: true,
        timeout: Math.max(1, Math.floor(Math.min(120000, remaining)))
      }
    )
    report.displayCancelChildExitCode = cancellation.status
    report.displayCancelChildSignal = cancellation.signal
    report.displayCancelChildError = (cancellation.error as NodeJS.ErrnoException | undefined)?.code
    if (cancellation.error || cancellation.status !== 0)
      return cancellation.status && cancellation.status > 0 ? cancellation.status : 1
    report.displayCancellation = await completedDisplayCancellation(
      cancellationReceipt,
      asar,
      fingerprints.asar
    )
    if (
      (await fingerprint(executable)) !== fingerprints.executable ||
      (await fingerprint(asar)) !== fingerprints.asar
    )
      throw Error("MODS_PACKAGED_CHANGED")
    report.passed = true
    return 0
  } catch (error) {
    report.failure = error instanceof Error ? error.message : "MODS_PACKAGED_VALIDATION_FAILED"
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    await writeFile(
      join(output, "packaged-validation.json"),
      JSON.stringify(report, null, 2) + "\n"
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const args = process.argv.slice(2)
  if (args.length < 1 || args.length > 2) {
    console.error(
      "Usage: node --import tsx scripts/run-mods-packaged-e2e.ts <package-directory> [new-evidence-directory]"
    )
    process.exitCode = 1
  } else {
    void runPackagedModsValidation({
      root,
      packageDirectory: args[0],
      outputDirectory: args[1] ?? "output/mods-v2-validation/actions-packaged"
    }).then(
      (code) => {
        process.exitCode = code
      },
      (error) => {
        console.error(error)
        process.exitCode = 1
      }
    )
  }
}
