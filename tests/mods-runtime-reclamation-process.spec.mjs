/** Isolated Electron/utility acceptance. Requires the parent's completed production build. */
import assert from "node:assert/strict"
import { build } from "esbuild"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const host = join(root, "out/main/function-mod-host.js")
assert(existsSync(host), "Run only after the main task has completed its production build")
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")
const hostDigest = hash(host)
const output = join(
  root,
  "output/runtime-probe-reclamation-process",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
)
mkdirSync(output, { recursive: true })

// Bundle only this test main. The actual utility entry comes from the final application build.
await build({
  entryPoints: [join(root, "tests/support/mods-runtime-reclamation-process-entry.ts")],
  outfile: join(output, "acceptance-entry.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron", "quickjs-emscripten", "esbuild"]
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
for (const [key, directory] of Object.entries({
  HOME: "home",
  USERPROFILE: "home",
  APPDATA: "appdata",
  LOCALAPPDATA: "localappdata",
  CMB_COWORK_AGENT_HOME: "data",
  TEMP: "temp",
  TMP: "temp"
})) {
  env[key] = join(output, directory)
  mkdirSync(env[key], { recursive: true })
}
const child = spawn(require("electron"), [join(output, "acceptance-entry.cjs"), output, host], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"]
})
let log = ""
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (chunk) => {
    const text = chunk.toString()
    log += text
    process.stdout.write(text)
  })
writeFileSync(
  join(output, "run.json"),
  JSON.stringify(
    {
      host,
      hostDigest,
      fixtureDigest: hash(join(output, "acceptance-entry.cjs")),
      runnerNode: process.versions.node,
      runnerPid: process.pid,
      electronPid: child.pid,
      isolation:
        "No BrowserWindow, separate Electron profile, app data, SQLite and plugin fixtures",
      output
    },
    null,
    2
  )
)
const timer = setTimeout(() => {
  log += "\nOWNED_TEST_ELECTRON_TIMEOUT\n"
  child.kill()
}, 180_000)
try {
  const code = await new Promise((resolveCode, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolveCode(code ?? 1))
  })
  assert.equal(hash(host), hostDigest, "Production utility bundle changed during acceptance")
  assert.equal(code, 0, `Isolated Electron acceptance failed; see ${output}`)
  const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"))
  assert.equal(report.status, "passed")
  assert(report.peakLiveChildren <= 6)
  assert(report.children.every((child) => child.exitedAt !== undefined))
  console.log(`PASS real utility reclamation: ${report.checks.length} checks; ${output}`)
} finally {
  clearTimeout(timer)
  writeFileSync(join(output, "electron.log"), log)
}
