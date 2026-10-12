// Run after npm run build. Maintenance and its native SQLite Worker execute
// the shipped bundles under Electron's installed Node runtime, not tsx source.
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { build } from "esbuild"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
const require = createRequire(import.meta.url),
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  directory = mkdtempSync(join(tmpdir(), "cmb-computer-native-report-")),
  report = join(directory, "results.json")
try {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/main/bots/computer-checkpoint-compiled.test.ts",
      "--maxWorkers=1",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CMB_BOT_COMPUTER_PROCESS_TEST: "1",
        CMB_BOT_NODE: require("electron")
      },
      stdio: "inherit",
      windowsHide: true
    }
  )
  if (result.error) console.error(result.error)
  process.exitCode = result.status ?? 1
  if (result.status === 0) {
    const results = JSON.parse(readFileSync(report, "utf8"))
    if (results.numPassedTests !== 1 || results.numFailedTests !== 0) {
      console.error(
        "Expected the compiled computer recovery check to run and pass; refusing an empty selection."
      )
      process.exitCode = 1
    }
  }
  if (!process.exitCode) {
    await build({
      entryPoints: [join(root, "tests/computer-maintenance-continuity.native.ts")],
      outfile: join(directory, "computer-maintenance-continuity.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      logLevel: "warning"
    })
    const continuity = spawnSync(
      require("electron"),
      [join(directory, "computer-maintenance-continuity.cjs")],
      {
        cwd: root,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          CMB_BOT_COMPUTER_NATIVE_ENTRY: join(root, "out/main/bot-computer-checkpoint-native.js")
        },
        stdio: "inherit",
        windowsHide: true,
        timeout: 90_000
      }
    )
    if (continuity.error) console.error(continuity.error)
    process.exitCode = continuity.status ?? 1
  }
} finally {
  rmSync(directory, { force: true, recursive: true })
}
