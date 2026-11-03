/** Inspect the real Windows package's process tree outside its main event loop. */
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import type { ElectronApplication } from "playwright"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

assert.equal(process.platform, "win32")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "Explicit packaged candidate required")
const root = resolve(__dirname, "..")
const fixture = projectCompositionEnvironment(root)
const candidate = projectCompositionCandidate(root)
const execute = promisify(execFile)
type ProcessRow = { id: number; parent: number; name: string; created: string }
const observations: unknown[] = []
const seen = new Map<number, string>()
let app: ElectronApplication | undefined
let mainPid = 0
let passed = false
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms))

async function inventory(): Promise<ProcessRow[]> {
  const { stdout } = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Select-Object @{n='id';e={$_.ProcessId}}," +
    "@{n='parent';e={$_.ParentProcessId}},@{n='name';e={$_.Name}}," +
    "@{n='created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"
  ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
  return JSON.parse(stdout.replace(/^\uFEFF/, ""))
}

async function snapshot(phase: string) {
  const rows = await inventory()
  const owned = new Set([mainPid])
  for (let changed = true; changed;) {
    changed = false
    for (const row of rows) if (owned.has(row.parent) && !owned.has(row.id)) {
      owned.add(row.id)
      changed = true
    }
  }
  const tree = rows.filter(row => owned.has(row.id))
  for (const row of tree) seen.set(row.id, row.created)
  const compilers = tree.filter(row => row.name.toLowerCase() === "esbuild.exe")
  observations.push({ phase, tree, compilerCount: compilers.length })
  console.log(JSON.stringify({ phase, compilerCount: compilers.length, processCount: tree.length }))
  return compilers.length
}

async function idle(phase: string) {
  // Production idle interval is 30 seconds. Keep the app running and do not kill any child.
  await pause(31_000)
  const deadline = performance.now() + 15_000
  while (await snapshot(phase)) {
    assert(performance.now() < deadline, "Idle compiler children must exit without closing the app")
    await pause(1000)
  }
}

async function main() {
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture,
      { unobtrusivePresentation: true })()
    mainPid = await app.evaluate(() => process.pid)
    const page = await app.firstWindow()
    await page.waitForFunction(() => !!window.api?.mods)
    await pause(1500)
    assert.equal(await snapshot("unused-startup"), 0, "Opening an empty app must not start esbuild")
    const selection = await page.evaluate(async workspace => {
      const thread = await window.api.threads.create({ title: "Compiler lifecycle", workspacePath: workspace })
      await window.api.workspace.set(thread.thread_id, workspace)
      await window.api.mods.configureGlobal(true)
      const config = await window.api.mods.status(thread.thread_id)
      await window.api.mods.configure(thread.thread_id, true, false, config.workspace)
      await window.api.mods.installExamples()
      const status = await window.api.mods.status(thread.thread_id)
      const selected = status.functionMods?.find(item => item.name === "function-commands")
      if (!selected?.digest) throw Error("BUNDLED_COMPILER_FIXTURE_MISSING")
      return { threadId: thread.thread_id, pluginId: selected.pluginId,
        digest: selected.digest, workspace: status.workspace }
    }, fixture.workspace)
    assert(await snapshot("after-source-inspection") > 0, "Real source inspection must exercise compilation")
    await idle("first-idle")
    const compatibility = await page.evaluate(input => window.api.mods.checkFunctionCompatibility(
      input.threadId, input.pluginId, input.digest, input.workspace
    ), selection)
    assert.equal(compatibility.digest, selection.digest)
    assert(await snapshot("reuse-after-idle") > 0, "Compilation must work again after idle shutdown")
    await idle("second-idle")
    await app.close()
    app = undefined
    await pause(1000)
    const remaining = (await inventory()).filter(row => seen.get(row.id) === row.created)
    observations.push({ phase: "after-exit", remaining })
    assert.deepEqual(remaining, [], "The application's observed process tree must exit")
    passed = true
  } finally {
    await app?.close()
    writeFileSync(join(fixture.isolated, "compiler-lifecycle.json"),
      JSON.stringify({ passed, candidate, observations }, null, 2))
    console.log(JSON.stringify({ passed, profile: fixture.isolated }))
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
