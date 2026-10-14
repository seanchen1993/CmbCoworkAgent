import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

// Run after an ordinary production build. Exercises bin argument forwarding,
// the actual Electron CLI entry, utility-process registration and process exits.
const workspace = resolve(__dirname, "..")
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE

async function run(args: string[]) {
  return new Promise<{ code: number; output: string }>((done, reject) => {
    execFile(
      process.execPath,
      [join(workspace, "bin/cli.js"), "plugin", ...args],
      {
        cwd: workspace,
        env: environment,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(Error(`CLI launch/timeout failure: ${error.message}\n${stderr.slice(-2000)}`))
          return
        }
        done({ code: error?.code ?? 0, output: stdout })
      }
    )
  })
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "mods-compat-cli-"))
  try {
    await mkdir(join(root, ".claude-plugin"))
    await mkdir(join(root, "hooks"))
    await writeFile(
      join(root, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "compat-cli" })
    )
    await writeFile(join(root, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
    async function check(pattern: string, strict: boolean) {
      await writeFile(
        join(root, "hooks/register.ts"),
        `export function register(on){on(${JSON.stringify(pattern)},(_,event,next)=>next(event))}`
      )
      const result = await run(["check", root, ...(strict ? ["--strict-compatibility"] : [])])
      // Electron can emit environment notices before the dedicated JSON report.
      const start = result.output.indexOf('{\n  "valid"')
      assert.ok(start >= 0, `Missing check report: ${result.output.slice(-2000)}`)
      const report = JSON.parse(result.output.slice(start))
      assert.equal(report.authorized, false)
      assert.equal(report.compatibility.scope, "registration-events-only")
      return { ...result, report }
    }
    const legacy = await check("classic.FileChanged", false)
    assert.equal(legacy.code, 0)
    assert.equal(legacy.report.valid, true)
    assert.equal(legacy.report.packageValid, true)
    assert.equal(legacy.report.compatibility.status, "unsupported")
    assert.ok(
      legacy.report.diagnostics.some(
        (item: { code: string }) => item.code === "MODS_EVENT_SCHEMA_ONLY"
      )
    )
    assert.equal((await check("classic.FileChanged", true)).code, 1)
    assert.equal((await check("env.set", true)).code, 1)
    assert.equal((await check("session.send", true)).code, 0)
    assert.equal((await check("command.run", true)).code, 0)
    const observer = await check("*", true)
    assert.equal(observer.code, 0)
    assert.equal(observer.report.compatibility.status, "partial")
    assert.equal((await check("custom.unknown", false)).code, 1)
    await writeFile(
      join(root, "hooks/register.ts"),
      'export function register(on){on("command.run",$=>$.audio.speak("unsupported"))}'
    )
    const sdkStrict = await run(["inspect", root, "--strict-compatibility"])
    assert.equal(sdkStrict.code, 1)
    const sdkReport = JSON.parse(sdkStrict.output.slice(sdkStrict.output.indexOf('{\n  "valid"')))
    assert.equal(sdkReport.compatibility.strictCompatible, true)
    assert.equal(sdkReport.sdkCompatibility.strictCompatible, false)
    assert.equal(sdkReport.sdkCompatibility.runtimeVerified, false)
    assert.equal(sdkReport.sdkCompatibility.digest, sdkReport.digest)
    assert.ok(
      sdkReport.diagnostics.some((item: { code: string }) => item.code === "MODS_SDK_UNSUPPORTED")
    )
    assert.equal((await run(["check", root])).code, 0)
    assert.equal((await run(["check", root, "--bad-option"])).code, 2)
    console.log(
      "PASS: production CLI compatibility checks; bounded peer, rejected env write, real utility process"
    )
  } finally {
    if (
      resolve(root).startsWith(`${resolve(tmpdir())}\\`) ||
      resolve(root).startsWith(`${resolve(tmpdir())}/`)
    ) {
      if (basename(root).startsWith("mods-compat-cli-"))
        await rm(root, { recursive: true, force: true })
    }
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
