import { waitForBotAppState } from "./support/bot-app-state"
/** Real beta App/preload/IPC/Store/Thread/Runtime/ChatContainer with an isolated profile and localhost-only model. */
import assert from "node:assert/strict"
import { botTestAppOutput } from "./support/bot-test-app"
import { createServer } from "node:http"
import { mkdir, mkdtemp, writeFile, readFile, realpath, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { _electron } from "playwright"

async function main() {
  const root = resolve("."),
    out = botTestAppOutput(),
    dir = await mkdtemp(join(tmpdir(), "m05-local-work-app-")),
    binary = createRequire(import.meta.url)("electron") as string
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  const explicitWorkspace = process.env.BOT_TEST_EXPLICIT_WORKSPACE === "1"
  let workIdForRevision = ""
  const chosenDirectory = join(dir, "指定工作目录")
  await mkdir(chosenDirectory)
  const calls: Array<{ tools: string[]; lastUser: string }> = [],
    errors: string[] = []
  const server = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw),
        messages = body.messages ?? []
      const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value))
      let lastUser = -1
      messages.forEach((m: any, i: number) => {
        if (m.role === "user") lastUser = i
      })
      const user = text(messages[lastUser]?.content ?? ""),
        turn = messages.slice(lastUser + 1)
      const all = JSON.stringify(messages)
      const inWork = all.includes("You are ALREADY inside independent task")
      if (inWork) {
        assert.ok(
          !all.includes("M05_CREATE_WORK"),
          "raw parent request must remain only in its source conversation"
        )
        assert.ok(
          !all.includes("M05_PARENT_EDIT"),
          "raw parent revision must not enter task history"
        )
        assert.ok(
          !all.includes("M05_PRIVATE_MAIN"),
          "unrelated main context must not enter task history"
        )
      }
      if (inWork && user.includes("M05_EDIT_WORK")) {
        assert.ok(
          all.includes("已写好**第一版安排**"),
          "edit must carry this work's previous assistant result"
        )
        assert.ok(
          !all.includes("M05_PRIVATE_MAIN"),
          "work may not silently import unrelated main messages"
        )
      }
      const used = turn.flatMap((m: any) => (m.tool_calls ?? []).map((t: any) => t.function?.name))
      calls.push({ tools: used, lastUser: user.slice(0, 200) })
      let reply = "本机专家可以持续讨论并修改文字或文件。",
        call: { name: string; args: Record<string, unknown> } | undefined
      const reporting = messages.some(
        (m: any) =>
          m.role === "system" &&
          text(m.content).includes("An independent task returned a host-recorded result")
      )
      if (reporting) {
        assert.equal((body.tools ?? []).length, 0, "a result report may not execute the task again")
        const result = JSON.parse(user)
        assert.equal(result.files[0].name, "report.md")
        const requests = result.requestContext.messages.map((entry: any) => entry.text).join("\n")
        assert.ok(
          requests.includes(result.result.includes("第二版") ? "M05_EDIT_WORK" : "M05_WORK_GOAL"),
          "a report must carry this execution's actual instruction, including task-local edits"
        )
        assert.ok(
          !requests.includes("M05_PRIVATE_MAIN"),
          "the result envelope must not import unrelated main context"
        )
        reply = result.result.includes("第二版")
          ? "M05_WORK_RETURN：季度安排已按意见更新为第二版，文件在原任务中。"
          : "M05_WORK_RETURN：季度安排第一版已写好，report.md 在原任务中，可继续修改。"
      } else if (!inWork && user.includes("M05_PARENT_EDIT")) {
        if (!used.includes("bot_work_send")) {
          assert.ok(workIdForRevision)
          call = {
            name: "bot_work_send",
            args: {
              requestKey: "revise-draft",
              workId: workIdForRevision,
              message:
                "M05_EDIT_WORK：将 report.md 中的第一版安排改为第二版安排，其他内容保持不变，交付修改后的文件。"
            }
          }
        } else reply = "已将修改要求交办给原任务。"
      } else if (!inWork && user.includes("M05_CREATE_WORK")) {
        if (!used.includes("bot_work_create"))
          call = {
            name: "bot_work_create",
            args: {
              requestKey: "draft-work",
              title: "季度安排草稿",
              goal: "M05_WORK_GOAL：请写一份季度安排到 report.md 并交付文件。",
              contextMessageIds: [],
              ...(explicitWorkspace
                ? { workspace: { kind: "directory", path: chosenDirectory } }
                : {})
            }
          }
        else reply = "已交办「季度安排草稿」，可从工作入口打开。"
      } else if ((inWork && all.includes("M05_WORK_GOAL")) || user.includes("M05_EDIT_WORK")) {
        const edit = user.includes("M05_EDIT_WORK")
        if (!used.includes(edit ? "edit_file" : "write_file"))
          call = {
            name: edit ? "edit_file" : "write_file",
            args: edit
              ? { file_path: "report.md", old_string: "第一版安排", new_string: "第二版安排" }
              : {
                  file_path: "report.md",
                  content:
                    "# 第一版安排\n\n- 分析材料\n- 起草建议\n\n|阶段|内容|\n|---|---|\n|一|讨论|\n|二|修改|\n"
                }
          }
        else if (!used.includes("bot_deliver_files"))
          call = { name: "bot_deliver_files", args: { files: ["report.md"] } }
        else
          reply = edit
            ? "已按你的意见更新为**第二版安排**，文件已交付。"
            : "已写好**第一版安排**，可继续讨论和修改。\n\n- 分析材料\n- 起草建议\n\n| 阶段 | 内容 |\n| --- | --- |\n| 一 | 讨论 |\n| 二 | 修改 |"
      } else if (user.includes("M05_MAIN_PING")) reply = "主对话仍然可用。"
      else if (user.includes("M05_PRIVATE_MAIN")) reply = "这是主对话的其他讨论，不交办工作。"
      else if (JSON.stringify(messages).includes("memory")) reply = "[]"
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${calls.length}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) }
              }
            ]
          }
        : { content: reply }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        const send = (delta: unknown, finish_reason: string | null) =>
          res.write(
            `data: ${JSON.stringify({ id: `m05-${calls.length}`, object: "chat.completion.chunk", model: "local-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
          )
        send(delta, null)
        send({}, call ? "tool_calls" : "stop")
        res.end("data: [DONE]\n\n")
      } else {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id: `m05-${calls.length}`,
            object: "chat.completion",
            model: "local-fixture",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: call ? null : reply,
                  ...(call
                    ? {
                        tool_calls: [
                          {
                            id: `call-${calls.length}`,
                            type: "function",
                            function: { name: call.name, arguments: JSON.stringify(call.args) }
                          }
                        ]
                      }
                    : {})
                },
                finish_reason: call ? "tool_calls" : "stop"
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          })
        )
      }
    } catch (error) {
      errors.push(String(error))
      console.error("Local model fixture failed:", error)
      res.writeHead(500).end("fixture-error")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number },
    env: Record<string, string> = {}
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
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
  if (process.env.HOME) env.HOME = process.env.HOME
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: join(dir, "agent-profile"),
    CMB_TASK_CARDS_MOCK: "1",
    CMB_COWORK_TRACE_STORAGE_MODE: "plaintext",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1"
  })
  try {
    console.log("stage: launching isolated App", dir)
    app = await _electron.launch({
      executablePath: binary,
      args: [join(out, "main/index.js"), `--user-data-dir=${join(dir, "electron-profile")}`],
      cwd: root,
      env,
      timeout: 60000
    })
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.setBackgroundThrottling(false)
    })
    app
      .process()
      .stdout?.on(
        "data",
        (chunk) => void writeFile(join(dir, "electron.log"), chunk, { flag: "a" })
      )
    app
      .process()
      .stderr?.on(
        "data",
        (chunk) => void writeFile(join(dir, "electron.log"), chunk, { flag: "a" })
      )
    await app
      .context()
      .route(/^https?:/, (route) =>
        new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()
      )
    const page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    page.on("pageerror", (error) => {
      errors.push(error.message)
      console.error("renderer", error.message)
    })
    await page.getByText("新任务", { exact: true }).first().waitFor()
    await page.evaluate(() => {
      ;(globalThis as any).__name = (value: unknown) => value
    })
    const bot = await page.evaluate(async (baseUrl) => {
      const api = (window as any).api
      await api.models.setCustomConfig({
        id: "m05-local",
        name: "Local fixture",
        baseUrl,
        model: "local-fixture",
        apiKey: "synthetic-only",
        maxTokens: 64000,
        maxOutputTokens: 2048
      })
      await api.models.setDefault("custom:m05-local")
      return api.bots.create({
        name: "本机协作专家",
        instructions: "帮助讨论和交办普通工作，按要求生成实际文件。",
        color: "#168bea",
        modelRef: "custom:m05-local"
      })
    }, `http://127.0.0.1:${address.port}/v1`)
    console.log("stage: profile-model-bot-created")
    // This journey tests ordinary main-chat delegation. Let onboarding settle
    // before typing, rather than racing its separate beta steering lifecycle.
    await waitForBotAppState(
      page,
      async () =>
        !(await (window as any).api.bots.snapshot()).tasks.some((t: any) =>
          ["queued", "running", "waiting_user"].includes(t.state)
        ),
      undefined,
      { timeout: 90000 }
    )
    await page.getByText("Bots", { exact: true }).first().click()
    await page.getByText("本机协作专家", { exact: true }).first().click()
    const composer = () => page.locator(".bots-conversation").locator('textarea, [role="textbox"][contenteditable="true"]').last()
    const composerValue = () => composer().evaluate((element) => element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? "")
    const send = async () => {
      // Let the controlled textarea commit before activating its actual submit button.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      const button = page
        .locator('.bots-conversation button[type="submit"]')
        .last()
      await button.waitFor()
      await button.click()
    }
    await composer().waitFor()
    await composer().fill("M05_PRIVATE_MAIN：先讨论其他话题，不要建工作。")
    await composer().press("Enter")
    await waitForBotAppState(
      page,
      async () => {
        const rows = (await (window as any).api.bots.snapshot()).tasks
        return (
          rows.some(
            (t: any) => t.message.includes("M05_PRIVATE_MAIN") && t.state === "completed"
          ) && !rows.some((t: any) => ["queued", "running", "waiting_user"].includes(t.state))
        )
      },
      undefined,
      { timeout: 90000 }
    )
    await page.getByText("这是主对话的其他讨论，不交办工作。", { exact: true }).last().waitFor()
    await composer().fill("M05_CREATE_WORK：请独立交办一份季度安排草稿。")
    await send()
    await page
      .getByRole("button", { name: /季度安排草稿/ })
      .first()
      .waitFor({ timeout: 90000 })
    const work = await page.evaluate(
      async (botId) => (await (window as any).api.bots.works.list(botId)).items[0],
      bot.id
    )
    assert.ok(work?.threadId && work.threadId !== bot.threadId)
    workIdForRevision = work.id
    assert.equal(work.workspace.kind, explicitWorkspace ? "directory" : "default")
    if (explicitWorkspace) assert.equal(work.workspace.path, await realpath(chosenDirectory))
    await page.locator(`[data-chat-thread-id="${bot.threadId}"]`).waitFor()
    console.log("stage: main-created-work-without-switch")
    await page
      .getByRole("button", { name: /季度安排草稿/ })
      .last()
      .click()
    await page.locator(`[data-chat-thread-id="${work.threadId}"]`).waitFor()
    const approve = async () => {
      const button = page.getByRole("button", { name: /^(允许|运行|全部批准并执行)$/ }).first()
      await button.waitFor({ timeout: 30000 })
      assert.ok(
        (await page.locator(".bots-conversation").innerText()).includes("report.md"),
        "only the fixed fixture report operation may be approved"
      )
      await button.click()
    }
    // The waiting Work keeps one resident slot while the original main conversation genuinely responds.
    await page
      .getByRole("button", { name: /^(允许|运行|全部批准并执行)$/ })
      .first()
      .waitFor()
    await page
      .locator(".bots-conversation")
      .getByRole("button", { name: /主对话$/ })
      .first()
      .click()
    await page.locator(`[data-chat-thread-id="${bot.threadId}"]`).waitFor()
    await composer().fill("M05_MAIN_PING：工作等待时主对话能继续吗？")
    await send()
    await page.getByText("主对话仍然可用。", { exact: true }).last().waitFor({ timeout: 90000 })
    await page
      .getByRole("button", { name: /季度安排草稿/ })
      .last()
      .click()
    await page.locator(`[data-chat-thread-id="${work.threadId}"]`).waitFor()
    await approve()
    const waitSettled = async (count: number) =>
      waitForBotAppState(
        page,
        async ({ workId, count }) => {
          const rows = (await (window as any).api.bots.snapshot()).tasks.filter(
            (t: any) => t.workId === workId
          )
          return (
            rows.length >= count &&
            rows.every((t: any) => !["queued", "running", "waiting_user"].includes(t.state))
          )
        },
        { workId: work.id, count },
        { timeout: 90000 }
      )
    await waitSettled(1)
    await page.getByText("第一版安排", { exact: false }).last().waitFor({ timeout: 90000 })
    const messages = await page.evaluate(
      async (threadId) => (window as any).api.threads.getMessages(threadId),
      work.threadId
    )
    assert.ok(
      messages.some(
        (m: any) => m.role === "assistant" && JSON.stringify(m.content).includes("第一版安排")
      )
    )
    assert.ok(
      JSON.stringify(messages).includes("bot-file-delivery"),
      "a real verified file delivery receipt must be persisted"
    )
    const readReport = async () =>
      page.evaluate(
        async (threadId) =>
          (window as any).api.bots.filePreview.readFilePreview({
            source: { threadId, filePath: "report.md", workspacePathKind: "relative" },
            lane: "m05-proof",
            requestToken: crypto.randomUUID()
          }),
        work.threadId
      )
    const firstReport = await readReport()
    assert.equal(firstReport.success, true)
    assert.match(firstReport.content, /第一版安排/)
    assert.match(await readFile(join(work.workspace.path, "report.md"), "utf8"), /第一版安排/)
    await page.getByRole("button", { name: "打开 report.md", exact: true }).last().click()
    await page
      .getByRole("dialog")
      .filter({ has: page.getByText("report.md", { exact: true }) })
      .waitFor()
    await page.getByRole("dialog").getByText("第一版安排", { exact: false }).first().waitFor()
    await page.screenshot({ path: join(out, "artifacts", "m05-local-work-file-preview.png") })
    await page.keyboard.press("Escape")
    const assignment = page.getByRole("region", { name: "Bot 交办说明", exact: true }).first()
    await assignment.waitFor()
    assert.ok((await assignment.innerText()).includes("M05_WORK_GOAL"))
    assert.ok(!(await page.locator(".bots-conversation").innerText()).includes("M05_CREATE_WORK"))
    const originCheck = await page.evaluate(
      async ({ botId, workId, threadId }) => {
        const api = (window as any).api
        const tasks = (await api.bots.snapshot()).tasks.filter(
          (t: any) => t.workId === workId && t.origin.dispatch === "create"
        )
        const messages = await api.threads.getMessages(threadId)
        const origins = await api.bots.messageOrigins(
          botId,
          [tasks[0].requestId],
          undefined,
          workId
        )
        return { tasks, messages, origins }
      },
      { botId: bot.id, workId: work.id, threadId: work.threadId }
    )
    assert.equal(
      originCheck.tasks[0].message,
      "M05_WORK_GOAL：请写一份季度安排到 report.md 并交付文件。"
    )
    assert.equal(originCheck.origins[0].origin.dispatch, "create")
    assert.ok(originCheck.origins[0].origin.sourceMessageIds.length > 0)
    assert.ok(!JSON.stringify(originCheck.messages).includes("M05_CREATE_WORK"))
    await assignment.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: join(out, "artifacts", "bot-work-assignment.png"),
      animations: "disabled"
    })
    console.log("stage: real-work-runtime-file-delivery")
    const checkReturned = async (count: number) => {
      await waitForBotAppState(
        page,
        async ({ botId, workId, count }) => {
          const rows = (await (window as any).api.bots.snapshot()).tasks.filter(
            (t: any) =>
              t.botId === botId && t.origin.kind === "work_result" && t.origin.workId === workId
          )
          return rows.length === count && rows.every((t: any) => t.state === "completed")
        },
        { botId: bot.id, workId: work.id, count },
        { timeout: 90000 }
      )
      await page
        .locator(".bots-conversation")
        .getByRole("button", { name: /主对话$/ })
        .first()
        .click()
      await page.locator(`[data-chat-thread-id="${bot.threadId}"]`).waitFor()
      const report = await page.evaluate(
        async (threadId) =>
          (await (window as any).api.threads.getMessages(threadId)).findLast(
            (m: any) =>
              m.role === "assistant" &&
              typeof m.content === "string" &&
              m.content.startsWith("M05_WORK_RETURN")
          ),
        bot.threadId
      )
      assert.ok(report, "the completed report must be persisted in main history")
      const summary = page.locator(
        `[data-chat-thread-id="${bot.threadId}"] [data-chat-message-id="${report.id}"]`
      )
      await summary.waitFor()
      await summary.scrollIntoViewIfNeeded()
      assert.ok((await summary.innerText()).includes(count === 1 ? "第一版" : "第二版"))
      const card = page
        .getByRole("button", { name: "任务有新结果：季度安排草稿", exact: true })
        .last()
      await card.waitFor()
      await page.screenshot({
        path: join(out, "artifacts", `bot-work-result-${count}.png`),
        animations: "disabled"
      })
      await card.click()
      await page.locator(`[data-chat-thread-id="${work.threadId}"]`).waitFor()
      assert.equal(
        (
          await page.evaluate(
            async ({ botId, workId }) => (window as any).api.bots.works.get(botId, workId),
            { botId: bot.id, workId: work.id }
          )
        ).state,
        "active"
      )
    }
    await checkReturned(1)
    if (explicitWorkspace) {
      // Keep direct task-local edits covered in the explicit-directory variant.
      await composer().fill("M05_EDIT_WORK：把第一版改为第二版。")
      await send()
    } else {
      await page
        .locator(".bots-conversation")
        .getByRole("button", { name: /主对话$/ })
        .first()
        .click()
      await page.locator(`[data-chat-thread-id="${bot.threadId}"]`).waitFor()
      await composer().fill("M05_PARENT_EDIT：把刚才那份改成第二版，继续原任务。")
      await send()
      await page
        .getByText("已将修改要求交办给原任务。", { exact: true })
        .last()
        .waitFor({ timeout: 90000 })
      await page.locator(`[data-work-id="${work.id}"]`).click()
      await page.locator(`[data-chat-thread-id="${work.threadId}"]`).waitFor()
      const followUp = page.getByRole("region", { name: "Bot 交办说明", exact: true }).last()
      await followUp.waitFor()
      assert.ok((await followUp.innerText()).includes("Bot 补充"))
      assert.ok((await followUp.innerText()).includes("M05_EDIT_WORK"))
      assert.ok(!(await page.locator(".bots-conversation").innerText()).includes("M05_PARENT_EDIT"))
      await followUp.scrollIntoViewIfNeeded()
      await page.screenshot({
        path: join(out, "artifacts", "bot-work-follow-up.png"),
        animations: "disabled"
      })
    }
    await approve()
    await waitSettled(2)
    const secondReport = await readReport()
    assert.equal(secondReport.success, true)
    assert.match(secondReport.content, /第二版安排/)
    assert.ok(!secondReport.content.includes("第一版安排"))
    await page.getByText("第二版安排", { exact: false }).last().waitFor({ timeout: 90000 })
    await checkReturned(2)
    await page.getByRole("button", { name: "完成任务", exact: true }).click()
    await page.getByRole("button", { name: "继续处理", exact: true }).waitFor()
    assert.equal(
      await page.locator(".bots-conversation").locator('textarea:not([disabled]), [role="textbox"][contenteditable="true"]').count(),
      0
    )
    await page.getByRole("button", { name: "继续处理", exact: true }).click()
    await composer().waitFor()
    const reopened = await page.evaluate(
      async ({ botId, id }) => (window as any).api.bots.works.get(botId, id),
      { botId: bot.id, id: work.id }
    )
    assert.equal(reopened.threadId, work.threadId)
    assert.equal(reopened.state, "active")
    assert.deepEqual(reopened.workspace, work.workspace)
    const thread = await page.evaluate(
      async (id) => (window as any).api.threads.get(id),
      work.threadId
    )
    assert.equal(thread.metadata.workspacePath, work.workspace.path)
    assert.match(await readFile(join(work.workspace.path, "report.md"), "utf8"), /第二版安排/)
    await composer().fill("这个工作的未发送草稿")
    await page
      .locator(".bots-conversation")
      .getByRole("button", { name: /主对话$/ })
      .first()
      .click()
    await page.locator(`[data-chat-thread-id="${bot.threadId}"]`).waitFor()
    assert.equal(await composerValue(), "")
    await composer().fill("M05_MAIN_PING：主对话能继续吗？")
    await send()
    await page.getByText("主对话仍然可用。", { exact: true }).last().waitFor({ timeout: 90000 })
    await page
      .getByRole("button", { name: /季度安排草稿/ })
      .last()
      .click()
    await page.locator(`[data-chat-thread-id="${work.threadId}"]`).waitFor()
    assert.equal(await composerValue(), "这个工作的未发送草稿")
    await composer().fill("")
    await page.getByText("第二版安排", { exact: false }).last().waitFor({ timeout: 30000 })
    // Hold the real work-get IPC while the resource tabs remain selected. No fallback to main is permitted.
    await page
      .locator(".bots-conversation")
      .getByRole("button", { name: /主对话$/ })
      .first()
      .click()
    await page.locator(`[data-chat-thread-id="${bot.threadId}"]`).waitFor()
    await page.getByRole("tab", { name: "电脑", exact: true }).click()
    await app.evaluate(({ ipcMain }) => {
      const state: any = { hold: true, reads: [], released: false }
      ;(globalThis as any).m05TargetGate = state
      state.promise = new Promise((resolve, reject) => {
        state.resolve = resolve
        state.reject = reject
      })
      const handlers = (ipcMain as any)._invokeHandlers
      for (const channel of ["bots:work:get", "bots:browser:preview", "bots:files:list"]) {
        const original = handlers.get(channel)
        if (typeof original !== "function") throw new Error("fixture handler missing")
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async (event, ...args) => {
          if (channel === "bots:work:get" && state.hold) {
            state.started = true
            await state.promise
          }
          if (state.started && channel !== "bots:work:get")
            state.reads.push({ channel, botId: args[1], workId: args[4] })
          return original(event, ...args)
        })
      }
    })
    await page
      .locator(".bots-conversation")
      .getByRole("button", { name: /已交办任务.*季度安排草稿/ })
      .click()
    await page.getByText("正在读取任务会话，资源面板暂不可用…", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "接管电脑", exact: true }).count(), 0)
    await page.getByRole("tab", { name: "资料库", exact: true }).click()
    await page.getByText("正在读取任务会话，资源面板暂不可用…", { exact: true }).waitFor()
    assert.deepEqual(await app.evaluate(() => (globalThis as any).m05TargetGate.reads), [])
    await app.evaluate(() => {
      const state = (globalThis as any).m05TargetGate
      state.hold = false
      state.reject(new Error("M05_TARGET_READ_UNAVAILABLE"))
    })
    await page.getByText("M05_TARGET_READ_UNAVAILABLE", { exact: false }).first().waitFor()
    assert.deepEqual(await app.evaluate(() => (globalThis as any).m05TargetGate.reads), [])
    await page.locator(".bot-details").getByRole("button", { name: "重试", exact: true }).click()
    await page
      .getByRole("button", { name: /report.md/ })
      .first()
      .waitFor()
    const scopeReads = await app.evaluate(() => (globalThis as any).m05TargetGate.reads)
    assert.ok(
      scopeReads.some((read: any) => read.channel === "bots:files:list" && read.workId === work.id)
    )
    assert.ok(
      scopeReads.every(
        (read: any) => read.channel !== "bots:browser:preview" || read.botId !== bot.id
      )
    )
    await page.getByRole("tab", { name: "详情", exact: true }).click()
    await page.getByText("第二版安排", { exact: false }).last().waitFor({ timeout: 30000 })
    console.log("stage: delayed/failed Work target never opens main files/browser")
    await page.screenshot({ path: join(out, "artifacts", "m05-local-work-app.png") })
    await page.getByRole("button", { name: "Bot 工作区设置", exact: true }).click()
    await page.getByRole("combobox", { name: "主题", exact: true }).click()
    await page.getByRole("option", { name: "深色", exact: true }).click()
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.documentElement.dataset.colorScheme === "dark")
    const searchColors = await page.locator(".bot-work-search").evaluate((input) => {
      const style = getComputedStyle(input),
        probe = document.createElement("span")
      input.parentElement!.appendChild(probe)
      probe.style.color = "var(--bot-text)"
      probe.style.background = "var(--bot-elevated)"
      const expected = getComputedStyle(probe)
      const colors = {
        text: style.color,
        background: style.backgroundColor,
        expectedText: expected.color,
        expectedBackground: expected.backgroundColor,
        placeholder: getComputedStyle(input, "::placeholder").color
      }
      probe.remove()
      return colors
    })
    assert.equal(searchColors.text, searchColors.expectedText)
    assert.equal(searchColors.background, searchColors.expectedBackground)
    assert.notEqual(searchColors.placeholder, searchColors.background)
    await page
      .locator('[data-bot-popup][aria-label="Bot 工作区设置"]')
      .waitFor({ state: "detached" })
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => Number.isFinite(animation.effect?.getTiming().iterations))
          .map((animation) => animation.finished.catch(() => {}))
      )
    })
    await page.screenshot({ path: join(out, "artifacts", "m05-local-work-app-dark.png") })
    console.log(
      "PASS: real beta App, ChatContainer and Runtime: main delegation → right Work → file delivery → edit → complete/continue same thread → separate drafts/main reply",
      {
        calls: calls.length,
        screenshots: [
          join(out, "artifacts", "m05-local-work-app.png"),
          join(out, "artifacts", "m05-local-work-app-dark.png")
        ]
      }
    )
    assert.deepEqual(errors, [])
  } catch (error) {
    console.error(
      "artifact-directory",
      dir,
      "last model phases",
      JSON.stringify(calls.map((c) => c.tools))
    )
    if (app) {
      const page = await app.firstWindow().catch(() => null)
      if (page)
        await page
          .screenshot({ path: join(out, "artifacts", "m05-local-work-app-failure.png") })
          .catch(() => {})
    }
    throw error
  } finally {
    if (app) await app.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Keep only diagnostic logs; the isolated profiles and their fixture-only credentials are removed.
    for (const key of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "TEMP",
      "TMP",
      "agent-profile",
      "electron-profile"
    ])
      await rm(join(dir, key), { recursive: true, force: true })
    console.log(
      "cleanup: owned Electron and localhost fixture stopped; isolated profiles removed",
      dir
    )
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
