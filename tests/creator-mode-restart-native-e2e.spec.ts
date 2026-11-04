/** Actual Electron restart with a private persistent profile, no model or trial execution. */
import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import { writeFileSync } from "node:fs"
import type { ElectronApplication, Page } from "playwright"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
const fixture = projectCompositionEnvironment(root)
const candidate = projectCompositionCandidate(root)
const launch = createHeadlessProjectCompositionLaunch(root, fixture, {
  unobtrusivePresentation: true
})
let app: ElectronApplication | undefined
const observations: unknown[] = []

async function open(): Promise<Page> {
  app = await launch()
  const page = await app.firstWindow({ timeout: 60000 })
  await page.waitForFunction(() => !!window.api?.mods?.development)
  return page
}
async function close() {
  await app?.close()
  app = undefined
}
async function main() {
  let passed = false
  try {
    let page = await open()
    const threads = await page.evaluate(async (workspace) => {
      await window.api.mods.configureGlobal(true)
      const targets: Record<string, string> = {}
      for (const name of ["creator", "normal", "disabled", "untouched"]) {
        const thread = await window.api.threads.create({
          title: `Mode restart ${name}`,
          workspacePath: workspace
        })
        targets[name] = thread.thread_id
        await window.api.workspace.set(thread.thread_id, workspace)
        const scope = await window.api.mods.status(thread.thread_id)
        await window.api.mods.configure(thread.thread_id, true, true, scope.workspace!)
        const input = { threadId: thread.thread_id, expectedWorkspace: scope.workspace! }
        if (name !== "untouched")
          await window.api.mods.development.setMode({ ...input, mode: "creator" })
        if (name === "normal")
          await window.api.mods.development.setMode({ ...input, mode: "normal" })
        if (name === "disabled")
          await window.api.mods.development.setEnabled({ ...input, enabled: false })
      }
      return targets
    }, fixture.workspace)
    await close()
    page = await open()
    const restored = await page.evaluate(async (targets) => {
      const results: Record<string, { mode: string; enabled: boolean; trials: number }> = {}
      for (const [name, threadId] of Object.entries(targets)) {
        const status = await window.api.mods.development.status({ threadId })
        results[name] = { mode: status.mode, enabled: status.enabled, trials: status.trials.length }
      }
      return results
    }, threads)
    observations.push(restored)
    assert.deepEqual(restored, {
      creator: { mode: "creator", enabled: true, trials: 0 },
      normal: { mode: "normal", enabled: true, trials: 0 },
      disabled: { mode: "normal", enabled: false, trials: 0 },
      untouched: { mode: "normal", enabled: false, trials: 0 }
    })
    await page.evaluate(async (threadId) => {
      const scope = await window.api.mods.development.status({ threadId })
      await window.api.mods.development.setMode({
        threadId,
        expectedWorkspace: scope.workspace,
        mode: "normal"
      })
    }, threads.creator)
    await close()
    page = await open()
    const ordinary = await page.evaluate(
      (threadId) => window.api.mods.development.status({ threadId }),
      threads.creator
    )
    assert.equal(ordinary.mode, "normal")
    assert.equal(ordinary.enabled, true)
    assert.deepEqual(ordinary.trials, [])
    passed = true
    console.log(
      "PASS actual Electron restart restores creator/normal/disabled preferences without trial execution"
    )
  } finally {
    await close()
    writeFileSync(
      join(fixture.isolated, "creator-mode-restart.json"),
      JSON.stringify({ passed, candidate, observations }, null, 2)
    )
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
