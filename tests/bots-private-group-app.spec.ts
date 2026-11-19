/** Full built Electron App: real UI, preload, IPC, SQLite, Runtime and IM WebSocket.
 * The gateway is local. BOT_STYLE_REAL_IM runs two additional synthetic requests through the selected real model. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { selectedBotRoutingModel } from "./support/bot-routing-model"
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
  const realModel = process.env.BOT_STYLE_REAL_IM === "1" ? await selectedBotRoutingModel() : undefined
  let useRealModel = false
  const binary = createRequire(import.meta.url)("electron") as string
  const errors: string[] = [],
    replies: any[] = [],
    requests: any[] = []
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined, page: Page | undefined
  let binding: any, dmBinding: any,
    groupId = "",
    appGroupId = "",
    socket: WebSocket | undefined
  let passed = false
  let releaseOrdinaryTurn: (() => void) | undefined
  let releaseToolFrame: (() => void) | undefined
  const incomplete = "清单已有需求范围，尚缺验收条件。"
  const completed = "群任务检查完成：需求范围和验收条件均已补齐。"
  const dataResult = "这 24 行数据中有 3 行重复。"
  const dataConfirmation = "我来核对这份数据，查好发到这里。"
  const findingConfirmation = "输入有 24 行，其中 3 行重复。 我来核对其余数据。"
  const groupSummary = "群任务结果：清单和验收条件已整理。"
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
            items: [binding, dmBinding].filter(item => item && item.botId === body.botId),
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
      if (useRealModel && realModel) {
        const response = await fetch(realModel.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + realModel.apiKey },
          body: JSON.stringify({ ...body, model: realModel.model }), signal: AbortSignal.timeout(120000)
        })
        assert.ok(response.body)
        res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" })
        await pipeline(Readable.fromWeb(response.body as any), res)
        return
      }
      const text = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x))
      const all = JSON.stringify(messages)
      let index = -1
      messages.forEach((m: any, i: number) => {
        if (m.role === "user" && !/^(?:<bot_reply_reminder>|\[\[CMB_TURN_COMPLETION_GATE_V1:)/.test(text(m.content).trimStart())) index = i
      })
      const user = text(messages[index]?.content ?? "")
      const used = messages
        .slice(index + 1)
        .flatMap((m: any) => (m.tool_calls ?? []).map((c: any) => c.function?.name))
      const tools = (body.tools ?? []).map((t: any) => t.function?.name)
      requests.push({ user, used, tools })
      const reporting = /<bot_runtime_context event="task_result(?:_review)?">/.test(user)
      const heldSteer = !reporting && user.startsWith("STEER_HOLD_")
      if (heldSteer || (!reporting && user.startsWith("LIVE_ORDINARY_HOLD"))) {
        await new Promise<void>((done) => {
          releaseOrdinaryTurn = done
        })
        if (res.destroyed) return
      }
      let reply = "本地测试已就绪。",
        call: { name: string; args: any } | undefined
      if (messages.some((m: any) => m.role === "system" && text(m.content).includes("You are a memory curation agent."))) {
        reply = JSON.stringify({ operations: [], memory_md: "" })
      } else if (reporting) {
        assert.ok(!all.includes("PRIVATE_SECRET"), "the group Bot may only receive its group's context")
        if (user.includes(completed)) reply = groupSummary
        else if (user.includes("STEER_AFTER_BOUNDARY")) reply = "已按两次补充完成任务。"
        else if (user.includes(incomplete)) {
          if (!used.includes("bot_work_result_continue"))
            call = { name: "bot_work_result_continue", args: { gap: "需求清单缺少验收条件", instruction: "在原清单补齐各项验收条件。" } }
        } else {
          assert.ok(user.includes(dataResult), "the Bot must receive the worker's actual conclusion")
          reply = dataResult
        }
      } else if (all.includes("You are ALREADY inside independent task")) {
        assert.ok(!all.includes("PRIVATE_SECRET"), "task must not inherit private history")
        if (user.includes("在原清单补齐各项验收条件")) reply = completed
        else if (user.includes("LIVE_WORK_GOAL")) reply = incomplete
        else reply = dataResult
      } else if (user.includes("LIVE_TO_IM")) {
        if (!used.includes("bot_send_message"))
          call = {
            name: "bot_send_message",
            args: {
              groupId,
              groupSource: "zhaohu",
              content: "LIVE_IM_BRIEF 请沿用群内讨论整理需求清单，列出需求范围和验收条件。"
            }
          }
        else reply = "已交办到招乎群，后续结果留在该群。"
      } else if (user.includes("LIVE_FINDING")) {
        if (!used.length) call = { name: "execute", args: { command: "echo rows24_duplicates3" } }
        else if (!used.includes("bot_work_create")) call = { name: "bot_work_create", args: {
          requestKey: "finding-work", finishTurn: true, confirmation: { kind: "new", text: "我来核对其余数据。" }, finding: "输入有 24 行，其中 3 行重复。", title: "重复行检查", goal: "继续核对数据并回复结果。", contextMessageIds: []
        } }
        else throw Error("A dispatch with findings must not need another confirmation model call")
      } else if (user.includes("LIVE_LATE_TOOL")) {
        if (!used.includes("execute")) call = { name: "execute", args: { command: "echo 3" } }
        else reply = "核对结果为 3。"
      } else if (user.includes("LIVE_OWNER_DM")) {
        if (used.includes("bot_work_create")) throw Error("Unexpected second DM acknowledgement")
        call = { name: "bot_work_create", args: {
          requestKey: "owner-dm-work", confirmation: { kind: "new", text: dataConfirmation }, title: "本人数据核对",
          goal: "核对数据并回复结果。", contextMessageIds: []
        } }
      } else if (user.includes("LIVE_BUDGET")) {
        const continuation = messages.slice(index + 1).some((m: any) => m.role === "tool" && text(m.content).includes('"kind":"bot-foreground-continuation"'))
        if (used.includes("bot_work_create")) throw Error("Budget continuation must not repeat acknowledgement")
        const retry = messages.slice(index + 1).some((m: any) => m.role === "user" && text(m.content).includes("[[CMB_TURN_COMPLETION_GATE_V1:"))
        if (continuation && !retry) reply = "任务已派发。我用 finishTurn: true 结束本轮。"
        else call = continuation ? { name: "bot_work_create", args: {
          requestKey: "budget-work", confirmation: { kind: "new", text: dataConfirmation }, title: "数据核对", goal: "核对数据，只回复结果。", contextMessageIds: []
        } } : { name: "execute", args: { command: `echo feedback_probe_${used.length}` } }
      } else if (user.includes("LIVE_DISPATCH_FAIL")) {
        if (!used.includes("bot_work_create")) call = { name: "bot_work_create", args: {
          requestKey: "failed-work", finishTurn: true, title: "失败场景", goal: "检查目录。", contextMessageIds: [],
          workspace: { kind: "directory", path: join(dir, "missing-directory") }
        } }
        else reply = "指定目录不存在，任务未创建。请提供可用目录。"
      } else if (user.includes("LIVE_IM_BRIEF")) {
        assert.ok(!all.includes("PRIVATE_SECRET"), "group must not inherit private history")
        assert.ok(all.includes("原群讨论"), "handoff must reuse target group's existing history")
        if (!used.includes("bot_work_create"))
          call = {
            name: "bot_work_create",
            args: {
              requestKey: "local-group-work",
              finishTurn: true,
              title: "群内需求清单",
              goal: "LIVE_WORK_GOAL 整理群内需求清单，列出需求范围和验收条件，只回复正文。",
              contextMessageIds: []
            }
          }
        else throw Error("Accepted dispatch must not make a second model call")
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
      if (heldSteer) reply = "STEER_BEFORE_BOUNDARY"
      else if (!reporting && user.startsWith("STEER_SECOND_")) {
        assert.ok(all.includes("STEER_FIRST_"), "both corrections enter the same model history")
        assert.ok(all.includes("STEER_BEFORE_BOUNDARY"), "the interrupted-looking reply is actually retained")
        reply = "STEER_AFTER_BOUNDARY"
      }
      // A real provider may reuse an ID across calls; steering must still create
      // separate assistant messages on each side of the injected user boundary.
      const responseId = user.includes("STEER_") ? "reused-steer-provider-id" : `local-${requests.length}`
      if (call) assert.ok(tools.includes(call.name), "fixture may call only advertised tools")
      let opening = call && used.length === 0 &&
        (user.includes("LIVE_IM_BRIEF") || user.includes("LIVE_BUDGET") || user.includes("LIVE_DISPATCH_FAIL") || user.includes("LIVE_FINDING"))
        ? "我来核对数据，整理好后发给你。" : undefined
      if (call && (user.includes("LIVE_BUDGET") || user.includes("LIVE_FINDING")))
        opening = "先确认服务健康。\nLet me check the pipeline.\n我以 finishTurn: true 结束本轮。"
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
            `data: ${JSON.stringify({ id: responseId, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
          )
        if (fn && user.includes("LIVE_LATE_TOOL")) {
          frame({ content: "INTERNAL_DRAFT_BEFORE_TOOL" }, null)
          await new Promise<void>(done => { releaseToolFrame = done })
        }
        frame(fn ? { ...(opening ? { content: opening } : {}), tool_calls: [{ index: 0, ...fn }] } : { content: reply }, null)
        frame({}, fn ? "tool_calls" : "stop")
        res.end("data: [DONE]\n\n")
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: responseId,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: fn ? opening ?? null : reply,
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
      if (!res.headersSent) res.writeHead(500)
      if (!res.destroyed && !res.writableEnded) res.end("local-fixture-error")
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
    const wait = async (predicate: () => boolean, label: string, timeout = 60000) => {
      const deadline = Date.now() + timeout
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
    const lateDraft = "INTERNAL_DRAFT_BEFORE_TOOL"
    await page.evaluate(marker => {
      const state = { seen: false, observer: undefined as MutationObserver | undefined }
      state.observer = new MutationObserver(() => {
        if (document.querySelector(".bots-conversation")?.textContent?.includes(marker)) state.seen = true
      })
      state.observer.observe(document.body, { subtree: true, characterData: true, childList: true })
      ;(window as any).__botReplyProbe = state
    }, lateDraft)
    await fill("LIVE_LATE_TOOL 运行一个简单计算")
    await send()
    await wait(() => Boolean(releaseToolFrame), "provider sent content before tool identity")
    try {
      await page.waitForTimeout(250)
    } finally {
      releaseToolFrame?.()
    }
    await page.locator(".bots-conversation").getByText("核对结果为 3。", { exact: true }).waitFor()
    await idle()
    assert.equal(await page.evaluate(() => {
      const probe = (window as any).__botReplyProbe
      probe.observer.disconnect()
      return probe.seen
    }), false, "unclassified provider prose must never flash in the App")
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
      () => replies.some((r) => r.message.content === groupSummary),
      "parent summary delivered through WS"
    )
    assert.ok(replies.every((r) => r.conversationKey === binding.conversationKey))
    await idle()
    assert.equal(replies.filter(r => r.message.content === groupSummary).length, 1)
    assert.ok(!replies.some(r => r.message.content.includes(incomplete) || r.message.content.includes(completed)),
      "neither worker reply should be published to the group")
    const workTurns = await page.evaluate(async () => (await (window as any).api.bots.snapshot()).tasks
      .filter((t: any) => t.origin.kind === "work" && (t.message.includes("LIVE_WORK_GOAL") ||
        (t.origin.dispatch === "repair" && t.message.includes("在原清单补齐各项验收条件")))))
    assert.equal(workTurns.length, 2, "the original execution and exactly one follow-up must run")
    assert.ok(workTurns[0].workId && workTurns[0].workId === workTurns[1].workId)
    assert.equal(workTurns[0].threadId, workTurns[1].threadId)
    await page.getByRole("button", { name: "已交办到招乎群 · 产品协作群", exact: true }).click()
    await page.getByRole("button", { name: "进入任务：群内需求清单", exact: true }).click()
    await page.locator(".bot-personal-header[data-task]").getByRole("button", { name: "返回群聊「产品协作群」", exact: true }).waitFor()
    await page
      .locator(".bots-conversation")
      .getByText(completed, { exact: true })
      .waitFor()
    await page.screenshot({ path: join(out, "artifacts/group-app-work.png") })
    await page.locator(".bot-personal-header[data-task]").getByRole("button", { name: "返回群聊「产品协作群」", exact: true }).click()
    await page.getByRole("button", { name: "前往私人主对话", exact: true }).click()
    await page.getByText("私人助手", { exact: true }).first().click()
    console.log(
      "stage: selected Zhaohu group -> real Runtime -> WS delivery -> work -> return group/private"
    )
    // The same App/IPC/Runtime/WS path now covers initial, budget and failure feedback.
    const mainCalls = (marker: string) => requests.filter(r => r.user.includes(marker) && r.user.includes('<bot_runtime_context event="user_request">'))
    assert.equal(mainCalls("LIVE_IM_BRIEF").length, 1)
    assert.equal(replies.filter(r => r.message.content === "我来处理「群内需求清单」，结果发回这里。").length, 1)
    const inject = (id: string, text: string, sequence: number, target = binding) => sendFrame(socket!, "BOT_EVENT", {
      event: { schemaVersion: 1, eventId: id, platformMessageId: id, principalId: "local-owner",
        conversationKey: target.conversationKey, conversationSeq: sequence, message: { type: "text", text },
        occurredAt: new Date().toISOString(), lease: { id: `${id}-lease`, expiresAt: new Date(Date.now() + 90000).toISOString() }, redelivered: false },
      route: { bindingId: target.id, botId: bots.service.id, kind: target.kind, label: target.label, version: 1, senderId: "local-owner" }
    })
    const beforeBudget = replies.length
    inject("budget-event", "LIVE_BUDGET 核对数据并整理结果。", 2)
    await wait(() => replies.slice(beforeBudget).some(r => r.message.content === dataResult), "budget work result")
    await idle()
    const budgetReplies = replies.slice(beforeBudget)
    assert.deepEqual(budgetReplies.map(r => r.message.content), [dataConfirmation, dataResult])
    assert.doesNotMatch(JSON.stringify(budgetReplies), /finishTurn|Let me check|先确认服务健康/)
    assert.ok(!JSON.stringify(budgetReplies).includes("Foreground execution budget"))
    assert.ok(!JSON.stringify(budgetReplies).includes("bot-foreground-continuation"))
    assert.equal(mainCalls("LIVE_BUDGET").length, 7)
    await page.getByRole("button", { name: "已交办到招乎群 · 产品协作群", exact: true }).click()
    const visible = await page.locator(".bots-conversation").innerText()
    assert.ok(!visible.includes("执行遇到问题"), "budget handoff is not a user-facing error")
    assert.ok(!visible.includes("Foreground execution budget"))
    assert.doesNotMatch(visible, /finishTurn|Let me check|先确认服务健康/)
    await page.screenshot({ path: join(out, "artifacts/feedback-budget.png") })
    const beforeFailure = replies.length
    inject("failed-event", "LIVE_DISPATCH_FAIL 请在指定目录处理。", 3)
    await wait(() => replies.slice(beforeFailure).some(r => r.message.content.includes("指定目录不存在")), "genuine error remains delivered")
    await idle()
    await page.locator(".bots-conversation").getByText("指定目录不存在，任务未创建。请提供可用目录。", { exact: true }).waitFor()
    const nativeMessages = await page.evaluate(async (id) => {
      const conversation = (await (window as any).api.bots.snapshot()).imConversations.find((c: any) => c.id === id)
      return (window as any).api.threads.getMessages(conversation.threadId)
    }, groupId)
    assert.ok(nativeMessages.some((m: any) => m.role === "tool" && m.name === "bot_work_create" && m.is_error), "genuine native tool error is preserved")
    const budgetControl = nativeMessages.find((m: any) => m.role === "tool" && typeof m.content === "string" && m.content.includes('"kind":"bot-foreground-continuation"'))
    assert.ok(budgetControl && !budgetControl.is_error)
    assert.equal(JSON.parse(budgetControl.content).executed, false)
    await page.getByRole("button", { name: "查看执行过程", exact: true }).click()
    await page.locator("[data-bot-continuation]").waitFor()
    await page.locator("[data-bot-continuation]").scrollIntoViewIfNeeded()
    assert.match(await page.locator("[data-bot-continuation]").innerText(), /本次工具未执行/)
    await page.screenshot({ path: join(out, "artifacts/feedback-execution-details.png") })
    await page.getByRole("button", { name: "收起执行过程", exact: true }).click()
    await page.screenshot({ path: join(out, "artifacts/feedback-real-error.png") })
    const beforeFinding = replies.length
    inject("finding-event", "LIVE_FINDING 核对数据，继续处理发现的问题。", 4)
    await wait(() => replies.slice(beforeFinding).some(r => r.message.content === dataResult), "findings work result")
    await idle()
    const findingReplies = replies.slice(beforeFinding)
    assert.deepEqual(findingReplies.map(r => r.message.content), [findingConfirmation, dataResult])
    assert.doesNotMatch(JSON.stringify(findingReplies), /finishTurn|Let me check|先确认服务健康/)
    assert.equal(mainCalls("LIVE_FINDING").length, 2)
    await page.locator(".bots-conversation").getByText(findingConfirmation, { exact: true }).waitFor()
    await page.screenshot({ path: join(out, "artifacts/feedback-findings.png") })
    console.log("PASS: unified App/IM acknowledgement; 4 executed probes, 1 nonexecuted continuation; accepted receipt skips post-dispatch model; real failure and new findings stay visible")
    dmBinding = { ...binding, id: "local-owner-dm-binding", kind: "dm", conversationKey: "local-private", peerLabel: "本人" }
    await app.evaluate(async (_, id) => (globalThis as any).__handoffApp.service.list(id), bots.service.id)
    const beforeDm = replies.length
    inject("owner-dm-event", "LIVE_OWNER_DM 核对数据并整理结果。", 1, dmBinding)
    await wait(() => replies.slice(beforeDm).some(r => r.message.content === dataResult), "owner DM receives result")
    await idle()
    const dmReplies = replies.slice(beforeDm)
    assert.deepEqual(dmReplies.map(r => r.message.content), [dataConfirmation, dataResult])
    assert.ok(dmReplies.every(r => r.conversationKey === dmBinding.conversationKey))
    assert.equal(mainCalls("LIVE_OWNER_DM").length, 1)
    await writeFile(join(out, "artifacts/feedback-validation.json"), JSON.stringify({
      mode: "controlled-model-real-electron-local-ws", normalDispatchModelCalls: 1,
      budgetMainModelCalls: mainCalls("LIVE_BUDGET").length, openingDeliveries: budgetReplies.filter(r => r.message.content === dataConfirmation).length,
      appDraftFlashed: false, appLookup: "核对结果为 3。",
      group: budgetReplies.map(r => r.message.content), ownerDm: dmReplies.map(r => r.message.content),
      finding: findingReplies.map(r => r.message.content),
      resultDeliveries: budgetReplies.filter(r => r.message.content === dataResult).length,
      realFailureDelivered: true, laterFindingDelivered: true, errors
    }, null, 2))
    if (realModel) {
      await page.evaluate(async id => {
        const bots = (window as any).api.bots
        const current = (await bots.snapshot()).bots.find((item: any) => item.id === id)
        await bots.update({ ...current, expectedVersion: current.version, instructions: "你是值班同事，接下工作和最终汇报时都以“搭档”称呼对方。答复简短、务实。" })
      }, bots.service.id)
      const liveResults: Array<{ channel: string; messages: string[]; firstMs?: number; resultMs?: number; failure?: string }> = []
      const evidence = join(out, "artifacts", `im-style-${Date.now()}.json`)
      const firstLiveReply = replies.length
      useRealModel = true
      try {
        for (const target of [dmBinding, binding]) {
          const entry: (typeof liveResults)[number] = { channel: target.kind, messages: [] }
          liveResults.push(entry)
          const start = Date.now(), before = replies.length
          const delivered = () => replies.slice(before).filter(r => r.conversationKey === target.conversationKey)
          const question = `请新开一个任务，核对 orders_${target.kind} 今天的两条异常摘录：09:15 batch=a size=0 E_EMPTY_BATCH；11:20 batch=b size=0 E_EMPTY_BATCH。规则是 size 为零就拒绝该批次。请告诉我几次、触发原因及调用方的修复建议，直接在这里回复。仅依据消息中的摘录，无需读取本地文件或运行命令。`
          inject(`real-log-${target.kind}`, question, target.kind === "dm" ? 2 : 5, target)
          try {
            await wait(() => delivered().length > 0, `${target.kind} accepted`, 120000)
            entry.firstMs = Date.now() - start
            assert.ok(delivered()[0].message.content.length <= 160, "first delivery should only confirm acceptance")
            await wait(() => delivered().length >= 2, `${target.kind} result`, 150000)
            entry.resultMs = Date.now() - start
            await idle()
          } catch (error) {
            entry.failure = String(error)
          } finally {
            entry.messages = delivered().map(r => r.message.content)
          }
        }
        for (const response of replies.slice(firstLiveReply)) {
          const otherService = response.conversationKey === dmBinding.conversationKey ? "orders_group" : "orders_dm"
          assert.ok(!response.message.content.includes(otherService), "reply delivered outside original conversation")
        }
        for (const entry of liveResults) {
          assert.ok(!entry.failure, entry.channel + ": " + entry.failure)
          assert.equal(entry.messages.length, 2, "one acceptance and one result on the source route")
          assert.match(entry.messages[1], /E_EMPTY_BATCH/)
          assert.match(entry.messages[1], /2|两/)
          assert.match(entry.messages[1], /过滤|跳过|校验|非空|检查/)
          assert.doesNotMatch(entry.messages.join("\n"), /finishTurn|bot_work_|review scope|Let me check|前台预算/i)
          assert.match(entry.messages[0], /搭档/, entry.channel + " acceptance should honor the configured address")
          assert.match(entry.messages[1], /搭档/, entry.channel + " result should honor the configured address")
        }
      } finally {
        useRealModel = false
        await writeFile(evidence, JSON.stringify({ model: realModel.model, gateway: "loopback", results: liveResults }, null, 2))
        console.log("Real IM reply evidence:", evidence)
      }
    }
    if (process.env.BOT_FEEDBACK_ONLY === "1") { assert.deepEqual(errors, []); passed = true; return }
    await page.getByRole("button", { name: "前往私人主对话", exact: true }).click()
    await page.getByText("私人助手", { exact: true }).first().click()
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
    for (const agentMode of ["normal", "coordinator", "workflow"]) {
      releaseOrdinaryTurn = undefined
      const title = `运行中补充-${agentMode}`
      const thread = await page.evaluate(async ({ title, workspacePath, agentMode }) =>
        (window as any).api.threads.create({ title, workspacePath, agentMode, model: "custom:local-test" }),
      { title, workspacePath, agentMode })
      await page.reload()
      await page.getByText(title, { exact: true }).first().click()
      const chat = page.locator(`[data-chat-thread-id="${thread.thread_id}"]`)
      const input = chat.locator('textarea, [role="textbox"][contenteditable="true"]').last()
      await input.fill(`STEER_HOLD_${agentMode}`)
      await settle()
      await chat.locator('button[type="submit"]').last().click()
      await wait(() => !!releaseOrdinaryTurn, `${agentMode} model is in flight`)
      for (const marker of ["STEER_FIRST_", "STEER_SECOND_"]) {
        await input.fill(`${marker}${agentMode}`)
        await settle()
        await input.press("Enter")
        await chat.getByRole("button", { name: "引导", exact: true }).last().click()
      }
      assert.equal(requests.filter(item => item.user.includes(`STEER_HOLD_${agentMode}`)).length, 1,
        "steering does not cancel or restart an in-flight model call")
      releaseOrdinaryTurn!()
      await chat.getByText("STEER_AFTER_BOUNDARY", { exact: true }).waitFor({ timeout: 90000 })
      const expected = [`STEER_HOLD_${agentMode}`, "STEER_BEFORE_BOUNDARY",
        `STEER_FIRST_${agentMode}`, `STEER_SECOND_${agentMode}`, "STEER_AFTER_BOUNDARY"]
      const verifyVisible = async () => {
        for (const value of expected)
          assert.equal(await chat.getByText(value, { exact: true }).count(), 1, `${agentMode} renders ${value} exactly once`)
        const visible = await chat.innerText()
        for (let index = 1; index < expected.length; index++)
          assert.ok(visible.indexOf(expected[index - 1]) < visible.indexOf(expected[index]), `${agentMode} visible transcript order`)
      }
      await verifyVisible()
      await waitForBotAppState(page, async ({ id, expected }) => {
        const rows = await (window as any).api.threads.getMessages(id)
        const values = rows.map((row: any) => row.content)
        return expected.every(value => values.filter((item: any) => item === value).length === 1) &&
          expected.every((value, i) => !i || values.indexOf(expected[i - 1]) < values.indexOf(value))
      }, { id: thread.thread_id, expected }, { timeout: 30000 })
      await page.screenshot({ path: join(out, `artifacts/steer-${agentMode}.png`) })
      await page.reload()
      await page.getByText(title, { exact: true }).first().click()
      await chat.getByText("STEER_AFTER_BOUNDARY", { exact: true }).waitFor()
      await verifyVisible()
      console.log(`stage: ${agentMode} two safe-boundary corrections, live and reloaded transcript verified`)
    }
    await page.getByText("Bots", { exact: true }).first().click()
    for (const kind of ["bot-main", "bot-work"]) {
      releaseOrdinaryTurn = undefined
      const bot = await page.evaluate(async name => (window as any).api.bots.create({
        name, instructions: "按要求处理并保留运行中的补充。", color: "#168e87", modelRef: "custom:local-test"
      }), `补充验收-${kind}`)
      await idle()
      await page.getByText(bot.name, { exact: true }).first().click()
      const mainChat = page.locator(`[data-chat-thread-id="${bot.threadId}"]`)
      await mainChat.getByText("本地测试已就绪。", { exact: true }).first().waitFor()
      await idle()
      let threadId = bot.threadId
      if (kind === "bot-work") {
        const result = await page.evaluate(async botId => (window as any).api.bots.works.create({
          botId, operationId: crypto.randomUUID(), title: "运行中补充验收任务", goal: "STEER_HOLD_bot-work"
        }), bot.id)
        threadId = result.work.threadId
        await page.getByRole("button", { name: "进入任务：运行中补充验收任务", exact: true }).click()
      } else {
        await fill(`STEER_HOLD_${kind}`)
        await send()
      }
      await wait(() => !!releaseOrdinaryTurn, `${kind} model in flight`)
      const chat = page.locator(`[data-chat-thread-id="${threadId}"]`)
      await chat.getByText(`STEER_HOLD_${kind}`, { exact: true }).first().waitFor()
      const taskInput = chat.locator('textarea, [role="textbox"][contenteditable="true"]').last()
      const supplements: string[] = []
      for (const marker of ["STEER_FIRST_", "STEER_SECOND_"]) {
        const message = marker + kind
        await taskInput.fill(message)
        await settle()
        await taskInput.press("Enter")
        supplements.push(message)
        await waitForBotAppState(page, async ({ threadId, supplements }) => {
          const { tasks } = await window.api.bots.snapshot()
          const queued = tasks.filter(task => task.threadId === threadId && task.state === "queued")
          return supplements.every(message => queued.some(task => task.message === message))
        }, { threadId, supplements })
      }
      assert.equal(requests.filter(item => item.user.includes(`STEER_HOLD_${kind}`)).length, 1)
      releaseOrdinaryTurn!()
      await chat.getByText("STEER_AFTER_BOUNDARY", { exact: true }).waitFor({ timeout: 90000 })
      await idle()
      const expected = ["STEER_BEFORE_BOUNDARY", `STEER_FIRST_${kind}`, `STEER_SECOND_${kind}`, "STEER_AFTER_BOUNDARY"]
      await waitForBotAppState(page, async ({ threadId, expected }) => {
        const rows = await (window as any).api.threads.getMessages(threadId)
        const values = rows.map((r: any) => r.content)
        return expected.every(value => values.filter((v: any) => v === value).length === 1) &&
          expected.every((value, i) => !i || values.indexOf(expected[i - 1]) < values.indexOf(value))
      }, { threadId, expected })
      for (const value of expected) assert.equal(await chat.getByText(value, { exact: true }).count(), 1)
      await page.screenshot({ path: join(out, `artifacts/steer-${kind}.png`) })
      await page.reload()
      await page.getByText("Bots", { exact: true }).first().click()
      await page.getByText(bot.name, { exact: true }).first().click()
      if (kind === "bot-work") await page.getByRole("button", { name: "进入任务：运行中补充验收任务", exact: true }).click()
      await chat.getByText("STEER_AFTER_BOUNDARY", { exact: true }).waitFor()
      for (const value of expected) assert.equal(await chat.getByText(value, { exact: true }).count(), 1)
      console.log(`stage: ${kind} two corrections retained in the same run/thread, UI and reload verified`)
    }
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
    releaseToolFrame?.()
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
