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
      let reply = "本机对话可用。"
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
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        for (const [delta, finish_reason] of [
          [{ content: reply }, null],
          [{}, "stop"]
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
              { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          })
        )
    } catch (error) {
      errors.push(String(error))
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
            maxOutputTokens: 2048
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
      await chat().locator("textarea").last().fill(text)
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
      const inputBox = await composer.locator("textarea").boundingBox(),
        actionsBox = await composer.locator("[data-composer-actions]").boundingBox()
      assert.ok(
        inputBox && actionsBox && inputBox.y + inputBox.height <= actionsBox.y + 1,
        "model/mode toolbar must sit below the textarea"
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
    await page.getByRole("button", { name: "在对话模式打开", exact: true }).click()
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
    await page.getByRole("button", { name: "在对话模式打开", exact: true }).click()
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
