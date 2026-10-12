// Requires a current build. Uses the shipped Electron Node runtime and actual
// Host/owner/worker entries; verifies refusal of weak physical closure separately from
// unknown business effects and refuses empty or partial test selection.
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const directory = mkdtempSync(join(tmpdir(), "bot-owned-shell-native-report-"))
const report = join(directory, "results.json")
try {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/main/bots/host-process.test.ts",
      "-t",
      "kills an executing shell after Host SIGKILL and retains its uncertain effect without replay|retains escaped Mac daemon evidence and blocks recovery despite group closure",
      "--maxWorkers=1",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`
    ],
    {
      cwd: root,
      env: { ...process.env, CMB_BOT_PROCESS_TEST: "1", CMB_BOT_NODE: require("electron") },
      stdio: "inherit",
      windowsHide: true
    }
  )
  if (result.error) console.error(result.error)
  process.exitCode = result.status ?? 1
  if (result.status === 0) {
    const results = JSON.parse(readFileSync(report, "utf8"))
    if (
      results.numPassedTests !== (process.platform === "darwin" ? 5 : 3) ||
      results.numFailedTests !== 0
    ) {
      console.error(
        "Expected all inherited-lifetime and platform-specific escaped-daemon safety checks to pass."
      )
      process.exitCode = 1
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
