// Use the same portable Node launcher pattern as run-mods-e2e.mjs; the Host
// children use the installed Electron runtime, matching the shipped app.
// Requires a current build; npm run test:bot:host performs both steps.
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cases = [
  "retains the model binding across compiled Host SIGKILL",
  "resumes a persisted graph after SIGKILL and review without repeating a committed tool",
  "uses an owned bounded endpoint for long multibyte TMPDIR and reclaims its exact socket after compiled Host SIGKILL",
  "keeps the compiled Host alive after desktop connections close",
  "arbitrates concurrent compiled Hosts",
  "uses the configured proxy for a compiled Host model stream",
  "preserves output allowance and unknown model usage across compiled Host restart",
  "recovers interrupted download notices once through compiled Host startup",
  "repairs a genuine legacy all-absent generation through compiled Host startup and SIGKILL restart"
]
const directory = mkdtempSync(join(tmpdir(), "bot-native-host-report-"))
const report = join(directory, "results.json")
try {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/main/bots/host-process.test.ts",
      "-t",
      cases.join("|"),
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
    const expected = process.platform === "win32" ? 9 : 10
    if (results.numPassedTests !== expected || results.numFailedTests !== 0) {
      console.error(
        `Expected all ${expected} applicable native Host checks to run and pass; refusing an empty or partial selection.`
      )
      process.exitCode = 1
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
