// Like the compiled Host gate, launch workers with the shipped Electron Node
// runtime. The macOS OS-policy tests execute real denied/allowed operations.
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const directory = mkdtempSync(join(tmpdir(), "bot-native-shell-report-"))
const report = join(directory, "results.json")
try {
  const windows = process.platform === "win32"
  const result = spawnSync(
    windows ? require("electron") : process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/main/bots/shell-process.test.ts",
      "src/main/bots/mac-shell-sandbox.test.ts",
      ...(windows ? ["src/main/bots/windows-native-kernel.test.ts"] : []),
      "--maxWorkers=1",
      "--minWorkers=1",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CMB_BOT_SHELL_TEST_COMPILED: "1",
        CMB_BOT_NODE: require("electron"),
        ...(windows ? { ELECTRON_RUN_AS_NODE: "1" } : {})
      },
      stdio: "inherit",
      windowsHide: true
    }
  )
  if (result.error) console.error(result.error)
  process.exitCode = result.status ?? 1
  if (result.status === 0) {
    const results = JSON.parse(readFileSync(report, "utf8"))
    // Preserve all 17 existing Windows Shell cases and require the five actual
    // kernel checks, whose skipped status must never count as acceptance.
    const expected = process.platform === "darwin" ? 25 : windows ? 22 : 18
    const kernel = results.testResults?.find((value) =>
      value.name.endsWith("windows-native-kernel.test.ts")
    )
    const kernelPassed =
      !windows ||
      (kernel?.assertionResults.length === 5 &&
        kernel.assertionResults.every((value) => value.status === "passed"))
    if (results.numPassedTests !== expected || results.numFailedTests !== 0 || !kernelPassed) {
      console.error(`Expected all ${expected} applicable native Shell checks to pass.`)
      process.exitCode = 1
    }
  }
} finally {
  if (!process.exitCode) rmSync(directory, { recursive: true, force: true })
  else console.error("Failed Shell gate report retained", { directory })
}
