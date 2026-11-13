/** Full built Electron App: real UI, preload, IPC, SQLite, Runtime and IM WebSocket.
 * Only the model and gateway endpoints are localhost fixtures. Never uses user data. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron, type Page } from "playwright"
import { WebSocketServer, type WebSocket } from "ws"
import { botTestAppOutput } from "./support/bot-test-app"
import { waitForBotAppState } from "./support/bot-app-state"

async function main() {
  const root = resolve("."),
    out = botTestAppOutput()
  const dir = await mkdtemp(join(tmpdir(), "bot-group-app-"))
  const binary = createRequire(import.meta.url)("electron") as string
  const errors: string[] = [],
    replies: any[] = [],
    requests: any[] = []
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, page: Page | undefined
  let binding: any,
    groupId = "",
    appGroupId = "",
    socket: WebSocket | undefined
  let passed = false
  let releaseOrdinaryTurn: (() => void) | undefined
  const sendFrame = (peer: WebSocket, type: string, payload: unknown, commandId?: string) =>
    peer.send(
      JSON.stringify({
        schemaVersion: 1,
        type,
        sentAt: new Date().toISOString(),
        payload,
        commandId,
        ...(type === "BOT_EVENT" ? { messageId: "local-push" } : {})
      })
    )
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((done) => gateway.once("listening", done))
  gateway.on("connection", (peer) => {
    socket = peer
    peer.on("message", (raw) => {
      const frame = JSON.parse(String(raw)),
        body = frame.payload
      if (frame.type === "HELLO")
        sendFrame(
          peer,
          "WELCOME",
          {
            sessionId: "isolated-session",
            principalId: "local-owner",
            serverTime: new Date().toISOString(),
            heartbeatIntervalSeconds: 60,
            protocolExtensions: ["bot-channel-v1"]
          },
          frame.commandId
        )
      else if (frame.type === "SYNC_REQUEST")
        sendFrame(
          peer,
          "SYNC_STATE",
          {
            defaultConversationKey: "local-private",
            routes: [
              { principalId: "local-owner", conversationKey: "local-private", state: "active" }
            ]
          },
          frame.commandId
        )
      else if (frame.type === "BOT_BINDING_COMMAND")
        sendFrame(
          peer,
          "BOT_BINDING_RESULT",
          {
            items: binding && body.botId === binding.botId ? [binding] : [],
            before: null
          },
          frame.commandId
        )
      else if (frame.type === "EXECUTION_PERMIT_ACQUIRE" || frame.type === "EXECUTION_PERMIT_RENEW")
        sendFrame(
          peer,
          "PERMIT_RESULT",
          {
            eventId: body.eventId,
            leaseId: body.lastLeaseId,
            status: "GRANTED",
            expiresAt: new Date(Date.now() + 90_000).toISOString()
          },
          frame.commandId
        )
      else if (frame.type === "REMOTE_REPLY") {
        replies.push(body)
        sendFrame(
          peer,
          "REPLY_ACCEPTED",
          {
            deliveryId: body.deliveryId,
            idempotencyKey: body.idempotencyKey,
            segmentIndex: body.segment.index,
            state: "ACCEPTED"
          },
          frame.commandId
        )
      }
    })
  })
  const model = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw),
        messages = body.messages ?? []
      const text = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x))
      const all = JSON.stringify(messages)
      let index = -1
      messages.forEach((m: any, i: number) => {
        if (m.role === "user") index = i
      })
      const user = text(messages[index]?.content ?? "")
      const used = messages
        .slice(index + 1)
        .flatMap((m: any) => (m.tool_calls ?? []).map((c: any) => c.function?.name))
      const tools = (body.tools ?? []).map((t: any) => t.function?.name)
      requests.push({ user, used, tools })
      if (user.includes("LIVE_ORDINARY_HOLD")) {
        await new Promise<void>((done) => {
          releaseOrdinaryTurn = done
        })
        if (res.destroyed) return
      }
      let reply = "本地测试已就绪。",
        call: { name: string; args: any } | undefined
      if (all.includes("You are ALREADY inside independent task")) {
        assert.ok(!all.includes("PRIVATE_SECRET"), "task must not inherit private history")
        reply = "群任务检查完成：需求清单已整理。"
      } else if (all.includes("An independent task returned a host-recorded result")) {
        reply = "群任务结果：需求清单已整理。"
      } else if (user.includes("LIVE_TO_IM")) {
        if (!used.includes("bot_send_message"))
          call = {
            name: "bot_send_message",
            args: {
              groupId,
              groupSource: "zhaohu",
              content: "LIVE_IM_BRIEF 请沿用群内讨论创建一个独立任务整理需求清单。"
            }
          }
        else reply = "已交办到招乎群，后续结果留在该群。"
      } else if (user.includes("LIVE_IM_BRIEF")) {
        assert.ok(!all.includes("PRIVATE_SECRET"), "group must not inherit private history")
        assert.ok(all.includes("原群讨论"), "handoff must reuse target group's existing history")
        if (!used.includes("bot_work_create"))
          call = {
            name: "bot_work_create",
            args: {
              requestKey: "local-group-work",
              title: "群内需求清单",
              goal: "LIVE_WORK_GOAL 整理群内需求清单，只回复正文。",
              contextMessageIds: []
            }
          }
        else reply = "群内需求清单任务已开始。"
      } else if (user.includes("LIVE_TO_APP")) {
        if (!used.includes("bot_send_message"))
          call = {
            name: "bot_send_message",
            args: {
              groupId: appGroupId,
              groupSource: "app",
              content: "@群协作助手 LIVE_APP_BRIEF 请回复已经收到。"
            }
          }
        else reply = "已交办到 App 群聊。"
      } else if (user.includes("LIVE_APP_BRIEF") && tools.includes("bot_send_message")) {
        if (!used.includes("bot_send_message"))
          call = { name: "bot_send_message", args: { content: "App 群已收到交办。" } }
        else reply = "(pass)"
      } else if (user.includes("LIVE_GROUP_SEED")) reply = "原群讨论：本周重点是需求清单。"
      else if (user.includes("PRIVATE_SECRET")) reply = "私聊内容仅保留在本会话。"
      else if (user.includes("LIVE_RETRY") || user.includes("LIVE_LOST"))
        reply = "发送已接收，仅执行一轮。"
      if (call) assert.ok(tools.includes(call.name), "fixture may call only advertised tools")
      const fn = call
        ? {
            id: `call-${requests.length}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) }
          }
        : undefined
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        const frame = (delta: unknown, finish_reason: string | null) =>
          res.write(
            `data: ${JSON.stringify({ id: `local-${requests.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
          )
        frame(fn ? { tool_calls: [{ index: 0, ...fn }] } : { content: reply }, null)
        frame({}, fn ? "tool_calls" : "stop")
        res.end("data: [DONE]\n\n")
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: `local-${requests.length}`,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: fn ? null : reply,
                  ...(fn ? { tool_calls: [fn] } : {})
                },
                finish_reason: fn ? "tool_calls" : "stop"
              }
            ]
          })
        )
      }
    } catch (error) {
      errors.push(String(error))
      res.writeHead(500).end("local-fixture-error")
    }
  })
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done))
  const env: Record<string, string> = {}
  for (const key of ["PATH", "Path", "HOME", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
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
    console.log("stage: launch real App", dir)
    app = await _electron.launch({
      executablePath: binary,
      args: [join(out, "main/index.js"), `--user-data-dir=${join(dir, "electron-profile")}`],
      cwd: root,
      env,
      timeout: 60000
    })
    for (const stream of [app.process().stdout, app.process().stderr])
      stream?.on("data", (chunk) => void writeFile(join(dir, "electron.log"), chunk, { flag: "a" }))
    await app
      .context()
      .route(/^https?:/, (route) =>
        new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()
      )
    page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.getByText("新任务", { exact: true }).first().waitFor()
    await page.evaluate(() => {
      ;(globalThis as any).__name = (x: any) => x
    })
    const bots = await page.evaluate(
      async (baseUrl) => {
        const api = (window as any).api
        await api.models.setCustomConfig({
          id: "local-test",
          name: "Local test",
          baseUrl,
          model: "local-fixture",
          apiKey: "synthetic-only",
          maxTokens: 64000,
          maxOutputTokens: 2048
        })
        await api.models.setDefault("custom:local-test")
        const create = (name: string) =>
          api.bots.create({
            name,
            instructions: "按用户要求交办和处理工作。",
            color: "#168e87",
            modelRef: "custom:local-test"
          })
        return { private: await create("私人助手"), service: await create("群协作助手") }
      },
      `http://127.0.0.1:${(model.address() as any).port}/v1`
    )
    binding = {
      id: "local-group-binding",
      botId: bots.service.id,
      kind: "group",
      label: "群协作助手",
      peerLabel: "产品协作群",
      state: "active",
      version: 1,
      conversationKey: "local-zhaohu-group",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString()
    }
    await app.evaluate(
      async ({ BrowserWindow, ipcMain }, { entry, url, botId }) => {
        ;(globalThis as any).__name = (x: any) => x
        const load = process.getBuiltinModule("module").createRequire(entry)
        const { getLocalBotHost, BotImChannelService, ImGatewayWsClient } = load(entry)
        const host = getLocalBotHost(),
          failures: string[] = []
        const client = new ImGatewayWsClient({
          url: () => url,
          token: () => "synthetic-only",
          appVersion: "isolated-test",
          onRemoteEvent: () => {
            throw Error("Unexpected legacy event")
          },
          onBotEvent: (event: any) => service.receive(event),
          isProactiveRouteConfirmed: (key: string, principal: string) =>
            service.isRouteConfirmed(key, principal)
        })
        const service = new BotImChannelService(
          client,
          "local-test-realm",
          () => host,
          (e: any) => failures.push(String(e))
        )
        service.start()
        client.start()
        const deadline = Date.now() + 10000
        while (!client.supportsBotChannel()) {
          if (Date.now() > deadline) throw Error("Local gateway handshake timed out")
          await new Promise((done) => setTimeout(done, 30))
        }
        await service.list(botId)
        const state = ((globalThis as any).__handoffApp = {
          host,
          service,
          client,
          failures,
          mode: "normal",
          attempts: [] as any[],
          release: undefined as any
        })
        for (const channel of ["bots:send", "bots:request-receipts"]) {
          const original = (ipcMain as any)._invokeHandlers.get(channel)
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, async (event, ...args) => {
            if (channel === "bots:request-receipts" && state.mode !== "normal")
              throw Error("Local test: receipt unavailable")
            if (channel === "bots:send") {
              state.attempts.push(args[1])
              if (state.mode === "reject") throw Error("本地测试：目标群暂不可用")
              if (state.mode === "hold") {
                await new Promise<void>((done) => {
                  state.release = done
                })
                throw Error("本地测试：暂时未收到确认")
              }
              const result = await original(event, ...args)
              if (state.mode === "lost") throw Error("本地测试：确认响应丢失")
              return result
            }
            return original(event, ...args)
          })
        }
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.setBackgroundThrottling(false)
      },
      {
        entry: join(out, "main/bots-app-e2e.js"),
        url: `ws://127.0.0.1:${(gateway.address() as any).port}`,
        botId: bots.service.id
      }
    )
    const group = await page.evaluate(
      async ({ privateId, serviceId }) =>
        (window as any).api.bots.saveGroup({
          name: "产品协作群",
          memberIds: [privateId, serviceId]
        }),
      { privateId: bots.private.id, serviceId: bots.service.id }
    )
    appGroupId = group.id
    groupId = await page.evaluate(
      async () => (await (window as any).api.bots.snapshot()).imConversations[0].id
    )
    const idle = () =>
      waitForBotAppState(
        page!,
        async () =>
          !(await (window as any).api.bots.snapshot()).tasks.some((t: any) =>
            ["queued", "running", "waiting_user"].includes(t.state)
          )
      )
    await idle()
    sendFrame(socket!, "BOT_EVENT", {
      event: {
        schemaVersion: 1,
        eventId: "seed-event",
        platformMessageId: "seed-message",
        principalId: "local-owner",
        conversationKey: binding.conversationKey,
        conversationSeq: 1,
        message: { type: "text", text: "LIVE_GROUP_SEED 原群讨论" },
        occurredAt: new Date().toISOString(),
        lease: { id: "seed-lease", expiresAt: new Date(Date.now() + 90000).toISOString() },
        redelivered: false
      },
      route: {
        bindingId: binding.id,
        botId: bots.service.id,
        kind: "group",
        label: binding.label,
        version: 1,
        senderId: "local-owner"
      }
    })
    const wait = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 60000
      while (!predicate()) {
        if (Date.now() > deadline) throw Error("Timed out: " + label)
        await new Promise((done) => setTimeout(done, 100))
      }
    }
    await wait(
      () => replies.some((r) => JSON.stringify(r).includes("原群讨论")),
      "group seed reply"
    )
    await idle()
    await page.getByText("Bots", { exact: true }).first().click()
    await page.getByText("私人助手", { exact: true }).first().click()
    const composer = () =>
      page!
        .locator(".bots-conversation")
        .locator('textarea, [role="textbox"][contenteditable="true"]')
        .last()
    const settle = () =>
      page!.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
    const fill = async (text: string) => {
      await composer().click()
      await composer().press(process.platform === "darwin" ? "Meta+a" : "Control+a")
      await composer().press("Backspace")
      await page!.keyboard.insertText(text)
      await settle()
    }
    const send = async () => {
      await settle()
      await page!.locator('.bots-conversation button[type="submit"]').last().click()
    }
    const selectGroup = async (source: "App 群聊" | "招乎群聊", text: string) => {
      await fill("@")
      await page!
        .getByRole("option")
        .filter({ hasText: "产品协作群" })
        .filter({ hasText: source })
        .click()
      await page!.keyboard.insertText(" " + text)
      await settle()
    }
    await fill("PRIVATE_SECRET 这是私聊内容，请勿转到任何群。")
    await send()
    await idle()
    await selectGroup("招乎群聊", "LIVE_TO_IM 请交办到这个群。")
    await page.screenshot({ path: join(out, "artifacts/group-app-selected.png") })
    await send()
    await page
      .getByRole("button", { name: "已交办到招乎群 · 产品协作群", exact: true })
      .waitFor({ timeout: 60000 })
    await wait(
      () => replies.some((r) => JSON.stringify(r).includes("群任务检查完成")),
      "work report delivered through WS"
    )
    assert.ok(replies.every((r) => r.conversationKey === binding.conversationKey))
    await idle()
    await page.getByRole("button", { name: "已交办到招乎群 · 产品协作群", exact: true }).click()
    await page.getByRole("button").filter({ hasText: "群内需求清单" }).last().click()
    await page.getByRole("button", { name: "返回群聊", exact: true }).waitFor()
    await page
      .locator(".bots-conversation")
      .getByText("群任务检查完成：需求清单已整理。", { exact: true })
      .waitFor()
    await page.screenshot({ path: join(out, "artifacts/group-app-work.png") })
    await page.getByRole("button", { name: "返回群聊", exact: true }).click()
    await page.getByRole("button", { name: "前往私人主对话", exact: true }).click()
    await page.getByText("私人助手", { exact: true }).first().click()
    console.log(
      "stage: selected Zhaohu group -> real Runtime -> WS delivery -> work -> return group/private"
    )
    await selectGroup("App 群聊", "LIVE_TO_APP 请交办到这个 App 群。")
    await send()
    await idle()
    await page.getByRole("button", { name: "已发送到 App 群 · 产品协作群", exact: true }).waitFor()
    await waitForBotAppState(
      page,
      async (id) =>
        (await (window as any).api.bots.groupMessages(id)).some(
          (item: any) => item.text === "App 群已收到交办。"
        ),
      appGroupId
    )
    await page.getByRole("button", { name: "已发送到 App 群 · 产品协作群", exact: true }).click()
    await page.getByText("App 群已收到交办。", { exact: true }).first().waitFor()
    await page.screenshot({ path: join(out, "artifacts/group-app-room.png") })
    await page.getByText("私人助手", { exact: true }).first().click()
    console.log("stage: same-name App group handoff")
    const mode = (mode: string) =>
      app!.evaluate((_electron, value) => {
        ;(globalThis as any).__handoffApp.mode = value
      }, mode)
    const failed = async () => {
      const retry = page!.getByRole("button", { name: "重试发送", exact: true })
      await retry.waitFor()
      await waitForBotAppState(page!, () =>
        Array.from(document.querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === "重试发送" && !button.disabled
        )
      )
    }
    // Rejection before admission: retained payload and its real ellipsis/trash controls.
    await mode("reject")
    await selectGroup("招乎群聊", "LIVE_DELETE 保留后删除这条草稿。")
    await composer().evaluate((element) => {
      const data = new DataTransfer()
      data.items.add(new File(["本地隔离测试附件"], "brief.md", { type: "text/markdown" }))
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
      )
    })
    await page.getByRole("button", { name: "移除附件 brief.md", exact: true }).waitFor()
    await send()
    await failed()
    await page
      .getByText(/brief\.md/)
      .last()
      .waitFor()
    await page.getByRole("button", { name: "更多", exact: true }).last().click()
    await page.getByRole("button", { name: "编辑消息", exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "编辑消息", exact: true }).isDisabled(),
      true
    )
    await page.screenshot({ path: join(out, "artifacts/group-app-failed-menu.png") })
    await page.getByRole("button", { name: "删除待发消息", exact: true }).last().click()
    await page.getByRole("button", { name: "重试发送", exact: true }).waitFor({ state: "hidden" })
    await page.reload()
    await page.getByText("Bots", { exact: true }).first().click()
    await page.evaluate(() => {
      ;(globalThis as any).__name = (x: any) => x
    })
    await page.getByText("私人助手", { exact: true }).first().click()
    assert.equal(await page.getByRole("button", { name: "重试发送", exact: true }).count(), 0)
    console.log("stage: rejected draft menu/delete + persisted removal after reload")
    // In-flight deletion remains disabled, while the menu stays responsive.
    await mode("hold")
    await fill("LIVE_RETRY 请回复。")
    await send()
    await page.getByRole("button", { name: "更多", exact: true }).last().click()
    await page.getByText("正在发送，请稍候。", { exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "删除待发消息", exact: true }).last().isDisabled(),
      true
    )
    await page.keyboard.press("Escape")
    await app.evaluate(() => {
      ;(globalThis as any).__handoffApp.release()
    })
    await failed()
    await mode("normal")
    await page.getByRole("button", { name: "重试发送", exact: true }).click()
    await idle()
    await page.getByRole("button", { name: "重试发送", exact: true }).waitFor({ state: "hidden" })
    const attempts = await app.evaluate(() => (globalThis as any).__handoffApp.attempts)
    const retries = attempts.filter((x: any) => x.message.includes("LIVE_RETRY"))
    assert.equal(retries.length, 2)
    assert.equal(retries[0].requestId, retries[1].requestId)
    console.log("stage: in-flight menu + disabled deletion + retry preserves nonce")
    // Accepted but response lost: transcript hydration is also a durable receipt.
    // It must remove both the parked record and its now-obsolete error notice.
    await mode("lost")
    await fill("LIVE_LOST 请回复。")
    await send()
    await idle()
    const accepted = await page.evaluate(async () =>
      (await (window as any).api.bots.snapshot()).tasks.filter((t: any) =>
        t.message?.includes("LIVE_LOST")
      )
    )
    assert.equal(accepted.length, 1)
    assert.equal(accepted[0].state, "completed")
    await page.getByRole("button", { name: "重试发送", exact: true }).waitFor({ state: "hidden" })
    await page
      .getByRole("alert")
      .filter({ hasText: /原消息已保留/ })
      .waitFor({ state: "hidden" })
    const after = await page.evaluate(async () =>
      (await (window as any).api.bots.snapshot()).tasks.filter((t: any) =>
        t.message?.includes("LIVE_LOST")
      )
    )
    assert.equal(after[0].id, accepted[0].id)
    assert.equal(after[0].state, "completed")
    await mode("normal")
    console.log("stage: response loss reconciles from transcript, no duplicate run or stale notice")
    // The same menu also serves ordinary conversations. Exercise its editable
    // queue in the real ChatContainer while an actual Runtime turn is waiting.
    const workspacePath = join(dir, "queue-workspace")
    await mkdir(workspacePath)
    const ordinary = await page.evaluate(
      async (workspacePath) =>
        (window as any).api.threads.create({
          title: "普通会话队列验收",
          workspacePath,
          model: "custom:local-test",
          agentMode: "normal"
        }),
      workspacePath
    )
    await page.getByRole("button", { name: "Bot 工作区设置", exact: true }).click()
    await page.getByRole("button", { name: "返回 CMBDevClaw 工作台", exact: true }).click()
    await page.reload()
    await page.getByText("普通会话队列验收", { exact: true }).first().click()
    const ordinaryChat = page.locator(`[data-chat-thread-id="${ordinary.thread_id}"]`)
    const ordinaryInput = ordinaryChat
      .locator('textarea, [role="textbox"][contenteditable="true"]')
      .last()
    await ordinaryInput.fill("LIVE_ORDINARY_HOLD 测试普通会话队列")
    await settle()
    await ordinaryChat.locator('button[type="submit"]').last().click()
    await wait(() => !!releaseOrdinaryTurn, "ordinary conversation model turn")
    await ordinaryInput.fill("这条消息先排队")
    await settle()
    // Ordinary conversations enqueue with Enter while the stop button is shown.
    await ordinaryInput.press("Enter")
    await ordinaryChat.getByText("排队中 1 条", { exact: true }).waitFor()
    await ordinaryChat.getByRole("button", { name: "更多", exact: true }).last().click()
    await page.getByRole("button", { name: "编辑消息", exact: true }).click()
    await ordinaryChat.locator("textarea").first().fill("修改后的排队消息")
    await ordinaryChat.getByRole("button", { name: "保存", exact: true }).click()
    await ordinaryChat.getByText("修改后的排队消息", { exact: true }).waitFor()
    await ordinaryChat.getByRole("button", { name: "更多", exact: true }).last().click()
    await page.getByRole("button", { name: "关闭排队", exact: true }).click()
    await ordinaryChat.getByText("排队中 1 条", { exact: true }).waitFor({ state: "hidden" })
    releaseOrdinaryTurn!()
    console.log("stage: ordinary conversation queue menu/edit/delete preserved")
    assert.deepEqual(await app.evaluate(() => (globalThis as any).__handoffApp.failures), [])
    assert.deepEqual(errors, [])
    console.log(
      "PASS: real App group handoff, context isolation, work navigation, failure/delete/menu/retry; model calls:",
      requests.length
    )
    passed = true
  } finally {
    releaseOrdinaryTurn?.()
    await writeFile(
      join(dir, "diagnostics.json"),
      JSON.stringify({ errors, replies, requests }, null, 2)
    )
    if (!passed && page) {
      await page.screenshot({ path: join(out, "artifacts/group-app-failure.png") }).catch(() => {})
      await writeFile(
        join(dir, "visible.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      )
      console.log("Failure diagnostics:", dir)
    }
    await app?.close().catch(() => {})
    for (const peer of gateway.clients) peer.terminate()
    await new Promise<void>((done) => gateway.close(() => done()))
    model.closeAllConnections()
    await new Promise<void>((done) => model.close(() => done()))
    if (passed) await rm(dir, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
