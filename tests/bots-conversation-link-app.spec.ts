import { waitForBotAppState } from "./support/bot-app-state"
/** M05-06 only: real App/Host/Thread/Runtime, independent output/profile and localhost model. */
import assert from "node:assert/strict"
import { botTestAppOutput } from "./support/bot-test-app"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { _electron } from "playwright"

async function main() {
  const root = resolve("."),
    out = botTestAppOutput(),
    dir = await mkdtemp(join(tmpdir(), "m05-06-link-app-"))
  const originalWorkspace = join(dir, "original-workspace"),
    otherWorkspace = join(dir, "different-global-workspace")
  await mkdir(originalWorkspace, { recursive: true })
  await mkdir(otherWorkspace, { recursive: true })
  await writeFile(
    join(originalWorkspace, "existing.md"),
    "# Existing material\n\nOriginal workspace content.\n"
  )
  const calls: Array<{ path: string; user: string; all: string }> = [],
    errors: string[] = []
  const server = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw),
        messages = body.messages ?? []
      const last = [...messages].reverse().find((m) => m.role === "user"),
        user =
          typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "")
      const all = JSON.stringify(messages)
      calls.push({ path: req.url ?? "", user, all })
      const reporting = messages.some(
        (m: any) =>
          m.role === "system" &&
          JSON.stringify(m.content).includes("An independent task returned a host-recorded result")
      )
      let reply = "本机对话可用。"
      if (reporting) {
        assert.equal((body.tools ?? []).length, 0)
        const result = JSON.parse(user)
        const request = result.requestContext.messages.map((entry: any) => entry.text).join("\n")
        const expected = result.result.includes("LINK_CHAT_REPLY")
          ? "LINK_MODIFY_FROM_CHAT"
          : result.result.includes("LINK_BOT_REPLY")
            ? "LINK_MODIFY_FROM_BOT"
            : "LINK_NEW_WORK"
        assert.ok(
          request.includes(expected),
          "the report must carry the request from its actual source conversation"
        )
        reply = "LINK_RETURN：" + result.result
      } else {
        if (user.includes("LINK_INITIAL"))
          reply = "LINK_INITIAL_REPLY：已保留既有讨论，可以继续修改。"
        if (user.includes("LINK_MODIFY_FROM_BOT")) {
          assert.ok(all.includes("LINK_INITIAL_REPLY"))
          reply = "LINK_BOT_REPLY：已从 Bot 入口继续同一段讨论。"
        }
        if (user.includes("LINK_MODIFY_FROM_CHAT")) {
          assert.ok(all.includes("LINK_BOT_REPLY"))
          reply = "LINK_CHAT_REPLY：两个入口使用同一会话。"
        }
        if (user.includes("LINK_NEW_WORK")) reply = "LINK_NEW_REPLY：新任务也有同一个本机会话入口。"
        if (user.includes("LINK_UNLINKED")) reply = "LINK_UNLINKED_REPLY：普通会话继续保留。"
        if (user.includes("memory") && !user.includes("LINK_")) reply = "[]"
      }
      const linkedTurn = !reporting && /LINK_(MODIFY_FROM_BOT|MODIFY_FROM_CHAT|NEW_WORK)/.test(user)
      const toolNames = (body.tools ?? []).map(
        (entry: { function: { name: string } }) => entry.function.name
      )
      if (linkedTurn) {
        assert.ok(
          !toolNames.includes("bot_work_create"),
          "a task must not offer recursive creation"
        )
        assert.ok(
          !toolNames.includes("bot_work_projects"),
          "a task must keep its assigned workspace"
        )
        assert.ok(all.includes("ALREADY inside independent task"))
      }
      const turnMessages = messages.slice(
        messages.findLastIndex((entry: { role: string }) => entry.role === "user") + 1
      )
      const inspectFile =
        linkedTurn &&
        user.includes("LINK_MODIFY_FROM_CHAT") &&
        !turnMessages.some((entry: { role: string }) => entry.role === "tool")
      const reasoning = inspectFile
        ? "LINK_DETAIL_THOUGHT：先读取原目录的材料，再继续当前任务。"
        : undefined
      let toolCalls = inspectFile
        ? [
            {
              id: `link-read-${calls.length}`,
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ file_path: join(originalWorkspace, "existing.md") })
              }
            }
          ]
        : undefined
      if (!reporting && user.includes("LINK_HISTORY_QUERY")) {
        assert.ok(toolNames.includes("bot_work_search") && toolNames.includes("bot_work_read"))
        const linkedPrompt = messages.find(
          (m: any) => m.role === "system" && JSON.stringify(m.content).includes("Recent links:")
        )
        assert.ok(linkedPrompt, "main Bot receives associated-work metadata without a task run")
        const prompt =
          typeof linkedPrompt.content === "string"
            ? linkedPrompt.content
            : linkedPrompt.content.map((block: any) => block.text ?? "").join("\n")
        const workId = /"workId":"([^"]+)"/.exec(prompt)?.[1]
        assert.ok(workId)
        const receipts = turnMessages
          .filter((m: any) => m.role === "tool")
          .map((m: any) => JSON.parse(m.content))
        const searched = receipts.find((r: any) => r.operation === "bot_work_search")
        const read = receipts.find((r: any) => r.operation === "bot_work_read")
        if (!searched)
          toolCalls = [
            {
              id: `history-search-${calls.length}`,
              type: "function",
              function: {
                name: "bot_work_search",
                arguments: JSON.stringify({ workId, query: "LINK_INITIAL" })
              }
            }
          ]
        else if (!read) {
          assert.ok(searched.receipt.entries.length)
          const original = searched.receipt.entries.find((e: any) => e.role === "user")
          toolCalls = [
            {
              id: `history-read-${calls.length}`,
              type: "function",
              function: {
                name: "bot_work_read",
                arguments: JSON.stringify({ workId, messageId: original.source.messageId })
              }
            }
          ]
        } else {
          assert.ok(read.receipt.entries.some((e: any) => e.text.includes("LINK_INITIAL_REPLY")))
          const original = read.receipt.entries.find((e: any) => e.role === "user")
          reply = `LINK_HISTORY_FOUND：原讨论已经保留。[查看原消息](${original.href})`
          toolCalls = undefined
        }
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        for (const [delta, finish_reason] of [
          [
            toolCalls
              ? {
                  reasoning_content: reasoning,
                  tool_calls: toolCalls.map((call) => ({ index: 0, ...call }))
                }
              : { content: reply },
            null
          ],
          [{}, toolCalls ? "tool_calls" : "stop"]
        ])
          res.write(
            `data: ${JSON.stringify({ id: `link-${calls.length}`, object: "chat.completion.chunk", model: "local-link", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
          )
        res.end("data: [DONE]\n\n")
      } else
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: `link-${calls.length}`,
            object: "chat.completion",
            model: "local-link",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: toolCalls ? null : reply,
                  ...(toolCalls ? { tool_calls: toolCalls, reasoning_content: reasoning } : {})
                },
                finish_reason: toolCalls ? "tool_calls" : "stop"
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          })
        )
    } catch (error) {
      errors.push(String(error))
      console.error("Local link model fixture failed:", error)
      res.writeHead(500).end("fixture failure")
    }
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address() as { port: number },
    binary = createRequire(import.meta.url)("electron") as string
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  const env: Record<string, string> = {}
  for (const key of ["HOME", "PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
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
    CMB_COWORK_AGENT_HOME: join(dir, "profile"),
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_COWORK_TRACE_STORAGE_MODE: "plaintext",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1"
  })
  try {
    console.log("stage: isolated-launch", dir)
    app = await _electron.launch({
      executablePath: binary,
      args: [join(out, "main/index.js"), `--user-data-dir=${join(dir, "electron")}`],
      cwd: root,
      env,
      timeout: 60000
    })
    app
      .process()
      .stdout?.on("data", (chunk) => void writeFile(join(dir, "app.log"), chunk, { flag: "a" }))
    app
      .process()
      .stderr?.on("data", (chunk) => void writeFile(join(dir, "app.log"), chunk, { flag: "a" }))
    await app
      .context()
      .route(/^https?:/, (route) =>
        new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()
      )
    const page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    await page.addInitScript(() => {
      ;(globalThis as any).__name = (value: unknown) => value
    })
    page.on("pageerror", (error) => {
      errors.push(error.message)
      console.error("renderer", error.message)
    })
    await page.getByText("新任务", { exact: true }).first().waitFor()
    await page.evaluate(() => {
      ;(globalThis as any).__name = (value: unknown) => value
    })
    const setup = await page.evaluate(
      async ({ base, originalWorkspace, otherWorkspace }) => {
        const api = (window as any).api
        for (const [id, name, path] of [
          ["link-original", "Original fixture", "original"],
          ["link-default", "Bot default fixture", "default"]
        ])
          await api.models.setCustomConfig({
            id,
            name,
            baseUrl: `${base}/${path}/v1`,
            model: "local-link",
            apiKey: "synthetic-only",
            maxTokens: 64000,
            maxOutputTokens: 2048,
            enableThinking: true
          })
        await api.models.setDefault("custom:link-original")
        const bot = await api.bots.create({
          name: "会话关联专家",
          instructions: "使用原会话持续讨论。",
          color: "#168bea",
          modelRef: "custom:link-default"
        })
        const thread = await api.threads.create({
          title: "既有本机讨论",
          workspacePath: originalWorkspace,
          model: "custom:link-original",
          agentMode: "normal",
          memoryEnabled: true
        })
        await api.workspace.set(undefined, otherWorkspace)
        return { bot, thread }
      },
      { base: `http://127.0.0.1:${address.port}`, originalWorkspace, otherWorkspace }
    )
    await page.reload()
    await page.getByText("既有本机讨论", { exact: true }).first().click()
    const threadId = setup.thread.thread_id
    const chat = () => page.locator(`[data-chat-thread-id="${threadId}"]`)
    const send = async (text: string) => {
      await chat().locator('textarea, [role="textbox"][contenteditable="true"]').last().fill(text)
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
      await chat().locator('button[type="submit"]').last().click()
    }
    const assertComposerLayout = async () => {
      const composer = page.locator("[data-bot-owner-composer]").last()
      const inputBox = await composer.locator('textarea, [role="textbox"][contenteditable="true"]').boundingBox(),
        actionsBox = await composer.locator("[data-composer-actions]").boundingBox()
      assert.ok(
        inputBox && actionsBox && inputBox.y + inputBox.height <= actionsBox.y + 1,
        "model/mode toolbar must sit below the editor"
      )
    }
    await page
      .waitForFunction(
        (id) => {
          const element = document.querySelector(`[data-chat-thread-id="${id}"]`)
          if (!element) return false
          let fiber = (element as any)[
            Object.getOwnPropertyNames(element).find((key) => key.startsWith("__reactFiber"))!
          ]
          while (fiber) {
            const value = fiber.memoizedProps?.value
            if (value?.getStreamData && value?.getThreadState) {
              const state = value.getThreadState(id)
              ;(window as any).linkReadiness = {
                historyLoading: state.historyLoading,
                baselineReady: state.subagentTranscriptBaselineReady,
                presence: state.historyConversationPresence,
                stream: Boolean(value.getStreamData(id).stream)
              }
              return Boolean(value.getStreamData(id).stream && !state.historyLoading)
            }
            fiber = fiber.return
          }
          return false
        },
        threadId,
        { timeout: 15000 }
      )
      .catch(async (error) => {
        console.error(
          "thread-readiness",
          JSON.stringify(await page.evaluate(() => (window as any).linkReadiness))
        )
        throw error
      })
    await chat().waitFor()
    await chat().getByRole("button", { name: "Original fixture", exact: true }).waitFor()
    await send("LINK_INITIAL：先在普通对话讨论。")
    await page
      .getByText(/LINK_INITIAL_REPLY/)
      .last()
      .waitFor({ timeout: 90000 })
    await waitForBotAppState(
      page,
      async (id) => (await (window as any).api.threads.get(id)).status === "idle",
      threadId
    )
    const before = await page.evaluate(
      async () => (await (window as any).api.bots.snapshot()).tasks.length
    )
    await page.getByRole("button", { name: "关联为 Bot 任务", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("任务名称").fill("原讨论的持续任务")
    await dialog.getByLabel("任务目标").fill("保留既有讨论与目录继续修改。")
    await dialog.getByRole("button", { name: "关联此会话", exact: true }).click()
    await page.getByRole("button", { name: "解除任务关联", exact: true }).waitFor()
    const linked = await page.evaluate(
      async (id) => (window as any).api.bots.conversations.resolve(id),
      threadId
    )
    assert.equal(linked.work.threadId, threadId)
    assert.equal(linked.workspacePath, originalWorkspace)
    assert.equal(
      await page.evaluate(async () => (await (window as any).api.bots.snapshot()).tasks.length),
      before,
      "association itself must not execute"
    )
    const preserved = await page.evaluate(
      async (id) => (window as any).api.threads.get(id),
      threadId
    )
    assert.equal(preserved.metadata.model, "custom:link-original")
    assert.equal(preserved.metadata.memoryEnabled, true)
    assert.equal(preserved.metadata.workspacePath, originalWorkspace)
    console.log("stage: existing-associated-no-execution", threadId, linked.work.id)
    await page.getByRole("button", { name: "返回 Bot 任务", exact: true }).click()
    await chat().waitFor()
    // Main chat learns the association and can retrieve pre-link history without running that work.
    await page.getByRole("button", { name: "返回主对话", exact: true }).first().click()
    assert.equal(await page.locator("[data-bot-association-notice]").count(), 0)
    await page.locator(`[data-work-id="${linked.work.id}"]`).waitFor()
    await page.locator(`[data-work-id="${linked.work.id}"]`).click()
    await page.getByText("来源 · 已有会话关联", { exact: true }).waitFor()
    await page.getByRole("button", { name: "打开原会话", exact: true }).waitFor()
    await chat().getByText(/LINK_INITIAL_REPLY/).last().waitFor()
    await page.screenshot({ path: join(out, "artifacts", "bot-unified-task-source.png"), fullPage: true })
    await page.getByRole("button", { name: "返回主对话", exact: true }).first().click()
    const notices = await page.evaluate(
      async (id) => (window as any).api.bots.works.associations(id),
      setup.bot.id
    )
    assert.equal(notices.items.length, 1)
    assert.equal(notices.items[0].workId, linked.work.id)
    const beforeHistory = await page.evaluate(
      async (id) =>
        (await (window as any).api.bots.snapshot()).tasks.filter((t: any) => t.workId === id)
          .length,
      linked.work.id
    )
    const mainChat = page.locator(`[data-chat-thread-id="${setup.bot.threadId}"]`)
    await mainChat
      .locator('textarea, [role="textbox"][contenteditable="true"]')
      .last()
      .fill("LINK_HISTORY_QUERY：查一下关联会话最早讨论了什么，附原消息来源。")
    await mainChat.locator('button[type="submit"]').last().click()
    await mainChat.getByText(/LINK_HISTORY_FOUND/).waitFor({ timeout: 90000 })
    await waitForBotAppState(
      page,
      async () =>
        !(await (window as any).api.bots.snapshot()).tasks.some((t: any) =>
          ["queued", "running", "waiting_user"].includes(t.state)
        )
    )
    assert.equal(
      await page.evaluate(
        async (id) =>
          (await (window as any).api.bots.snapshot()).tasks.filter((t: any) => t.workId === id)
            .length,
        linked.work.id
      ),
      beforeHistory,
      "history queries must not dispatch task execution"
    )
    await mainChat.locator("[data-bot-history-sources]").first().waitFor()
    await page.screenshot({
      path: join(out, "artifacts", "bot-history-main-sources.png"),
      fullPage: true
    })
    const sourceReference = await page.evaluate(async (id) => {
      const messages = await (window as any).api.threads.getMessages(id)
      for (const message of messages) {
        if (message.role !== "tool" || typeof message.content !== "string") continue
        try {
          const value = JSON.parse(message.content)
          if (value.operation === "bot_work_read") return value.receipt.entries[0].source
        } catch {
          /* unrelated tool payload */
        }
      }
      throw new Error("missing source receipt")
    }, setup.bot.threadId)
    await mainChat.getByRole("button", { name: "查看原消息", exact: true }).click()
    await chat().waitFor()
    const sourceMessage = chat().getByText("LINK_INITIAL：先在普通对话讨论。", { exact: true })
    await sourceMessage.waitFor()
    await page.waitForFunction((id) => {
      const root = document.querySelector(`[data-chat-thread-id="${id}"]`)
      const rows = Array.from(root?.querySelectorAll("[data-chat-message-id]") ?? [])
      const source = rows.find((row) =>
        row.textContent?.includes("LINK_INITIAL：先在普通对话讨论。")
      )
      const viewport = root?.querySelector("[data-radix-scroll-area-viewport]")
      if (!source || !viewport) return false
      const a = source.getBoundingClientRect(),
        b = viewport.getBoundingClientRect()
      return a.top >= b.top - 10 && a.top < b.bottom
    }, threadId)
    await page.screenshot({
      path: join(out, "artifacts", "bot-history-source-reveal.png"),
      fullPage: true
    })
    console.log(
      "stage: unified task directory -> model history search/read -> exact source reveal without task execution"
    )
    await page.getByRole("tab", { name: "资料库", exact: true }).click()
    await page
      .getByRole("button", { name: /existing.md/ })
      .first()
      .click()
    await page
      .getByRole("dialog")
      .getByText(/Original workspace content/)
      .waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("tab", { name: "详情", exact: true }).click()
    await send("LINK_MODIFY_FROM_BOT：从 Bot 入口修改。")
    await page
      .getByText(/LINK_BOT_REPLY/)
      .last()
      .waitFor({ timeout: 90000 })
    await waitForBotAppState(
      page,
      async () =>
        !(await (window as any).api.bots.snapshot()).tasks.some((t) =>
          ["queued", "running", "waiting_user"].includes(t.state)
        )
    )
    await page.getByRole("button", { name: "打开原会话", exact: true }).click()
    await page.getByRole("button", { name: "返回 Bot 任务", exact: true }).waitFor()
    await page
      .getByText(/LINK_INITIAL_REPLY/)
      .last()
      .waitFor()
    await page
      .getByText(/LINK_BOT_REPLY/)
      .last()
      .waitFor()
    await send("LINK_MODIFY_FROM_CHAT：从对话入口继续修改。")
    await page
      .getByText(/LINK_CHAT_REPLY/)
      .last()
      .waitFor({ timeout: 90000 })
    await waitForBotAppState(
      page,
      async () =>
        !(await (window as any).api.bots.snapshot()).tasks.some((t) =>
          ["queued", "running", "waiting_user"].includes(t.state)
        )
    )
    await waitForBotAppState(
      page,
      async (workId) => {
        const rows = (await (window as any).api.bots.snapshot()).tasks.filter(
          (t: any) => t.origin.kind === "work_result" && t.origin.workId === workId
        )
        return rows.length === 2 && rows.every((t: any) => t.state === "completed")
      },
      linked.work.id,
      { timeout: 90000 }
    )
    const returned = await page.evaluate(
      async ({ botId, workId, mainThread }) => {
        const api = (window as any).api
        return {
          rows: (await api.bots.snapshot()).tasks.filter(
            (t: any) =>
              t.botId === botId && t.origin.kind === "work_result" && t.origin.workId === workId
          ),
          messages: await api.threads.getMessages(mainThread)
        }
      },
      { botId: setup.bot.id, workId: linked.work.id, mainThread: setup.bot.threadId }
    )
    assert.equal(
      returned.rows.length,
      2,
      "both Bot and Chat entrances must return each result once"
    )
    assert.ok(
      returned.rows.every((t: any) => t.state === "completed" && t.threadId === setup.bot.threadId)
    )
    assert.ok(
      returned.messages.some(
        (m: any) =>
          m.role === "assistant" &&
          JSON.stringify(m.content).includes("LINK_RETURN：LINK_CHAT_REPLY")
      )
    )
    console.log("stage: both conversation entrances return results to the owning Bot")
    const detailButton = () => page.getByRole("button", { name: /^(查看|收起)执行过程$/ })
    assert.equal(await detailButton().getAttribute("aria-pressed"), "false")
    assert.equal(await chat().getByRole("button", { name: "思考", exact: true }).count(), 0)
    await detailButton().click()
    assert.equal(await detailButton().getAttribute("aria-pressed"), "true")
    const thinking = chat().getByRole("button", { name: "思考", exact: true }).last()
    await thinking.waitFor()
    if ((await thinking.getAttribute("aria-expanded")) !== "true") await thinking.click()
    await chat()
      .getByText(/LINK_DETAIL_THOUGHT/)
      .waitFor()
    const fileCall = chat()
      .getByText(/读取文件.*existing\.md/)
      .first()
    await fileCall.waitFor()
    await fileCall.click()
    await chat()
      .getByText(/Original workspace content/)
      .waitFor()
    await page.screenshot({
      path: join(out, "artifacts", "linked-task-execution-details.png"),
      fullPage: true
    })
    await page.getByRole("button", { name: "返回 Bot 任务", exact: true }).click()
    assert.equal(await detailButton().getAttribute("aria-pressed"), "true")
    await detailButton().click()
    await page.getByRole("button", { name: "打开原会话", exact: true }).click()
    await page.getByRole("button", { name: "返回 Bot 任务", exact: true }).waitFor()
    assert.equal(await detailButton().getAttribute("aria-pressed"), "false")
    assert.equal(await chat().getByRole("button", { name: "思考", exact: true }).count(), 0)
    console.log(
      "stage: linked-task reasoning and tool details toggle stays in sync across entrances"
    )
    // Both entrances edit the actual Thread model, never the Bot default.
    await chat().getByRole("button", { name: "Original fixture", exact: true }).click()
    await page.getByText("Bot default fixture", { exact: true }).last().click()
    await waitForBotAppState(
      page,
      async (id) =>
        (await (window as any).api.threads.get(id)).metadata.model === "custom:link-default",
      threadId
    )
    await page.getByRole("button", { name: "返回 Bot 任务", exact: true }).click()
    await chat().getByRole("button", { name: "Bot default fixture", exact: true }).waitFor()
    await chat().getByRole("button", { name: "Bot default fixture", exact: true }).click()
    await page.getByText("Original fixture", { exact: true }).last().click()
    await waitForBotAppState(
      page,
      async (id) =>
        (await (window as any).api.threads.get(id)).metadata.model === "custom:link-original",
      threadId
    )
    await page.getByRole("button", { name: "打开原会话", exact: true }).click()
    await page.getByRole("button", { name: "返回 Bot 任务", exact: true }).waitFor()
    await page.getByRole("button", { name: "完成任务", exact: true }).click()
    await page.getByRole("button", { name: "继续处理", exact: true }).waitFor()
    const completed = await page.evaluate(
      async (id) => (window as any).api.bots.conversations.resolve(id),
      threadId
    )
    assert.equal(completed.work.id, linked.work.id)
    assert.equal(completed.work.state, "completed")
    const bypass = await page.evaluate(async (id) => {
      const api = (window as any).api
      return new Promise((resolve) => {
        let cleanup = () => {}
        cleanup = api.agent.streamAgent(
          id,
          "LINK_RAW_BYPASS",
          null,
          (event) => {
            if (event.type === "error") {
              cleanup()
              resolve(event)
            }
          },
          "custom:link-original"
        )
      })
    }, threadId)
    assert.ok(JSON.stringify(bypass).includes("BOT_WORK_MANAGED_CONVERSATION"))
    assert.ok(!calls.some((c) => c.user.includes("LINK_RAW_BYPASS")))
    await page.getByRole("button", { name: "继续处理", exact: true }).click()
    await page.getByRole("button", { name: "完成任务", exact: true }).waitFor()
    await chat()
      .getByText(/LINK_CHAT_REPLY/)
      .last()
      .waitFor()
    await assertComposerLayout()
    await page.screenshot({
      path: join(out, "artifacts", "m05-06-linked-conversation.png"),
      fullPage: true
    })
    page.once("dialog", (dialog) => void dialog.accept())
    await page.getByRole("button", { name: "解除任务关联", exact: true }).click()
    await page.getByRole("button", { name: "关联为 Bot 任务", exact: true }).waitFor()
    assert.equal(
      await page.evaluate(
        async (id) => (window as any).api.bots.conversations.resolve(id),
        threadId
      ),
      null
    )
    const stale = await page.evaluate(
      async ({ botId, source }) => {
        try {
          await (window as any).api.bots.works.resolveSource(botId, source)
          return "unexpected success"
        } catch (error) {
          return String(error)
        }
      },
      { botId: setup.bot.id, source: sourceReference }
    )
    assert.notEqual(stale, "unexpected success", "an old source cannot reopen an unlinked task")
    await send("LINK_UNLINKED：解除后继续普通对话。")
    await page
      .getByText(/LINK_UNLINKED_REPLY/)
      .last()
      .waitFor({ timeout: 90000 })
    const final = await page.evaluate(async (id) => (window as any).api.threads.get(id), threadId)
    assert.equal(final.metadata.workspacePath, originalWorkspace)
    assert.equal(final.metadata.model, "custom:link-original")
    assert.equal(final.metadata.botId, undefined)
    assert.ok(
      calls
        .filter((c) =>
          /^LINK_(INITIAL|MODIFY_FROM_BOT|MODIFY_FROM_CHAT|UNLINKED)/.test(c.user.trim())
        )
        .every((c) => c.path.startsWith("/original/")),
      "explicit conversation model must survive both entrances"
    )
    const created = await page.evaluate(
      async (botId) =>
        (window as any).api.bots.works.create({
          botId,
          operationId: "new-created",
          title: "新建独立任务的对话",
          goal: "LINK_NEW_WORK：新建任务会话。"
        }),
      setup.bot.id
    )
    await waitForBotAppState(
      page,
      async (id) =>
        (await (window as any).api.bots.snapshot()).tasks.some(
          (t) => t.workId === id && t.state === "completed"
        ),
      created.work.id
    )
    await page.reload()
    await page.getByText("新建独立任务的对话", { exact: true }).first().click()
    await page.getByRole("button", { name: "返回 Bot 任务", exact: true }).waitFor()
    await page.getByRole("button", { name: "返回 Bot 任务", exact: true }).click()
    await page.getByText("来源 · Bot 内新建", { exact: true }).waitFor()
    await page.getByRole("button", { name: "在对话模式打开", exact: true }).click()
    await page.getByRole("button", { name: "返回 Bot 任务", exact: true }).waitFor()
    const newLink = await page.evaluate(
      async (id) => (window as any).api.bots.conversations.resolve(id),
      created.work.threadId
    )
    assert.equal(newLink.work.id, created.work.id)
    await page
      .getByText(/LINK_NEW_REPLY/)
      .last()
      .waitFor()
    assert.ok(
      !calls.find((c) => c.user.includes("LINK_NEW_WORK"))!.all.includes("LINK_INITIAL_REPLY"),
      "a new task must not import another conversation history"
    )
    await assertComposerLayout()
    await page.screenshot({
      path: join(out, "artifacts", "m05-06-created-conversation.png"),
      fullPage: true
    })
    console.log(
      "stage: both-entrances-complete-continue-unlink",
      JSON.stringify({
        calls: calls.length,
        threadId,
        workId: linked.work.id,
        originalWorkspacePreserved: true
      })
    )
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error("fixture artifacts", dir)
    if (app)
      await (await app.firstWindow())
        .screenshot({ path: join(out, "artifacts", "m05-06-link-app-failure.png"), fullPage: true })
        .catch(() => {})
    throw error
  } finally {
    if (app) await app.close()
    await new Promise<void>((done) => server.close(() => done()))
    console.log("stage: own-app-server-closed", dir)
    if (process.env.M05_KEEP_FIXTURE !== "1") await rm(dir, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
