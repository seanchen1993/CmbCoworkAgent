/** Real desktop/preload/IPC/detached Host; enterprise identity is a local fixture
 * and a loopback model holds its reply until the desktop exits.
 * CMB_BOT_APP_BINARY selects a packaged app executable. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { existsSync, watch } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import { _electron, type ElectronApplication, type Page } from "playwright"
import { BotTransportClient, type BotHostDescriptor } from "../src/main/bots/transport-client"
import { botMessageLink } from "../src/shared/bot-deep-link"
import { botViewAddress } from "../src/renderer/src/lib/bot-thread-view"
import { MEMORY_SYNTHESIS_PROMPT_MARKER } from "../src/main/bots/upstream/grok-memory-synthesis"
import { protectWindows } from "../src/main/bots/credential-protection"
import { unwrapBotIpcResult } from "../src/shared/bot-ipc-result"
import { createTestLocalProjectAccess } from "../src/main/bots/test-local-project-permission"
import type { BotLocalToolCard } from "../src/shared/bot-local-tool-permission"
import {
  inspectOwnedShellReceipts,
  inspectOwnedShellReceiptEntries
} from "../src/main/bots/owned-shell-receipts"
import { hasOwnedShellPhysicalClosure } from "../src/main/bots/owned-shell-receipt-contract"
import { BOT_OWNED_SHELL_RESOURCE_DIRECTORY } from "../src/main/bots/owned-shell-maintenance-fence"
import * as XLSX from "xlsx"

async function until(check: () => Promise<boolean>, label: string, timeout = 30_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error("Timed out: " + label)
}

/** Playwright's owning CDP session forces focus/visibility. Emulation is scoped
 * to a session, so a second public CDP session cannot release that override.
 * This test-only adapter is intentionally guarded against dependency changes;
 * it does not alter the renderer or synthesize its visibility events. */
async function emulatePageFocus(page: Page, enabled: boolean): Promise<void> {
  const connection = (
    page as unknown as {
      _connection?: {
        toImpl?(page: Page): {
          delegate?: {
            _mainFrameSession?: {
              _client?: { send(method: string, value: { enabled: boolean }): Promise<unknown> }
            }
          }
        }
      }
    }
  )._connection
  const owner = connection?.toImpl?.(page)?.delegate?._mainFrameSession?._client
  assert.ok(owner?.send, "Playwright focus adapter changed; update the native visibility fixture")
  await owner.send("Emulation.setFocusEmulationEnabled", { enabled })
}

async function main() {
  const root = process.cwd()
  const folder = await mkdtemp(join(tmpdir(), "cmb-bot-desktop-"))
  const data = join(folder, "data")
  const evidence = resolve("output/bot-desktop")
  await Promise.all([mkdir(data), mkdir(evidence, { recursive: true })])
  // A failed run must not leave a previous successful report looking current.
  await Promise.all(
    ["checks.json", "retained-shell-resources.json", "native-command-scope.json"].map((name) =>
      rm(join(evidence, name), { force: true })
    )
  )
  // Metadata only: never read or print the credential-bearing snapshot.
  const configurationTrace: unknown[] = []
  const configurationWatcher = watch(data, { recursive: true }, (event, name) => {
    if (!name?.toString().includes("models.private")) return
    configurationTrace.push({
      at: new Date().toISOString(),
      event,
      name: String(name),
      pending: existsSync(join(data, "bot-host/models.private.pending"))
    })
    if (configurationTrace.length > 256) configurationTrace.shift()
  })
  configurationWatcher.on("error", () => console.warn("Fixture configuration trace unavailable"))
  configurationWatcher.unref()
  const fixtureUser = {
    sapId: "bot-desktop-fixture",
    ystId: "bot-desktop-fixture",
    userName: "Bot Desktop Fixture",
    originOrgId: "",
    orgName: "",
    pathName: "",
    originPathId: "",
    ystRefreshToken: "",
    ystCode: "",
    ystAccessToken: ""
  }
  await writeFile(join(data, "userinfo-models.json"), JSON.stringify(fixtureUser))
  const binary = process.env.CMB_BOT_APP_BINARY
    ? resolve(process.env.CMB_BOT_APP_BINARY)
    : (createRequire(import.meta.url)("electron") as string)
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value &&
      /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|display|wayland_display|xdg_runtime_dir|dbus_session_bus_address|lang)$/i.test(
        name
      )
    )
      env[name] = value
  }
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: data,
    // This isolated Bot journey does not exercise trace encryption. Avoid
    // reading the user's macOS keychain from a freshly ad-hoc-signed test app.
    CMB_COWORK_TRACE_STORAGE_MODE: "off",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1"
  })
  let requested = false
  let modelRequests = 0
  let memoryRequests = 0
  const modelToolCatalogs: { request: number; probe: boolean; tools: string[] }[] = []
  const rejectedExecuteContents: string[] = []
  let unsolicitedExecuteCalls = 0
  let browserActivated = false
  let browserState: { cookie: string; value: string | null } | undefined
  // Bound fixture-only traffic diagnostics so a failed restore distinguishes
  // an HTTP/state failure from an unexpected edit to the navigation input.
  const fixtureTraffic: { at: string; method: string; path: string }[] = []
  let release!: () => void
  const held = new Promise<void>((done) => {
    release = done
  })
  const server = createServer(async (req, res) => {
    fixtureTraffic.push({
      at: new Date().toISOString(),
      method: req.method ?? "",
      path: (req.url ?? "").slice(0, 256)
    })
    if (fixtureTraffic.length > 128) fixtureTraffic.shift()
    if (req.url === "/desktop") {
      res
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "checkpoint=before; Path=/; Max-Age=3600; SameSite=Lax"
        })
        .end(
          "<!doctype html><title>本机浏览器验收</title><h1>Bot 工作浏览器</h1>" +
            "<button autofocus onclick=\"fetch('/activated',{method:'POST'});this.textContent='已确认'\">确认操作</button><script>localStorage.setItem('checkpoint','before')</script>"
        )
      return
    }
    if (req.url === "/activated" && req.method === "POST") {
      browserActivated = true
      res.writeHead(204).end()
      return
    }
    if (req.url === "/inspect") {
      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(
          "<!doctype html><title>浏览器恢复验收</title><p>检查恢复后的站点状态</p><script>fetch('/state',{method:'POST',body:JSON.stringify({cookie:document.cookie,value:localStorage.getItem('checkpoint')})})</script>"
        )
      return
    }
    if (req.url === "/state" && req.method === "POST") {
      const chunks: Buffer[] = []
      for await (const bytes of req) chunks.push(Buffer.from(bytes))
      browserState = JSON.parse(Buffer.concat(chunks).toString())
      res.writeHead(204).end()
      return
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end()
      return
    }
    const parts: Buffer[] = []
    for await (const bytes of req) parts.push(Buffer.from(bytes))
    const body = JSON.parse(Buffer.concat(parts).toString())
    assert.equal(body.model, "bot-desktop-fixture")
    // Memory maintenance shares the provider but is not a submitted agent task.
    // Match only the trusted system message; all other requests count as work.
    const memory = body.messages?.some(
      (message: { role?: string; content?: unknown }) =>
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith(MEMORY_SYNTHESIS_PROMPT_MARKER)
    )
    if (memory) memoryRequests++
    else {
      requested = true
      modelRequests++
      await held
    }
    const shellProbe =
      !memory &&
      body.messages.some(
        (message: { role?: string; content?: unknown }) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("PACKAGED_SHELL_BOUNDARY")
      )
    const shellResult = body.messages.some(
      (message: { role?: string; tool_call_id?: string }) =>
        message.role === "tool" && message.tool_call_id === "desktop-shell-probe"
    )
    const callShell = shellProbe && !shellResult
    if (!memory) {
      const tools = Array.isArray(body.tools)
        ? body.tools.map((tool: { function?: { name?: unknown } }) => tool.function?.name)
        : []
      assert.ok(tools.every((name: unknown) => typeof name === "string"))
      modelToolCatalogs.push({ request: modelRequests, probe: shellProbe, tools })
    }
    if (process.platform === "darwin" && callShell) unsolicitedExecuteCalls++
    if (process.platform === "darwin" && shellResult) {
      const result = body.messages.find(
        (message: { role?: string; tool_call_id?: string }) =>
          message.role === "tool" && message.tool_call_id === "desktop-shell-probe"
      )
      rejectedExecuteContents.push(
        (typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content)
        ).slice(0, 8192)
      )
    }
    const responseId = randomUUID()
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" })
    for (const chunk of [
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              ...(callShell
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: "desktop-shell-probe",
                        type: "function",
                        function: {
                          name: "execute",
                          arguments: JSON.stringify({
                            command: "node verify.cjs",
                            timeout_seconds: 20
                          })
                        }
                      }
                    ]
                  }
                : {
                    content: memory
                      ? '{"changes":[]}'
                      : shellProbe
                        ? process.platform === "darwin"
                          ? "NATIVE_COMMAND_UNAVAILABLE_WITHOUT_EXECUTION"
                          : "SHELL_PROBE_FINISHED"
                        : "DESKTOP_CLOSED_TASK_FINISHED"
                  })
            },
            finish_reason: null
          }
        ]
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: callShell ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }
    ])
      res.write(
        "data: " +
          JSON.stringify({
            id: responseId,
            object: "chat.completion.chunk",
            model: "bot-desktop-fixture",
            ...chunk
          }) +
          "\n\n"
      )
    res.end("data: [DONE]\n\n")
  }).listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  let app: ElectronApplication | undefined
  let page: Page | undefined
  let client: BotTransportClient | undefined
  const errors: string[] = []
  const checks: string[] = []
  let fixtureComputerBotId: string | undefined
  let fixtureShellProbe:
    | { conversationId: string; runId: string; botId: string; workspace: string }
    | undefined
  let cleanupFailure: unknown
  let fixtureOwnedHostCapture = false
  const boot = async (activation?: string) => {
    app = await _electron.launch({
      executablePath: binary,
      args: [
        ...(process.env.CMB_BOT_APP_BINARY ? [] : [join(root, "out/main/index.js")]),
        "--user-data-dir=" + join(folder, "electron"),
        "--proxy-server=http://127.0.0.1:9",
        "--proxy-bypass-list=<-loopback>;127.0.0.1;localhost",
        ...(activation ? [activation] : [])
      ],
      cwd: root,
      env,
      timeout: 60_000
    })
    app.on("window", (window) => {
      window.on("pageerror", (error) => {
        errors.push(error.message)
        console.error("Renderer error: " + error.message)
      })
      window.on("requestfailed", (request) => {
        if (request.url().startsWith("file:"))
          console.error("Asset failure: " + request.url() + " " + request.failure()?.errorText)
      })
    })
    await app
      .context()
      .route("**/cowork/login-info", (route) =>
        route.fulfill({ json: { returnCode: "SUC0000", body: fixtureUser } })
      )
    await until(async () => {
      for (const candidate of app!.windows()) {
        if (await candidate.evaluate(() => Boolean(window.api?.bots)).catch(() => false)) {
          page = candidate
          return true
        }
      }
      return false
    }, "desktop preload")
    await page!.addInitScript("window.__name = (value) => value")
    await page!.evaluate("window.__name = (value) => value")
    const nativeWindow = await app.browserWindow(page!)
    await nativeWindow.evaluate((native) => {
      native.show()
      native.focus()
    })
    await nativeWindow.dispose()
    page!.on("pageerror", (error) => {
      errors.push(error.message)
      console.error("Renderer error: " + error.message)
    })
    page!.on("console", (message) => {
      if (message.type() === "error") console.error("Renderer console: " + message.text())
      if (
        /changing from (?:uncontrolled to controlled|controlled to uncontrolled)/.test(
          message.text()
        )
      )
        errors.push(message.text())
    })
    page!.setDefaultTimeout(20_000)
    if (!activation) {
      await page!.reload()
      await page!.getByRole("button", { name: "Bot 工作区", exact: true }).click()
    }
    await page!.getByTestId("bot-workspace").waitFor()
  }
  try {
    await boot()
    const previewBoundary = await page!.evaluate(async () => {
      const denied = await window.api.botLinkPreviews.getLinkPreview({
        requestId: crypto.randomUUID(),
        url: "http://127.0.0.1/private"
      })
      await window.api.botLinkPreviews.cancelLinkPreview({ requestId: crypto.randomUUID() })
      return denied
    })
    assert.deepEqual(previewBoundary, { status: "unavailable", reason: "blocked" })
    checks.push(
      "Packaged Main preview IPC rejects a non-HTTPS request without creating a Host task"
    )
    assert.equal(await page!.getByRole("button", { name: "新任务", exact: true }).count(), 0)
    await page!.getByRole("button", { name: "工作区菜单", exact: true }).click()
    await page!.getByRole("menuitem", { name: "返回工作台", exact: true }).click()
    await page!.getByRole("button", { name: "新任务", exact: true }).waitFor()
    await page!.getByRole("button", { name: "Bot 工作区", exact: true }).click()
    await page!.getByTestId("bot-workspace").waitFor()
    assert.ok((await page!.getByTestId("bot-workspace").boundingBox())!.x < 2)
    await page!.getByRole("button", { name: "搜索工作区", exact: true }).click()
    await page!.getByRole("dialog", { name: "快速查找与操作", exact: true }).waitFor()
    await page!.screenshot({ path: join(evidence, "desktop-command-palette.png") })
    await page!.keyboard.press("Escape")
    await page!
      .getByRole("dialog", { name: "快速查找与操作", exact: true })
      .waitFor({ state: "hidden" })
    await page!.getByRole("button", { name: "连接应用", exact: true }).click()
    const connectorSettings = page!.getByRole("dialog", { name: "设置", exact: true })
    await connectorSettings
      .getByRole("heading", { name: "MCP 连接器", exact: true, level: 2 })
      .waitFor()
    await page!.screenshot({
      animations: "disabled",
      path: join(evidence, "desktop-connect-apps.png")
    })
    await page!.keyboard.press("Escape")
    await connectorSettings.waitFor({ state: "hidden" })
    checks.push(
      "Connect apps opens the existing connector settings and returns to the Bot workspace"
    )
    await page!.getByRole("button", { name: "应用设置", exact: true }).click()
    await page!.getByRole("dialog", { name: "设置", exact: true }).waitFor()
    await page!
      .getByRole("dialog", { name: "设置", exact: true })
      .getByRole("button", { name: "模型", exact: true })
      .waitFor()
    await page!
      .getByRole("dialog", { name: "设置", exact: true })
      .getByRole("heading", { name: "通用", exact: true })
      .waitFor()
    const settingsBounds = (await page!
      .getByRole("dialog", { name: "设置", exact: true })
      .boundingBox())!
    assert.ok(settingsBounds.x > 10 && settingsBounds.width <= 1121)
    assert.equal(await page!.locator("[data-workspace-surface]").getAttribute("inert"), "")
    assert.equal(
      await page!
        .locator("[data-workspace-surface]")
        .evaluate((node) => getComputedStyle(node).opacity),
      "1"
    )
    await page!.screenshot({ path: join(evidence, "desktop-settings.png") })
    await page!
      .getByRole("dialog", { name: "设置", exact: true })
      .getByRole("button", { name: "模型", exact: true })
      .click()
    const modelSettings = page!.getByRole("region", { name: "模型设置", exact: true })
    await modelSettings.waitFor()
    await modelSettings.getByRole("button", { name: "模型配置", exact: true }).click()
    const modelEditor = page!.getByRole("dialog", { name: /编辑(内置模型参数|模型配置)/ })
    await modelEditor.waitFor()
    await modelEditor.getByRole("button", { name: "新增", exact: true }).click()
    await modelEditor.getByPlaceholder("例如：DeepSeek Chat（生产）").fill("Bot desktop fixture")
    await modelEditor
      .getByPlaceholder("https://api.example.com/v1")
      .fill("http://127.0.0.1:" + address.port + "/v1")
    await modelEditor.getByPlaceholder("gpt-4o, deepseek-chat, ...").fill("bot-desktop-fixture")
    await modelEditor.getByPlaceholder("sk-...").fill("fixture-key")
    await page!.screenshot({ path: join(evidence, "desktop-model-settings.png") })
    await modelEditor.getByRole("button", { name: "保存", exact: true }).click()
    await modelEditor.waitFor({ state: "hidden" })
    await modelSettings
      .getByRole("button", { name: "配置模型 Bot desktop fixture", exact: true })
      .waitFor()
    checks.push("Bot settings opens the shared model editor and saves a usable model")
    await page!.keyboard.press("Escape")
    await page!.getByRole("dialog", { name: "设置", exact: true }).waitFor({ state: "hidden" })
    checks.push("Bot workspace uses one sidebar; workbench navigation remains available")
    const model = await page!.evaluate(async () => {
      const catalog = await window.api.models.getCatalog()
      const configured = catalog.models.find((item) => item.name === "Bot desktop fixture")
      if (!configured) throw new Error("Model editor did not publish the saved model")
      await window.api.models.setDefault(configured.id)
      return configured
    })
    const created = unwrapBotIpcResult(
      await page!.evaluate(
        ({ modelRef }) =>
          window.api.bots.create({ nonce: "desktop-bot", name: "桌面验收 Bot", modelRef }),
        { modelRef: model.id }
      )
    )
    const limits = await page!.evaluate(() => window.electron.setAgentRuntimeRecursionLimit(321))
    assert.equal(limits.recursionLimit, 321)
    const executionSettings = await page!.evaluate(async () => {
      await window.electron.setAgentToolStrategy("shell-first")
      await window.electron.setWorkflowWorktreeTimeoutMinutes(7)
      await window.api.sandbox.setFailureFuseWarning(false)
      await window.api.sandbox.setFailureFuseModelFeedback(true)
      await window.api.sandbox.setFailureFuseDebug(false)
      return window.electron.setWorkflowWorktreeRemoveTimeoutMinutes(2)
    })
    assert.equal(executionSettings.toolStrategy, "shell-first")
    assert.equal(executionSettings.workflowWorktreeTimeoutMinutes, 7)
    assert.equal(executionSettings.workflowWorktreeRemoveTimeoutMinutes, 2)
    // Inspect the atomically published value at acknowledgement. A subsequent
    // unrelated settings event may already have fenced the next refresh; that
    // does not undo this publication. Never print this credential-bearing file.
    const published = await readFile(join(data, "bot-host/models.private"))
    const plain = process.platform === "win32" ? await protectWindows(published, true) : published
    const snapshot = JSON.parse(plain.toString("utf8"))
    assert.equal(snapshot.graphRecursionLimit, 321)
    assert.equal(
      snapshot.timezone,
      await page!.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
    )
    assert.equal(snapshot.toolStrategy, "shell-first")
    assert.equal(snapshot.workflowWorktreeTimeoutMinutes, 7)
    assert.equal(snapshot.workflowWorktreeRemoveTimeoutMinutes, 2)
    assert.deepEqual(snapshot.failureFuse, {
      mode: "warn",
      userNoticeEnabled: false,
      modelFeedbackEnabled: true
    })
    checks.push(
      "Shared execution limits, tool strategy, failure feedback and Git budgets reach the detached Host before acknowledgement"
    )
    const profileReplies = await page!.evaluate(async ({ id, revision }) => {
      const input = {
        id,
        revision,
        nonce: "desktop-profile-save",
        instructions: "按用户交办的任务工作。"
      }
      const saved = await window.api.bots.update(input)
      const replay = await window.api.bots.update(input)
      return { saved, replay }
    }, created.bot)
    const profile = {
      savedRevision: unwrapBotIpcResult(profileReplies.saved).revision,
      replayRevision: unwrapBotIpcResult(profileReplies.replay).revision
    }
    assert.equal(profile.savedRevision, created.bot.revision + 1)
    assert.equal(profile.replayRevision, profile.savedRevision)
    checks.push(
      "Bot profile save replays its receipt through preload and the detached Host without duplicate edits"
    )
    const routine = unwrapBotIpcResult(
      await page!.evaluate(
        (botId) =>
          window.api.bots.saveRoutine({
            botId,
            nonce: "desktop-routine-create",
            name: "桌面例程验收",
            prompt: "验收前的指令",
            enabled: false,
            timezone: "UTC",
            schedule: { kind: "event", topic: "desktop.fixture" }
          }),
        created.bot.id
      )
    )
    const edited = unwrapBotIpcResult(
      await page!.evaluate(
        (routine) =>
          window.api.bots.saveRoutine({
            ...routine,
            nonce: "desktop-routine-edit",
            prompt: "已更新的例程指令"
          }),
        routine
      )
    )
    const routineRunsBefore = unwrapBotIpcResult(
      await page!.evaluate(() => window.api.bots.snapshot())
    ).runs.length
    const routineResult = await page!.evaluate(
      (routine) =>
        window.api.bots.runRoutine({
          id: routine.id,
          nonce: "desktop-stale-routine-run",
          revision: routine.revision
        }),
      routine
    )
    const manualRoutine = {
      routine: edited,
      code: "botFailure" in routineResult ? routineResult.botFailure.code : "",
      added:
        unwrapBotIpcResult(await page!.evaluate(() => window.api.bots.snapshot())).runs.length -
        routineRunsBefore
    }
    assert.equal(manualRoutine.code, "version_conflict")
    assert.equal(manualRoutine.added, 0)
    checks.push(
      "Packaged preload preserves a stale routine version rejection without creating a task"
    )
    await page!.getByRole("button", { name: "桌面验收 Bot", exact: true }).click()
    await page!
      .getByLabel("向 Bot 交办工作", { exact: true })
      .fill("请返回 DESKTOP_CLOSED_TASK_FINISHED。")
    await page!.getByRole("button", { name: "发送", exact: true }).click()
    await until(async () => requested, "loopback model request")
    await page!.screenshot({ path: join(evidence, "desktop-running.png") })
    await page!.getByRole("button", { name: "Bot 帮助", exact: true }).click()
    const busyHelp = page!.getByRole("dialog", { name: "Bot 帮助与信息", exact: true })
    await busyHelp.getByRole("tab", { name: "关于与反馈", exact: true }).click()
    await busyHelp.getByRole("button", { name: "重启后台", exact: true }).click()
    await busyHelp.getByRole("alert").waitFor()
    assert.match(await busyHelp.getByRole("alert").innerText(), /任务|请求/)
    assert.equal(modelRequests, 1)
    await page!.keyboard.press("Escape")
    checks.push(
      "Packaged restart control rejects unfinished work without cancelling the running model"
    )
    const descriptor = JSON.parse(
      await readFile(join(data, "bot-host/host.json"), "utf8")
    ) as BotHostDescriptor
    client = new BotTransportClient(descriptor)
    const before = await client.call("status")
    await app!.close()
    app = undefined
    assert.equal((await client.call("status")).hostId, before.hostId)
    release()
    await until(
      async () =>
        (await client!.call("messages", { conversationId: created.conversationId })).some(
          (message) => message.text === "DESKTOP_CLOSED_TASK_FINISHED"
        ),
      "task completion without desktop"
    )
    checks.push("Detached Host completes task after desktop exits")
    await boot()
    await page!.getByRole("button", { name: "桌面验收 Bot", exact: true }).click()
    await page!
      .getByRole("article")
      .getByText("DESKTOP_CLOSED_TASK_FINISHED", { exact: true })
      .waitFor()
    await page!
      .getByRole("button", { name: "加载更早消息", exact: true })
      .waitFor({ state: "hidden" })
    checks.push("Desktop restart reloads the original Bot and durable result")
    await page!.getByRole("button", { name: "Bot 帮助", exact: true }).click()
    const help = page!.getByRole("dialog", { name: "Bot 帮助与信息", exact: true })
    await help.getByRole("tab", { name: "关于与反馈", exact: true }).click()
    const electronVersion = await page!.evaluate(() => window.electron.process.versions.electron)
    await help.getByText(electronVersion, { exact: true }).waitFor()
    await page!.screenshot({ animations: "disabled", path: join(evidence, "desktop-about.png") })
    const helpBounds = (await help.boundingBox())!
    const downloadBounds = (await help
      .getByRole("button", { name: "下载诊断信息", exact: true })
      .boundingBox())!
    assert.ok(downloadBounds.y + downloadBounds.height <= helpBounds.y + helpBounds.height)
    await help.getByRole("button", { name: "重启后台", exact: true }).click()
    await help.getByText("后台已重新连接。", { exact: true }).waitFor({ timeout: 45_000 })
    const restarted = unwrapBotIpcResult(await page!.evaluate(() => window.api.bots.status()))
    assert.notEqual(restarted.hostId, before.hostId)
    assert.equal(modelRequests, 1)
    await page!.keyboard.press("Escape")
    await page!
      .getByRole("article")
      .getByText("DESKTOP_CLOSED_TASK_FINISHED", { exact: true })
      .waitFor()
    client.close()
    client = undefined
    checks.push(
      "Packaged restart control starts a new idle Host and retains Bot history without another model call"
    )
    await page!.getByRole("button", { name: "查看 Bot 详情", exact: true }).click()
    await page!.getByRole("complementary", { name: "桌面验收 Bot 的详情", exact: true }).waitFor()
    await page!.screenshot({ path: join(evidence, "desktop-bot-details.png") })
    await page!.getByRole("tab", { name: "资料库", exact: true }).click()
    await page!.getByText("暂无文件", { exact: true }).waitFor()
    await page!.screenshot({ path: join(evidence, "desktop-bot-library.png") })
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["概述", "桌面验收"]]), "摘要")
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["用例", "结果"],
        ["T-1", "通过"]
      ]),
      "测试结果"
    )
    const tableArtifact = unwrapBotIpcResult(
      await page!.evaluate(
        ({ conversationId, base64 }) =>
          window.api.bots.upload({
            nonce: "desktop-table",
            conversationId,
            base64,
            name: "桌面验收.xlsx",
            mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          }),
        {
          conversationId: created.conversationId,
          base64: XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }).toString("base64")
        }
      )
    )
    await page!.getByRole("button", { name: "预览 桌面验收.xlsx", exact: true }).click()
    await page!.getByRole("combobox", { name: "选择工作表", exact: true }).click()
    await page!.getByRole("option", { name: "测试结果", exact: true }).click()
    await page!.getByRole("button", { name: "单元格 B2", exact: true }).click()
    assert.equal(await page!.getByLabel("所选单元格内容", { exact: true }).textContent(), "通过")
    await page!.screenshot({
      animations: "disabled",
      path: join(evidence, "desktop-table-preview.png")
    })
    await page!.keyboard.press("Escape")
    checks.push(
      "Packaged table preview uses the detached file service and compiled parser; sheet selection and cell inspection work"
    )
    // Control only the OS chooser response. The shipped renderer, context
    // bridge, Main service, authenticated Host and native filesystem stay real.
    // This does not claim to validate the operating system's dialog interaction.
    const savedTable = join(folder, "saved-desktop-table.xlsx")
    await app!.evaluate(({ dialog, BrowserWindow }, destination) => {
      const previous = dialog.showSaveDialog
      Reflect.set(globalThis, "__restoreBotSaveChooser", () => {
        Reflect.set(dialog, "showSaveDialog", previous)
      })
      Reflect.set(globalThis, "__botSaveChooserCalls", 0)
      Reflect.set(dialog, "showSaveDialog", async (...args: unknown[]) => {
        if (!(args[0] instanceof BrowserWindow) || args[0].isDestroyed())
          throw new Error("Save chooser must belong to the live native main window")
        if (
          !args[1] ||
          typeof args[1] !== "object" ||
          Reflect.get(args[1], "title") !== "另存成果文件" ||
          Reflect.get(args[1], "buttonLabel") !== "保存"
        )
          throw new Error("Native save chooser contract changed")
        Reflect.set(
          globalThis,
          "__botSaveChooserCalls",
          Reflect.get(globalThis, "__botSaveChooserCalls") + 1
        )
        return { canceled: false, filePath: destination }
      })
    }, savedTable)
    try {
      await page!.getByRole("button", { name: "保存 桌面验收.xlsx", exact: true }).click()
      await until(async () => {
        const jobs = unwrapBotIpcResult(
          await page!.evaluate(() => window.api.botArtifactDownloads.page({}))
        )
        const job = jobs.items.find((item) => item.source.artifactId === tableArtifact.id)
        if (job?.state === "failed") throw new Error(job.error ?? "Native file save failed")
        return job?.state === "completed"
      }, "packaged native artifact save")
      const savedJobs = unwrapBotIpcResult(
        await page!.evaluate(() => window.api.botArtifactDownloads.page({}))
      )
      assert.equal(savedJobs.total, 1)
      const savedJob = savedJobs.items[0]
      assert.equal(savedJob.source.artifactId, tableArtifact.id)
      assert.equal(savedJob.source.sha256, tableArtifact.sha256)
      assert.equal(savedJob.bytes, tableArtifact.size)
      assert.equal(
        JSON.stringify(savedJobs).includes(savedTable),
        false,
        "Native paths must stay in Main"
      )
      const bytes = await readFile(savedTable)
      assert.equal(bytes.length, tableArtifact.size)
      assert.equal(createHash("sha256").update(bytes).digest("hex"), tableArtifact.sha256)
      const replayed = unwrapBotIpcResult(
        await page!.evaluate((input) => window.api.botArtifactDownloads.start(input), {
          nonce: savedJob.id,
          source: savedJob.source
        })
      )
      assert.equal(replayed.id, savedJob.id)
      assert.equal(replayed.state, "completed")
      assert.equal(await app!.evaluate(() => Reflect.get(globalThis, "__botSaveChooserCalls")), 1)
      await page!.getByRole("button", { name: "工作区菜单", exact: true }).click()
      await page!.getByRole("menuitem", { name: "下载与保存", exact: true }).click()
      const saves = page!.getByRole("dialog", { name: "下载与保存", exact: true })
      await saves.waitFor()
      await saves
        .locator(`[data-download-job="${savedJob.id}"]`)
        .getByText(/已保存/)
        .waitFor()
      await page!.screenshot({
        animations: "disabled",
        path: join(evidence, "desktop-artifact-downloads.png")
      })
      await page!.keyboard.press("Escape")
      await saves.waitFor({ state: "hidden" })
      unwrapBotIpcResult(
        await page!.evaluate((input) => window.api.botArtifactDownloads.forget(input), {
          id: savedJob.id,
          revision: savedJob.revision
        })
      )
      assert.equal(
        unwrapBotIpcResult(await page!.evaluate(() => window.api.botArtifactDownloads.page({})))
          .total,
        0
      )
      assert.deepEqual(
        await readFile(savedTable),
        bytes,
        "Forgetting history must retain the user's saved file"
      )
      const archived = await page!.evaluate(
        (input) => window.api.botArtifactDownloads.start(input),
        { nonce: savedJob.id, source: savedJob.source }
      )
      assert.ok("botFailure" in archived)
      assert.equal(archived.botFailure.code, "download_archived")
      assert.equal(await app!.evaluate(() => Reflect.get(globalThis, "__botSaveChooserCalls")), 1)
      checks.push(
        "Packaged artifact saving uses a controlled chooser response with real IPC, authenticated transfer and native SHA verification; exact receipts do not reopen the chooser or rewrite forgotten files"
      )
    } finally {
      await app!.evaluate(() => Reflect.get(globalThis, "__restoreBotSaveChooser")())
    }
    await page!.getByRole("tab", { name: "电脑", exact: true }).click()
    fixtureComputerBotId = created.bot.id
    await page!.getByRole("button", { name: "接管操作", exact: true }).click()
    await page!.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
    const browserText = page!.getByLabel("向浏览器输入文本", { exact: true })
    await browserText.fill("暂存网页输入")
    await page!.getByRole("tab", { name: "详情", exact: true }).click()
    await page!.getByRole("tab", { name: "电脑", exact: true }).click()
    await page!.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
    assert.equal(await browserText.inputValue(), "暂存网页输入")
    checks.push("Inspector tabs retain browser control and unsent text without duplicating panels")
    await page!.getByRole("button", { name: "应用设置", exact: true }).click()
    const floatingSettings = page!.getByRole("dialog", { name: "设置", exact: true })
    await floatingSettings.getByRole("heading", { name: "通用", exact: true }).waitFor()
    await page!.screenshot({
      animations: "disabled",
      path: join(evidence, "desktop-settings-over-browser.png")
    })
    await floatingSettings.getByRole("button", { name: "关闭设置", exact: true }).click()
    await floatingSettings.waitFor({ state: "hidden" })
    await page!.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
    assert.equal(await browserText.inputValue(), "暂存网页输入")
    assert.equal(await page!.locator(".bot-computer-panel").count(), 1)
    checks.push(
      "Floating Bot settings preserve the mounted browser, unsent input and control on return"
    )

    const rejectedText = "界".repeat(16_001)
    await browserText.fill(rejectedText)
    await page!.getByRole("button", { name: "输入", exact: true }).click()
    await page!
      .getByRole("alert")
      .filter({ hasText: /最多 16000/ })
      .waitFor()
    assert.equal(await browserText.inputValue(), rejectedText)
    await browserText.fill("")
    checks.push("Rejected browser input preserves the user's text")
    await browserText.fill("隐藏窗口后保留的输入")
    await page!.getByRole("button", { name: "例程", exact: true }).click()
    const routineDialog = page!.getByRole("dialog", { name: "桌面验收 Bot · 例程", exact: true })
    await routineDialog.getByText("已更新的例程指令", { exact: true }).waitFor()
    const desktopWindow = await app!.browserWindow(page!)
    // Keep DevTools focus emulation enabled: native hide must suspend viewers
    // independently of Chromium continuing to report a visible document.
    await emulatePageFocus(page!, true)
    await page!.evaluate(() => {
      Reflect.set(window, "__botVisibilityEvents", [])
      Reflect.set(
        window,
        "__stopBotVisibilityObservation",
        window.api.windowVisibility.onChanged((value) =>
          Reflect.get(window, "__botVisibilityEvents").push(value)
        )
      )
    })
    await desktopWindow.evaluate((window) => window.hide())
    assert.equal(await desktopWindow.evaluate((window) => window.isVisible()), false)
    // Observe the push channel; calling read here could itself repair a missed
    // lifecycle notification and conceal the regression.
    await page!.waitForFunction(() =>
      Reflect.get(window, "__botVisibilityEvents").some(
        (value: { visible: boolean }) => !value.visible
      )
    )
    assert.equal(await page!.evaluate(() => document.visibilityState), "visible")
    // Allow reads dispatched before the visibility event to finish.
    await new Promise((done) => setTimeout(done, 500))
    client = new BotTransportClient(
      JSON.parse(await readFile(join(data, "bot-host/host.json"), "utf8")) as BotHostDescriptor
    )
    await client.call("create", { nonce: "hidden-window", name: "隐藏窗口验收 Bot" })
    const updatedRoutine = await client.call("saveRoutine", {
      ...manualRoutine.routine,
      nonce: "desktop-hidden-routine-edit",
      prompt: "窗口隐藏期间更新的指令"
    })
    await new Promise((done) => setTimeout(done, 3200))
    assert.equal(await page!.locator('button[aria-label="隐藏窗口验收 Bot"]').count(), 0)
    assert.equal(
      await routineDialog.getByText("窗口隐藏期间更新的指令", { exact: true }).count(),
      0
    )
    await desktopWindow.evaluate((window) => {
      window.show()
      window.focus()
    })
    await routineDialog.getByText("窗口隐藏期间更新的指令", { exact: true }).waitFor()
    await page!.keyboard.press("Escape")
    await routineDialog.waitFor({ state: "hidden" })
    await page!.getByRole("button", { name: "隐藏窗口验收 Bot", exact: true }).waitFor()
    await page!.evaluate(() => {
      Reflect.get(window, "__stopBotVisibilityObservation")()
      Reflect.deleteProperty(window, "__stopBotVisibilityObservation")
      Reflect.deleteProperty(window, "__botVisibilityEvents")
    })
    await client.call("deleteRoutine", {
      id: updatedRoutine.id,
      botId: updatedRoutine.botId,
      revision: updatedRoutine.revision,
      nonce: "desktop-routine-delete"
    })
    await emulatePageFocus(page!, true)
    assert.equal(await browserText.inputValue(), "隐藏窗口后保留的输入")
    await browserText.fill("")
    client.close()
    client = undefined
    await desktopWindow.dispose()
    checks.push(
      "Native hide suspends conversation and routine refresh even with browser focus emulation; Host work continues and reopening refreshes data and retains input"
    )
    await page!
      .getByLabel("浏览器网址", { exact: true })
      .fill("http://127.0.0.1:" + address.port + "/desktop")
    await page!.getByRole("button", { name: "前往", exact: true }).click()
    await page!.getByRole("img", { name: "本机浏览器验收", exact: true }).waitFor()
    await page!
      .getByRole("application", { name: "浏览器画面，接管后点击或按键操作", exact: true })
      .focus()
    await page!.keyboard.press("Enter")
    await until(async () => browserActivated, "human input reaches the native browser")
    await page!.screenshot({ path: join(evidence, "desktop-browser.png") })
    await page!.getByRole("button", { name: "归还 Bot", exact: true }).click()
    await page!.getByRole("button", { name: "接管操作", exact: true }).waitFor()
    await page!.screenshot({ path: join(evidence, "desktop-browser-preview.png") })
    const status = unwrapBotIpcResult(await page!.evaluate(() => window.api.bots.status()))
    assert.equal(status.computer?.state, "ready")
    assert.match(status.computer?.version ?? "", /^\d+\.\d+/)
    checks.push("Packaged UI takes browser control, navigates, sends input and releases control")
    checks.push("Packaged IPC reports the running browser's actual version")
    await page!.getByRole("button", { name: "关闭电脑面板", exact: true }).click()
    const maintenance = async () => {
      await page!.getByRole("button", { name: "工作区菜单", exact: true }).click()
      await page!.getByRole("menuitem", { name: "备份与恢复", exact: true }).click()
      await page!.getByRole("button", { name: "工作浏览器恢复与重置", exact: true }).click()
      await page!.getByRole("dialog", { name: "工作浏览器恢复与重置", exact: true }).waitFor()
    }
    const inspect = async () => {
      browserState = undefined
      await page!.getByRole("button", { name: "查看 Bot 浏览器", exact: true }).click()
      await page!.getByRole("button", { name: "接管操作", exact: true }).click()
      await page!.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
      const inspectionUrl = "http://127.0.0.1:" + address.port + "/inspect"
      const addressInput = page!.getByLabel("浏览器网址", { exact: true })
      await addressInput.fill(inspectionUrl)
      assert.equal(await addressInput.inputValue(), inspectionUrl)
      await page!.getByRole("button", { name: "前往", exact: true }).click()
      await until(async () => !!browserState, "restored native browser state")
      await page!.getByRole("button", { name: "归还 Bot", exact: true }).click()
      await page!.getByRole("button", { name: "接管操作", exact: true }).waitFor()
      await page!.getByRole("button", { name: "关闭电脑面板", exact: true }).click()
      return browserState!
    }
    await maintenance()
    await page!.getByRole("button", { name: "保存恢复点", exact: true }).click()
    await page!.getByRole("button", { name: "确认", exact: true }).click()
    await page!.getByText("1 / 20 份恢复点", { exact: true }).waitFor()
    const checkpoint = unwrapBotIpcResult(
      await page!.evaluate(() => window.api.botBrowserMaintenance.list())
    )[0]
    await page!.getByRole("button", { name: "重置浏览器", exact: true }).click()
    await page!.getByRole("button", { name: "确认", exact: true }).click()
    await page!.getByText("2 / 20 份恢复点", { exact: true }).waitFor()
    await page!.getByRole("button", { name: "保存恢复点", exact: true }).waitFor()
    await until(
      async () => page!.getByRole("button", { name: "保存恢复点", exact: true }).isEnabled(),
      "maintenance and workspace refresh settle"
    )
    await page!.keyboard.press("Escape")
    await page!
      .getByRole("dialog", { name: "工作浏览器恢复与重置", exact: true })
      .waitFor({ state: "hidden" })
    assert.deepEqual(await inspect(), { cookie: "", value: null })
    await maintenance()
    await page!
      .getByTestId(`browser-checkpoint-${checkpoint.id}`)
      .getByRole("button", { name: "恢复", exact: true })
      .click()
    await page!.getByRole("button", { name: "确认", exact: true }).click()
    await page!.getByText("3 / 20 份恢复点", { exact: true }).waitFor()
    await until(
      async () => page!.getByRole("button", { name: "保存恢复点", exact: true }).isEnabled(),
      "restoration and workspace refresh settle"
    )
    await page!.screenshot({ path: join(evidence, "desktop-browser-maintenance.png") })
    await page!.keyboard.press("Escape")
    assert.deepEqual(await inspect(), { cookie: "checkpoint=before", value: "before" })
    checks.push(
      "Packaged UI/IPC/worker saves, resets and restores real browser cookies and site storage"
    )
    await page!.getByRole("button", { name: "工作区菜单", exact: true }).click()
    await page!.getByRole("menuitem", { name: "备份与恢复", exact: true }).click()
    const backupDialog = page!.getByRole("dialog", { name: "备份与恢复", exact: true })
    await backupDialog.waitFor()
    // The button includes a visible description in its accessible name.
    await backupDialog
      .getByRole("button")
      .filter({ has: page!.getByText("电脑恢复点", { exact: true }) })
      .click()
    const computerDialog = page!.getByRole("dialog", { name: "电脑检查点", exact: true })
    await computerDialog.waitFor()
    await computerDialog.getByText("0 / 20 份", { exact: true }).waitFor()
    await computerDialog.getByRole("button", { name: "保存检查点", exact: true }).click()
    await computerDialog.getByRole("button", { name: "确认操作", exact: true }).click()
    await computerDialog.getByText("电脑检查点已保存", { exact: true }).waitFor()
    const computerPoints = unwrapBotIpcResult(
      await page!.evaluate(() => window.api.botComputerCheckpoints.list())
    )
    assert.equal(computerPoints.length, 1)
    const computerPoint = computerPoints[0]
    assert.equal(computerPoint.platform, process.platform)
    assert.equal(computerPoint.data, "established")
    assert.equal(computerPoint.browser, "established")
    const duplicatePoint = unwrapBotIpcResult(
      await page!.evaluate(
        (nonce) => window.api.botComputerCheckpoints.execute({ action: "create", nonce }),
        computerPoint.id
      )
    )
    assert.equal(duplicatePoint.action, "create")
    if (duplicatePoint.action === "create")
      assert.equal(duplicatePoint.checkpoint.sha256, computerPoint.sha256)
    assert.equal(
      unwrapBotIpcResult(await page!.evaluate(() => window.api.botComputerCheckpoints.list()))
        .length,
      1
    )
    await page!.screenshot({ path: join(evidence, "desktop-computer-checkpoints.png") })
    await computerDialog
      .getByTestId(`computer-checkpoint-${computerPoint.id}`)
      .getByRole("button", { name: /^删除 / })
      .click()
    await computerDialog.getByRole("button", { name: "确认操作", exact: true }).click()
    await computerDialog.getByText("电脑检查点已删除", { exact: true }).waitFor()
    await computerDialog.getByText("0 / 20 份", { exact: true }).waitFor()
    const deletedPoint = await page!.evaluate(
      (nonce) => window.api.botComputerCheckpoints.execute({ action: "create", nonce }),
      computerPoint.id
    )
    assert.ok("botFailure" in deletedPoint)
    assert.equal(deletedPoint.botFailure.code, "snapshot_deleted")
    assert.equal(
      unwrapBotIpcResult(await page!.evaluate(() => window.api.botComputerCheckpoints.list()))
        .length,
      0
    )
    await page!.keyboard.press("Escape")
    await computerDialog.waitFor({ state: "hidden" })
    checks.push(
      "Packaged computer checkpoints use the shipped native worker and preserve exact creation and deletion receipts across preload IPC"
    )
    if (process.platform === "darwin" && process.env.CMB_BOT_APP_BINARY) {
      const branchMessages = unwrapBotIpcResult(
        await page!.evaluate(
          (conversationId) => window.api.bots.messages({ conversationId }),
          created.conversationId
        )
      )
      const branchRoot = branchMessages.find((message) => message.sender === "user")!
      const branchReceipt = unwrapBotIpcResult(
        await page!.evaluate(
          ({ conversationId, threadRootId }) =>
            window.api.bots.send({
              nonce: "desktop-external-link",
              conversationId,
              threadRootId,
              text: "外部链接分支定位验收"
            }),
          { conversationId: created.conversationId, threadRootId: branchRoot.id }
        )
      )
      const branch = { rootId: branchRoot.id, runId: branchReceipt.runIds[0] }
      await until(
        async () =>
          unwrapBotIpcResult(
            await page!.evaluate((input) => window.api.bots.runHistory(input), {
              conversationId: created.conversationId,
              runId: branch.runId,
              threadRootId: branch.rootId
            })
          ).run.status === "succeeded",
        "branch completion"
      )
      const target = unwrapBotIpcResult(
        await page!.evaluate((input) => window.api.bots.messages(input), {
          conversationId: created.conversationId,
          threadRootId: branch.rootId
        })
      ).at(-1)!
      const link = botMessageLink({ conversationId: created.conversationId, messageId: target.id })
      const requestsBeforeNavigation = modelRequests
      const messagesBeforeNavigation = unwrapBotIpcResult(
        await page!.evaluate(
          ({ conversationId, threadRootId }) =>
            window.api.bots.messages({ conversationId, threadRootId }),
          { conversationId: created.conversationId, threadRootId: branch.rootId }
        )
      )
      const pid = app!.process().pid
      // Explicitly target this isolated test package, never the user's default app.
      // This exercises Launch Services / open-url, not an injected Electron event.
      await promisify(execFile)("/usr/bin/open", ["-a", dirname(dirname(dirname(binary))), link])
      await page!.getByRole("region", { name: "分支讨论", exact: true }).waitFor()
      const row = page!.locator(`[data-message-id="${target.id}"]`)
      await row.waitFor()
      await until(
        async () =>
          (await row.locator(".bot-message-bubble").getAttribute("data-reply-highlight")) ===
          "true",
        "OS URL message highlight"
      )
      assert.equal(app!.process().pid, pid)
      assert.equal(modelRequests, requestsBeforeNavigation)
      assert.deepEqual(
        unwrapBotIpcResult(
          await page!.evaluate(
            ({ conversationId, threadRootId }) =>
              window.api.bots.messages({ conversationId, threadRootId }),
            { conversationId: created.conversationId, threadRootId: branch.rootId }
          )
        ),
        messagesBeforeNavigation
      )
      await page!.screenshot({
        animations: "disabled",
        path: join(evidence, "desktop-external-branch.png")
      })
      checks.push(
        "macOS opens an external message link in the running packaged app's correct branch without submitting work"
      )
      await page!.getByRole("button", { name: "返回主对话", exact: true }).click()
      await page!
        .getByRole("region", { name: "分支讨论", exact: true })
        .waitFor({ state: "hidden" })
      await app!.close()
      app = undefined
      await boot(link)
      await page!.getByRole("region", { name: "分支讨论", exact: true }).waitFor()
      await page!.locator(`[data-message-id="${target.id}"]`).waitFor()
      assert.equal(modelRequests, requestsBeforeNavigation)
      assert.deepEqual(
        unwrapBotIpcResult(
          await page!.evaluate(
            ({ conversationId, threadRootId }) =>
              window.api.bots.messages({ conversationId, threadRootId }),
            { conversationId: created.conversationId, threadRootId: branch.rootId }
          )
        ),
        messagesBeforeNavigation
      )
      await page!.screenshot({
        animations: "disabled",
        path: join(evidence, "desktop-startup-branch.png")
      })
      checks.push(
        "A message URL supplied at packaged cold startup waits for the renderer and opens its original branch without submitting work"
      )
    }
    if (process.platform === "darwin") {
      // The cold-start journey deliberately exits the previous Main, so its
      // detached Host handle cannot be recovered from a descriptor PID. Capture
      // one real launch by this still-live Main before the weak Shell runs.
      const ownedHostDirectory = await realpath(join(data, "bot-host"))
      await app!.evaluate(({ app }, directory) => {
        const childProcess = process.getBuiltinModule("child_process")
        const fs = process.getBuiltinModule("fs")
        const path = process.getBuiltinModule("path")
        const logicalRoot = path.join(path.resolve(process.env.CMB_COWORK_AGENT_HOME!), "bot-host")
        const rootIdentity = fs.lstatSync(directory, { bigint: true })
        if (
          fs.realpathSync(logicalRoot) !== directory ||
          !rootIdentity.isDirectory() ||
          rootIdentity.isSymbolicLink() ||
          Reflect.has(globalThis, "__botFixtureOwnedHostControl")
        )
          throw new Error("Fixture Host capture root is not exact")
        const executable = process.execPath
        const entry = path.join(app.getAppPath(), "out", "main", "bot-host.js")
        const original = childProcess.spawn
        const record: {
          child?: import("node:child_process").ChildProcess
          launched: number
          bound?: { hostId: string; token: string }
          stopping: boolean
          signalled: boolean
          closed: boolean
          code: number | null
          signal: NodeJS.Signals | null
          spawnError: boolean
        } = {
          launched: 0,
          stopping: false,
          signalled: false,
          closed: false,
          code: null,
          signal: null,
          spawnError: false
        }
        Reflect.set(childProcess, "spawn", (...args: unknown[]) => {
          const argv = Array.isArray(args[1]) ? args[1] : []
          if (argv.length !== 3 || argv[1] !== "--data-dir" || argv[2] !== logicalRoot)
            return Reflect.apply(original, childProcess, args)
          const current = fs.lstatSync(directory, { bigint: true })
          const options = args[2]
          if (
            record.stopping ||
            record.launched !== 0 ||
            args[0] !== executable ||
            argv[0] !== entry ||
            !options ||
            typeof options !== "object" ||
            Reflect.get(options, "detached") !== true ||
            Reflect.get(options, "windowsHide") !== true ||
            Reflect.get(options, "stdio") !== "ignore" ||
            Reflect.get(Reflect.get(options, "env") ?? {}, "ELECTRON_RUN_AS_NODE") !== "1" ||
            fs.realpathSync(logicalRoot) !== directory ||
            current.dev !== rootIdentity.dev ||
            current.ino !== rootIdentity.ino
          )
            throw new Error("Fixture Host launch is fenced or its exact identity changed")
          const child = Reflect.apply(
            original,
            childProcess,
            args
          ) as import("node:child_process").ChildProcess
          record.child = child
          record.launched++
          child.once("error", () => {
            record.spawnError = true
          })
          child.once("close", (code, signal) => {
            record.closed = true
            record.code = code
            record.signal = signal
          })
          return child
        })
        Reflect.set(
          globalThis,
          "__botFixtureOwnedHostControl",
          (request: { action: "bind" | "fence" | "stop" | "state"; hostId?: string }) => {
            if (request.action === "fence" || request.action === "stop") record.stopping = true
            const child = record.child
            if (request.action === "bind" || (request.action === "stop" && !record.closed)) {
              const current = fs.lstatSync(directory, { bigint: true })
              if (
                fs.realpathSync(logicalRoot) !== directory ||
                current.dev !== rootIdentity.dev ||
                current.ino !== rootIdentity.ino ||
                !child?.pid ||
                record.spawnError ||
                child.exitCode !== null ||
                child.signalCode !== null
              )
                throw new Error("Fixture does not hold its live exact Host child")
              if (request.action === "bind" || record.bound) {
                const descriptor = JSON.parse(
                  fs.readFileSync(path.join(directory, "host.json"), "utf8")
                ) as { pid: number; hostId: string; token: string }
                if (
                  descriptor.pid !== child.pid ||
                  !descriptor.hostId ||
                  descriptor.hostId === "starting" ||
                  typeof descriptor.token !== "string" ||
                  (request.action === "bind" && descriptor.hostId !== request.hostId) ||
                  (record.bound &&
                    (descriptor.hostId !== record.bound.hostId ||
                      descriptor.token !== record.bound.token))
                )
                  throw new Error("Fixture Host descriptor no longer matches its actual child")
                if (request.action === "bind")
                  record.bound = { hostId: descriptor.hostId, token: descriptor.token }
              }
              if (request.action === "stop") {
                if (!record.signalled) {
                  if (!child.kill("SIGTERM")) throw new Error("Fixture Host SIGTERM was not sent")
                  record.signalled = true
                }
              }
            }
            return {
              launched: record.launched,
              bound: !!record.bound,
              signalled: record.signalled,
              closed: record.closed,
              code: record.code,
              signal: record.signal,
              spawnError: record.spawnError
            }
          }
        )
      }, ownedHostDirectory)
      fixtureOwnedHostCapture = true
      const beforeCaptureRestart = unwrapBotIpcResult(
        await page!.evaluate(() => window.api.bots.status())
      )
      const requestsBeforeCapture = modelRequests
      const memoryBeforeCapture = memoryRequests
      const captureComposer = page!.getByLabel("向 Bot 交办工作", { exact: true })
      const captureEditorId = await captureComposer.getAttribute("id")
      assert.ok(captureEditorId)
      assert.ok(captureEditorId.startsWith("bot-composer-"))
      const captureAddress = botViewAddress(captureEditorId.slice("bot-composer-".length))
      const selectedBeforeCapture = await page!
        .locator('.bot-list-row[aria-current="page"]')
        .getAttribute("aria-label")
      const conversationBeforeCapture = unwrapBotIpcResult(
        await page!.evaluate(() => window.api.bots.snapshot())
      ).conversations.find((item) => item.id === captureAddress.conversationId)
      assert.ok(conversationBeforeCapture)
      assert.equal(conversationBeforeCapture.name, selectedBeforeCapture)
      const messagesBeforeCapture = unwrapBotIpcResult(
        await page!.evaluate((input) => window.api.bots.messages(input), captureAddress)
      )
      const captureRunId = messagesBeforeCapture.findLast(
        (message) => message.sender === "bot" && message.runId
      )?.runId
      assert.ok(captureRunId)
      const captureHistoryAddress = { ...captureAddress, runId: captureRunId }
      const historyBeforeCapture = unwrapBotIpcResult(
        await page!.evaluate((input) => window.api.bots.runHistory(input), captureHistoryAddress)
      )
      const captureDraft = "取得清理句柄前，保留这份未发送草稿。"
      await captureComposer.fill(captureDraft)
      const captureDraftKey = `bot-draft:${captureEditorId.slice("bot-composer-".length)}`
      await page!.waitForFunction(
        ({ key, prompt }) => {
          const raw = localStorage.getItem(key)
          if (!raw) return false
          const saved = JSON.parse(raw)
          return saved.prompt === prompt && typeof saved.revision === "string"
        },
        { key: captureDraftKey, prompt: captureDraft },
        { timeout: 10_000 }
      )
      const captureDraftRaw = await page!.evaluate(
        (key) => localStorage.getItem(key),
        captureDraftKey
      )
      assert.ok(captureDraftRaw)
      const captureDraftOwner = JSON.parse(captureDraftRaw)
      assert.equal(captureDraftOwner.prompt, captureDraft)
      assert.equal(captureDraftOwner.dataEpoch, beforeCaptureRestart.dataEpoch)
      assert.equal(typeof captureDraftOwner.revision, "string")
      assert.equal(typeof captureDraftOwner.richText, "string")
      const capturedRestart = unwrapBotIpcResult(
        await page!.evaluate((input) => window.api.botHost.restart(input), {
          hostId: beforeCaptureRestart.hostId
        })
      )
      assert.notEqual(capturedRestart.hostId, beforeCaptureRestart.hostId)
      assert.equal(capturedRestart.dataEpoch, beforeCaptureRestart.dataEpoch)
      assert.equal(
        await page!.evaluate((key) => localStorage.getItem(key), captureDraftKey),
        captureDraftRaw
      )
      const captured = await app!.evaluate(
        (_, hostId) =>
          Reflect.get(globalThis, "__botFixtureOwnedHostControl")({ action: "bind", hostId }),
        capturedRestart.hostId
      )
      assert.equal(captured.launched, 1)
      assert.equal(captured.bound, true)
      assert.equal(captured.closed, false)
      assert.equal(captured.spawnError, false)
      assert.equal(await captureComposer.getAttribute("id"), captureEditorId)
      assert.equal(
        await page!.locator('.bot-list-row[aria-current="page"]').getAttribute("aria-label"),
        selectedBeforeCapture
      )
      // Host readiness is an IPC receipt; renderer editor readiness is separate.
      // Prove the same draft owner survived before waiting for its document.
      await page!.waitForFunction(
        ({ editorId, draftKey, draftRaw, prompt, richText }) => {
          if (localStorage.getItem(draftKey) !== draftRaw) return false
          const element = document.getElementById(editorId)
          if (!element?.isConnected || !element.getClientRects().length) return false
          const editor = Reflect.get(element, "editor")
          return (
            editor &&
            !editor.isDestroyed &&
            editor.isEditable &&
            editor.view.dom === element &&
            JSON.stringify(editor.getJSON()) === richText &&
            element.innerText === prompt
          )
        },
        {
          editorId: captureEditorId,
          draftKey: captureDraftKey,
          draftRaw: captureDraftRaw,
          prompt: captureDraft,
          richText: captureDraftOwner.richText
        },
        { timeout: 10_000 }
      )
      assert.equal(
        await page!.evaluate((key) => localStorage.getItem(key), captureDraftKey),
        captureDraftRaw
      )
      assert.equal(await captureComposer.innerText(), captureDraft)
      await writeFile(
        join(evidence, "desktop-composer-restart-draft.json"),
        JSON.stringify(
          {
            source: "actual packaged renderer draft storage and attached Tiptap document",
            beforeHostId: beforeCaptureRestart.hostId,
            afterHostId: capturedRestart.hostId,
            dataEpoch: capturedRestart.dataEpoch,
            editorId: captureEditorId,
            selectedBot: selectedBeforeCapture,
            draft: captureDraftOwner,
            sameRawImmediatelyAfterRestart: true,
            sameRawAfterEditorReady: true,
            sameEditorDocumentAfterReady: true
          },
          null,
          2
        )
      )
      assert.deepEqual(
        unwrapBotIpcResult(
          await page!.evaluate((input) => window.api.bots.messages(input), captureAddress)
        ),
        messagesBeforeCapture
      )
      assert.deepEqual(
        unwrapBotIpcResult(
          await page!.evaluate((input) => window.api.bots.runHistory(input), captureHistoryAddress)
        ),
        historyBeforeCapture
      )
      assert.equal(modelRequests, requestsBeforeCapture)
      assert.equal(memoryRequests, memoryBeforeCapture)
      const nativeScopeStatus = unwrapBotIpcResult(
        await page!.evaluate(() => window.api.bots.status())
      )
      assert.equal(nativeScopeStatus.platform, "darwin")
      assert.equal(nativeScopeStatus.runtimeReady, true)
      assert.ok(nativeScopeStatus.dataEpoch)
      const commandCapabilities = [
        "harness-context",
        "skill-dependencies",
        "background-shell-jobs",
        "cross-turn-shell-services"
      ]
      assert.ok(
        commandCapabilities.every(
          (capability) => !nativeScopeStatus.capabilities?.includes(capability)
        )
      )
      assert.ok(nativeScopeStatus.capabilities?.includes("skill-dependency-history"))
      assert.ok(nativeScopeStatus.capabilities?.includes("computer-client-ownership"))
      assert.ok(nativeScopeStatus.capabilities?.includes("file-lifecycle"))
      assert.ok(nativeScopeStatus.computer)
      assert.ok(
        commandCapabilities.every(
          (capability) => !beforeCaptureRestart.capabilities?.includes(capability)
        )
      )
      assert.ok(
        commandCapabilities.every(
          (capability) => !capturedRestart.capabilities?.includes(capability)
        )
      )
      // A real disabled skill exercises the read endpoint without inventing a
      // historic dependency report or granting permission to run its probes.
      const dependencySkill = unwrapBotIpcResult(
        await page!.evaluate(
          ({ botId, expectedDataEpoch }) =>
            window.api.bots.saveSkill({
              botId,
              expectedDataEpoch,
              nonce: "desktop-native-scope-skill",
              name: "原生范围只读技能",
              instructions: "只查看已保存的元数据；不得执行命令。",
              enabled: false
            }),
          { botId: created.bot.id, expectedDataEpoch: nativeScopeStatus.dataEpoch }
        )
      )
      const dependencySelection = {
        botId: created.bot.id,
        id: dependencySkill.id,
        version: dependencySkill.version
      }
      const dependencyView = unwrapBotIpcResult(
        await page!.evaluate(
          (selection) => window.api.bots.skillDependencies(selection),
          dependencySelection
        )
      )
      assert.equal(dependencyView.skill.id, dependencySkill.id)
      assert.equal(dependencyView.skill.version, dependencySkill.version)
      assert.equal(dependencyView.skill.scope, "bot")
      assert.deepEqual(dependencyView.history, [])
      const runsBeforeDependencyRejection = unwrapBotIpcResult(
        await page!.evaluate(() => window.api.bots.snapshot())
      )
        .runs.map((run) => run.id)
        .sort()
      const requestsBeforeDependencyRejection = modelRequests
      const dependencyRejection = await page!.evaluate(
        ({ skill, expectedDataEpoch }) =>
          window.api.bots.checkSkillDependencies({
            skill,
            expectedDataEpoch,
            nonce: "desktop-native-scope-dependency-rejected"
          }),
        { skill: dependencySelection, expectedDataEpoch: nativeScopeStatus.dataEpoch! }
      )
      assert.ok("botFailure" in dependencyRejection)
      assert.equal(dependencyRejection.botFailure.code, "shell_unavailable")
      assert.deepEqual(
        unwrapBotIpcResult(await page!.evaluate(() => window.api.bots.snapshot()))
          .runs.map((run) => run.id)
          .sort(),
        runsBeforeDependencyRejection
      )
      assert.equal(modelRequests, requestsBeforeDependencyRejection)
      assert.deepEqual(
        unwrapBotIpcResult(
          await page!.evaluate((input) => window.api.bots.runHistory(input), captureHistoryAddress)
        ),
        historyBeforeCapture
      )
      checks.push(
        "Packaged macOS Host omits command execution capabilities despite saved shell-first settings; dependency metadata and original task history remain readable"
      )
      const resourceRoot = join(ownedHostDirectory, BOT_OWNED_SHELL_RESOURCE_DIRECTORY)
      const readNativeScopeResources = async () => {
        const info = await lstat(resourceRoot).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
          throw error
        })
        if (!info) return { exists: false, names: [] as string[], entries: [], resources: [] }
        assert.equal(info.isDirectory(), true)
        assert.equal(info.isSymbolicLink(), false)
        return {
          exists: true,
          names: (await readdir(resourceRoot)).sort(),
          entries: await inspectOwnedShellReceiptEntries(resourceRoot),
          resources: await inspectOwnedShellReceipts(resourceRoot)
        }
      }
      const resourcesBeforeNativeProbe = await readNativeScopeResources()
      assert.deepEqual(resourcesBeforeNativeProbe.entries, [])
      assert.deepEqual(resourcesBeforeNativeProbe.resources, [])
      assert.deepEqual(resourcesBeforeNativeProbe.names, [])
      const workspace = join(data, "shell-project")
      await mkdir(workspace)
      const privateProbe = join(data, "bot-host", "private-probe.txt")
      await writeFile(privateProbe, "FAKE_HOST_DATA")
      await writeFile(
        join(workspace, "verify.cjs"),
        `
        const fs=require('fs');let outcome='UNEXPECTED_ACCESS';
        try{fs.readFileSync(${JSON.stringify(privateProbe)});}catch(e){outcome=e.code;}
        fs.writeFileSync('result.txt',outcome);console.log(outcome);
      `
      )
      const probeScriptHash = createHash("sha256")
        .update(await readFile(join(workspace, "verify.cjs")))
        .digest("hex")
      const controlMarkerHash = createHash("sha256")
        .update(await readFile(privateProbe))
        .digest("hex")
      assert.equal(existsSync(join(workspace, "result.txt")), false)
      const nativeScopeBot = unwrapBotIpcResult(
        await page!.evaluate(
          ({ workspacePath, modelRef }) =>
            window.api.bots.create({
              nonce: "desktop-shell-bot",
              name: "原生命令范围验收 Bot",
              workspacePath,
              modelRef
            }),
          { workspacePath: workspace, modelRef: model.id }
        )
      )
      const catalogsBeforeNativeProbe = modelToolCatalogs.length
      const nativeScopeSent = unwrapBotIpcResult(
        await page!.evaluate(
          (conversationId) =>
            window.api.bots.send({
              nonce: "desktop-shell-send",
              conversationId,
              text: "PACKAGED_SHELL_BOUNDARY：运行 verify.cjs"
            }),
          nativeScopeBot.conversationId
        )
      )
      assert.equal(nativeScopeSent.runIds.length, 1)
      const probe = {
        conversationId: nativeScopeBot.conversationId,
        runId: nativeScopeSent.runIds[0]
      }
      fixtureShellProbe = {
        ...probe,
        botId: nativeScopeBot.bot.id,
        workspace: await realpath(workspace)
      }
      const localAccess = await createTestLocalProjectAccess({
        workspace,
        runId: probe.runId,
        readProject: true,
        commands: []
      })
      const admittedProjectReads = new Map<string, { revision: number; card: BotLocalToolCard }>()
      const projectSnapshot = () =>
        localAccess.snapshot({
          snapshot: async () =>
            unwrapBotIpcResult(await page!.evaluate(() => window.api.bots.snapshot())),
          resolve: async (answer) => {
            const answered = unwrapBotIpcResult(
              await page!.evaluate(
                (input) => window.api.bots.resolveLocalToolPermission(input),
                answer
              )
            )
            assert.ok(answered.localProjectAccess)
            assert.equal(answered.localProjectAccess.action.kind, "read-file")
            assert.equal(answered.localProjectAccess.action.workspace, fixtureShellProbe!.workspace)
            assert.equal(answered.localProjectAccess.dataEpoch, nativeScopeStatus.dataEpoch)
            admittedProjectReads.set(answered.id, {
              revision: answered.revision,
              card: answered.localProjectAccess
            })
            return answered
          }
        })
      await page!.getByRole("button", { name: "原生命令范围验收 Bot", exact: true }).click()
      await until(async () => {
        // The graph needs its exact project's read permission before it can ask
        // the model. This admission never grants a command or an action effect.
        const snapshot = await projectSnapshot()
        if (
          snapshot.interactions.some(
            (item) => item.runId === probe.runId && item.status === "pending"
          )
        )
          throw new Error("An unavailable command must not create operation authorization")
        const history = unwrapBotIpcResult(
          await page!.evaluate((input) => window.api.bots.runHistory(input), probe)
        )
        if (history.run.status === "needs_review")
          throw new Error("An unavailable command must not create uncertain execution")
        return ["succeeded", "failed"].includes(history.run.status)
      }, "packaged native command rejection")
      const probeHistory = unwrapBotIpcResult(
        await page!.evaluate((input) => window.api.bots.runHistory(input), { ...probe, limit: 50 })
      )
      assert.equal(probeHistory.run.id, probe.runId)
      assert.equal(probeHistory.run.botId, nativeScopeBot.bot.id)
      const probeCatalogs = modelToolCatalogs.slice(catalogsBeforeNativeProbe)
      assert.ok(probeCatalogs.length > 0)
      assert.ok(probeCatalogs.every((request) => request.probe && request.tools.length > 0))
      assert.ok(
        probeCatalogs.every((request) =>
          request.tools.every(
            (name) =>
              ![
                "execute",
                "task_output",
                "task_stop",
                "stop_shell_task",
                "list_shell_services"
              ].includes(name)
          )
        )
      )
      assert.equal(unsolicitedExecuteCalls, 1)
      // The installed ToolNode returns an error ToolMessage for a missing tool.
      // If a stricter packaged runtime fails the run instead, its error must
      // identify that same unavailable execute call; unrelated failures fail.
      if (probeHistory.run.status === "succeeded") {
        assert.equal(probeHistory.run.result, "NATIVE_COMMAND_UNAVAILABLE_WITHOUT_EXECUTION")
        assert.ok(
          rejectedExecuteContents.some((content) =>
            /execute.*(?:not a valid tool|not found|unavailable)/i.test(content)
          )
        )
      } else {
        assert.equal(probeHistory.run.status, "failed")
        assert.match(
          probeHistory.run.error ?? "",
          /execute.*(?:not a valid tool|not found|unavailable)/i
        )
      }
      const historyItems = [...probeHistory.items]
      let before = probeHistory.nextBefore
      while (before !== null) {
        const history = unwrapBotIpcResult(
          await page!.evaluate((input) => window.api.bots.runHistory(input), {
            ...probe,
            before,
            limit: 50
          })
        )
        assert.equal(history.run.id, probe.runId)
        assert.ok(history.nextBefore === null || history.nextBefore < before)
        historyItems.push(...history.items)
        before = history.nextBefore
      }
      assert.ok(historyItems.every((event) => !event.effectId))
      const interactionIds = [
        ...new Set(
          historyItems
            .map((event) => event.interactionId)
            .filter((id): id is string => id !== undefined)
        )
      ]
      assert.equal(admittedProjectReads.size, 1)
      assert.deepEqual(interactionIds.sort(), [...admittedProjectReads.keys()].sort())
      const projectReadDetails = []
      for (const interactionId of interactionIds) {
        const detail = unwrapBotIpcResult(
          await page!.evaluate((input) => window.api.bots.interactionDetail(input), {
            ...probe,
            interactionId
          })
        )
        const admitted = admittedProjectReads.get(interactionId)
        assert.ok(admitted)
        assert.equal(detail.interaction.id, interactionId)
        assert.equal(detail.interaction.kind, "approval")
        assert.equal(detail.interaction.status, "answered")
        assert.equal(detail.interaction.answer, "approve")
        assert.equal(detail.interaction.revision, admitted.revision)
        assert.ok(detail.interaction.localProjectAccess)
        assert.deepEqual(detail.interaction.localProjectAccess, admitted.card)
        assert.equal(detail.interaction.localProjectAccess.action.kind, "read-file")
        assert.equal(
          detail.interaction.localProjectAccess.action.workspace,
          fixtureShellProbe.workspace
        )
        assert.equal(detail.interaction.localProjectAccess.dataEpoch, nativeScopeStatus.dataEpoch)
        assert.equal(detail.secret, null)
        assert.deepEqual(detail.effects, [])
        projectReadDetails.push(detail)
      }
      assert.ok(historyItems.every((event) => !/后台命令/.test(event.label)))
      assert.deepEqual(probeHistory.shellJobs ?? [], [])
      assert.deepEqual(
        unwrapBotIpcResult(await page!.evaluate((id) => window.api.bots.effects(id), probe.runId)),
        []
      )
      assert.equal(await page!.getByRole("region", { name: "操作审批", exact: true }).count(), 0)
      assert.equal(
        unwrapBotIpcResult(
          await page!.evaluate(() => window.api.bots.snapshot())
        ).interactions.filter((interaction) => interaction.runId === probe.runId).length,
        0
      )
      checks.push(
        "Packaged macOS model requests omit command tools and unsolicited execute creates no command authorization, command job or effect"
      )
      const resourcesAfterNativeProbe = await readNativeScopeResources()
      assert.deepEqual(resourcesAfterNativeProbe, resourcesBeforeNativeProbe)
      assert.equal(existsSync(join(workspace, "result.txt")), false)
      assert.equal(
        createHash("sha256")
          .update(await readFile(privateProbe))
          .digest("hex"),
        controlMarkerHash
      )
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(workspace, "verify.cjs")))
          .digest("hex"),
        probeScriptHash
      )
      const statusAfterNativeProbe = unwrapBotIpcResult(
        await page!.evaluate(() => window.api.bots.status())
      )
      assert.equal(statusAfterNativeProbe.hostId, nativeScopeStatus.hostId)
      assert.equal(statusAfterNativeProbe.dataEpoch, nativeScopeStatus.dataEpoch)
      assert.equal(statusAfterNativeProbe.runtimeReady, true)
      assert.ok(
        commandCapabilities.every(
          (capability) => !statusAfterNativeProbe.capabilities?.includes(capability)
        )
      )
      assert.ok(statusAfterNativeProbe.capabilities?.includes("computer-client-ownership"))
      assert.ok(statusAfterNativeProbe.capabilities?.includes("file-lifecycle"))
      await page!.screenshot({
        animations: "disabled",
        path: join(evidence, "desktop-native-command-unavailable.png")
      })
      checks.push(
        "Packaged macOS command rejection leaves owned command resources, control marker and result canaries unchanged; browser and file acceptance remains intact"
      )
      await writeFile(
        join(evidence, "native-command-scope.json"),
        JSON.stringify(
          {
            source:
              "actual packaged preload, detached formal Host, model HTTP requests and validated resource inspection",
            actualStatus: nativeScopeStatus,
            statusAfterProbe: statusAfterNativeProbe,
            dependencyView,
            dependencyRejectionCode: dependencyRejection.botFailure.code,
            originalTaskHistoryReadable: true,
            probe,
            actualModelToolCatalogs: probeCatalogs,
            unsolicitedExecuteCalls,
            rejectedExecuteContents,
            actualRun: probeHistory.run,
            historyItems,
            projectReadDetails,
            localProjectReadAdmission:
              "Exactly one real read-file allow-once for the probe project; commands:[]; not command authorization or an action effect",
            resourcesBefore: resourcesBeforeNativeProbe,
            resourcesAfter: resourcesAfterNativeProbe,
            controlMarkerHash,
            probeScriptHash,
            resultFileExists: false,
            osCommandSpawnObserved: false,
            evidenceLimit:
              "Empty resources and unchanged canaries are not an OS-level zero-spawn proof; low-level factory/start guard evidence is reported separately",
            legacyWeakSceneAssertionsRun: false,
            legacyMainIpcAndDraftProofRestored: false
          },
          null,
          2
        )
      )
      await page!.getByRole("button", { name: "桌面验收 Bot", exact: true }).click()
    }
    assert.deepEqual(errors, [])
    await writeFile(
      join(evidence, "checks.json"),
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          platform: process.platform,
          packaged: !!process.env.CMB_BOT_APP_BINARY,
          modelRequests,
          memoryRequests,
          configurationTrace,
          checks
        },
        null,
        2
      )
    )
    for (const check of checks) console.log("PASS " + check)
  } catch (error) {
    console.error("Desktop assertion failed:", error)
    console.error("Fixture configuration events", configurationTrace)
    console.error("Fixture HTTP traffic", fixtureTraffic)
    if (page)
      console.error(
        "Desktop state: " +
          (await page
            .locator("body")
            .innerText()
            .catch(() => "unavailable"))
      )
    await page?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {})
    for (const file of await readdir(data, { recursive: true })) {
      // Chromium's .log files are binary databases, not diagnostic output.
      if (
        typeof file === "string" &&
        /\.log$/.test(file) &&
        !/(?:^|[/\\])(?:browser-profile|browser-maintenance)(?:[/\\])/.test(file)
      ) {
        const contents = await readFile(join(data, file), "utf8")
        console.error("Fixture log " + file + ":\n" + contents.slice(-12_000))
      }
    }
    throw error
  } finally {
    configurationWatcher.close()
    release()
    let cleaned = false
    let fixtureOwnedHostLaunched = false
    try {
      if (fixtureOwnedHostCapture) {
        assert.ok(app, "Fixture Main exited before its owned Host cleanup")
        const fenced = await app.evaluate(() =>
          Reflect.get(globalThis, "__botFixtureOwnedHostControl")({ action: "fence" })
        )
        assert.ok(fenced.launched === 0 || fenced.launched === 1)
        fixtureOwnedHostLaunched = fenced.launched === 1
      }
      if (!fixtureOwnedHostCapture) await app?.close().catch(() => {})
      client?.close()
      client = undefined
      const raw = await readFile(join(data, "bot-host/host.json"), "utf8").catch(() => null)
      if (raw) client = new BotTransportClient(JSON.parse(raw) as BotHostDescriptor)
      if (client) {
        const status = await client.call("status")
        if (fixtureShellProbe) {
          const probe = fixtureShellProbe
          const snapshot = await client.call("snapshot")
          const run = snapshot.runs.find((item) => item.id === probe.runId)
          const localCard = snapshot.interactions.find(
            (item) =>
              item.runId === probe.runId && item.status === "pending" && item.localProjectAccess
          )
          if (run?.status === "waiting_input" && localCard) {
            assert.equal(run.botId, probe.botId)
            assert.equal(run.conversationId, probe.conversationId)
            assert.equal(run.parentRunId, null)
            assert.equal(run.rootRunId, probe.runId)
            assert.equal(localCard.localProjectAccess!.action.workspace, probe.workspace)
            assert.equal(localCard.localProjectAccess!.dataEpoch, snapshot.dataEpoch)
            assert.equal(await realpath(probe.workspace), probe.workspace)
            const history = await client.call("runHistory", probe)
            assert.equal(history.run.id, probe.runId)
            assert.equal(history.run.botId, probe.botId)
            assert.deepEqual(await client.call("effects", probe.runId), [])
            assert.deepEqual(history.shellJobs ?? [], [])
            // A failed fixture can leave a read/command permission unanswered.
            // Cancel only its verified run before any effect/command started;
            // never approve during cleanup or remove recovery receipts.
            assert.equal((await client.call("cancel", probe.runId)).status, "cancelled")
          }
        }
        if (fixtureComputerBotId) {
          // Only the computer created by this isolated fixture can be reclaimed.
          // A failed assertion may leave it human-held after the UI disconnects.
          const target = await client.call("computerOpen", fixtureComputerBotId)
          if (target.control === "human") {
            const owned = await client.call("computerTake", { ...target, replaceHuman: true })
            await client.call("computerRelease", owned)
          }
        }
        if (!fixtureOwnedHostLaunched) {
          await until(
            async () => (await client!.restartIfIdle(status.hostId)).accepted,
            "idle Host cleanup"
          )
        }
      }
      if (fixtureOwnedHostLaunched) {
        const stopped = await app!.evaluate(() =>
          Reflect.get(globalThis, "__botFixtureOwnedHostControl")({ action: "stop" })
        )
        assert.equal(stopped.launched, 1)
        assert.ok(stopped.closed || stopped.signalled)
        await until(async () => {
          const state = await app!.evaluate(() =>
            Reflect.get(globalThis, "__botFixtureOwnedHostControl")({ action: "state" })
          )
          if (!state.closed) return false
          assert.equal(state.spawnError, false)
          assert.equal(state.code, 0)
          assert.equal(state.signal, null)
          return true
        }, "owned Host graceful exit")
        await app!.close()
        app = undefined
      }
      if (client || fixtureOwnedHostLaunched) {
        // The removed descriptor confirms this Host finished cleanup, including
        // its browser. It does not prove arbitrary Shell descendant closure.
        await until(async () => {
          try {
            await lstat(join(data, "bot-host/host.json"))
            return false
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            return true
          }
        }, "Host and browser exit")
      }
      cleaned = true
    } catch (cleanupError) {
      console.error("Desktop fixture cleanup failed:", cleanupError)
      cleanupFailure = cleanupError
    } finally {
      await app?.close().catch(() => {})
      client?.close()
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      let retainReason: string | undefined
      if (cleaned) {
        try {
          const resourceRoot = join(
            await realpath(join(data, "bot-host")),
            BOT_OWNED_SHELL_RESOURCE_DIRECTORY
          )
          const resourceRootInfo = await lstat(resourceRoot).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
            throw error
          })
          const resources = resourceRootInfo ? await inspectOwnedShellReceipts(resourceRoot) : []
          const retained = resources.filter(
            (item) => item.runAuthorized || !hasOwnedShellPhysicalClosure(item)
          )
          if (retained.length) {
            retainReason = "Owned command receipts still require physical closure evidence"
            await writeFile(
              join(evidence, "retained-shell-resources.json"),
              JSON.stringify(
                {
                  fixture: folder,
                  hostDescriptorRemoved: true,
                  reason: retainReason,
                  resources: retained.map((item) => ({
                    nonce: item.nonce,
                    runId: item.runId,
                    phase: item.phase,
                    runAuthorized: item.runAuthorized,
                    containment: item.containment
                  }))
                },
                null,
                2
              )
            )
          }
        } catch (error) {
          retainReason = "Owned command receipt inspection failed"
          cleanupFailure ??= error
          console.error(retainReason, error)
        }
      }
      if (cleaned && !retainReason)
        await rm(folder, { recursive: true, force: true, maxRetries: 3 })
      else
        console.error(
          `${retainReason ?? "Cleanup incomplete"}; isolated fixture retained at ${folder}`
        )
    }
  }
  if (cleanupFailure) throw cleanupFailure
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
