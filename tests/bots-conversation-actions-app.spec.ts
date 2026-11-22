/** Real desktop renderer, Host and SQLite. A loopback model fixture selects only the requested tool. */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { _electron } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { NativeSqliteAdapter } from "../src/main/db/native-sqlite-adapter"
import { botTestAppOutput } from "./support/bot-test-app"
import { waitForBotAppState } from "./support/bot-app-state"

async function main() {
  const out = botTestAppOutput()
  const root = await mkdtemp(join(tmpdir(), "bot-conversation-actions-"))
  const profile = join(root, "profile")
  await mkdir(join(profile, "bots"), { recursive: true })
  const db = new NativeSqliteAdapter(new DatabaseSync(join(profile, "bots/control.sqlite")))
  const store = new BotStore(db)
  const bot = store.create({ name: "任务助手", instructions: "按用户的请求管理任务。", color: "#21604f", modelRef: "custom:actions" })
  const other = store.create({ name: "另一位助手", instructions: "", color: "#876037", modelRef: "custom:actions" })
  for (const owner of [bot, other]) {
    const introduction = store.introduce(owner.id)!
    store.transition(introduction.id, "running")
    store.transition(introduction.id, "completed")
  }
  const { work, task } = store.createWork({ botId: bot.id, operationId: "fixture", title: "临时周报", goal: "草拟周报" })
  store.transition(task.id, "running")
  store.transition(task.id, "completed")
  db.close()

  const actions = new Map<string, { name: string; args: object }>()
  const receipts: string[] = []
  const errors: string[] = []
  const requests: string[] = []
  const server = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      const i = body.messages.findLastIndex((m: any) => m.role === "user" && !String(m.content).trimStart().startsWith("<bot_reply_reminder>"))
      const content = JSON.stringify(body.messages[i]?.content ?? "")
      const selected = [...actions].find(([text]) => content.includes(text))?.[1]
      const prior = body.messages.slice(i + 1).find((m: any) => m.role === "tool")
      requests.push(JSON.stringify({ message: content.slice(0, 350), tool: selected?.name, result: String(prior?.content ?? "").slice(0, 400) }))
      const call = selected && !prior ? selected : undefined
      let reply = "已就绪。"
      if (selected && prior) {
        const record = JSON.parse(prior.content)
        assert.equal(record.operation, selected.name)
        receipts.push(record.receipt.state)
        reply = "操作结果 " + record.receipt.state
      }
      const id = randomUUID()
      const finish_reason = call ? "tool_calls" : "stop"
      const delta = call ? { tool_calls: [{ id, index: 0, type: "function", function: {
        name: call.name, arguments: JSON.stringify(call.args)
      } }] } : { content: reply }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason }])
          res.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] }) + "\n\n")
        res.end("data: [DONE]\n\n")
      } else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason }]
      }))
    } catch (error) { errors.push(String(error)); res.writeHead(500).end("fixture error") }
  })
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const env = Object.fromEntries(["PATH", "HOME", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"].filter(k => process.env[k]).map(k => [k, process.env[k]!]))
    app = await _electron.launch({ executablePath: createRequire(import.meta.url)("electron") as string,
      args: [join(out, "main/index.js"), "--user-data-dir=" + join(root, "electron")],
      env: { ...env, CMB_COWORK_AGENT_HOME: profile, CMB_TASK_CARDS_MOCK: "1", CMB_E2E_DISABLE_GPU: "1",
        HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", NODE_USE_ENV_PROXY: "1" }
    })
    app.process().stdout?.resume()
    app.process().stderr?.resume()
    await app.context().route(/^https?:/, route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort())
    const page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    const nativeDialogs: string[] = []
    page.on("dialog", async dialog => { nativeDialogs.push(dialog.message()); await dialog.dismiss() })
    await page.getByText("新任务", { exact: true }).first().waitFor()
    const setup = await page.evaluate(async ({ bot, work, root, baseUrl }) => {
      ;(globalThis as any).__name = (x: unknown) => x
      const api = window.api
      await api.models.setCustomConfig({ id: "actions", name: "Local fixture", baseUrl, model: "local-fixture", apiKey: "fixture", maxTokens: 64000, maxOutputTokens: 2048 })
      await api.models.setDefault("custom:actions")
      await api.bots.open(bot.id, work.id)
      await api.bots.open(bot.id)
      const thread = await api.threads.create({ title: "原讨论", workspacePath: root, model: "custom:actions", agentMode: "normal" })
      await api.threads.appendMessages(thread.thread_id, [{
        id: "original-history", role: "user", content: "这条记录早于关联任务。", created_at: new Date()
      }])
      const ref = { kind: "local_thread" as const, threadId: thread.thread_id, incarnation: {
        token: thread.metadata?.cmb_thread_incarnation as string ?? null, legacyCreatedAt: new Date(thread.created_at).getTime()
      } }
      const linked = await api.bots.conversations!.link({ botId: bot.id, operationId: "test-link", title: "已关联工作", goal: "保留原讨论", conversation: ref })
      return { native: await api.bots.works!.get(bot.id, work.id), linked, ref }
    }, { bot, work, root, baseUrl: 'http://127.0.0.1:' + address.port + '/v1' })
    const nativeMessage = "删除「临时周报」"
    const linkedMessage = "删掉「已关联工作」这个任务"
    const ordinaryMessage = "删除普通会话「原讨论」"
    actions.set(nativeMessage, { name: "bot_work_delete", args: { requestKey: "native", workId: work.id, expectedVersion: setup.native.version } })
    actions.set(linkedMessage, { name: "bot_work_delete", args: { requestKey: "linked", workId: setup.linked.id, expectedVersion: setup.linked.version } })
    actions.set(ordinaryMessage, { name: "bot_thread_delete", args: { requestKey: "ordinary", conversation: setup.ref, expectedTitle: "原讨论" } })
    await page.getByText("Bots", { exact: true }).first().click()
    const openBot = (name: string) => page.locator(".bots-sidebar").getByText(name, { exact: true }).first().click()
    await openBot(bot.name)
    const chat = page.locator('[data-chat-thread-id="' + bot.threadId + '"]')
    const card = chat.locator(".bot-question-input")
    assert.ok(await page.evaluate(id => window.api.threads.get(id).then(Boolean), work.threadId))
    const send = async (text: string) => {
      const editor = chat.locator('textarea,[role="textbox"][contenteditable="true"]').last()
      await editor.fill(text)
      await chat.locator('button[type="submit"]').last().click()
    }
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as any).actionModals = seen
      new MutationObserver(() => {
        for (const modal of document.querySelectorAll('[role="dialog"],[role="alertdialog"]')) seen.push(modal.textContent ?? "")
      }).observe(document.body, { childList: true, subtree: true })
    })
    await send(nativeMessage)
    console.log("Sent native task deletion")
    await chat.getByText("操作结果 deleted", { exact: true }).first().waitFor()
    assert.equal(await page.evaluate(id => window.api.threads.get(id).then(Boolean), work.threadId), false)
    await send(linkedMessage)
    await card.getByText(/原讨论.*连同聊天记录一起删除/).waitFor()
    await mkdir(join(out, "artifacts"), { recursive: true })
    await card.screenshot({ path: join(out, "artifacts", "bot-conversation-action.png") })
    assert.equal(await card.locator("textarea").count(), 0)
    await openBot(other.name)
    await page.locator('[data-chat-thread-id="' + other.threadId + '"]').waitFor()
    assert.equal(await page.locator(".bot-question-input:visible").count(), 0)
    await openBot(bot.name)
    await card.getByRole("button", { name: /^仅解除关联/ }).click()
    await chat.getByText("操作结果 detached", { exact: true }).first().waitFor()
    await waitForBotAppState(page, async id => {
      const thread = await window.api.threads.get(id)
      return Boolean(thread && !thread.metadata?.botLocalConversation)
    }, setup.ref.threadId)
    await send(ordinaryMessage)
    await card.getByRole("button", { name: "保留会话", exact: true }).click()
    await chat.getByText("操作结果 cancelled", { exact: true }).first().waitFor()
    assert.ok(await page.evaluate(async id => (await window.api.threads.getMessages(id)).some(
      message => message.id === "original-history" && message.content === "这条记录早于关联任务。"), setup.ref.threadId))
    await send(ordinaryMessage)
    await card.getByRole("button", { name: "删除会话", exact: true }).click()
    await waitForBotAppState(page, async id => !(await window.api.threads.get(id)), setup.ref.threadId)
    await chat.getByText("操作结果 deleted", { exact: true }).nth(1).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).actionModals), [])
    assert.deepEqual(nativeDialogs, [])
    assert.deepEqual(receipts, ["deleted", "detached", "cancelled", "deleted"])
    assert.deepEqual(errors, [])
    console.log("PASS: direct task deletion, scoped choices across navigation, history retained on unlink/cancel, ordinary deletion, 0 global dialogs")
  } catch (error) {
    console.error("Fixture requests:", requests)
    if (app) console.error((await (await app.firstWindow()).locator("body").innerText()).slice(-3000))
    throw error
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>(done => server.close(() => done()))
    await rm(root, { recursive: true, force: true })
    if (errors.length) console.error(errors)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
