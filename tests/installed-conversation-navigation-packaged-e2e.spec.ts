/** Real packaged runtime; only a loopback model is simulated. Never replace agent IPC. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication } from "playwright"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"
import {
  closeModsProgress,
  openModsFlowPreset,
  openModsProgress
} from "./support/mods-sidebar-navigation"

const root = resolve(__dirname, "..")
assert(process.env.CMB_MODS_PACKAGED_DIR, "Packaged directory required")
assert(process.env.CMB_MODS_EXPECTED_ASAR_SHA256, "Expected package SHA required")
assert(process.env.CMB_MODS_CORE_E2E_ARTIFACTS, "Fresh evidence directory required")
const artifacts = resolve(process.env.CMB_MODS_CORE_E2E_ARTIFACTS)
assert(!existsSync(artifacts), "Preserve previous evidence")
mkdirSync(artifacts, { recursive: true })
const { isolated, workspace, env } = compositionEnvironment(root)
const launch = createModsCoreLauncher(root, isolated, env, artifacts)
const hash = () =>
  createHash("sha256")
    .update(readFileSync(join(process.env.CMB_MODS_PACKAGED_DIR!, "resources/app.asar")))
    .digest("hex")
const evidence: Record<string, unknown> = {
  isolated,
  workspace,
  passed: false,
  asarBefore: hash(),
  limitations: [
    "Ten actual conversation turns, not an 80-row virtualization test",
    "Project sidebar navigation only; no project feature is executed",
    "Loopback deterministic model; no external model or enterprise operation"
  ]
}
assert.equal(evidence.asarBefore, process.env.CMB_MODS_EXPECTED_ASAR_SHA256)
const requests: number[] = []
const completed: number[] = []
const failures: string[] = []
const slowStreamStarted = Promise.withResolvers<void>()
const releaseSlowStream = Promise.withResolvers<void>()
let slowStreamPrefixWritten = false
let app: ElectronApplication | undefined
let expired = false
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
async function waitForSlowStream() {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      slowStreamStarted.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error("Slow navigation response did not start")), 15000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
const messageText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part && typeof part === "object" && part.type === "text" && typeof part.text === "string"
        ? part.text
        : ""
    )
    .join("\n")
}
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/chat/completions")
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    assert(Buffer.concat(chunks).length < 4 * 1024 * 1024)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const user = [...body.messages]
      .reverse()
      .find((message: { role: string }) => message.role === "user")
    const match = JSON.stringify(user?.content).match(/NAV_INPUT_(\d+)/)
    assert(match, "Unexpected model invocation")
    const turn = Number(match[1])
    assert(turn >= 1 && turn <= 10 && !requests.includes(turn), "Unexpected retry or task")
    requests.push(turn)
    res.writeHead(200, { "content-type": "text/event-stream" })
    const emit = (content: string, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({
          id: `nav-${turn}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: { content }, finish_reason: finish }]
        })}\n\n`
      )
    emit(`NAV_OUTPUT_${turn}_START\n`)
    if (turn === 2) {
      slowStreamPrefixWritten = true
      const closed = Promise.withResolvers<never>()
      const onClose = () => closed.reject(Error("Navigation closed the held response"))
      res.once("close", onClose)
      slowStreamStarted.resolve()
      try {
        // Protection may defer native text publication until capture completes. Hold the actual
        // response open until the UI has returned to A, rather than waiting for raw first-token text.
        await Promise.race([releaseSlowStream.promise, closed.promise])
      } finally {
        res.off("close", onClose)
      }
    }
    for (let index = 0; index < 2; index++) {
      await pause(100)
      if (res.destroyed) throw Error("Stream closed before completion")
      emit("继续处理隔离测试。")
    }
    emit(`\nNAV_OUTPUT_${turn}_DONE`)
    emit("", "stop")
    completed.push(turn)
    res.end("data: [DONE]\n\n")
  } catch (error) {
    failures.push(String(error))
    res.destroy()
  }
})

async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address === "object")
  const watchdog = setTimeout(() => {
    expired = true
    void app?.close()
  }, 120000)
  let closeFailure: { error: unknown } | undefined
  try {
    app = await launch(30000)
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    await page.addInitScript("window.__name = value => value")
    await page.evaluate("window.__name = value => value")
    await page.waitForFunction(() => Boolean(window.api?.mods))
    evidence.runtime = await app.evaluate(({ app }) => ({
      appPath: app.getAppPath(),
      executable: process.execPath,
      packaged: app.isPackaged
    }))
    page.on("pageerror", (error) => failures.push(String(error)))
    const ids = await page.evaluate(
      async ({ workspace, url }) => {
        await window.api.models.setCustomConfig({
          id: "nav-loopback",
          name: "隔离导航模型",
          baseUrl: url,
          model: "nav-loopback",
          apiKey: "owned-loopback-only",
          maxTokens: 32000,
          maxOutputTokens: 4096
        })
        await window.api.models.setDefault("custom:nav-loopback")
        await window.api.mods.configureGlobal(true)
        const ids: string[] = []
        for (const title of ["NAV_CHAT_A", "NAV_CHAT_B"]) {
          const thread = await window.api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          const id = (thread as unknown as { thread_id: string }).thread_id
          await window.api.workspace.set(id, workspace)
          await window.api.mods.configure(id, true, false)
          ids.push(id)
        }
        return ids
      },
      { workspace, url: `http://127.0.0.1:${address.port}/v1` }
    )
    evidence.threadIds = ids
    await page.reload()
    await page.getByText("NAV_CHAT_A", { exact: true }).first().click()
    const composer = page.locator("textarea.composer-textarea")
    let previous: Array<{ id: string; content: unknown }> = []
    for (let turn = 1; turn <= 10; turn++) {
      await composer.fill(`NAV_INPUT_${turn}`)
      await composer.press("Enter")
      if (turn === 2) {
        await waitForSlowStream()
        await page.getByText("NAV_INPUT_2", { exact: true }).waitFor()
        await page.getByRole("button", { name: "停止生成", exact: true }).waitFor()
        assert(slowStreamPrefixWritten, "Actual response bytes must precede navigation")
        assert(!completed.includes(2), "Navigation starts while the model response is open")
        await page.getByText("NAV_CHAT_B", { exact: true }).first().click()
        await page.locator(`[data-chat-thread-id="${ids[1]}"]`).waitFor()
        await composer.waitFor()
        assert.equal(await page.getByText(/NAV_OUTPUT_2_START/).count(), 0)
        assert.equal(await page.getByText("NAV_INPUT_2", { exact: true }).count(), 0)
        await composer.fill("NAV_B_UNSENT_DRAFT")
        await page.getByText("NAV_CHAT_A", { exact: true }).first().click()
        await page.locator(`[data-chat-thread-id="${ids[0]}"]`).waitFor()
        await page.getByText("NAV_INPUT_2", { exact: true }).waitFor()
        await page.getByRole("button", { name: "停止生成", exact: true }).waitFor()
        assert.equal(requests.length, 2, "Navigation must not send a task")
        assert(!completed.includes(2), "A to B to A must occur before the slow stream ends")
        evidence.streamingNavigation = {
          turn,
          prefixWritten: slowStreamPrefixWritten,
          requests: [...requests],
          completedBeforeRelease: [...completed]
        }
        releaseSlowStream.resolve()
      }
      await page
        .getByText(new RegExp(`NAV_OUTPUT_${turn}_DONE`))
        .first()
        .waitFor()
      if (turn === 2)
        assert.equal(
          await page.getByText(/NAV_OUTPUT_2_START/).count(),
          1,
          "The streamed prefix must remain in the protected final answer after navigation"
        )
      // Last-token visibility precedes runtime finalization and timing persistence.
      await page.getByRole("button", { name: "停止生成", exact: true }).waitFor({ state: "hidden" })
      const end = Date.now() + 15000
      let history: unknown = []
      let settled = false
      let previousCompleteSnapshot: string | undefined
      while (Date.now() < end) {
        history = await page.evaluate((id) => window.api.threads.getMessages(id), ids[0])
        const candidates = (
          history as Array<{
            role: string
            content: unknown
            start_at?: string | Date
            end_at?: string | Date
          }>
        ).filter(
          (row) =>
            row.role === "assistant" && messageText(row.content).includes(`NAV_OUTPUT_${turn}_DONE`)
        )
        const final = candidates.length === 1 ? candidates[0] : undefined
        const timestamp = (value: string | Date | undefined) =>
          value instanceof Date
            ? value.getTime()
            : typeof value === "string"
              ? Date.parse(value)
              : NaN
        const start = timestamp(final?.start_at)
        const finish = timestamp(final?.end_at)
        const snapshot = JSON.stringify(history)
        const complete =
          completed.includes(turn) &&
          Number.isFinite(start) &&
          Number.isFinite(finish) &&
          finish >= start
        if (complete && snapshot === previousCompleteSnapshot) {
          settled = true
          break
        }
        previousCompleteSnapshot = complete ? snapshot : undefined
        await pause(100)
      }
      const rows = history as Array<{ id: string; content: unknown }>
      // Persist the actual IPC result before asserting, including the failing turn.
      writeFileSync(join(artifacts, `history-turn-${turn}.json`), JSON.stringify(rows, null, 2))
      assert(settled, `Turn ${turn} must finish and persist complete stable timing metadata`)
      const tokens = rows.flatMap(
        (row) =>
          messageText(row.content).match(/NAV_(?:INPUT_\d+|OUTPUT_\d+_(?:START|DONE))/g) ?? []
      )
      for (let prior = 1; prior <= turn; prior++) {
        for (const marker of [
          `NAV_INPUT_${prior}`,
          `NAV_OUTPUT_${prior}_START`,
          `NAV_OUTPUT_${prior}_DONE`
        ])
          assert.equal(
            tokens.filter((token) => token === marker).length,
            1,
            `Persisted marker unique: ${marker}`
          )
      }
      assert.deepEqual(
        rows.slice(0, previous.length),
        previous,
        "Persisted previous history, order and every metadata field must remain identical"
      )
      previous = rows
    }
    evidence.persistedHistory = previous
    await composer.fill("NAV_A_UNSENT_DRAFT")
    // The removed send-mode menu is now an explicit preset in task-progress settings.
    // Opening/closing these views must preserve the draft without starting a task.
    const preset = await openModsFlowPreset(page)
    assert.equal(await preset.inputValue(), "")
    assert.equal(await preset.locator("option:checked").innerText(), "普通聊天，不使用步骤")
    assert.equal((await page.evaluate((id) => window.api.mods.flowRuns(id), ids[0])).length, 0)
    await openModsProgress(page, "当前任务")
    await closeModsProgress(page)
    assert.equal(await composer.inputValue(), "NAV_A_UNSENT_DRAFT")
    await page.getByRole("tab", { name: "项目模式", exact: true }).click()
    assert.equal(
      await page.getByRole("tab", { name: "项目模式", exact: true }).getAttribute("aria-selected"),
      "true"
    )
    // This fresh profile must acknowledge the actual first-entry modal before switching back.
    const projectGuide = page.getByRole("dialog", { name: "项目模式使用引导", exact: true })
    await projectGuide.getByRole("button", { name: "知道了，不再提示", exact: true }).click()
    await projectGuide.waitFor({ state: "hidden" })
    await page.getByRole("tab", { name: "对话模式", exact: true }).click()
    assert.equal(
      await page.getByRole("tab", { name: "对话模式", exact: true }).getAttribute("aria-selected"),
      "true"
    )
    await page.getByText("NAV_CHAT_A", { exact: true }).first().click()
    await page
      .getByText(/NAV_OUTPUT_10_DONE/)
      .first()
      .waitFor()
    assert.equal(await page.getByText(/NAV_OUTPUT_10_DONE/).count(), 1)
    assert.deepEqual(
      await page.evaluate((id) => window.api.threads.getMessages(id), ids[0]),
      previous
    )
    assert.equal(
      (await page.evaluate((id) => window.api.threads.getMessages(id), ids[1])).length,
      0
    )
    await pause(500)
    assert.deepEqual(requests, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.deepEqual(failures, [])
    assert.equal(expired, false)
    await page.screenshot({ path: join(artifacts, "navigation-final.png") })
    evidence.asarAfter = hash()
    assert.equal(evidence.asarAfter, evidence.asarBefore)
    evidence.passed = true
  } catch (error) {
    evidence.stack = error instanceof Error ? error.stack : undefined
    try {
      const page = app?.windows()[0]
      if (page) await page.screenshot({ path: join(artifacts, "failure.png") })
    } catch (screenshotError) {
      evidence.screenshotError = String(screenshotError)
      console.error("Navigation failure screenshot failed:", screenshotError)
    }
    throw error
  } finally {
    clearTimeout(watchdog)
    releaseSlowStream.resolve()
    try {
      if (app) await app.close()
    } catch (closeError) {
      closeFailure = { error: closeError }
      evidence.closeError = String(closeError)
      console.error("Closing navigation runtime failed:", closeError)
    }
  }
  if (closeFailure) throw closeFailure.error
}
main()
  .catch((error) => {
    console.error(error)
    evidence.passed = false
    evidence.error = String(error)
    evidence.stack ??= error instanceof Error ? error.stack : undefined
    process.exitCode = 1
  })
  .finally(() => {
    evidence.requests = requests
    evidence.completed = completed
    evidence.failures = failures
    writeFileSync(join(artifacts, "report.json"), JSON.stringify(evidence, null, 2))
    server.closeAllConnections()
    server.close()
  })
