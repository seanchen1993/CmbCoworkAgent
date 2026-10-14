/** Real Electron, disposable analysis Worker and Function utility process; no mock backend. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { build } from "esbuild"

async function main() {
  const root = resolve(__dirname, "..")
  const parent = join(root, "output", "mods-authoring-preview-runtime")
  await mkdir(parent, { recursive: true })
  const owned = await mkdtemp(join(parent, "run-"))
  const require = createRequire(__filename)
  try {
    const entries = [
      ["tests/fixtures/mods-authoring-preview-electron.ts", "preview.cjs"],
      ["src/main/mods/v2/host-entry.ts", "function-mod-host.js"],
      ["src/main/mods/devtools/authoring-preflight-entry.ts", "mods-authoring-preflight.js"]
    ]
    for (const [entry, output] of entries)
      await build({
        bundle: true,
        platform: "node",
        format: "cjs",
        packages: "external",
        logLevel: "silent",
        entryPoints: [join(root, entry!)],
        outfile: join(owned, output!)
      })
    const env = { ...process.env, TEMP: owned, TMP: owned, TMPDIR: owned }
    delete env.ELECTRON_RUN_AS_NODE
    const { stdout } = await promisify(execFile)(
      require("electron"),
      [join(owned, "preview.cjs")],
      { cwd: root, env, windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 }
    )
    for (const kind of ["command", "tool", "rule", "panel", "flow-action"])
      assert(stdout.includes(`PASS actual worker and utility preview: ${kind}`))
    console.log(
      "PASS authoring preview: five real handlers, analysis Worker and isolated utility process"
    )
  } finally {
    assert.equal(dirname(resolve(owned)), parent)
    assert(basename(owned).startsWith("run-"))
    await rm(owned, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
