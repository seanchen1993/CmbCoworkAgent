// A current build is required. Exercise the actual document utility entry
// with the shipped Electron Node runtime, including cancellation and disposal.
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const directory = mkdtempSync(join(tmpdir(), "bot-link-preview-native-report-"))
const report = join(directory, "results.json")
try {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/main/bots/link-preview-image-and-ipc.test.ts",
      "-t",
      "actual existing utility transport|utility cancellation of an inflight request",
      "--maxWorkers=1",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CMB_BOT_NODE: require("electron"),
        CMB_BOT_DOCUMENT_NATIVE_ENTRY: join(root, "out/main/bot-document.js")
      },
      stdio: "inherit",
      windowsHide: true
    }
  )
  if (result.error) console.error(result.error)
  process.exitCode = result.status ?? 1
  if (result.status === 0) {
    const results = JSON.parse(readFileSync(report, "utf8"))
    if (results.numPassedTests !== 2 || results.numFailedTests !== 0) {
      console.error("Expected both native thumbnail and cancellation checks to run and pass.")
      process.exitCode = 1
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
