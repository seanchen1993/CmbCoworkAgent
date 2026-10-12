// Explicit matching Windows acceptance only. Build application + fixed native
// package first, initialize in Bot settings, then run this using Node >=22.16.
// No automatic elevation, package download, WSL, mock kernel or skip-as-pass.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
if (process.platform !== "win32")
  throw new Error("This acceptance requires an actual Windows kernel")
if (!process.env.CMB_COWORK_AGENT_HOME || !process.env.CMB_BOT_NATIVE_WINDOWS_TEST_HOST_DIRECTORY)
  throw new Error(
    "Configure an isolated application home and initialize it explicitly in Bot settings before acceptance"
  )
if (
  !process.env.CMB_BOT_NATIVE_SANDBOX_DIRECTORY ||
  !process.env.CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256
)
  throw new Error("Set the trusted native package and manifest SHA before acceptance")
const directory = mkdtempSync(join(tmpdir(), "cmb-windows-native-report-")),
  report = join(directory, "results.json")
try {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/main/bots/windows-native-kernel.test.ts",
      "--maxWorkers=1",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`
    ],
    {
      cwd: root,
      env: { ...process.env, CMB_BOT_NATIVE_WINDOWS_TEST: "1" },
      stdio: "inherit",
      windowsHide: true
    }
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
  if (result.status === 0) {
    const evidence = JSON.parse(readFileSync(report, "utf8"))
    if (evidence.numPassedTests !== 5 || evidence.numFailedTests !== 0) {
      console.error("All five actual compiled Windows checks must run and pass.")
      process.exitCode = 1
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
