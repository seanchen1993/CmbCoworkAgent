// Bundle the actual production modules into isolated test executables. No test
// entry is added to the shipped app; the installed Electron Node runs each test.
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const directory = mkdtempSync(join(tmpdir(), "cmb-download-native-tests-"))
const require = createRequire(import.meta.url)
try {
  await build({
    absWorkingDir: root,
    entryPoints: {
      native: "tests/bot-artifact-download-native.spec.ts",
      ledger: "tests/bot-artifact-download-ledger-native.spec.ts",
      authenticated: "tests/bot-artifact-download-authenticated.spec.ts",
      crash: "tests/fixtures/bot-artifact-download-crash.ts",
      host: "tests/fixtures/bot-artifact-download-host.ts"
    },
    outdir: directory,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: "inline",
    logLevel: "warning"
  })
  const executable = process.env.CMB_BOT_NODE ?? require("electron")
  const result = spawnSync(
    executable,
    [
      "--test",
      "--test-concurrency=1",
      join(directory, "native.cjs"),
      join(directory, "ledger.cjs"),
      join(directory, "authenticated.cjs")
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        CMB_BOT_DOWNLOAD_CRASH_FIXTURE: join(directory, "crash.cjs"),
        CMB_BOT_DOWNLOAD_HOST_FIXTURE: join(directory, "host.cjs"),
        CMB_BOT_DOWNLOAD_PERFORMANCE: process.argv.includes("--performance") ? "1" : "0"
      },
      windowsHide: true,
      stdio: "inherit",
      timeout: 120_000
    }
  )
  if (result.error) console.error(result.error)
  process.exitCode = result.status ?? 1
} finally {
  rmSync(directory, { recursive: true, force: true })
}
