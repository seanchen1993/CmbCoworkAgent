/** Production Electron renderer with an interrupted work item in an isolated Bot database. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { _electron } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { NativeSqliteAdapter } from "../src/main/db/native-sqlite-adapter"
import { botTestAppOutput } from "./support/bot-test-app"

function seedInterruptedWork(database: string) {
  const db = new NativeSqliteAdapter(new DatabaseSync(database))
  try {
    const store = new BotStore(db)
    const bot = store.create({ name: "报表助手", instructions: "", color: "#895bdf", modelRef: null })
    const request = store.enqueue({ botId: bot.id, requestId: "setup", message: "整理今天的报表" })
    store.transition(request.id, "running")
    store.transition(request.id, "completed")
    const { work, task } = store.createWork({
      botId: bot.id, operationId: "daily-report", title: "查看今日报表", goal: "整理今日报表。"
    })
    store.transition(task.id, "running")
    store.transition(task.id, "interrupted")
    return { bot, work }
  } finally {
    db.close()
  }
}

async function main() {
  const out = botTestAppOutput()
  const dir = await mkdtemp(join(tmpdir(), "bot-work-attention-"))
  const profile = join(dir, "profile")
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    await mkdir(join(profile, "bots"), { recursive: true })
    const { bot, work } = seedInterruptedWork(join(profile, "bots", "control.sqlite"))
    const env = Object.fromEntries(["PATH", "HOME", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"].filter(k => process.env[k]).map(k => [k, process.env[k]!]))
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as string,
      args: [join(out, "main/index.js"), "--user-data-dir=" + join(dir, "electron")],
      env: { ...env, CMB_COWORK_AGENT_HOME: profile, CMB_TASK_CARDS_MOCK: "1", CMB_E2E_DISABLE_GPU: "1",
        HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NODE_USE_ENV_PROXY: "1" }
    })
    await app.context().route(/^https?:/, route => route.abort())
    const page = await app.firstWindow()
    await page.getByText("新任务", { exact: true }).first().waitFor()
    await page.evaluate(async ({ bot, work }) => {
      await window.api.bots.open(bot.id, work.id)
      await window.api.bots.open(bot.id)
      await window.api.threads.appendMessages(bot.threadId, [{
        id: "layout-reply", role: "assistant", content: "报表任务已中断，你可以打开任务查看详情。", created_at: new Date()
      }])
    }, { bot, work })
    await page.getByText("Bots", { exact: true }).first().click()
    await page.locator(".bots-sidebar").getByText(bot.name, { exact: true }).first().click()
    const main = page.locator(".bots-conversation")
    const header = main.locator(".bot-personal-header")
    const card = main.locator(".bot-task-attention")
    const row = card.getByRole("button", { name: /查看今日报表.*执行已中断/ })
    await row.waitFor()
    await main.locator(`[data-chat-thread-id="${bot.threadId}"]`).waitFor()
    await main.getByText("报表任务已中断，你可以打开任务查看详情。", { exact: true }).waitFor()
    for (const width of [1280, 1000]) {
      await page.setViewportSize({ width, height: 760 })
      const head = await header.boundingBox(), notice = await card.boundingBox()
      assert.ok(head && notice)
      const gap = notice.y - head.y - head.height
      console.log(JSON.stringify({ width, headerHeight: head.height, gap }))
      await page.screenshot({
        path: join(out, "artifacts", `bot-work-attention-${width}.png`),
        clip: { ...head, height: Math.max(head.height, notice.y + notice.height - head.y) + 12 }
      })
      assert.ok(gap >= 0, "interrupted task card overlaps the main header")
      await header.locator(".bot-title-pill").click({ trial: true })
      await header.getByRole("button", { name: /^(查看|收起)执行过程$/ }).click({ trial: true })
      await header.getByRole("button", { name: /^(打开|关闭)详情$/ }).click({ trial: true })
      await row.locator("small").click({ trial: true })
    }
    await row.locator("small").click()
    await main.locator(`[data-chat-thread-id="${work.threadId}"]`).waitFor()
    await header.getByRole("button", { name: `返回 ${bot.name} 主对话` }).click()
    await row.waitFor()
    await page.evaluate(async ({ bot, work }) => {
      const current = await window.api.bots.works!.get(bot.id, work.id)
      await window.api.bots.works!.lifecycle({ botId: bot.id, workId: work.id,
        expectedVersion: current.version, operationId: "finish-test-work", action: "complete" })
    }, { bot, work })
    await card.waitFor({ state: "detached" })
    const head = await header.boundingBox(), transcript = await main.locator(":scope > .bot-conversation-content").boundingBox()
    assert.ok(head && transcript && Math.abs(head.y - transcript.y) <= 1, "chat floats under the header once the notice is gone")
    console.log("PASS: interrupted task layout, task navigation and floating header recovery")
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
