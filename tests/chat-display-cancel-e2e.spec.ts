/** Real main/preload/React cancellation; no display IPC, history or guest clock is mocked. */
import assert from "node:assert/strict"
import { appendFileSync, existsSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { releaseGuideConfig } from "../src/renderer/src/components/guides/release-guide-content"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
import {
  assertOldDisplayReadsCancelled,
  DISPLAY_CANCEL_SLEEP_MS,
  observeDisplayCancellation,
  readDisplayCancellation
} from "./support/chat-display-cancel-observation"

const root = resolve(__dirname, "..")
assert(
  process.env.COMPOSITION_E2E_SOURCE_CANDIDATE || process.env.COMPOSITION_E2E_PACKAGED_DIR,
  "Explicit immutable source candidate or production package required; no built-output fallback"
)
const candidate = projectCompositionCandidate(root)
const summaryPath = process.env.CMB_CHAT_DISPLAY_CANCEL_RECEIPT
assert(!summaryPath || !existsSync(summaryPath), "Fresh display cancellation receipt required")
const fixture = projectCompositionEnvironment(root)
const errors: string[] = []
const evidence: Record<string, unknown> = {
  passed: false,
  candidate,
  profile: fixture.isolated,
  fixture: "Normal plugin install and approveFunction; real ui.render and native clock.sleep",
  observation:
    "Read-only wrappers around Main physical IPC, native timer handles and real clock hook logs",
  limitations: [
    "Prepared plugin sessions; cold transcript view; no model invocation",
    "QuickJS runs in utility process; its SDK clock.sleep capability executes in Main"
  ]
}
if (candidate.execution === "source-isolated") {
  const bridge = join(dirname(dirname(dirname(candidate.path))), "node_modules")
  if (existsSync(bridge)) {
    assert.equal(
      realpathSync(bridge),
      realpathSync(join(root, "node_modules")),
      "Source dependency bridge must resolve to the verified repository dependency tree"
    )
    evidence.sourceDependencyBridge = { path: bridge, target: realpathSync(bridge) }
  }
}
let app: ElectronApplication | undefined
let page: Page | undefined
function phase(name: string) {
  evidence.phase = name
  const entry = { phase: name, at: new Date().toISOString(), profile: fixture.isolated }
  appendFileSync(
    join(fixture.isolated, "display-cancel-phases.ndjson"),
    JSON.stringify(entry) + "\n"
  )
  console.log(JSON.stringify(entry))
}

async function until(check: () => Promise<boolean>, label: string, timeout = 15000) {
  const deadline = performance.now() + timeout
  while (!(await check())) {
    assert(performance.now() < deadline, label)
    await new Promise((done) => setTimeout(done, 20))
  }
}

async function main() {
  const watchdog = setTimeout(() => {
    errors.push("E2E_WATCHDOG")
    void app?.close()
  }, 90000)
  try {
    phase("launching")
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    app
      .process()
      .stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app
      .process()
      .stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    await app.evaluate("globalThis.__name = value => value\nvoid 0")
    await until(
      async () =>
        app!.evaluate(({ ipcMain }) => {
          const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })
            ._invokeHandlers
          return (
            handlers.has("mods:function-site-read") &&
            handlers.has("mods:function-site-read-cancel")
          )
        }),
      "Actual Mods IPC handlers must finish normal registration"
    )
    await observeDisplayCancellation(app)
    evidence.runtime = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      executable: process.execPath
    }))
    page = await app.firstWindow({ timeout: 60000 })
    page.setDefaultTimeout(15000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.setSize(1440, 1100)
    })
    await page.waitForFunction(() => Boolean(window.api?.mods))
    phase("preparing-isolated-history")
    const threads = await page.evaluate(
      async ({ workspace, guide }) => {
        for (const config of [
          guide,
          { guideId: "project-mode-getting-started", revision: 2, maxShowCount: 3 }
        ]) {
          await window.api.uiGuides.getState(config)
          await window.api.uiGuides.acknowledge(config)
        }
        await window.api.mods.configureGlobal(true)
        const result: Array<{ id: string; title: string }> = []
        // The newest default conversation is A, so setup never opens B's transcript.
        for (const letter of ["B", "A"]) {
          const title = `Display cancellation ${letter}`
          const thread = await window.api.threads.create({ title, workspacePath: workspace })
          await window.api.workspace.set(thread.thread_id, workspace)
          await window.api.mods.configure(thread.thread_id, true, true)
          await window.api.threads.appendMessages(
            thread.thread_id,
            Array.from({ length: 4 }, (_, index) => ({
              id: `display-cancel-${letter}-${index}`,
              role: index % 2 ? ("assistant" as const) : ("user" as const),
              content: `DISPLAY_CANCEL_${letter}_${index}`,
              created_at: new Date(1700000000000 + index)
            }))
          )
          result.push({ id: thread.thread_id, title })
        }
        return result.sort((left, right) => left.title.localeCompare(right.title))
      },
      { workspace: fixture.workspace, guide: releaseGuideConfig("2.0.0") }
    )
    evidence.threads = threads
    phase("installing-and-approving-plugin")
    const zip = new AdmZip()
    zip.addFile(
      "plugin.json",
      Buffer.from(JSON.stringify({ name: "display-cancel-fixture", version: "1.0.0" }))
    )
    zip.addFile("hooks/hooks.json", Buffer.from(JSON.stringify({ modules: ["./register.ts"] })))
    zip.addFile(
      "hooks/register.ts",
      Buffer.from(`let armed = false;
    export function register(on) {
      let clockCalls = 0;
      on("clock.sleep", {ms:${DISPLAY_CANCEL_SLEEP_MS}}, async ($, e, next) => {
        await $.ui.log("DISPLAY_CANCEL_HOST_CLOCK_" + (++clockCalls));
        return next(e);
      });
      on("session.start", async ($, e, next) => {
        await $.command.register({name:"display-cancel-arm",description:"Arm isolated display cancellation fixture",immediate:true});
        return next(e);
      });
      on("command.run", {command:"display-cancel-arm"}, $ => {
        armed = true;
        $.ui.invalidate("ui.render");
        return {text:"DISPLAY_CANCEL_ARMED"};
      });
      for (const component of ["UserMessage", "AssistantMessage"])
        on("ui.render", {component}, async ($, e, next) => {
          if (armed && /^DISPLAY_CANCEL_A_[0-3]$/.test(e.props.text)) await $.clock.sleep(${DISPLAY_CANCEL_SLEEP_MS});
          return next(e);
        });
    }`)
    )
    await page.evaluate(
      async ({ bytes, threads }) => {
        const result = await window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "display-cancel-fixture.zip",
          "local"
        )
        if (!result.success) throw Error(result.error)
        for (const thread of threads) {
          const mod = (await window.api.mods.status(thread.id)).functionMods?.find(
            (row) => row.name === "display-cancel-fixture"
          )
          if (!mod?.digest) throw Error("DISPLAY_CANCEL_PLUGIN_NOT_COMPILED")
          await window.api.mods.approveFunction(thread.id, mod.pluginId, mod.digest)
          await window.api.mods.commands(thread.id)
        }
      },
      { bytes: [...zip.toBuffer()], threads }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    phase("reading-unarmed-A")
    await page.getByText(threads[0].title, { exact: true }).first().click()
    await page.waitForFunction((id) => {
      const scope = document.querySelector(`[data-chat-thread-id="${id}"]`)
      return (
        scope?.querySelector('[data-chat-initial-presentation="ready"]') &&
        scope.textContent?.includes("DISPLAY_CANCEL_A_0") &&
        !scope.querySelector("[data-function-site-pending]")
      )
    }, threads[0].id)
    await page.addInitScript(() => {
      const visited: string[] = []
      ;(window as unknown as { displayCancelVisited: string[] }).displayCancelVisited = visited
      const scan = () => {
        for (const scope of document.querySelectorAll<HTMLElement>("[data-chat-thread-id]")) {
          const id = scope.dataset.chatThreadId
          if (id && !visited.includes(id)) visited.push(id)
        }
      }
      new MutationObserver(scan).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-chat-thread-id"]
      })
      scan()
    })
    // Start a fresh renderer and prove below that B never mounted before measurement.
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(threads[0].title, { exact: true }).first().click()
    await page.waitForFunction((id) => {
      const scope = document.querySelector(`[data-chat-thread-id="${id}"]`)
      return (
        scope?.querySelector('[data-chat-initial-presentation="ready"]') &&
        [0, 1, 2, 3].every((index) => scope.textContent?.includes(`DISPLAY_CANCEL_A_${index}`)) &&
        !scope.querySelector("[data-function-site-pending]")
      )
    }, threads[0].id)
    await until(
      async () => (await readDisplayCancellation(app!)).active === 0,
      "Initial unarmed native display reads must settle"
    )
    await app.evaluate(() => {
      const state = (
        globalThis as unknown as {
          displayCancelObservation: {
            reads: unknown[]
            cancels: unknown[]
            nativeClockTimers: unknown[]
            peak: number
          }
        }
      ).displayCancelObservation
      state.reads.length = 0
      state.cancels.length = 0
      state.nativeClockTimers.length = 0
      state.peak = 0
    })
    await page.evaluate(async (id) => {
      const descriptor = (await window.api.mods.commands(id)).find(
        (row) => row.command === "display-cancel-arm"
      )
      if (!descriptor) throw Error("DISPLAY_CANCEL_ARM_COMMAND_MISSING")
      await window.api.mods.enqueue(id, descriptor, { text: "" })
    }, threads[0].id)
    phase("waiting-for-four-native-clocks")
    await until(async () => {
      const current = await readDisplayCancellation(app!)
      const clocks = await page!.evaluate((id) => window.api.mods.logs(id), threads[0].id)
      const calls = clocks.filter((row) => /^DISPLAY_CANCEL_HOST_CLOCK_[1-4]$/.test(row.text))
      evidence.hostClockEntries = calls
      return (
        calls.length === 4 &&
        current.nativeClockTimers.length === 4 &&
        current.nativeClockTimers.every((timer) => !timer.cancelled && !timer.fired) &&
        current.reads.filter(
          (row) =>
            row.threadId === threads[0].id &&
            /^DISPLAY_CANCEL_A_[0-3]$/.test(row.text) &&
            row.ended === undefined
        ).length === 4
      )
    }, "Four actual slow body reads must occupy the real physical queue")
    evidence.beforeSwitch = await readDisplayCancellation(app)
    phase("four-native-clocks-and-body-reads-active")
    evidence.visitedBeforeSwitch = await page.evaluate(
      () =>
        (
          window as unknown as {
            displayCancelVisited: string[]
          }
        ).displayCancelVisited
    )
    assert(
      !(evidence.visitedBeforeSwitch as string[]).includes(threads[1].id),
      "B must not have a hot renderer presentation from setup"
    )
    assert(
      !(evidence.beforeSwitch as { reads: Array<{ threadId: string }> }).reads.some(
        (row) => row.threadId === threads[1].id
      ),
      "B must have no display reads in the measured renderer"
    )
    await page.evaluate((id) => {
      const state = { slow: false }
      ;(window as unknown as { displayCancelUi: typeof state }).displayCancelUi = state
      const scan = () => {
        const scope = document.querySelector(`[data-chat-thread-id="${id}"]`)
        if (scope?.textContent?.includes("内容加载较慢")) state.slow = true
      }
      new MutationObserver(scan).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true
      })
      scan()
    }, threads[1].id)
    const started = performance.now()
    await page.getByText(threads[1].title, { exact: true }).first().click()
    await page.waitForFunction(
      (id) => {
        const scope = document.querySelector(`[data-chat-thread-id="${id}"]`)
        if (!scope?.querySelector('[data-chat-initial-presentation="ready"]')) return false
        return [0, 1, 2, 3].every((index) => {
          const row = scope.querySelector<HTMLElement>(
            `[data-chat-message-id="display-cancel-B-${index}"]`
          )
          if (
            !row ||
            row.closest('[inert], [aria-hidden="true"]') ||
            row.querySelector("[data-function-site-pending]") ||
            !row.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
            !row.textContent?.includes(`DISPLAY_CANCEL_B_${index}`)
          )
            return false
          const viewport = row.closest("[data-radix-scroll-area-viewport]")
          if (!viewport) return false
          const box = row.getBoundingClientRect(),
            area = viewport.getBoundingClientRect()
          return box.height > 0 && box.bottom > area.top && box.top < area.bottom
        })
      },
      threads[1].id,
      { timeout: 1500 }
    )
    evidence.switchMs = performance.now() - started
    phase("B-readable")
    assert(
      Number(evidence.switchMs) < 1500,
      `B must become readable within original 1500ms budget: ${evidence.switchMs}`
    )
    const afterSwitch = await readDisplayCancellation(app)
    assertOldDisplayReadsCancelled(afterSwitch, threads[0].id)
    evidence.afterSwitch = afterSwitch
    evidence.physicalPeak = afterSwitch.peak
    evidence.cancelledReads = 4
    evidence.hostClockCalls = (evidence.hostClockEntries as unknown[]).length
    evidence.observedCancelledNativeTimers = afterSwitch.nativeClockTimers.filter(
      (timer) => timer.cancelled !== undefined && timer.fired === undefined
    ).length
    // Continue observing beyond the product's five-second slow-message threshold.
    await page.waitForTimeout(5200)
    evidence.ui = await page.evaluate(
      () =>
        (
          window as unknown as {
            displayCancelUi: { slow: boolean }
          }
        ).displayCancelUi
    )
    assert.deepEqual(evidence.ui, { slow: false })
    assertOldDisplayReadsCancelled(await readDisplayCancellation(app), threads[0].id)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(fixture.isolated, "display-cancel-B.png") })
    evidence.passed = true
    phase("passed")
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    clearTimeout(watchdog)
    if (page && !page.isClosed() && !evidence.passed) {
      await page.screenshot({ path: join(fixture.isolated, "failure.png") }).catch(() => {})
      writeFileSync(
        join(fixture.isolated, "failure-ui.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable")
      )
    }
    if (app) evidence.final = await readDisplayCancellation(app).catch(() => "unavailable")
    evidence.errors = errors
    writeFileSync(
      join(fixture.isolated, "display-cancel-acceptance.json"),
      JSON.stringify(evidence, null, 2)
    )
    if (summaryPath) writeFileSync(summaryPath, JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({ passed: evidence.passed, profile: fixture.isolated }))
    await app?.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
