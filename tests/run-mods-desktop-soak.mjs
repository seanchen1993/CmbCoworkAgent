import { execFileSync, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
if (
  new Set(args).size !== args.length ||
  args.some((arg) => !["--smoke", "--performance"].includes(arg))
)
  throw Error("Usage: node tests/run-mods-desktop-soak.mjs [--smoke] [--performance]")
const smoke = args.includes("--smoke")
const performanceOnly = args.includes("--performance")
const output = join(
  root,
  "output/mods-v2-validation",
  `desktop-${performanceOnly ? "performance" : "soak"}-${new Date().toISOString().replace(/[:.]/g, "-")}-${smoke ? "smoke" : "full"}-${randomUUID().slice(0, 8)}`
)
mkdirSync(output, { recursive: true })
const build = spawnSync(
  process.execPath,
  [join(root, "node_modules/electron-vite/bin/electron-vite.js"), "build"],
  {
    cwd: root,
    env: { ...process.env, CMB_MODS_E2E: "0" },
    stdio: "inherit",
    windowsHide: true
  }
)
if (build.status !== 0 || existsSync(join(root, "out/main/mods-e2e.js")))
  throw Error("Ordinary application build failed or test bridge leaked into build")
const snapshot = join(output, "application")
mkdirSync(snapshot)
cpSync(join(root, "out"), join(snapshot, "out"), { recursive: true })
// Host adapters also resolve platform helpers relative to app.getAppPath()/resources.
cpSync(join(root, "resources"), join(snapshot, "resources"), { recursive: true })
// A package root preserves production app.getAppPath() semantics in the frozen copy.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
writeFileSync(
  join(snapshot, "package.json"),
  JSON.stringify({ name: pkg.name, version: pkg.version, main: "out/main/index.js" })
)
const hashes = {}
function hashTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink())
      throw Error(`Unexpected mutable link in application snapshot: ${path}`)
    if (entry.isDirectory()) hashTree(path)
    else
      hashes[relative(snapshot, path)] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex")
  }
}
hashTree(snapshot)
const driverHashes = Object.fromEntries(
  [
    "tests/run-mods-desktop-soak.mjs",
    "tests/mods-e2e.spec.ts",
    "tests/support/mods-desktop-soak-e2e.ts",
    "tests/support/mods-desktop-soak-options.ts",
    "tests/support/mods-desktop-latency.ts",
    "tests/support/mods-v2-performance.ts",
    "tests/support/mods-desktop-performance.ts",
    "tests/support/mods-desktop-performance-e2e.ts"
  ].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(join(root, file)))
      .digest("hex")
  ])
)
writeFileSync(
  join(output, "run.json"),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      runnerPid: process.pid,
      smoke,
      performanceOnly,
      output,
      snapshot,
      hashes,
      driverHashes,
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true
      }).trim(),
      status: execFileSync("git", ["status", "--short"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true
      }),
      dependencies:
        "Existing repository node_modules is read only; its installation must remain unchanged during this run.",
      stopFile: join(output, "STOP")
    },
    null,
    2
  )
)
console.log(JSON.stringify({ output, snapshot, smoke }))
const runEnv = {
  ...process.env,
  CMB_MODS_E2E_FOCUS: performanceOnly ? "desktop-performance" : "desktop-soak",
  CMB_MODS_E2E_APP_DIR: snapshot,
  CMB_MODS_E2E_ARTIFACTS: output
}
delete runEnv.CMB_MODS_SOAK_SMOKE
if (smoke) runEnv.CMB_MODS_SOAK_SMOKE = "1"
const run = spawnSync(
  process.execPath,
  [join(root, "node_modules/tsx/dist/cli.mjs"), "tests/mods-e2e.spec.ts"],
  {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: runEnv
  }
)
writeFileSync(
  join(output, "exit.json"),
  JSON.stringify({ code: run.status, error: run.error?.message, at: new Date().toISOString() })
)
process.exitCode = run.status ?? 1
