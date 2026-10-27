/** Opt-in real-model + native Electron journey. Synthetic conversations only. */
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { _electron } from "playwright"
import { selectedBotRoutingModel } from "./support/bot-routing-model"
import { botTestAppOutput } from "./support/bot-test-app"
import { waitForBotAppState } from "./support/bot-app-state"
import { parseBotWorkHistoryHref } from "../src/shared/bots/work-history"

type ApiWindow = Window & { api: any; __name?: (value: unknown) => unknown }
async function main() {
  const model = await selectedBotRoutingModel()
  const out = botTestAppOutput()
  const dir = await mkdtemp(join(tmpdir(), "bot-history-real-"))
  const profile = join(dir, "profile"),
    workspace = join(dir, "workspace")
  await mkdir(workspace, { recursive: true })
  const env: Record<string, string> = {}
  for (const key of [
    "HOME",
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY"
  ])
    if (process.env[key]) env[key] = process.env[key]!
  for (const key of [
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "TEMP",
    "TMP"
  ]) {
    env[key] = join(dir, key)
    await mkdir(env[key], { recursive: true })
  }
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: profile,
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_COWORK_TRACE_STORAGE_MODE: "plaintext"
  })
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  const errors: string[] = []
  const redact = (value: string) =>
    model.apiKey ? value.replaceAll(model.apiKey, "[redacted]") : value
  try {
    console.log("stage: real-model-launch", { model: model.model, artifacts: dir })
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as string,
      args: [join(out, "main/index.js"), `--user-data-dir=${join(dir, "electron")}`],
      cwd: resolve("."),
      env,
      timeout: 60000
    })
    for (const stream of [app.process().stdout, app.process().stderr])
      stream?.on(
        "data",
        (chunk) => void writeFile(join(dir, "app.log"), redact(chunk.toString()), { flag: "a" })
      )
    const page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    await page.addInitScript(() => {
      ;(globalThis as unknown as ApiWindow).__name = (value) => value
    })
    page.on("pageerror", (error) => {
      errors.push(error.message)
      console.error("renderer", redact(error.message))
    })
    await page.getByText("新任务", { exact: true }).first().waitFor()
    await page.evaluate(() => {
      ;(window as ApiWindow).__name = (value) => value
    })
    // Transfer to the isolated test profile only; never print model credentials.
    const setup = await page.evaluate(
      async ({ config, workspace }) => {
        const api = (window as ApiWindow).api
        await api.models.setCustomConfig(config)
        await api.models.setDefault(`custom:${config.id}`)
        const bot = await api.bots.create({
          name: "活动搭档",
          instructions: "协助整理讨论与后续安排，按用户指令决定是否开展工作。",
          color: "#168bea",
          modelRef: `custom:${config.id}`
        })
        const thread = await api.threads.create({
          title: "社区读书会 · 前期讨论",
          workspacePath: workspace,
          model: `custom:${config.id}`,
          agentMode: "normal"
        })
        return { bot, thread }
      },
      { config: model, workspace }
    )
    await page.reload()
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setSize(1440, 940)
    })
    await page.getByText("社区读书会 · 前期讨论", { exact: true }).first().click()
    const threadId = setup.thread.thread_id
    const chat = (id: string) => page.locator(`[data-chat-thread-id="${id}"]`)
    const paint = () =>
      page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
    const ready = async (id: string) => {
      await chat(id).waitFor()
      await chat(id).getByText("正在加载会话历史", { exact: false }).waitFor({ state: "hidden" })
      await paint()
    }
    const sourceVisible = async (id: string, messageId: string) => {
      await ready(id)
      await page.waitForFunction(
        ({ id, messageId }) => {
          const root = document.querySelector(`[data-chat-thread-id="${id}"]`)
          const row = Array.from(root?.querySelectorAll("[data-chat-message-id]") ?? []).find(
            (element) => element.getAttribute("data-chat-message-id") === messageId
          )
          const viewport = root?.querySelector("[data-radix-scroll-area-viewport]")
          if (!row || !viewport) return false
          const bounds = row.getBoundingClientRect(),
            area = viewport.getBoundingClientRect()
          return bounds.top >= area.top - 10 && bounds.top < area.bottom
        },
        { id, messageId }
      )
      // Native Chromium can expose hydrated DOM before the compositor catches up.
      // Require a stable, populated target through the scroll/entrance transition.
      await chat(id)
        .locator(`[data-chat-message-id="${messageId}"]`)
        .evaluate(async (row) => {
          const start = performance.now()
          let signature = "",
            stableSince = start
          while (performance.now() - start < 10000) {
            const box = row.getBoundingClientRect()
            const next = `${box.x}:${box.y}:${box.width}:${box.height}:${row.textContent}`
            if (next !== signature || !row.isConnected) {
              signature = next
              stableSince = performance.now()
            }
            if (row.textContent?.includes("MORNING-7K2") && performance.now() - stableSince >= 500)
              return
            await new Promise<void>((done) => requestAnimationFrame(() => done()))
          }
          throw new Error("Original source did not finish rendering")
        })
      await paint()
    }
    const waitIdle = (id: string) =>
      waitForBotAppState(
        page,
        async (id) => {
          const api = (window as ApiWindow).api
          const thread = await api.threads.get(id)
          const tasks = (await api.bots.snapshot()).tasks
          return (
            thread.status === "idle" &&
            !tasks.some((task: any) => ["queued", "running", "waiting_user"].includes(task.state))
          )
        },
        id,
        { timeout: 240000 }
      )
    const send = async (id: string, text: string) => {
      const prior = await page.evaluate(
        async (id) =>
          (await (window as ApiWindow).api.threads.getMessages(id)).map((m: any) => m.id),
        id
      )
      await chat(id).locator('textarea, [role="textbox"][contenteditable="true"]').last().fill(text)
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
      await chat(id).locator('button[type="submit"]').last().click()
      await waitForBotAppState(
        page,
        async ({ id, prior }) =>
          (await (window as ApiWindow).api.threads.getMessages(id)).some(
            (m: any) =>
              m.role === "assistant" &&
              !prior.includes(m.id) &&
              JSON.stringify(m.content).length > 5
          ),
        { id, prior },
        { timeout: 240000 }
      )
      await waitIdle(id)
      const messages = await page.evaluate(
        async (id) => (window as ApiWindow).api.threads.getMessages(id),
        id
      )
      await writeFile(join(dir, `messages-${id}.json`), redact(JSON.stringify(messages, null, 2)))
      const lastReply = messages
        .filter((m: any) => m.role === "assistant" && !m.tool_calls?.length)
        .at(-1)
      if (lastReply) await chat(id).locator(`[data-chat-message-id="${lastReply.id}"]`).waitFor()
      await ready(id)
      return messages.filter((m: any) => !prior.includes(m.id))
    }
    const initial =
      "这是界面验收用的虚构活动，只需要简短文字回复，不创建文件或执行外部操作。晨光社区读书会原定周六14:30，在南楼203，18个名额，报名截止周四18:00，免费，参与者带一本书。之前考虑过上午10点，但因为志愿者有课放弃了。请确认这些讨论要点。"
    const revised =
      "最终改为周日15:40，名额增加到22人；其他条件不变。内部核对码是 MORNING-7K2。请简短记录最终决定，不再使用旧时间和旧人数。"
    await send(threadId, initial)
    console.log("stage: original-discussion")
    await send(threadId, revised)
    console.log("stage: revised-discussion")
    const before = await page.evaluate(
      async () => (await (window as ApiWindow).api.bots.snapshot()).tasks.length
    )
    await page.getByRole("button", { name: "关联为 Bot 任务", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("任务名称").fill("社区读书会 · 筹备")
    await dialog.getByLabel("任务目标").fill("继续跟进社区读书会的筹备安排。")
    await dialog.getByRole("button", { name: "关联此会话", exact: true }).click()
    await page.getByRole("button", { name: "解除任务关联", exact: true }).waitFor()
    const linked = await page.evaluate(
      async (id) => (window as ApiWindow).api.bots.conversations.resolve(id),
      threadId
    )
    assert.equal(
      await page.evaluate(
        async () => (await (window as ApiWindow).api.bots.snapshot()).tasks.length
      ),
      before
    )
    await page.getByRole("button", { name: "返回 Bot 任务", exact: true }).click()
    await page.getByRole("button", { name: "返回主对话", exact: true }).first().click()
    const mainId = setup.bot.threadId
    await ready(mainId)
    const notice = page.locator("[data-bot-association-notice]")
    await notice.waitFor()
    const beforeWorkRuns = await page.evaluate(
      async (id) =>
        (await (window as ApiWindow).api.bots.snapshot()).tasks.filter((t: any) => t.workId === id)
          .length,
      linked.work.id
    )
    const answer = await send(
      mainId,
      "刚关联的读书会讨论里，最终时间、地点、名额、报名截止和费用怎么定的？最初考虑的上午时间为什么不用了？请查原讨论回答，附上能点回原消息的来源。这次只回顾，不开展新工作。"
    )
    const replies = answer
      .filter((m: any) => m.role === "assistant" && !m.tool_calls?.length)
      .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n")
    assert.match(replies, /15[:：]40/)
    assert.match(replies, /203/)
    assert.match(replies, /22/)
    assert.match(replies, /18[:：]00/)
    assert.match(replies, /免费|不收.*费|费用.*0/)
    assert.match(replies, /课/)
    const calls = answer.flatMap((m: any) => m.tool_calls ?? [])
    assert.ok(calls.some((call: any) => ["bot_work_read", "bot_work_search"].includes(call.name)))
    await page.screenshot({
      path: join(dir, "02-history-answer-wide.png"),
      fullPage: true,
      animations: "disabled"
    })
    await notice.locator("summary").click()
    await paint()
    await page.screenshot({
      path: join(dir, "01-associated-expanded.png"),
      fullPage: true,
      animations: "disabled"
    })
    await notice.locator("summary").click()
    console.log("stage: real-model-correct-final-decisions", {
      toolNames: calls.map((call: any) => call.name)
    })
    const query = await send(
      mainId,
      "请在关联的原会话中搜索「内部核对码」，给我对应原句和能打开原消息的来源。"
    )
    const queryCalls = query.flatMap((m: any) => m.tool_calls ?? [])
    assert.ok(
      queryCalls.some((call: any) => call.name === "bot_work_search"),
      "natural search request should invoke actual history search"
    )
    assert.ok(JSON.stringify(query).includes("MORNING-7K2"))
    await page.screenshot({
      path: join(dir, "03-search-answer-wide.png"),
      fullPage: true,
      animations: "disabled"
    })
    const citations = chat(mainId).locator("button.bot-history-citation")
    assert.ok((await citations.count()) > 0, "real model must produce a usable source citation")
    const sourceReceipt = query
      .filter((m: any) => m.role === "tool")
      .map((m: any) => {
        try {
          return JSON.parse(m.content)
        } catch {
          return null
        }
      })
      .find((value: any) =>
        value?.receipt?.entries?.some((e: any) => e.text.includes("MORNING-7K2"))
      )
    const source =
      sourceReceipt.receipt.entries.find(
        (entry: any) => entry.role === "user" && entry.text.includes("MORNING-7K2")
      )?.source ?? sourceReceipt.receipt.entries[0].source
    const citedSource = parseBotWorkHistoryHref(
      (await citations.last().getAttribute("data-history-source")) ?? ""
    )
    assert.ok(citedSource)
    await citations.last().click()
    await sourceVisible(threadId, citedSource.messageId)
    await page.screenshot({
      path: join(dir, "04-source-reveal.png"),
      fullPage: true,
      animations: "disabled"
    })
    assert.equal(
      await page.evaluate(
        async (id) =>
          (await (window as ApiWindow).api.bots.snapshot()).tasks.filter(
            (t: any) => t.workId === id
          ).length,
        linked.work.id
      ),
      beforeWorkRuns
    )
    await page.getByRole("button", { name: "返回主对话", exact: true }).first().click()
    await ready(mainId)
    const sourceGroup = chat(mainId).locator("[data-bot-history-sources]").last()
    await sourceGroup.locator("summary").click()
    await paint()
    await page.screenshot({
      path: join(dir, "05-sources-expanded.png"),
      fullPage: true,
      animations: "disabled"
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 860))
    await paint()
    await page.screenshot({
      path: join(dir, "06-compact.png"),
      fullPage: true,
      animations: "disabled"
    })
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    )
    assert.equal(overflow, false, "compact UI must not cause document overflow")
    await page.evaluate(() => document.documentElement.classList.add("dark"))
    await paint()
    await page.screenshot({
      path: join(dir, "07-dark-sources.png"),
      fullPage: true,
      animations: "disabled"
    })
    await page.evaluate(() => document.documentElement.classList.remove("dark"))
    await sourceGroup.getByRole("button").first().click()
    await sourceVisible(threadId, sourceReceipt.receipt.entries[0].source.messageId)
    await page.getByRole("button", { name: "在对话模式打开", exact: true }).click()
    page.once("dialog", (dialog) => void dialog.accept())
    await page.getByRole("button", { name: "解除任务关联", exact: true }).click()
    await page.getByRole("button", { name: "关联为 Bot 任务", exact: true }).waitFor()
    const stale = await page.evaluate(
      async ({ botId, source }) => {
        try {
          await (window as ApiWindow).api.bots.works.resolveSource(botId, source)
          return false
        } catch {
          return true
        }
      },
      { botId: setup.bot.id, source }
    )
    assert.equal(stale, true)
    assert.equal(errors.length, 0)
    await writeFile(
      join(dir, "verdict.json"),
      JSON.stringify(
        {
          model: model.model,
          associationNoRun: true,
          finalDecisionsCorrect: true,
          historyCalls: calls.map((c: any) => c.name),
          searchCalls: queryCalls.map((c: any) => c.name),
          citations: true,
          queryNoTaskExecution: true,
          staleSourceRejected: true,
          originalWorkspace: workspace,
          rendererErrors: errors
        },
        null,
        2
      )
    )
    console.log("stage: real-model-history-ui-passed", dir)
  } catch (error) {
    if (app) {
      const page = await app.firstWindow().catch(() => null)
      await page
        ?.screenshot({ path: join(dir, "failure.png"), fullPage: true, animations: "disabled" })
        .catch(() => {})
    }
    console.error(redact(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  } finally {
    await app?.close().catch(() => {})
    await rm(join(profile, ".env"), { force: true })
    console.log("stage: isolated-app-closed; temporary-credential-removed", dir)
  }
}
void main()
