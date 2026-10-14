/** Real packaged runtime; only a loopback model is simulated. Never replace agent IPC. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ElectronApplication } from "playwright"
import { compositionEnvironment } from "./support/mods-composition-fixtures"
import { createModsCoreLauncher } from "./support/mods-core-packaged-launch"

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
let app: ElectronApplication | undefined
let expired = false
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
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
    for (let index = 0; index < (turn === 2 ? 80 : 2); index++) {
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
        await page
          .getByText(/NAV_OUTPUT_2_START/)
          .first()
          .waitFor()
        await page.getByText("NAV_CHAT_B", { exact: true }).first().click()
        await composer.waitFor()
        assert.equal(await page.getByText(/NAV_OUTPUT_2_START/).count(), 0)
        await composer.fill("NAV_B_UNSENT_DRAFT")
        await page.getByText("NAV_CHAT_A", { exact: true }).first().click()
        await page
          .getByText(/NAV_OUTPUT_2_START/)
          .first()
          .waitFor()
        assert.equal(requests.length, 2, "Navigation must not send a task")
        assert(!completed.includes(2), "A to B to A must occur before the slow stream ends")
      }
      await page
        .getByText(new RegExp(`NAV_OUTPUT_${turn}_DONE`))
        .first()
        .waitFor()
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
        (row) => messageText(row.content).match(/NAV_(?:INPUT_\d+|OUTPUT_\d+_DONE)/g) ?? []
      )
      for (let prior = 1; prior <= turn; prior++) {
        for (const marker of [`NAV_INPUT_${prior}`, `NAV_OUTPUT_${prior}_DONE`])
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
    await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
    await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
    assert.match(
      await page.getByRole("button", { name: "选择发送方式", exact: true }).innerText(),
      /按步骤执行/
    )
    await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
    await page.getByRole("button", { name: "直接聊天", exact: true }).click()
    assert.match(
      await page.getByRole("button", { name: "选择发送方式", exact: true }).innerText(),
      /直接聊天/
    )
    assert.equal(await composer.inputValue(), "NAV_A_UNSENT_DRAFT")
    await page.getByRole("tab", { name: "项目模式", exact: true }).click()
    assert.equal(
      await page.getByRole("tab", { name: "项目模式", exact: true }).getAttribute("aria-selected"),
      "true"
    )
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
  } finally {
    clearTimeout(watchdog)
    if (app) await app.close()
  }
}
main()
  .catch((error) => {
    evidence.error = String(error)
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
