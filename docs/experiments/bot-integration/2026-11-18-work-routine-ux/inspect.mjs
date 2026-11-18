/** Inspect the installed UI with an isolated profile. Run from the repository with Node 22 and --import tsx. */
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const require = createRequire(join(process.cwd(), "package.json"))
const { _electron } = require("playwright")
const { BotStore } = require("./src/main/bots/store.ts")
const { NativeSqliteAdapter } = require("./src/main/db/native-sqlite-adapter.ts")
const out = require("./tests/support/bot-test-app.ts").botTestAppOutput()
await mkdir(join(out, "artifacts"), { recursive: true })
const artifacts = await mkdtemp(join(out, "artifacts", "work-routine-ux-"))
console.log("Audit artifacts", artifacts)
const dir = await mkdtemp(join(tmpdir(), "work-routine-ux-"))
const profile = join(dir, "profile")
await mkdir(join(profile, "bots"), { recursive: true })

function seed() {
  const db = new NativeSqliteAdapter(new DatabaseSync(join(profile, "bots", "control.sqlite")))
  try {
    const store = new BotStore(db)
    const bot = store.create({
      name: "交付助手",
      instructions: "",
      color: "#30877a",
      modelRef: null
    })
    const intro = store.introduce(bot.id)
    store.transition(intro.id, "running")
    store.transition(intro.id, "completed")
    const { work, task } = store.createWork({
      botId: bot.id,
      operationId: "audit-work",
      title: "准备周会摘要",
      goal: "整理本周进展，给出待决事项和负责人。"
    })
    store.transition(task.id, "running")
    store.transition(task.id, "completed")
    for (const name of ["每周交付回顾", "发布检查", "跟进待办", "周报整理", "里程碑复核"]) {
      store.saveSchedule(
        bot.id,
        {
          name,
          message: "整理需要跟进的事项。",
          frequency: "weekly",
          weekday: 5,
          runAtTime: "17:00",
          enabled: false
        },
        null,
        undefined,
        undefined,
        { workId: work.id, operationId: "schedule-" + name }
      )
    }
    return { bot, work }
  } finally {
    db.close()
  }
}

const { bot, work } = seed()
let app
const observation = {}
try {
  const env = Object.fromEntries(
    ["PATH", "HOME", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]])
  )
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [join(out, "main/index.js"), "--user-data-dir=" + join(dir, "electron")],
    env: {
      ...env,
      CMB_COWORK_AGENT_HOME: profile,
      CMB_TASK_CARDS_MOCK: "1",
      CMB_E2E_DISABLE_GPU: "1",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NODE_USE_ENV_PROXY: "1"
    }
  })
  await app.context().route(/^https?:/, (route) => route.abort())
  const page = await app.firstWindow()
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.setDefaultTimeout(10000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByText("新任务", { exact: true }).first().waitFor()
  const target = await page.evaluate(
    async ({ bot, work }) => {
      const api = window.api
      await api.bots.open(bot.id, work.id)
      await api.bots.open(bot.id)
      const schedules = (await api.bots.snapshot()).schedules.filter((s) => s.botId === bot.id)
      const schedule = schedules[4]
      const now = new Date()
      await api.threads.appendMessages(bot.threadId, [
        {
          id: "ux-user",
          role: "user",
          content: "请把「" + schedule.name + "」安排成每周例行任务。",
          created_at: now
        },
        {
          id: "ux-tool-call",
          role: "assistant",
          content: "",
          tool_calls: [{ id: "ux-save", name: "bot_schedule", args: { action: "save" } }],
          created_at: now
        },
        {
          id: "ux-result",
          role: "tool",
          name: "bot_schedule",
          tool_call_id: "ux-save",
          content: JSON.stringify(schedule),
          created_at: now
        },
        {
          id: "ux-report",
          role: "assistant",
          content: "已安排「" + schedule.name + "」。",
          created_at: now
        }
      ])
      return { id: schedule.id, name: schedule.name }
    },
    { bot, work }
  )
  await page.getByText("Bots", { exact: true }).first().click()
  await page.locator(".bots-sidebar").getByText(bot.name, { exact: true }).first().click()
  const pane = page.getByRole("complementary", { name: "Bot 详情" })
  const tasks = pane.getByRole("region", { name: "任务", exact: true })
  const schedules = pane.getByRole("region", { name: "例行任务", exact: true })
  const receipt = page.getByRole("button", { name: "查看例行任务：" + target.name, exact: true })
  await receipt.waitFor()
  await pane.getByRole("button", { name: "关闭详情", exact: true }).click()
  await receipt.click()
  await schedules.waitFor()
  observation.receipt = {
    panelOpen: true,
    targetOpened: (await page.getByRole("dialog").count()) > 0,
    targetInList: (await schedules.getByText(target.name, { exact: true }).count()) > 0,
    visibleRoutines: await schedules.locator(".bot-schedule-summary").count()
  }
  console.log("Receipt", observation.receipt)
  await page.screenshot({ path: join(artifacts, "routine-receipt.png"), animations: "disabled" })
  await tasks.getByRole("button", { name: "添加任务" }).click()
  const name = tasks.getByLabel("任务名称", { exact: true })
  await name.waitFor()
  observation.createFocus = await name.evaluate((el) => el === document.activeElement)
  await name.fill("整理反馈")
  await tasks.getByLabel("交办目标").fill("汇总各团队的意见。")
  await tasks.screenshot({ path: join(artifacts, "work-create.png") })
  await name.press("Escape")
  observation.createEscapeDismissed = !(await name.isVisible())
  if (await name.isVisible()) await tasks.getByRole("button", { name: "取消" }).click()
  const row = tasks.locator('[data-work-id="' + work.id + '"]')
  await row.hover()
  await tasks.getByRole("button", { name: "预览任务：" + work.title }).click()
  const preview = page.getByLabel("任务预览", { exact: true })
  await preview.getByRole("button", { name: "打开聊天" }).waitFor()
  await preview.screenshot({ path: join(artifacts, "work-preview.png") })
  await page.getByRole("button", { name: "返回任务列表" }).click()
  await row.click()
  const main = page.locator(".bots-conversation")
  const back = main
    .locator(".bot-personal-header")
    .getByRole("button", { name: "返回 " + bot.name + " 主对话", exact: true })
  await back.waitFor()
  await main.getByRole("button", { name: "任务更多操作" }).waitFor()
  observation.taskBackButtons = await main
    .getByRole("button", { name: /返回.*主对话/ })
    .evaluateAll((nodes) =>
      nodes.map((el) => ({
        text: el.textContent.trim(),
        accessibleName: el.getAttribute("aria-label") ?? el.textContent.trim()
      }))
    )
  const h = await main.locator(".bot-personal-header").boundingBox()
  const t = await main.locator(".bot-task-toolbar").boundingBox()
  await page.screenshot({
    path: join(artifacts, "work-header.png"),
    clip: { x: h.x, y: h.y, width: h.width, height: t.y + t.height - h.y + 2 }
  })
  await back.click()
  await schedules.getByRole("button", { name: "展开其余 1 项" }).click()
  const targetRow = schedules.locator(".bot-schedule-row").filter({ hasText: target.name })
  const change = async (label, enabled) => {
    await targetRow.getByRole("button", { name: label }).click()
    await page.waitForFunction(
      async ({ id, enabled }) =>
        (await window.api.bots.snapshot()).schedules.find((s) => s.id === id)?.enabled === enabled,
      { id: target.id, enabled }
    )
  }
  await change("启用例行任务", true)
  await change("暂停例行任务", false)
  await targetRow.getByRole("button", { name: "编辑例行任务" }).click()
  const editor = page.getByRole("dialog", { name: "编辑例行任务" })
  await editor.getByRole("combobox", { name: "重复" }).click()
  await page.getByRole("option", { name: "仅一次" }).click()
  await editor.locator('input[type="datetime-local"]').fill("2099-12-24T17:00")
  await editor.screenshot({ path: join(artifacts, "routine-editor.png"), animations: "disabled" })
  await editor.getByRole("button", { name: "保存", exact: true }).click()
  await page.waitForFunction(
    async (id) =>
      (await window.api.bots.snapshot()).schedules.find((s) => s.id === id)?.frequency === "once",
    target.id
  )
  await targetRow.getByRole("button", { name: "编辑例行任务" }).click()
  // Record which confirmation is invoked and choose cancel in the temporary profile.
  await page.evaluate(() => {
    window.confirm = (text) => {
      window.auditConfirmation = text
      return false
    }
  })
  await editor.getByRole("button", { name: "删除", exact: true }).click()
  observation.nativeDeleteConfirmation = await page.evaluate(() =>
    Boolean(window.auditConfirmation)
  )
  assert.equal(await editor.isVisible(), true)
  await editor.getByRole("button", { name: "取消", exact: true }).click()
  observation.pauseResumeAndEditSaved = true
  await schedules.getByRole("button", { name: "创建例行任务" }).click()
  const add = page.getByRole("dialog", { name: "创建例行任务" })
  const scheduleName = add.getByRole("textbox", { name: "名称", exact: true })
  await scheduleName.waitFor()
  observation.routineCreateFocus = await scheduleName.evaluate(
    (el) => el === document.activeElement
  )
  await scheduleName.press("Escape")
  await add.waitFor({ state: "detached" })
  await schedules.getByRole("button", { name: "创建例行任务" }).click()
  await scheduleName.fill("核对计划")
  await add.getByRole("textbox", { name: "工作内容" }).fill("整理本周需要核对的三项计划。")
  await add.getByRole("combobox", { name: "重复" }).click()
  await page.getByRole("option", { name: "仅一次" }).click()
  await add.locator('input[type="datetime-local"]').fill("2099-12-25T17:00")
  await add.getByRole("button", { name: "保存", exact: true }).click()
  await add.waitFor({ state: "detached" })
  await page.waitForFunction(async () =>
    (await window.api.bots.snapshot()).schedules.some(
      (s) => s.name === "核对计划" && s.frequency === "once"
    )
  )
  observation.routineCreatedAndEscWorks = true
  await row.click()
  await main.getByRole("button", { name: "完成任务", exact: true }).click()
  await main.getByRole("button", { name: "继续处理", exact: true }).waitFor()
  observation.workCompleted = true
  await back.click()
  await tasks.getByRole("button", { name: "添加任务" }).click()
  await name.fill("核对交付")
  await tasks.getByLabel("交办目标").fill("核对交付清单。")
  await tasks.getByRole("button", { name: "交办任务", exact: true }).click()
  await page
    .getByLabel("任务预览", { exact: true })
    .getByText("核对交付", { exact: true })
    .waitFor()
  observation.workCreatedAndPreviewed = true
  assert.deepEqual(errors, [])
  console.log(JSON.stringify(observation, null, 2))
  await writeFile(join(artifacts, "observations.json"), JSON.stringify(observation, null, 2) + "\n")
} finally {
  await app?.close()
  await rm(dir, { recursive: true, force: true })
}
