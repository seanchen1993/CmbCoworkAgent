import { createPackage } from "@electron/asar"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)
const root = mkdtempSync(join(tmpdir(), "cmb-thread-search-probe-"))
const bundle = join(root, "bundle")
const archive = join(root, "probe.asar")
const env = {
  ...process.env,
  CMB_THREAD_SEARCH_PROBE_BUNDLE: bundle,
  CMB_THREAD_SEARCH_PROBE_DB: join(root, "fixture.db")
}

function run(command, args, processEnv) {
  const result = spawnSync(command, args, { env: processEnv, stdio: "inherit", windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Probe subprocess exited with ${result.status}`)
}

try {
  const cli = join(
    dirname(require.resolve("electron-vite/package.json")),
    "bin",
    "electron-vite.js"
  )
  run(
    process.execPath,
    [cli, "build", "--config", "tests/support/thread-search-runtime.config.ts"],
    env
  )
  writeFileSync(
    join(bundle, "package.json"),
    JSON.stringify({ name: "cmb-thread-search-probe", main: "index.js" })
  )
  await createPackage(bundle, archive)
  delete env.ELECTRON_RUN_AS_NODE
  run(require("electron"), [archive], env)
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
