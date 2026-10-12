// Supplemental actual Windows acceptance. Existing five kernel checks remain
// untouched and must pass separately; this entry never counts skip as success.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Selection acceptance requires actual Windows x64, not a cross build")
for (const name of [
  "CMB_COWORK_AGENT_HOME",
  "CMB_BOT_NATIVE_WINDOWS_TEST_HOST_DIRECTORY",
  "CMB_BOT_NATIVE_SANDBOX_DIRECTORY",
  "CMB_BOT_NATIVE_SANDBOX_MANIFEST_SHA256",
  "CMB_BOT_NATIVE_WINDOWS_SELECTION_FIXTURE",
  "CMB_BOT_NATIVE_WINDOWS_SELECTION_FIXTURE_SHA256"
])
  if (!process.env[name]) throw new Error(`Explicit isolated native preparation required: ${name}`)
const temporary = realpathSync(process.env.RUNNER_TEMP || tmpdir())
const directory = mkdtempSync(join(temporary, "cmb-windows-selection-report-")),
  report = join(directory, "results.json"),
  summary = join(directory, "summary.json")
const result = spawnSync(
  process.execPath,
  [
    join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "src/main/bots/windows-native-text-selection.test.ts",
    "--maxWorkers=1",
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${report}`
  ],
  {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      CMB_BOT_NATIVE_WINDOWS_TEST: "1",
      CMB_BOT_NATIVE_WINDOWS_SELECTION_TEST: "1"
    }
  }
)
let counts = null
try {
  if (statSync(report).size <= 4 * 1024 * 1024) {
    const evidence = JSON.parse(readFileSync(report, "utf8"))
    const values = [evidence.numPassedTests, evidence.numFailedTests, evidence.numPendingTests]
    if (values.every((value) => Number.isSafeInteger(value) && value >= 0))
      counts = { passed: values[0], failed: values[1], pending: values[2] }
  }
} catch {
  // A missing/invalid actual report is unknown, never invented zero counts.
}
const success =
  !result.error &&
  result.status === 0 &&
  counts?.passed === 1 &&
  counts.failed === 0 &&
  counts.pending === 0
// This is the only uploadable report. Raw assertion errors, paths, model data,
// control databases, fixture proofs and the isolated home remain local.
writeFileSync(
  summary,
  JSON.stringify(
    {
      version: 1,
      target: "win32-x64",
      success,
      exitCode: result.status,
      counts,
      fixtureSha256: /^[a-f0-9]{64}$/.test(
        process.env.CMB_BOT_NATIVE_WINDOWS_SELECTION_FIXTURE_SHA256
      )
        ? process.env.CMB_BOT_NATIVE_WINDOWS_SELECTION_FIXTURE_SHA256
        : null
    },
    null,
    2
  ) + "\n",
  { flag: "wx", mode: 0o600 }
)
console.info(`Sanitized Windows-only selection report retained at ${summary}`)
if (result.error) throw result.error
process.exitCode = success ? 0 : result.status || 1
if (!success) console.error("The one actual production UIA/WGC selection case must run and pass")
