/** Real desktop renderer and local Bot store. All names, tasks and bindings are fixtures. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { _electron, type Locator } from "playwright"
import { botImScopeId } from "../src/main/bots/im-gateway-store"
import { BotStore } from "../src/main/bots/store"
import { NativeSqliteAdapter } from "../src/main/db/native-sqlite-adapter"
import { botTestAppOutput } from "./support/bot-test-app"
import { waitForBotAppState } from "./support/bot-app-state"

function seed(database: string) {
  const db = new NativeSqliteAdapter(new DatabaseSync(database))
  try {
    const store = new BotStore(db)
    const bot = store.create({ name: "小泽", instructions: "整理产品反馈，跟进每周交付。", color: "#188a81", modelRef: null })
    const other = store.create({ name: "小青", instructions: "", color: "#5681c8", modelRef: null })
    for (const id of [bot.id, other.id]) {
      const intro = store.introduce(id)!
      store.transition(intro.id, "running")
      store.transition(intro.id, "completed")
    }
    const titles = ["整理产品反馈", "准备演示材料", "已交付的周报"]
    const works = titles.map((title, i) => {
      const { work, task } = store.createWork({ botId: bot.id, operationId: "work-" + i, title, goal: title })
      store.transition(task.id, "running")
      store.transition(task.id, "completed")
      return work
    })
    const finished = store.getWork(bot.id, works[2].id)
    store.changeWork(bot.id, finished.id, finished.version, "finish-weekly", "complete")
    store.saveSchedule(bot.id, { name: "每周交付回顾", message: "整理本周交付。", frequency: "weekly",
      weekday: 5, runAtTime: "17:00", enabled: false }, null, undefined, undefined,
      { workId: works[0].id, operationId: "schedule-weekly" })
    for (const [i, name] of ["发布检查", "每周复盘", "清点待办", "汇总反馈"].entries()) {
      store.saveSchedule(bot.id, { name, message: name, frequency: "weekly", weekday: 3,
        runAtTime: "17:00", enabled: false }, null, undefined, undefined,
        { workId: works[0].id, operationId: "schedule-extra-" + i })
    }
    const group = store.saveGroup({ name: "交付小组", memberIds: [bot.id, other.id] })
    const imTitle = "设计协作群"
    const route = store.imGateway.register("test", "owner", {
      id: "group-binding", botId: bot.id, kind: "group", label: imTitle, peerLabel: imTitle,
      version: 1, state: "active", conversationKey: "group-conversation",
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString()
    })
    store.im.importImBinding({ id: route.id, botId: bot.id, kind: "group", label: imTitle,
      channelKey: botImScopeId("test", "owner", "group-conversation"), version: 1 })
    const { work: groupWork, task: groupTask } = store.createWork({ botId: bot.id, operationId: "group-check",
      imConversationId: route.id, title: "核对群内演示时间", goal: "确认演示排期。" })
    store.transition(groupTask.id, "running")
    store.transition(groupTask.id, "completed")
    const routeB = store.imGateway.register("test", "owner", {
      ...route.binding, id: "group-binding-b", label: "资料协作群", peerLabel: "资料协作群", conversationKey: "group-b"
    })
    store.im.importImBinding({ id: routeB.id, botId: bot.id, kind: "group", label: "资料协作群",
      channelKey: botImScopeId("test", "owner", "group-b"), version: 1 })
    const sameName = [undefined, route.id, routeB.id].map((imConversationId, index) => {
      const marker = ["个人核对结论", "设计组核对结论", "资料组核对结论"][index]
      const { work, task } = store.createWork({ botId: bot.id, operationId: "isolation-" + index,
        title: "同名周报", goal: marker, imConversationId })
      store.transition(task.id, "running")
      store.transition(task.id, "completed")
      return { id: work.id, threadId: work.threadId, marker }
    })
    return { bot, work: works[0], finished, group, imTitle, groupWork, sameName }
  } finally {
    db.close()
  }
}

async function checkCards(pane: Locator, labels: string[], screenshot: string) {
  const stack = pane.locator(".bot-detail-cards")
  const cards = await stack.locator(":scope > *").evaluateAll(nodes => nodes.map(node => {
    const element = node as HTMLElement
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return {
      label: element.getAttribute("aria-label") ?? element.querySelector("summary")?.textContent?.trim(),
      left: rect.left, width: rect.width, border: style.borderTopWidth, radius: style.borderRadius,
      background: style.backgroundColor, overflow: element.scrollWidth - element.clientWidth
    }
  }))
  assert.deepEqual(cards.map(card => card.label), labels)
  for (const card of cards) {
    assert.equal(card.border, "1px", card.label)
    assert.ok(parseFloat(card.radius) > 0 && card.radius === cards[0].radius, card.label)
    assert.equal(card.background, cards[0].background, card.label)
    assert.ok(Math.abs(card.left - cards[0].left) < 1 && Math.abs(card.width - cards[0].width) < 1, card.label)
    assert.ok(card.overflow <= 1, card.label)
  }
  // Capture the viewport the user actually sees, including identity and navigation.
  const inFirstScreen = await pane.evaluate(aside => {
    const card = aside.querySelector(".bot-detail-card")!.getBoundingClientRect()
    const view = aside.getBoundingClientRect()
    return card.top >= view.top && card.bottom <= view.bottom
  })
  assert.ok(inFirstScreen, "settings completely visible on entry")
  const samples = await pane.evaluate(aside => {
    const ctx = document.createElement("canvas").getContext("2d")!
    return [
      [".bot-detail-row-copy small", ".bot-detail-card"],
      ['[role="tab"][data-state="inactive"]', ".bot-detail-tabs"]
    ].map(([text, background]) => [
      getComputedStyle(aside.querySelector(text)!).color,
      getComputedStyle(aside.querySelector(background)!).backgroundColor
    ].map(color => {
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 1, 1)
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
    }))
  })
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map(byte => {
      const s = byte / 255
      return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
    })
    return .2126 * r + .7152 * g + .0722 * b
  }
  const contrast = samples.map(colors => {
    const [fg, bg] = colors.map(luminance)
    return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05)
  })
  assert.ok(contrast.every(ratio => ratio >= 4.5), "readable secondary labels and inactive tabs")
  console.log("Secondary text and tab contrast", contrast.map(ratio => ratio.toFixed(2)))
  await pane.screenshot({ path: screenshot, animations: "disabled" })
  console.log("PASS: " + labels.join(" / ") + " (" + Math.round(cards[0].width) + "px)")
}

async function main() {
  const out = botTestAppOutput()
  const dir = await mkdtemp(join(tmpdir(), "bots-details-cards-"))
  const profile = join(dir, "profile")
  const artifacts = join(out, "artifacts")
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    await mkdir(join(profile, "bots"), { recursive: true })
    await mkdir(artifacts, { recursive: true })
    const { bot, work, finished, group, imTitle, groupWork, sameName } = seed(join(profile, "bots", "control.sqlite"))
    const env = Object.fromEntries(["PATH", "HOME", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]
      .filter(key => process.env[key]).map(key => [key, process.env[key]!]))
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as string,
      args: [join(out, "main/index.js"), "--user-data-dir=" + join(dir, "electron")],
      env: { ...env, CMB_COWORK_AGENT_HOME: profile, CMB_TASK_CARDS_MOCK: "1", CMB_E2E_DISABLE_GPU: "1",
        HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NODE_USE_ENV_PROXY: "1" }
    })
    await app.context().route(/^https?:/, route => route.abort())
    const page = await app.firstWindow()
    page.on("pageerror", error => console.error("Renderer:", error.message))
    page.setDefaultTimeout(12_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByText("新任务", { exact: true }).first().waitFor()
    await page.evaluate(async ({ id, works }) => {
      for (const work of works) {
        await window.api.bots.open(id, work.id)
        await window.api.threads.appendMessages(work.threadId, [{
          id: "answer-" + work.id, role: "assistant", content: work.marker + "已完成", created_at: new Date()
        }])
      }
    }, { id: bot.id, works: sameName })
    const fifthRoutine = await page.evaluate(async ({ id, threadId }) => {
      const api = window.api
      await api.bots.open(id)
      const routines = (await api.bots.snapshot()).schedules.filter(item => item.botId === id)
      const target = routines[4]
      const now = new Date()
      await api.threads.appendMessages(threadId, [
        { id: "routine-request", role: "user", content: "请把这件事安排成例行任务。", created_at: now },
        { id: "routine-call", role: "assistant", content: "", created_at: now,
          tool_calls: [{ id: "routine-save", name: "bot_schedule", args: { action: "save" } }] },
        { id: "routine-receipt", role: "tool", name: "bot_schedule", tool_call_id: "routine-save",
          content: JSON.stringify(target), created_at: now },
        { id: "routine-reply", role: "assistant", content: "例行任务已安排。", created_at: now }
      ])
      return { id: target.id, name: target.name, initialIds: routines.map(item => item.id) }
    }, { id: bot.id, threadId: bot.threadId })
    await page.getByText("Bots", { exact: true }).first().click()
    const sidebar = page.locator(".bots-sidebar")
    await sidebar.getByText(bot.name, { exact: true }).first().click()
    const pane = page.getByRole("complementary", { name: "Bot 详情" })
    const tasks = pane.getByRole("region", { name: "任务", exact: true })
    const settings = pane.getByRole("region", { name: "Bot 设置" })
    for (const [index, current] of sameName.entries()) {
      if (index) await sidebar.getByRole("button", { name: "招乎群聊：" + (index === 1 ? imTitle : "资料协作群") }).click()
      const targetPane = index ? page.getByRole("complementary", { name: "招乎群详情" }) : pane
      const row = targetPane.locator('[data-work-id="' + current.id + '"]')
      const body = row.getByRole("button", { name: "预览任务：同名周报" })
      const arrow = row.getByRole("button", { name: "进入任务：同名周报" })
      await arrow.waitFor()
      assert.equal(await targetPane.getByText("同名周报", { exact: true }).count(), 1)
      const origin = index ? page.getByLabel((index === 1 ? imTitle : "资料协作群") + "消息记录", { exact: true })
        : page.locator('[data-chat-thread-id="' + bot.threadId + '"]')
      await origin.waitFor()
      if (index === 0) await body.getByText("同名周报", { exact: true }).click()
      if (index === 1) await body.locator("small").click()
      if (index === 2) await body.locator(".bot-work-state-icon").click()
      const preview = page.getByRole("region", { name: "任务预览" })
      await preview.getByText(current.marker + "已完成", { exact: true }).waitFor()
      assert.ok(await origin.isVisible(), "预览时保留原主对话")
      for (const foreign of sameName.filter(w => w !== current)) {
        assert.equal(await targetPane.locator('[data-work-id="' + foreign.id + '"]').count(), 0)
        assert.ok(!(await preview.innerText()).includes(foreign.marker))
      }
      await preview.screenshot({ path: join(artifacts, "scope-preview-" + index + ".png") })
      if (index === 1) {
        await preview.getByRole("button", { name: "打开聊天", exact: true }).click()
        const back = page.getByRole("button", { name: "返回群聊「" + imTitle + "」" })
        await back.waitFor()
        await page.locator("main").getByText(current.marker + "已完成", { exact: true }).first().waitFor()
        await back.click()
        await targetPane.getByRole("button", { name: "前往私人主对话" }).waitFor()
      } else {
        await preview.getByRole("button", { name: /返回任务列表|关闭任务预览/ }).click()
      }
    }
    await sidebar.getByText(bot.name, { exact: true }).first().click()
    console.log("PASS: three identically named tasks, each preview reads only its own original thread")
    const search = tasks.getByRole("button", { name: "搜索任务" })
    const taskRow = tasks.locator('[data-work-id="' + work.id + '"]')
    await taskRow.waitFor()
    assert.equal(await tasks.getByText(groupWork.title, { exact: true }).count(), 0)
    const schedules = pane.getByRole("region", { name: "例行任务" })
    await schedules.locator(".bot-schedule-row").first().waitFor()
    const privateLabels = ["Bot 设置", "任务", "例行任务", "最近活动"]
    await checkCards(pane, privateLabels, join(artifacts, "bot-details-private.png"))
    assert.equal(await schedules.locator(".bot-schedule-row").count(), 4)
    await schedules.getByRole("button", { name: "展开其余 1 项" }).click()
    assert.equal(await schedules.locator(".bot-schedule-row").count(), 5)
    await schedules.getByText("每周交付回顾", { exact: true }).waitFor()
    await schedules.getByRole("button", { name: "收起例行任务" }).click()
    const firstRoutine = schedules.getByRole("button", { name: "编辑例行任务", exact: true }).first()
    await firstRoutine.click()
    await page.getByRole("dialog", { name: "编辑例行任务" }).getByRole("button", { name: "取消", exact: true }).click()
    await page.waitForFunction(() => document.activeElement === document.querySelector(".bot-schedule-summary"))
    assert.equal(await schedules.getByText(fifthRoutine.name, { exact: true }).count(), 0)
    const receipt = page.getByRole("button", { name: "查看例行任务：" + fifthRoutine.name, exact: true })
    await pane.getByRole("button", { name: "关闭详情", exact: true }).click()
    await receipt.click()
    const editor = page.getByRole("dialog", { name: "编辑例行任务", exact: true })
    const nameField = editor.getByRole("textbox", { name: "名称", exact: true })
    assert.equal(await nameField.inputValue(), fifthRoutine.name)
    await page.screenshot({ path: join(artifacts, "routine-receipt-target.png"), animations: "disabled" })
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.activeElement?.classList.contains("bot-routine-link"))
    await receipt.click()
    await page.evaluate(async ({ botId, id }) => {
      const api = window.api.bots
      const current = (await api.snapshot()).schedules.find(item => item.id === id)!
      await api.saveSchedule(botId, { ...current, message: "其他窗口刚刚保存的工作内容" }, { id, version: current.version })
    }, { botId: bot.id, id: fifthRoutine.id })
    await editor.getByRole("button", { name: "删除", exact: true }).click()
    await page.getByRole("button", { name: "确认删除", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "例行任务已改变" }).waitFor()
    await page.keyboard.press("Escape")
    await editor.getByRole("button", { name: "取消", exact: true }).click()
    await receipt.click()
    assert.equal(await editor.getByRole("textbox", { name: "工作内容" }).inputValue(), "其他窗口刚刚保存的工作内容")
    await nameField.fill("已改名的例行任务")
    await editor.getByRole("button", { name: "保存", exact: true }).click()
    await waitForBotAppState(page, async id => (await window.api.bots.snapshot()).schedules.find(s => s.id === id)?.name === "已改名的例行任务", fifthRoutine.id)
    await receipt.click()
    assert.equal(await nameField.inputValue(), "已改名的例行任务")
    await nameField.fill("未保存的草稿")
    let nativeDialogs = 0
    page.on("dialog", async dialog => { nativeDialogs++; await dialog.dismiss() })
    await editor.getByRole("button", { name: "删除", exact: true }).click()
    const confirmation = page.getByRole("dialog", { name: "删除例行任务？", exact: true })
    await confirmation.getByText("将删除「已改名的例行任务」。此操作不可撤销。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("dialog").count(), 1)
    await page.waitForFunction(() => document.activeElement?.textContent === "取消")
    await confirmation.screenshot({ path: join(artifacts, "routine-delete-inline.png"), animations: "disabled" })
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "删除")
    assert.equal(await nameField.inputValue(), "未保存的草稿")
    await editor.getByRole("button", { name: "删除", exact: true }).click()
    await confirmation.getByRole("button", { name: "取消", exact: true }).click()
    assert.equal(await nameField.inputValue(), "未保存的草稿")
    await editor.getByRole("button", { name: "删除", exact: true }).click()
    await confirmation.getByRole("button", { name: "确认删除", exact: true }).click()
    await receipt.waitFor({ state: "detached" })
    const remaining = await page.evaluate(async id => (await window.api.bots.snapshot()).schedules.filter(s => s.botId === id).map(s => s.id), bot.id)
    assert.deepEqual(remaining.sort(), fifthRoutine.initialIds.filter(id => id !== fifthRoutine.id).sort())
    assert.equal(nativeDialogs, 0)
    await page.getByRole("button", { name: "打开详情", exact: true }).click()
    console.log("PASS: fifth routine receipt opens its live schedule, restores focus, saves edits and removes exactly that schedule after inline confirmation")
    assert.deepEqual(await settings.getByRole("button").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label"))),
      ["职责与设置", "管理记忆", "招乎接入"])
    assert.equal(await pane.getByText("编辑职责", { exact: true }).count(), 0)
    await search.click()
    const input = tasks.getByRole("textbox", { name: "搜索任务" })
    await input.fill("没有这项工作")
    await tasks.getByText("没有匹配的任务").waitFor()
    await input.fill(work.title)
    await taskRow.waitFor()
    await input.press("Escape")
    await input.waitFor({ state: "detached" })
    assert.equal(await search.evaluate(el => el === document.activeElement), true)
    const completed = tasks.getByRole("button", { name: /^已完成/ })
    await completed.click()
    await tasks.getByText(finished.title, { exact: true }).waitFor()
    await completed.click()
    const previewButton = taskRow.getByRole("button", { name: "预览任务：" + work.title })
    // Padding near the top-left is part of the preview button, even before hovering.
    await previewButton.click({ position: { x: 3, y: 3 } })
    await page.getByRole("button", { name: "返回任务列表" }).click()
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("预览任务："))
    await previewButton.press("Space")
    await page.getByRole("button", { name: "返回任务列表" }).click()
    await previewButton.press("Tab")
    const enter = taskRow.getByRole("button", { name: "进入任务：" + work.title })
    assert.ok(await enter.evaluate(el => el === document.activeElement))
    await enter.press("Enter")
    await page.locator('[data-chat-thread-id="' + work.threadId + '"]').waitFor()
    const taskHeader = page.locator(".bot-personal-header[data-task]")
    await taskHeader.getByRole("button", { name: "任务更多操作" }).waitFor()
    assert.equal(await page.getByRole("region", { name: "任务预览" }).count(), 0)
    await tasks.getByRole("button", { name: "预览任务：同名周报" }).click()
    const adjacentPreview = page.getByRole("region", { name: "任务预览" })
    await adjacentPreview.getByText(sameName[0].marker + "已完成", { exact: true }).waitFor()
    await page.locator('[data-chat-thread-id="' + work.threadId + '"]').waitFor()
    await adjacentPreview.getByRole("button", { name: "返回任务列表" }).click()
    assert.equal(await page.locator(".bots-conversation").getByRole("button", { name: /返回.*主对话/ }).count(), 1)
    await taskHeader.screenshot({ path: join(artifacts, "private-work-header.png"), animations: "disabled" })
    await taskHeader.getByRole("button", { name: "返回 " + bot.name + " 主对话" }).click()
    const addWork = tasks.getByRole("button", { name: "添加任务" })
    await addWork.click()
    const workName = tasks.getByRole("textbox", { name: "任务名称" })
    await workName.waitFor()
    assert.ok(await workName.evaluate(element => element === document.activeElement))
    await workName.press("Escape")
    await workName.waitFor({ state: "detached" })
    assert.ok(await addWork.evaluate(element => element === document.activeElement))
    await addWork.click()
    await tasks.getByRole("button", { name: "取消" }).click()
    assert.ok(await addWork.evaluate(element => element === document.activeElement))
    await pane.getByRole("button", { name: "创建例行任务" }).click()
    await page.getByRole("dialog", { name: "创建例行任务" }).waitFor()
    await page.keyboard.press("Escape")
    await settings.getByRole("button", { name: "职责与设置" }).click()
    await page.getByRole("dialog", { name: "编辑 Bot" }).waitFor()
    await page.keyboard.press("Escape")
    await settings.getByRole("button", { name: "管理记忆" }).click()
    await pane.getByRole("button", { name: "添加记忆" }).click()
    await pane.getByLabel("名称", { exact: true }).fill("周报格式")
    await pane.getByLabel("内容", { exact: true }).fill("先写进展，再写下周计划。")
    await pane.getByRole("button", { name: "保存", exact: true }).click()
    await pane.getByRole("button", { name: "编辑 周报格式" }).click()
    assert.equal((await pane.getByRole("textbox", { name: "内容", exact: true }).inputValue()).trim(), "先写进展，再写下周计划。")
    await pane.getByRole("button", { name: "取消", exact: true }).click()
    const scopeGuide = pane.getByLabel("记忆使用范围说明", { exact: true })
    await scopeGuide.waitFor()
    assert.equal(await scopeGuide.textContent(),
      "「仅私聊」限私聊，「Bot 共享」适用于此 Bot 的所有对话，「群内」限所属群。")
    const moreMemory = pane.getByRole("button", { name: "周报格式的更多操作" })
    await moreMemory.focus()
    await moreMemory.press("ArrowDown")
    await page.getByRole("menu", { exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "周报格式的更多操作")
    await moreMemory.click()
    await page.getByRole("menuitem", { name: "编辑记忆", exact: true }).click()
    assert.equal(await scopeGuide.count(), 0)
    const updatedContent = "周报先写本周结论，再列下周计划。"
    await pane.getByRole("textbox", { name: "内容", exact: true }).fill(updatedContent)
    await pane.getByRole("button", { name: "保存", exact: true }).click()
    await pane.getByText(updatedContent, { exact: true }).waitFor()
    const saved = await page.evaluate(id => window.api.bots.listMemory(id), bot.id)
    const preferences = saved.filter(entry => entry.name === "周报格式")
    assert.equal(preferences.length, 1)
    assert.equal(preferences[0].content.trim(), updatedContent)
    assert.equal(preferences[0].scope?.kind, "private")
    await moreMemory.click()
    await page.getByRole("menuitem", { name: "分享给 Bot" }).click()
    await pane.getByRole("combobox", { name: "分享记忆给 Bot" }).waitFor()
    await pane.getByRole("button", { name: "取消", exact: true }).click()
    await moreMemory.click()
    await page.getByRole("menuitem", { name: "删除记忆" }).click()
    await pane.getByRole("button", { name: "取消删除" }).click()
    await pane.screenshot({ path: join(artifacts, "bot-details-memory.png"), animations: "disabled" })
    await pane.getByRole("button", { name: "返回详情" }).click()
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "管理记忆")
    await settings.getByRole("button", { name: "招乎接入" }).click()
    await page.getByRole("dialog", { name: /招乎接入/ }).waitFor()
    await page.keyboard.press("Escape")
    const detailsTab = pane.getByRole("tab", { name: "详情", exact: true })
    await detailsTab.focus()
    await detailsTab.press("ArrowRight")
    const library = pane.getByRole("region", { name: "工作资料" })
    await library.getByRole("button", { name: "添加资料" }).waitFor()
    await library.getByRole("button", { name: "刷新资料" }).click()
    await pane.getByRole("tab", { name: "资料库" }).press("ArrowRight")
    await pane.getByRole("region", { name: "工作浏览器" }).getByRole("combobox", { name: "查看任务浏览器" }).waitFor()
    await pane.getByRole("tab", { name: "详情" }).click()
    const activity = pane.locator(".bot-detail-activity")
    await activity.locator(":scope > summary").click()
    await activity.locator(".bot-detail-activity-item > summary").first().waitFor()
    await activity.locator(":scope > summary").click()
    console.log("PASS: search and focus, completed tasks, preview and open, create, settings, memory, binding and activity")

    await page.setViewportSize({ width: 1000, height: 750 })
    await page.waitForFunction(() => Math.round(document.querySelector('.bot-details[aria-label="Bot 详情"]')!.getBoundingClientRect().width) === 260)
    await page.evaluate(() => {
      const value = JSON.stringify({ mode: "dark", lightTheme: "codex-light", darkTheme: "codex-dark" })
      localStorage.setItem("cmb:theme-settings", value)
      window.dispatchEvent(new StorageEvent("storage", { key: "cmb:theme-settings", newValue: value }))
    })
    await page.locator('html[data-theme="codex-dark"]').waitFor()
    // Switching away and back from a scrolled panel must reveal its settings.
    assert.ok(await pane.locator(".bot-details-content").evaluate(element => {
      element.scrollTop = element.scrollHeight
      return element.scrollTop > 0
    }))
    await sidebar.getByText("小青", { exact: true }).first().click()
    await sidebar.getByText(bot.name, { exact: true }).first().click()
    await taskRow.waitFor()
    await checkCards(pane, privateLabels, join(artifacts, "bot-details-compact-dark.png"))
    await sidebar.getByText(group.name, { exact: true }).first().click()
    const appGroup = page.getByRole("complementary", { name: "群聊详情" })
    await appGroup.getByRole("button", { name: "群聊设置" }).click()
    await page.getByRole("dialog", { name: "群聊设置" }).waitFor()
    await page.keyboard.press("Escape")
    await appGroup.getByRole("button", { name: "管理记忆" }).click()
    await appGroup.getByRole("combobox", { name: "查看成员记忆" }).click()
    await page.getByRole("option", { name: "小青", exact: true }).click()
    await appGroup.getByRole("region", { name: "Bot 长期记忆" }).getByText("适用于「小青」的私聊和所有群聊。").waitFor()
    await appGroup.getByRole("region", { name: "群聊可用记忆" }).waitFor()
    assert.equal(await appGroup.getByLabel("记忆使用范围说明", { exact: true }).count(), 0)
    await appGroup.getByRole("button", { name: "返回详情" }).click()
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "管理记忆")
    await appGroup.getByRole("tab", { name: "成员" }).click()
    const members = appGroup.getByRole("region", { name: "群成员" })
    assert.equal(await members.getByRole("combobox", { name: "添加成员" }).isDisabled(), true)
    assert.equal(await members.getByRole("listitem").count(), 2)
    await appGroup.screenshot({ path: join(artifacts, "bot-details-members.png"), animations: "disabled" })
    await appGroup.getByRole("tab", { name: "资料库" }).click()
    await appGroup.getByRole("region", { name: "工作资料" }).waitFor()
    await appGroup.getByRole("tab", { name: "电脑" }).click()
    await appGroup.getByRole("combobox", { name: "查看成员浏览器" }).click()
    await page.getByRole("option", { name: "小青", exact: true }).click()
    await appGroup.getByRole("tab", { name: "详情" }).click()
    await appGroup.getByRole("region", { name: "群聊设置" }).waitFor()
    await sidebar.getByRole("button", { name: "招乎群聊：" + imTitle }).click()
    const im = page.getByRole("complementary", { name: "招乎群详情" })
    const groupTasks = im.getByRole("region", { name: "群内任务" })
    await groupTasks.getByText(groupWork.title, { exact: true }).waitFor()
    assert.equal(await groupTasks.getByText(work.title, { exact: true }).count(), 0)
    await checkCards(im, ["群聊设置", "群内任务", "例行任务"], join(artifacts, "bot-details-im-group.png"))
    await im.getByText("在群里安排一项定期工作，或点击 + 创建。", { exact: true }).waitFor()
    await im.getByRole("button", { name: "添加任务" }).click()
    await im.getByPlaceholder("留空使用本群默认目录").waitFor()
    const groupWorkName = im.getByRole("textbox", { name: "任务名称" })
    assert.ok(await groupWorkName.evaluate(element => element === document.activeElement))
    await groupWorkName.press("Escape")
    await groupWorkName.waitFor({ state: "detached" })
    assert.ok(await im.getByRole("button", { name: "添加任务" }).evaluate(el => el === document.activeElement))
    await groupTasks.getByRole("button", { name: "进入任务：" + groupWork.title }).click()
    const groupReturn = taskHeader.getByRole("button", { name: "返回群聊「" + imTitle + "」" })
    assert.equal(await groupReturn.innerText(), imTitle)
    assert.equal(await taskHeader.getByRole("button", { name: /^返回/ }).count(), 1)
    await taskHeader.screenshot({ path: join(artifacts, "group-work-header.png"), animations: "disabled" })
    await groupReturn.click()
    await im.getByRole("button", { name: "前往私人主对话" }).waitFor()
    await im.getByRole("button", { name: "创建例行任务" }).click()
    const groupRoutine = page.getByRole("dialog", { name: "创建例行任务" })
    await groupRoutine.getByRole("textbox", { name: "名称", exact: true }).fill("本群周报日程")
    await groupRoutine.getByRole("textbox", { name: "工作内容" }).fill("整理本群周报")
    await groupRoutine.getByRole("button", { name: /保存|创建/ }).last().click()
    await im.getByText("本群周报日程", { exact: true }).waitFor()
    const createdRoutine = await page.evaluate(async () => (await window.api.bots.snapshot()).schedules.find(s => s.name === "本群周报日程"))
    assert.equal(createdRoutine?.audienceKey, groupWork.audienceKey)
    assert.ok(createdRoutine?.workId)
    await im.getByRole("button", { name: "管理记忆", exact: true }).click()
    await im.getByRole("button", { name: "返回详情" }).click()
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "管理记忆")
    const computer = im.getByRole("tab", { name: "电脑" })
    await computer.click()
    assert.equal(await computer.getAttribute("aria-selected"), "true")
    await im.getByRole("region", { name: "工作浏览器" }).waitFor()
    await im.getByRole("tab", { name: "详情" }).click()
    await im.getByRole("button", { name: "前往私人主对话" }).click()
    await settings.getByRole("button", { name: "职责与设置" }).waitFor()
    console.log("PASS: App group settings and member memories, IM scoped actions and return to private chat")
    if (process.argv.includes("--keep-open")) {
      await page.bringToFront()
      console.log("READY: private chat and both groups are open for manual testing on the isolated profile")
      await app.waitForEvent("close", { timeout: 0 })
    }
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
