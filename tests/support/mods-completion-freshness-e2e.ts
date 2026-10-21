import { openModsResults } from "./mods-sidebar-navigation"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { verifyAutobizStage } from "./mods-autobiz-stage-e2e"
import {
  collectRegisteredRevocationDiagnostics,
  installRegisteredRevocationDiagnostics
} from "./mods-registered-revocation-e2e"

/** Physical file edit -> existing watcher -> host evidence ledger -> real React UI. */
export async function verifyCompletionFreshness(
  page: Page,
  workspace: string,
  artifacts: string,
  requests: unknown[],
  until: (check: () => Promise<boolean>, label: string) => Promise<void>,
  pass: (label: string) => void,
  app: ElectronApplication
): Promise<void> {
  const project = join(workspace, "completion-freshness-project")
  mkdirSync(project, { recursive: true })
  const target = join(project, "requirements.md")
  writeFileSync(target, "version one")
  const threadId = await page.evaluate(async (project) => {
    const thread = await window.api.threads.create({
      title: "Evidence freshness E2E",
      workspacePath: project,
      agentMode: "normal"
    })
    const id =
      (thread as unknown as { thread_id: string }).thread_id ??
      (thread as unknown as { id: string }).id
    await window.api.workspace.set(id, project)
    await window.api.threads.patchMetadata(id, {
      set: { model: "custom:mods-model-fixture", subagentsEnabled: false }
    })
    await window.api.mods.configure(id, true, true)
    return id
  }, project)
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "evidence-freshness", version: "1.0.0" }))
  )
  zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
  zip.addFile(
    "hooks/register.ts",
    Buffer.from(`export function register(on) {
    on("completion.check", () => ({ decision: "pass" }))
    on("turn.complete", async ($, e, next) => ({ ...await next(e), text: "FRESHNESS_CHECKED" }))
  }`)
  )
  const installed = await page.evaluate(
    (bytes) => window.api.plugins.install(new Uint8Array(bytes).buffer, "freshness.zip", "local"),
    [...zip.toBuffer()]
  )
  assert(installed.success, installed.error)
  const mod = (
    await page.evaluate((id) => window.api.mods.status(id), threadId)
  ).functionMods!.find((m) => m.name === "evidence-freshness")!
  assert(mod?.digest)
  await page.evaluate(
    ({ id, pluginId, digest }) => window.api.mods.approveFunction(id, pluginId, digest),
    { id: threadId, pluginId: mod.pluginId, digest: mod.digest }
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("Evidence freshness E2E", { exact: true }).first().click()
  const rail = page.locator("[data-completion-evidence]")
  const summary = rail.locator(":scope > summary")
  const staleOverview = "检查后文件或规则有变化，需要重新检查。"
  const staleVisible = async () =>
    (await summary.innerText()).includes("需要重新检查") &&
    (await rail.locator("[data-completion-overview]").innerText()) === staleOverview &&
    (await summary.isVisible())
  const openEvidence = async () => {
    if (!(await rail.evaluate((element) => (element as HTMLDetailsElement).open)))
      await summary.click()
  }
  const composer = page.locator("textarea.composer-textarea")
  const submit = page.locator("form").filter({ has: composer }).locator('button[type="submit"]')
  const records = () => page.evaluate((id) => window.api.mods.completionEvidence(id), threadId)
  const diagnosticSessions: unknown[] = []
  const startDiagnostics = async () => {
    await installRegisteredRevocationDiagnostics(page).catch((error) =>
      console.error("Unable to start freshness DOM diagnostics", error)
    )
    try {
      await page.evaluate(() => {
        const events: Array<Record<string, unknown>> = []
        const restores: Array<() => void> = []
        const log = (event: Record<string, unknown>) => {
          try {
            if (events.length < 160) events.push({ at: performance.now(), ...event })
          } catch {
            /* Diagnostics cannot alter an actual API call. */
          }
        }
        for (const name of ["promptAttach", "promptEditSupport", "promptEdit"] as const) {
          try {
            const descriptor = Object.getOwnPropertyDescriptor(window.api.mods, name)
            const original: unknown = descriptor?.value
            if (
              !descriptor ||
              typeof original !== "function" ||
              (!descriptor.writable && !descriptor.configurable)
            ) {
              log({
                name,
                phase: "unavailable",
                reason: "preload method is not safely replaceable",
                writable: descriptor?.writable,
                configurable: descriptor?.configurable
              })
              continue
            }
            let sequence = 0
            const wrapped = function (...args: unknown[]) {
              const call = ++sequence
              log({ name, call, phase: "started" })
              try {
                const result: unknown = Reflect.apply(original, window.api.mods, args)
                if (result instanceof Promise) {
                  void result
                    .then(
                      () => log({ name, call, phase: "fulfilled" }),
                      (error) => log({ name, call, phase: "rejected", error: String(error) })
                    )
                    .catch(() => undefined)
                } else log({ name, call, phase: "returned" })
                return result
              } catch (error) {
                log({ name, call, phase: "threw", error: String(error) })
                throw error
              }
            }
            Object.defineProperty(window.api.mods, name, { ...descriptor, value: wrapped })
            restores.push(() => {
              if (Object.getOwnPropertyDescriptor(window.api.mods, name)?.value === wrapped)
                Object.defineProperty(window.api.mods, name, descriptor)
            })
            log({ name, phase: "observing" })
          } catch (error) {
            log({ name, phase: "unavailable", error: String(error) })
          }
        }
        Object.assign(globalThis, { __modsFreshnessPromptDiagnostics: { events, restores } })
      })
    } catch (error) {
      console.error("Unable to observe actual freshness prompt APIs", error)
    }
  }
  const collectDiagnostics = async (label: string) => {
    try {
      const prompt = await page
        .evaluate(() => {
          const global = globalThis as typeof globalThis & {
            __modsFreshnessPromptDiagnostics?: {
              events: Array<Record<string, unknown>>
              restores: Array<() => void>
            }
          }
          const state = global.__modsFreshnessPromptDiagnostics
          try {
            return { missing: !state, events: state?.events ?? [] }
          } finally {
            for (const restore of state?.restores ?? []) {
              try {
                restore()
              } catch {
                /* A readonly bridge remains untouched. */
              }
            }
            delete global.__modsFreshnessPromptDiagnostics
          }
        })
        .catch((error) => ({ error: String(error) }))
      const dom = await collectRegisteredRevocationDiagnostics(page)
      let timer: ReturnType<typeof setTimeout> | undefined
      let currentRecords: unknown
      try {
        currentRecords = await Promise.race([
          records().catch((error) => ({ error: String(error) })),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve({ diagnosticReadTimedOut: true }), 2000)
          })
        ])
      } finally {
        clearTimeout(timer)
      }
      diagnosticSessions.push({ label, requestCount: requests.length, currentRecords, prompt, dom })
      writeFileSync(
        join(artifacts, "completion-freshness-submit-diagnostics.json"),
        JSON.stringify({ threadId, sessions: diagnosticSessions }, null, 2)
      )
    } catch (error) {
      console.error("Unable to preserve freshness submission diagnostics", error)
    }
  }
  const run = async (text: string) => {
    await composer.fill(text)
    await submit.click()
  }
  await startDiagnostics()
  try {
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    const before = requests.length
    await run("请确认任务状态。[freshness-off]")
    await until(
      async () =>
        requests.length > before &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "native off turn settles"
    )
    assert.deepEqual(await records(), [])
    assert.equal(await rail.count(), 0)
    pass("off completes the original model turn without a completion gate or evidence UI")
    await page.evaluate(() => window.api.mods.configureGlobal(true))
    await openModsResults(page)
    await run("请确认任务状态。[freshness-on]")
    await until(
      async () =>
        (await records()).some((row) => row.phase === "check.result" && row.status === "pass"),
      "real completion PASS recorded"
    )
    await until(
      async () =>
        (await page.evaluate((id) => window.api.mods.turnNotices(id), threadId)).some(
          (n) => n.text === "FRESHNESS_CHECKED"
        ),
      "guest completion settles"
    )
    const initial = await records()
    assert(!initial.some((row) => row.phase === "invalidated"))
    assert(initial.some((row) => row.phase === "capture.started" && row.status === "completed"))
    assert(initial.some((row) => row.phase === "check.started" && row.status === "completed"))
    assert(!initial.some((row) => row.status === "running"))
    pass(
      "capture starts durably and completed steps do not remain running beside the real guest result"
    )
    const modelCalls = requests.length
    // Same-content writes still generate an OS notification. They must not stale a proof.
    writeFileSync(target, "version one")
    await new Promise((resolve) => setTimeout(resolve, 1000))
    assert(!(await records()).some((row) => row.phase === "invalidated"))
    const started = Date.now()
    writeFileSync(target, "version two: requirement changed")
    await until(
      async () =>
        (await records()).some((row) => row.phase === "invalidated" && row.status === "stale"),
      "physical workspace watcher invalidates the old PASS"
    )
    await until(staleVisible, "stale state reaches UI without a reload")
    const latencyMs = Date.now() - started
    assert.equal(requests.length, modelCalls, "freshness must not invoke the model")
    assert.equal(
      (await records()).filter((row) => row.phase === "check.result").length,
      1,
      "freshness must not re-run checks"
    )
    const invalidated = (await records()).find(
      (row) => row.phase === "invalidated" && row.status === "stale"
    )!
    await openEvidence()
    const staleRow = rail.locator(`[data-completion-record="${invalidated.id}"]`)
    assert(await staleRow.isVisible())
    assert((await staleRow.innerText()).includes("input-changed"))
    assert((await staleRow.innerText()).includes("请对当前版本重新检查"))
    await page.screenshot({ path: join(artifacts, "completion-freshness-stale.png") })
    writeFileSync(
      join(artifacts, "completion-freshness.json"),
      JSON.stringify({ latencyMs, records: await records(), modelCallsUnchanged: true }, null, 2)
    )
    pass(
      "physical file modification invalidates host proof and UI without model/check replay; unchanged content stays valid"
    )
    await collectDiagnostics("before-stale-evidence-reload")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Evidence freshness E2E", { exact: true }).first().click()
    await startDiagnostics()
    await openModsResults(page)
    await until(staleVisible, "stale evidence survives renderer restart")
    assert((await records()).some((row) => row.id === invalidated.id && row.status === "stale"))
    await page.evaluate(() => window.api.mods.configureGlobal(false))
    await until(async () => (await rail.count()) === 0, "off removes evidence UI")
    assert.deepEqual(await records(), [])
    pass("durable stale evidence survives renderer restart and disabling Mods removes the gate UI")
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ scripts: { test: "node suite.cjs" } })
    )
    writeFileSync(
      join(project, "suite.cjs"),
      'console.log("REAL_ELECTRON_ASSERTION_FAILED");process.exitCode=2'
    )
    const configureTests = (mode: "off" | "check") =>
      page.evaluate(
        ({ id, plugin, mode }) =>
          window.api.mods.setCompletionPolicy(id, plugin, {
            mode,
            scope: "project",
            checks: ["unit-test"],
            maxRepairs: 0,
            timeoutMs: 30000,
            modelTokenBudget: 4096
          }),
        { id: threadId, plugin: mod.name, mode }
      )
    await page.evaluate(() => window.api.mods.configureGlobal(true))
    await configureTests("off")
    const beforeOff = requests.length
    await run("请确认任务状态。[project-test-off]")
    await until(
      async () =>
        requests.length > beforeOff &&
        (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "off completes without running the failing project suite"
    )
    assert(
      !(await page.evaluate((id) => window.api.mods.audit(id), threadId)).some(
        (row) => row.toolId === "host:execute"
      )
    )
    pass(
      "explicitly disabled project check leaves the same failing task ungated without executing tests"
    )
    await configureTests("check")
    await app.evaluate(({ dialog }) => {
      Object.assign(globalThis, { completionTestOriginalDialog: dialog.showMessageBox })
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false
      })) as typeof dialog.showMessageBox
    })
    try {
      const previousIds = new Set((await records()).map((row) => row.id))
      await run("请确认任务状态。[project-test-on-fail]")
      await until(
        async () =>
          (await records()).some(
            (row) =>
              !previousIds.has(row.id) &&
              row.phase === "validator.result" &&
              row.status === "block" &&
              JSON.stringify(row.detail).includes("REAL_ELECTRON_ASSERTION_FAILED")
          ),
        "native project failure records the actual assertion output"
      )
      await until(
        async () =>
          (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
        "failing configured test blocks original completion"
      )
      const failedRows = (await records()).filter((row) => !previousIds.has(row.id))
      const checked = failedRows.find(
        (row) =>
          row.phase === "validator.result" && JSON.stringify(row.detail).includes("executionId")
      )!
      const detail = checked.detail as { executionId: string; exitCode: number }
      assert.equal(detail.exitCode, 2)
      const receipt = (await page.evaluate((id) => window.api.mods.audit(id), threadId)).find(
        (row) => row.callId === detail.executionId
      )
      assert.equal(receipt?.status, "failed")
      assert(failedRows.some((row) => row.phase === "check.result" && row.status === "block"))
      assert(!failedRows.some((row) => row.phase === "check.result" && row.status === "pass"))
      pass(
        "enabled project check blocks a real failing npm test with original native approval and durable failed receipt"
      )
      writeFileSync(join(project, "suite.cjs"), 'console.log("REAL_ELECTRON_ASSERTION_PASSED")')
      const prior = new Set((await records()).map((row) => row.id))
      await run("请复检已修复的任务。[project-test-on-fixed]")
      await until(
        async () =>
          (await records()).some(
            (row) => !prior.has(row.id) && row.phase === "check.result" && row.status === "pass"
          ),
        "repaired project suite is re-executed and passes"
      )
      await until(
        async () =>
          (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
        "rechecked completion settles"
      )
      const passed = (await records()).filter((row) => !prior.has(row.id))
      assert(
        passed.some(
          (row) =>
            row.phase === "validator.result" &&
            row.status === "pass" &&
            JSON.stringify(row.detail).includes("executionId")
        )
      )
      writeFileSync(
        join(artifacts, "native-project-check.json"),
        JSON.stringify({ failedRows, passed }, null, 2)
      )
      await page.screenshot({ path: join(artifacts, "native-project-check.png") })
      pass(
        "a repaired real project test receives a new native receipt and new bound completion evidence"
      )
      await verifyAutobizStage(page, app, project, threadId, mod.name, artifacts, run, until, pass)
    } finally {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = (
          globalThis as unknown as { completionTestOriginalDialog: typeof dialog.showMessageBox }
        ).completionTestOriginalDialog
        delete (globalThis as unknown as { completionTestOriginalDialog?: unknown })
          .completionTestOriginalDialog
      })
    }
    writeFileSync(join(project, "too-large.txt"), Buffer.alloc(3 * 1024 * 1024, 65))
    await page.evaluate(
      async ({ id, plugin }) => {
        await window.api.mods.configureGlobal(true)
        await window.api.mods.setCompletionPolicy(id, plugin, {
          mode: "report",
          scope: "project",
          checks: ["code-review"],
          maxRepairs: 0,
          timeoutMs: 30000,
          modelTokenBudget: 4096
        })
      },
      { id: threadId, plugin: mod.name }
    )
    await run("请确认任务状态。[freshness-capture-error]")
    await until(
      async () => (await records()).some((row) => row.phase === "capture.failed"),
      "initial capture error reaches durable host evidence"
    )
    await until(
      async () => (await page.getByRole("button", { name: "停止生成", exact: true }).count()) === 0,
      "report-only capture error does not block original completion"
    )
    await until(
      async () => (await rail.locator(":scope > summary").innerText()).includes("检查错误"),
      "capture error reaches the actual evidence UI"
    )
    const failed = (await records()).find((row) => row.phase === "capture.failed")!
    await openEvidence()
    const failedRow = rail.locator(`[data-completion-record="${failed.id}"]`)
    assert(await failedRow.isVisible())
    assert((await failedRow.innerText()).includes("尚未取得文件和需求证据"))
    assert.equal(failed.binding, null)
    assert.equal(failed.status, "error")
    await page.screenshot({ path: join(artifacts, "completion-capture-error.png") })
    await collectDiagnostics("before-capture-error-reload")
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Evidence freshness E2E", { exact: true }).first().click()
    await startDiagnostics()
    assert((await records()).some((row) => row.id === failed.id && row.binding === null))
    pass(
      "report-only capture failure persists as unavailable evidence, explains the next action and survives renderer restart"
    )
  } finally {
    await collectDiagnostics("finally")
    await page.evaluate(() => window.api.mods.configureGlobal(true))
  }
}
