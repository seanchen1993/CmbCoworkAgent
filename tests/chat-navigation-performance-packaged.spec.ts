/** Actual packaged navigation with a populated directory and large file history, no model calls. */
import assert from "node:assert/strict"
import { appendFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import { releaseGuideConfig } from "../src/renderer/src/components/guides/release-guide-content"
import {
  compositionHostFlow,
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "An explicit production package is required")
const candidate = projectCompositionCandidate(root)
const fixture = projectCompositionEnvironment(root)
const observations: unknown[] = []
const errors: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
let passed = false
const record = (value: unknown) => {
  observations.push(value)
  appendFileSync(join(fixture.isolated, "navigation.ndjson"), JSON.stringify(value) + "\n")
  console.log(JSON.stringify(value))
}

async function readable(threadId: string) {
  await page!.waitForFunction(id => {
    const scope = document.querySelector(`[data-chat-thread-id="${id}"]`)
    const row = scope?.querySelector<HTMLElement>('[data-chat-message-id$="-119"]')
    const viewport = row?.closest("[data-radix-scroll-area-viewport]")
    if (!row || !viewport || !scope?.querySelector('[data-chat-initial-presentation="ready"]') ||
      row.closest('[aria-hidden="true"], [inert]') ||
      !row.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
      !row.textContent?.includes("NAVIGATION_BODY") || row.querySelector("[data-function-site-pending]")) return false
    const box = row.getBoundingClientRect(), area = viewport.getBoundingClientRect()
    return box.height > 0 && box.bottom > area.top && box.top < area.bottom
  }, threadId)
  await page!.evaluate(async () => {
    await new Promise<void>(done => requestAnimationFrame(() => done()))
    await new Promise<void>(done => requestAnimationFrame(() => done()))
  })
}

async function main() {
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture,
      { unobtrusivePresentation: true })()
    await app.evaluate("globalThis.__name = value => value\nvoid 0")
    // Only the remote feature-availability answer is fixed for this isolated test profile.
    // History, project catalogues, display protection, rendering and all timings stay real.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("featureGates:isEnabled")
      ipcMain.handle("featureGates:isEnabled", () => ({ enabled: true, reason: "isolated-fixture" }))
      const native = ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => unknown>
      }
      const timings: Array<{ channel: string; ms: number }> = []
      ;(globalThis as unknown as { navigationIpcTimings: typeof timings }).navigationIpcTimings = timings
      for (const [channel, handler] of native._invokeHandlers) {
        if (!/^(threads:|mods:function-site-|mods:chat-display|harnessBoard:|project-runtime:)/.test(channel)) continue
        native._invokeHandlers.set(channel, async (...args) => {
          const started = performance.now()
          try { return await handler(...args) }
          finally {
            if (timings.length < 10000) timings.push({ channel, ms: performance.now() - started })
          }
        })
      }
    })
    app.process().stdout?.on("data", data =>
      appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app.process().stderr?.on("data", data =>
      appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    page = await app.firstWindow({ timeout: 60000 })
    page.setDefaultTimeout(30000)
    page.on("pageerror", error => errors.push(error.message))
    await page.waitForFunction(() => !!window.api?.threads)
    const targets = await page.evaluate(async ({ workspace, guide }) => {
      for (const config of [guide, {
        guideId: "project-mode-getting-started", revision: 2, maxShowCount: 3
      }]) {
        await window.api.uiGuides.getState(config)
        await window.api.uiGuides.acknowledge(config)
      }
      await window.api.mods.configureGlobal(true)
      for (let index = 0; index < 498; index++)
        await window.api.threads.create({ title: `Navigation directory ${index}`, workspacePath: workspace })
      const targets: Array<{ id: string; title: string }> = []
      for (let index = 0; index < 2; index++) {
        const title = `Navigation measured ${index}`
        const thread = await window.api.threads.create({ title, workspacePath: workspace,
          llmFileHistory: { syntheticHistory: "x".repeat(512 * 1024) } })
        const id = thread.thread_id
        await window.api.workspace.set(id, workspace)
        const current = await window.api.mods.status(id)
        await window.api.mods.configure(id, true, true, current.workspace)
        await window.api.threads.appendMessages(id, Array.from({ length: 120 }, (_, ordinal) => ({
          id: `${id}-${ordinal}`, role: ordinal % 2 ? "assistant" as const : "user" as const,
          content: `NAVIGATION_BODY_${ordinal}\n\n` + "Persisted **message** with code history.\n\n".repeat(15),
          created_at: new Date(1700000000000 + ordinal)
        })))
        targets.push({ id, title })
      }
      return targets
    }, { workspace: fixture.workspace, guide: releaseGuideConfig("2.0.0") })
    const projects = await page.evaluate(async ({ bytes, threadId, workspace }) => {
      const result = await window.api.plugins.install(new Uint8Array(bytes).buffer, "navigation-project.zip", "local")
      if (!result.success) throw Error(result.error)
      const plugin = (await window.api.plugins.list()).find(item => item.name === "composition-host-fixture")
      if (!plugin) throw Error("NAVIGATION_PROJECT_PLUGIN_MISSING")
      await window.api.plugins.setEnabled(plugin.id, true)
      const prepared = await window.api.plugins.prepareStartUse({ pluginId: plugin.id, threadId,
        expectedWorkspace: workspace, expected: { name: plugin.name, version: plugin.version } })
      if (prepared.kind !== "host-project") throw Error("NATIVE_PROJECT_EXPECTED")
      const projects = []
      for (let index = 0; index < 12; index++) {
        const input = { adapterId: plugin.id, adapterType: "plugin" as const,
          name: "Navigation project " + index, projectCode: "NAV" + index, projectFromLean: false,
          isTestProject: true, projectDir: "navigation-project-" + index,
          description: "Isolated performance fixture; no model or business execution",
          systemId: "fixture", systemName: "Fixture", workspacePath: workspace,
          expectedNativeTemplate: prepared.identity }
        const review = await window.api.harnessBoard.reviewProjectUse({ adapterId: plugin.id,
          adapterType: "plugin", workspacePath: workspace, projectDir: input.projectDir,
          expectedNativeTemplate: prepared.identity })
        projects.push(await window.api.harnessBoard.createProject({ ...input,
          projectUseApproval: { reviewId: review.reviewId, reviewDigest: review.reviewDigest } }))
      }
      return projects.map(project => project.projectId)
    }, { bytes: compositionHostFlow(), threadId: targets[0].id, workspace: fixture.workspace })
    record({ kind: "populated-projects", count: projects.length, genericFixture: true })
    await app.evaluate(() => {
      (globalThis as unknown as { navigationIpcTimings: unknown[] }).navigationIpcTimings.length = 0
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    record({ kind: "fixture", candidate, threadCount: 500, metadataBytesPerTarget: 512 * 1024,
      remoteFeatureGate: "fixture-enabled", nativeDataAndRendering: true })
    for (let round = 0; round < 4; round++) {
      const target = targets[round % 2]
      const started = performance.now()
      await page.getByText(target.title, { exact: true }).first().click()
      await readable(target.id)
      const chatMs = performance.now() - started
      record({ kind: "thread-switch", round, ms: chatMs })
      const projectStarted = performance.now()
      await page.getByRole("tab", { name: "项目模式", exact: true }).click()
      await page.locator('[data-release-guide="project"]').waitFor({ state: "visible" })
      await page.getByRole("button", { name: "新建项目", exact: true }).first().waitFor()
      await page.waitForFunction(() => {
        const text = document.querySelector('[data-release-guide="project"]')?.textContent
        return text && !text.includes("正在同步项目看板") && !text.includes("正在查找项目")
      })
      await page.getByText("Navigation project 11", { exact: true }).first().waitFor()
      await page.evaluate(async () => new Promise<void>(done => requestAnimationFrame(() => done())))
      record({ kind: "project-mode", round, ms: performance.now() - projectStarted })
      const backStarted = performance.now()
      await page.getByRole("tab", { name: "对话模式", exact: true }).click()
      await readable(target.id)
      record({ kind: "return-chat", round, ms: performance.now() - backStarted })
    }
    const ipc = await app.evaluate(() =>
      (globalThis as unknown as { navigationIpcTimings: unknown[] }).navigationIpcTimings)
    writeFileSync(join(fixture.isolated, "ipc-timings.json"), JSON.stringify(ipc))
    await page.screenshot({ path: join(fixture.isolated, "navigation.png") })
    assert.deepEqual(errors, [])
    const measured = observations.filter((value): value is { kind: string; ms: number } =>
      typeof value === "object" && value !== null && "ms" in value)
    assert.equal(measured.length, 12)
    for (const sample of measured)
      assert(sample.ms < 1500, `${sample.kind} must become usable within 1500 ms: ${sample.ms}`)
    passed = true
  } finally {
    if (!passed && page && !page.isClosed()) {
      await page.screenshot({ path: join(fixture.isolated, "failure.png") }).catch(() => {})
      writeFileSync(join(fixture.isolated, "failure-ui.txt"),
        await page.locator("body").innerText().catch(() => "unavailable"))
    }
    writeFileSync(join(fixture.isolated, "navigation-acceptance.json"),
      JSON.stringify({ passed, candidate, observations, errors }, null, 2))
    console.log(JSON.stringify({ passed, profile: fixture.isolated }))
    await app?.close()
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
