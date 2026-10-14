import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Run after the ordinary production build: real bin argument forwarding and Electron CLI.
const workspace = resolve(__dirname, "..")
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
function run(args: string[]) {
  return new Promise<{ code: number; output: string; error: string }>((done, reject) => {
    execFile(
      process.execPath,
      [join(workspace, "bin/cli.js"), ...args],
      {
        cwd: workspace,
        env: environment,
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 2 * 1024 * 1024
      },
      (error, output, stderr) => {
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(error)
          return
        }
        done({ code: error?.code ?? 0, output, error: stderr })
      }
    )
  })
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "project-harness-cli-"))
  try {
    const version = await run(["--version"])
    assert.equal(version.code, 0, version.error)
    assert.match(version.output, /^openwork v/)
    const source = join(root, "source")
    const initialized = await run([
      "plugin",
      "init",
      source,
      "--id",
      "versioned-harness",
      "--template",
      "harness-lite",
      "--version",
      "0.2.0"
    ])
    assert.equal(initialized.code, 0, initialized.output + initialized.error)
    const pluginPath = join(source, "plugin.json")
    const plugin = JSON.parse(await readFile(pluginPath, "utf8"))
    assert.equal(plugin.version, "0.2.0")
    plugin.version = "0.3.0"
    await writeFile(pluginPath, JSON.stringify(plugin))
    const compiled = join(root, "compiled")
    const result = await run(["plugin", "compile", source, "--out", compiled])
    assert.equal(result.code, 0, result.output + result.error)
    assert.equal(
      JSON.parse(await readFile(join(compiled, "devclaw.project-runtime.json"), "utf8")).plugin
        .version,
      "0.3.0"
    )
    const doctor = await run(["plugin", "doctor", compiled])
    assert.equal(doctor.code, 0, doctor.output + doctor.error)
    assert.equal(
      JSON.parse(await readFile(join(source, "devclaw.project-runtime.json"), "utf8")).plugin
        .version,
      "0.2.0"
    )
    console.log("project-harness CLI version and recompile: passed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
