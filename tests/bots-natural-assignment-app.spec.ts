import { waitForBotAppState } from "./support/bot-app-state"
/** Opt-in real-model App journey. Only synthetic text tasks in a disposable local profile. */
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { _electron } from "playwright"
import { botTestAppOutput } from "./support/bot-test-app"
import { selectedBotRoutingModel } from "./support/bot-routing-model"

async function main() {
  const config = await selectedBotRoutingModel()
  const out = botTestAppOutput()
  const root = await mkdtemp(join(tmpdir(), "bot-natural-assignment-"))
  await chmod(root, 0o700)
  const workspace = join(root, "活动计划")
  await mkdir(workspace)
  const autonomous = process.env.BOT_TEST_AUTONOMOUS_ASSIGNMENT === "1"
  if (autonomous) {
    await writeFile(join(workspace, "活动约束.md"), "虚构读书会：周日下午三点开始，共90分钟，20人，各带一本书。必须包含签到、分组讨论和分享。预算1000元。\n")
    await writeFile(join(workspace, "场地说明.md"), "社区阅览室免费，可容纳24人，室内不受天气影响。小公园免费、容量40人，下雨时不可使用。活动中心收费300元、容量30人，有投影。\n")
    await writeFile(join(workspace, "费用.csv"), "项目,单价,数量\n饮用水,5,20\n材料,120,1\n备用金,100,1\n")
  }
  // Observe the real request without replacing model decisions or logging credentials.
  const wire: Array<{ delegationGuidance: boolean; canCreate: boolean }> = []
  const relay = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      wire.push({
        delegationGuidance: (body.messages ?? []).some((m: any) =>
          m.role === "system" && JSON.stringify(m.content).includes("prefer bot_work_create when available")),
        canCreate: (body.tools ?? []).some((t: any) => t.function?.name === "bot_work_create")
      })
      const response = await fetch(config.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
        body: raw,
        signal: AbortSignal.timeout(120000)
      })
      assert.ok(response.body)
      res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" })
      await pipeline(Readable.fromWeb(response.body as any), res)
    } catch {
      if (!res.headersSent) res.writeHead(502)
      res.end("real-model relay failed")
    }
  })
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
  const address = relay.address()
  assert.ok(address && typeof address !== "string")
  const env: Record<string, string> = {}
  for (const name of ["PATH", "HOME", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
    if (process.env[name]) env[name] = process.env[name]!
  const binary = createRequire(import.meta.url)("electron") as string
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: join(root, "profile"),
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    CMB_COWORK_TRACE_STORAGE_MODE: "plaintext"
  })
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    app = await _electron.launch({
      executablePath: binary,
      args: [join(out, "main/index.js"), "--user-data-dir=" + join(root, "electron-profile")],
      cwd: resolve("."),
      env,
      timeout: 60000
    })
    app.process().stdout?.resume()
    app.process().stderr?.resume()
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.setBackgroundThrottling(false)
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    await page.getByText("新任务", { exact: true }).first().waitFor()
    await page.evaluate(() => {
      ;(globalThis as any).__name = (v: unknown) => v
    })
    const bot = await page.evaluate(async (config) => {
      const api = (window as any).api
      await api.models.setCustomConfig(config)
      await api.models.setDefault("custom:" + config.id)
      return api.bots.create({
        name: "自然交办验收",
        instructions: "你协助安排日常活动，用中文回复。",
        color: "#168bea",
        modelRef: null
      })
    }, { ...config, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-relay-only" })
    // Sending a real user message ends/steers onboarding through beta's ordinary path.
    await page.getByText("Bots", { exact: true }).first().click()
    await page.getByText("自然交办验收", { exact: true }).first().click()
    const composer = () => page.locator(".bots-conversation").locator('textarea, [role="textbox"][contenteditable="true"]').last()
    const send = async (message: string) => {
      await composer().click()
      await composer().press(process.platform === "darwin" ? "Meta+a" : "Control+a")
      await composer().press("Backspace")
      await page.keyboard.insertText(message)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      await page
        .locator('.bots-conversation button[type="submit"]')
        .last()
        .click()
    }
    const idle = async (minimum: number) => {
      await waitForBotAppState(
        page,
        async ({ botId, minimum }) => {
          const api = (window as any).api
          const tasks = (await api.bots.snapshot()).tasks.filter((t: any) => t.botId === botId)
          return (
            tasks.filter((t: any) => t.workId).length >= minimum &&
            tasks.filter((t: any) => t.origin.kind === "work_result").length >= minimum &&
            !tasks.some((t: any) => ["queued", "running", "waiting_user"].includes(t.state))
          )
        },
        { botId: bot.id, minimum },
        { timeout: 180000 }
      )
    }
    if (autonomous) {
      await send("先帮我口算2+3，只回复答案。")
      await waitForBotAppState(page, async (botId) => {
        const tasks = (await (window as any).api.bots.snapshot()).tasks.filter((t: any) => t.botId === botId)
        return tasks.some((t: any) => t.message.includes("口算2+3") && t.state === "completed") &&
          !tasks.some((t: any) => ["queued", "running", "waiting_user"].includes(t.state))
      }, bot.id, { timeout: 180000 })
      assert.equal((await page.evaluate(async (id) => (await (window as any).api.bots.works.list(id)).items, bot.id)).length, 0,
        "a trivial question must remain inline")
      console.log("PASS real model: simple question answered without creating work")
    }
    await send(autonomous
      ? `请帮我做好周日读书会筹备方案。工作目录是 ${workspace}，先读取活动约束.md、场地说明.md、费用.csv，核对人数和费用；比较三个场地的容量、预算和天气风险，推荐一个，再给出90分钟流程、分工清单和两条应急安排。所有资料均为虚构，只需在回复中给出方案，不写文件、不用浏览器，也不联系任何人。后续我还会调整时间。你处理这些材料期间，我还需要继续跟你聊别的事情。`
      : "请为周日读书会单独建一个任务，后续在任务里继续修改。工作目录用 " +
        workspace +
        " 目录写一份周日读书会的简短计划。下午三点，社区阅览室，各带一本书。这些信息都是虚构的，只需要文字，不需要文件、浏览器或外部操作。"
    )
    let autonomouslyCreated = false
    if (autonomous) {
      await idle(0)
      autonomouslyCreated = (await page.evaluate(async (id) =>
        (await (window as any).api.bots.works.list(id)).items, bot.id)).length > 0
      // Model discretion is part of the product contract. Record inline handling
      // honestly, then explicitly request a task so the lifecycle is still tested.
      if (!autonomouslyCreated) {
        console.log("OBSERVED real model: chose inline handling; now testing an explicitly requested task")
        await send("请把刚才的读书会筹备方案放到一个独立任务中，沿用刚才的工作目录。先复核下午三点开始的90分钟计划，再交付简短方案，后面我会继续修改。只回复文字，不写文件。")
      }
    }
    await idle(1)
    assert.ok(wire.some((call) => call.delegationGuidance && call.canCreate),
      "the real main-chat model request must include both delegation guidance and the work tool")
    const list = () =>
      page.evaluate(async (id) => (await (window as any).api.bots.works.list(id)).items, bot.id)
    const first = await list()
    assert.equal(first.length, 1, "the assignment should use one independent task")
    const work = first[0]
    const checkReturned = async (count: number, time: RegExp) => {
      const data = await page.evaluate(
        async ({ botId, workId, threadId }) => {
          const api = (window as any).api
          return {
            rows: (await api.bots.snapshot()).tasks.filter(
              (t: any) =>
                t.botId === botId && t.origin.kind === "work_result" && t.origin.workId === workId
            ),
            messages: await api.threads.getMessages(threadId)
          }
        },
        { botId: bot.id, workId: work.id, threadId: bot.threadId }
      )
      assert.equal(data.rows.length, count)
      assert.ok(data.rows.every((t: any) => t.state === "completed"))
      const response = data.messages.findLast(
        (m: any) => m.role === "assistant" && typeof m.content === "string" && m.content.trim()
      )
      assert.ok(
        response && time.test(response.content),
        "the owning Bot must report the actual updated task result"
      )
      assert.ok(!response.tool_calls?.length, "result reporting must not repeat work")
      return response
    }
    await checkReturned(1, /三点|3[:：]00|15[:：]00|下午\s*3/)
    assert.equal(work.workspace.kind, "directory")
    assert.equal(work.workspace.path, await realpath(workspace))
    assert.equal(work.state, "active", "agent reply must not mark business completion")
    console.log(autonomouslyCreated
      ? "PASS real model: nontrivial natural request delegated without asking for an independent task"
      : "PASS App: requested independent task created in the selected directory")
    await send("把刚才的计划改到下午四点，增加十分钟的签到，只回复简短计划。")
    await idle(2)
    await checkReturned(2, /四点|4[:：]00|16[:：]00|下午\s*4/)
    assert.deepEqual(
      (await list()).map((w: any) => w.id),
      [work.id]
    )
    const row = page.locator(".bot-work-row").filter({ hasText: work.title })
    const preview = page.getByRole("region", { name: "任务预览", exact: true })
    const previewDraft = "查看任务时保留这条未发送草稿。"
    await composer().fill(previewDraft)
    await row.click()
    await preview.getByText(/四点|4[:：]00|16[:：]00|下午\s*4/).first().waitFor()
    await page.locator('[data-chat-thread-id="' + bot.threadId + '"]').waitFor()
    assert.equal(await composer().inputValue(), previewDraft)
    await preview.getByRole("button", { name: "返回任务列表", exact: true }).click()
    await preview.waitFor({ state: "hidden" })
    await row.click()
    await preview.getByRole("button", { name: "打开任务", exact: true }).click()
    await page.locator('[data-chat-thread-id="' + work.threadId + '"]').waitFor()
    const messages = await page.evaluate(
      async (id) => (window as any).api.threads.getMessages(id),
      work.threadId
    )
    assert.ok(
      messages.some(
        (m: any) =>
          m.role === "assistant" && /四点|4[:：]00|16[:：]00|下午4/.test(JSON.stringify(m.content))
      )
    )
    await page.getByRole("button", { name: "任务详情与操作", exact: true }).click()
    await page.getByRole("button", { name: "完成任务", exact: true }).click()
    await page.getByRole("button", { name: "任务详情与操作", exact: true }).click()
    await page.getByRole("button", { name: "继续处理", exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await page
      .locator(".bots-conversation")
      .getByRole("button", { name: /主对话$/ })
      .first()
      .click()
    await send("刚才已完成的读书会计划再改一下：改成下午五点，其他安排保持不变。")
    await idle(3)
    const report = await checkReturned(3, /五点|5[:：]00|17[:：]00|下午\s*5/)
    const mainReport = page.locator(
      `[data-chat-thread-id="${bot.threadId}"] [data-chat-message-id="${report.id}"]`
    )
    await mainReport.waitFor()
    await mainReport.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: join(out, "artifacts", "bot-real-work-result.png"),
      animations: "disabled"
    })
    const final = await list()
    assert.equal(final.length, 1)
    assert.equal(final[0].id, work.id)
    assert.equal(final[0].state, "active")
    assert.deepEqual(final[0].workspace, work.workspace)
    const finalMessages = await page.evaluate(
      async (id) => (window as any).api.threads.getMessages(id),
      work.threadId
    )
    const finalDelivery = finalMessages.findLast(
      (m: any) =>
        m.role === "assistant" && /五点|17[:：]00|下午\s*5/.test(JSON.stringify(m.content))
    )
    assert.ok(finalDelivery, "continued work must deliver the requested five o'clock revision")
    assert.ok(
      !finalMessages.some((m: any) =>
        m.tool_calls?.some((call: any) => ["write_file", "edit_file"].includes(call.name))
      ),
      "text-only instructions must not become file operations"
    )
    const thread = await page.evaluate(
      async (id) => (window as any).api.threads.get(id),
      work.threadId
    )
    assert.equal(thread.metadata.workspacePath, work.workspace.path)
    await row.click()
    await preview.getByRole("button", { name: "打开任务", exact: true }).click()
    await page.locator('[data-chat-thread-id="' + work.threadId + '"]').waitFor()
    const delivery = page.locator(
      '[data-chat-thread-id="' +
        work.threadId +
        '"] [data-chat-message-id="' +
        finalDelivery.id +
        '"]'
    )
    await delivery.waitFor()
    await delivery.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: join(out, "artifacts", "bot-natural-assignment.png"),
      animations: "disabled"
    })
    console.log(
      "PASS App: main-chat revision → user completion → natural continuation keeps one task, history and directory"
    )
  } catch (error) {
    if (app) {
      const page = await app.firstWindow().catch(() => null)
      if (page) {
        await page
          .screenshot({ path: join(out, "artifacts", "bot-natural-assignment-failure.png") })
          .catch(() => {})
        console.error(
          "Synthetic task states:",
          await page
            .evaluate(async () => {
              const tasks = (await (window as any).api.bots.snapshot()).tasks
              return tasks.map((t: any) => ({
                state: t.state,
                independent: Boolean(t.workId),
                origin: t.origin.kind
              }))
            })
            .catch(() => [])
        )
      }
    }
    throw error
  } finally {
    await app?.close()
    relay.closeAllConnections()
    await new Promise<void>((resolve) => relay.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
    console.log("Cleaned isolated real-model profile and synthetic tasks")
  }
}
main().catch((error) => {
  // Do not log provider responses, request/config objects or Electron stdout.
  console.error(error instanceof Error ? error.message : "Real-model App check failed")
  process.exitCode = 1
})
