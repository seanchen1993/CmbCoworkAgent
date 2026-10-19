/** Natural packaged history timings through public IPC, SQLite, Worker and actual chat UI. */
import assert from "node:assert/strict"
import { appendFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
assert(process.env.COMPOSITION_E2E_PACKAGED_DIR, "An explicit production package is required")
const candidate = projectCompositionCandidate(root)
const fixture = projectCompositionEnvironment(root)
const errors: string[] = []
const rows: unknown[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
let passed = false
const record = (value: unknown) => {
  rows.push(value)
  appendFileSync(join(fixture.isolated, "history-observation.ndjson"), JSON.stringify(value) + "\n")
  console.log(JSON.stringify(value))
}

async function main() {
  try {
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    app.process().stdout?.on("data", data =>
      appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app.process().stderr?.on("data", data =>
      appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    page = await app.firstWindow({ timeout: 60000 })
    page.setDefaultTimeout(30000)
    page.on("pageerror", error => errors.push(error.message))
    await page.waitForFunction(() => !!window.api?.threads)
    const threadId = await page.evaluate(async workspace => {
      const thread = await window.api.threads.create({
        title: "Natural history performance", workspacePath: workspace, agentMode: "normal"
      })
      const id = thread.thread_id
      await window.api.workspace.set(id, workspace)
      for (let offset = 0; offset < 2400; offset += 100) {
        const messages = Array.from({ length: 100 }, (_, index) => {
          const ordinal = offset + index
          return {
            id: `perf-history-${ordinal}`,
            role: ordinal % 2 ? "assistant" as const : "user" as const,
            created_at: new Date(1700000000000 + ordinal),
            content: `PERF_HISTORY_${ordinal}\n\n` +
              "A real persisted **history** paragraph with stable content and a bounded row.\n\n".repeat(90)
          }
        })
        const result = await window.api.threads.appendMessages(id, messages)
        if (result.count !== messages.length) throw Error("Incomplete history persistence")
      }
      return id
    }, fixture.workspace)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText("Natural history performance", { exact: true }).first().click()
    const scope = page.locator(`[data-chat-thread-id="${threadId}"]`)
    await scope.locator('[data-chat-message-id="perf-history-2399"]').waitFor({ state: "visible" })
    await scope.locator('[data-chat-initial-presentation="ready"]').waitFor()
    record({ kind: "fixture", candidate, threadId, messageCount: 2400, paragraphsPerMessage: 90,
      CPU_FS_IO_probes: false })
    for (let sample = 0; sample < 9; sample++) {
      const result = await page.evaluate(async ({ threadId, sample }) => {
        const start = performance.now()
        const result = await window.api.threads.getMessagesPage(threadId, {
          beforeOrdinal: 2400 - sample * 100, beforeMessageId: `perf-history-${2400 - sample * 100}`,
          limit: 500, byteBudget: 4 * 1024 * 1024
        })
        return { sample, elapsedMs: performance.now() - start, count: result.messages.length,
          total: result.total, first: result.messages[0]?.id, last: result.messages.at(-1)?.id,
          characters: result.messages.reduce((sum, message) => sum +
            (typeof message.content === "string" ? message.content.length : 0), 0) }
      }, { threadId, sample })
      assert.equal(result.count, 500)
      assert.equal(result.total, 2400)
      record({ kind: "direct-native-page", ...result })
    }
    const responsiveness = await page.evaluate(async threadId => {
      const bridge = window.api.windowPresentation
      if (!bridge) throw Error("The native window-presentation bridge is required")
      let finished = false
      const pings: number[] = []
      const ping = (async () => {
        while (!finished) {
          const start = performance.now()
          await bridge.read()
          pings.push(performance.now() - start)
          await new Promise<void>(done => setTimeout(done, 4))
        }
      })()
      let pages = 0
      const start = performance.now()
      try {
        for (; pages < 20; pages++) {
          const result = await window.api.threads.getMessagesPage(threadId, {
            limit: 500, byteBudget: 4 * 1024 * 1024
          })
          if (result.messages.length !== 500 || result.total !== 2400)
            throw Error("Concurrent response timing must keep the original page budget")
        }
      } finally {
        finished = true
        await ping
      }
      return { pages, elapsedMs: performance.now() - start, pings }
    }, threadId)
    assert(responsiveness.pings.length > 20)
    record({ kind: "native-response-during-history", ...responsiveness })
    for (let sample = 0; sample < 4; sample++) {
      const result = await page.evaluate(async threadId => {
        const scope = document.querySelector<HTMLElement>(`[data-chat-thread-id="${threadId}"]`)!
        const viewport = scope.querySelector<HTMLElement>(
          "[data-chat-message-scroll-area] [data-radix-scroll-area-viewport]")!
        viewport.scrollTop = 0
        for (let frame = 0; frame < 3; frame++)
          await new Promise<void>(done => requestAnimationFrame(() => done()))
        const button = scope.querySelector<HTMLButtonElement>('[data-chat-history-boundary="older"]')
        if (!button || button.disabled) throw Error("A real earlier-history boundary is required")
        const beforeLabel = button.textContent
        const start = performance.now()
        await new Promise<void>((resolve, reject) => {
          let loading = false
          const timer = setTimeout(() => {
            observer.disconnect()
            reject(Error("History page did not settle"))
          }, 30000)
          const observer = new MutationObserver(() => {
            const current = scope.querySelector<HTMLButtonElement>('[data-chat-history-boundary="older"]')
            if (current?.disabled) loading = true
            if (loading && !current?.disabled) {
              clearTimeout(timer)
              observer.disconnect()
              resolve()
            }
          })
          observer.observe(scope, { subtree: true, childList: true, attributes: true, characterData: true })
          button.click()
        })
        for (let frame = 0; frame < 2; frame++)
          await new Promise<void>(done => requestAnimationFrame(() => done()))
        const rect = viewport.getBoundingClientRect()
        const visible = [...viewport.querySelectorAll<HTMLElement>("[data-index]")].filter(row => {
          const box = row.getBoundingClientRect()
          return box.height > 0 && box.bottom > rect.top && box.top < rect.bottom
        })
        return { elapsedMs: performance.now() - start, beforeLabel,
          afterLabel: scope.querySelector('[data-chat-history-boundary="older"]')?.textContent,
          rows: visible.length, blank: visible.filter(row => !row.textContent?.trim()).length,
          scrollTop: viewport.scrollTop, mountedRows: viewport.querySelectorAll("[data-index]").length }
      }, threadId)
      assert(result.rows > 0 && result.blank === 0, "Loaded history must paint visible content")
      record({ kind: "actual-history-page-paint", sample, ...result })
    }
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(fixture.isolated, "history.png") })
    passed = true
  } finally {
    writeFileSync(join(fixture.isolated, "history-acceptance.json"),
      JSON.stringify({ passed, candidate, errors, rows, profile: fixture.isolated }, null, 2))
    console.log(JSON.stringify({ passed, profile: fixture.isolated }))
    await app?.close()
  }
}
void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
