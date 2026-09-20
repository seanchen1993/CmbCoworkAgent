/**
 * Real Electron UI / preload / transport / persistence regression.
 * Only the agent producer is replaced at its IPC boundary with controlled frames.
 * Run: npm run test:subagent-order:e2e
 * Optional: SUBAGENT_E2E_PACKAGED_EXE and SUBAGENT_E2E_ARTIFACT_DIR.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron, type ElectronApplication, type Page } from "playwright"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const binary = require("electron") as string
const title = "Subagent tool order E2E"
const taskId = "order-e2e-task"
const calls = [
  { id: "order-a", name: "read_file", args: { path: "order-a.txt" } },
  { id: "order-b", name: "read_file", args: { path: "order-b.txt" } }
]

interface TestApi {
  threads: {
    create(metadata: Record<string, unknown>): Promise<{ id?: string; thread_id?: string }>
    getSubagentTranscript(
      threadId: string,
      subagentId: string
    ): Promise<{
      messages: Array<{
        id?: string
        role?: string
        tool_calls?: typeof calls
        content?: unknown
        reasoning?: string
      }>
    }>
  }
  workspace: { set(threadId: string, path: string): Promise<unknown> }
}

async function until(run: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await run()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Timeout: ${label}`)
}

async function appPage(app: ElectronApplication): Promise<Page> {
  let page: Page | undefined
  await until(async () => {
    for (const candidate of app.windows()) {
      if (
        await candidate
          .evaluate(() => Boolean((window as unknown as { api?: unknown }).api))
          .catch(() => false)
      ) {
        page = candidate
        return true
      }
    }
    return false
  }, "app preload ready")
  return page!
}

function stream(kind: string, kwargs: Record<string, unknown>, child = true): unknown {
  return {
    type: "stream",
    mode: "messages",
    data: [
      { id: ["langchain_core", "messages", kind], kwargs },
      child
        ? {
            langgraph_checkpoint_ns: "tools:order-e2e-runtime|model:1",
            cmb_subagent_owner_tool_call_id: taskId
          }
        : { langgraph_node: "agent" }
    ]
  }
}

async function emit(app: ElectronApplication, frames: unknown[]): Promise<void> {
  await app.evaluate(({ webContents }, events) => {
    const run = (
      globalThis as unknown as {
        orderE2eRun: { senderId: number; channel: string }
      }
    ).orderE2eRun
    if (!run) throw new Error("No UI agent invocation captured")
    const sender = webContents.fromId(run.senderId)
    if (!sender) throw new Error("Missing request renderer")
    for (const frame of events) sender.send(run.channel, frame)
  }, frames)
}

async function openTranscript(page: Page): Promise<void> {
  const showPanel = page.getByRole("button", { name: "显示右侧面板" })
  if (await showPanel.count()) await showPanel.first().click()
  const agents = page.getByRole("button", { name: /^代理\s*\d/ }).first()
  await agents.waitFor()
  if ((await agents.getAttribute("aria-expanded")) !== "true") await agents.click()
  await page
    .getByRole("button", { name: /打开完整记录/ })
    .first()
    .click({ timeout: 30_000 })
  await page.getByText("子代理完整记录", { exact: false }).first().waitFor()
}

async function assertToolOrder(page: Page, label: string): Promise<void> {
  const assistant = page
    .locator("[data-subagent-stream-message-id]")
    .filter({ hasText: "order-a.txt" })
  await until(async () => {
    const text = await assistant
      .first()
      .innerText()
      .catch(() => "")
    return text.includes("order-b.txt") && text.indexOf("order-a.txt") < text.indexOf("order-b.txt")
  }, label)
  assert.equal(await assistant.count(), 1, "both tools belong to one assistant")
  console.log(`PASS ${label}`)
}

async function waitForToolStatus(page: Page, file: string, status: string): Promise<void> {
  const button = page
    .locator("[data-subagent-stream-message-id] button")
    .filter({ hasText: file })
    .first()
  await until(
    async () =>
      (
        await button
          .locator("..")
          .innerText()
          .catch(() => "")
      ).includes(status),
    `${file} ${status}`
  )
}

async function main(): Promise<void> {
  const isolated = mkdtempSync(join(tmpdir(), "cmb-subagent-order-e2e-"))
  const artifacts = process.env.SUBAGENT_E2E_ARTIFACT_DIR
    ? resolve(process.env.SUBAGENT_E2E_ARTIFACT_DIR)
    : join(root, "output", "e2e-comprehensive", "subagent")
  const packaged = process.env.SUBAGENT_E2E_PACKAGED_EXE
  mkdirSync(artifacts, { recursive: true })
  const workspace = join(isolated, "workspace")
  mkdirSync(workspace)
  writeFileSync(join(workspace, "order-a.txt"), "RESULT_A_SENTINEL\n")
  writeFileSync(join(workspace, "order-b.txt"), "RESULT_B_SENTINEL\n")
  const environment: Record<string, string> = {}
  const allowed =
    /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|display|wayland_display|xdg_runtime_dir|dbus_session_bus_address|lang)$/i
  for (const [key, value] of Object.entries(process.env)) {
    if (value && allowed.test(key)) environment[key] = value
  }
  for (const [key, folder] of Object.entries({
    HOME: "home",
    USERPROFILE: "home",
    APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
    CMB_COWORK_AGENT_HOME: "openwork",
    TEMP: "temp",
    TMP: "temp",
    TMPDIR: "temp",
    XDG_CONFIG_HOME: "config",
    XDG_CACHE_HOME: "cache",
    XDG_DATA_HOME: "data"
  })) {
    environment[key] = join(isolated, folder)
    mkdirSync(environment[key], { recursive: true })
  }
  Object.assign(environment, {
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: "127.0.0.1,localhost"
  })
  let app: ElectronApplication | undefined
  let page: Page | undefined
  const errors: string[] = []
  try {
    app = await _electron.launch({
      executablePath:
        packaged ||
        (process.platform === "win32" ? join(root, "tests/support/electron-launcher.cmd") : binary),
      args: [
        ...(packaged ? [] : [join(root, "out/main/index.js")]),
        `--user-data-dir=${join(isolated, "electron")}`
      ],
      cwd: root,
      env: environment,
      timeout: 60_000
    })
    await app.context().route(/^https?:/, (route) => route.abort())
    await app.evaluate(async ({ app, BrowserWindow, ipcMain }) => {
      // Packaged mode starts SSO for an empty profile. Keep this isolated fixture local.
      ipcMain.removeHandler("open-login-page")
      ipcMain.handle("open-login-page", () => undefined)
      const window = BrowserWindow.getAllWindows()[0]
      await window.loadFile(`${app.getAppPath()}/out/renderer/index.html`)
    })
    page = await appPage(app)
    page.on("pageerror", (error) => errors.push(error.message))
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeAllListeners("agent:invoke")
      ipcMain.on("agent:invoke", (event, request) => {
        ;(globalThis as unknown as { orderE2eRun: unknown }).orderE2eRun = {
          senderId: event.sender.id,
          channel: `agent:stream:${request.threadId}:request:${encodeURIComponent(request.streamRequestId)}`
        }
      })
    })
    const threadId = await page.evaluate(
      async ({ workspace, title }) => {
        const api = (window as unknown as { api: TestApi }).api
        const thread = await api.threads.create({
          title,
          workspacePath: workspace,
          agentMode: "normal"
        })
        const id = thread.thread_id ?? thread.id
        if (!id) throw new Error("Thread ID missing")
        await api.workspace.set(id, workspace)
        return id
      },
      { workspace, title }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click({ timeout: 30_000 })
    const composer = page.locator("textarea.composer-textarea")
    await composer.fill("Verify parallel subagent tool ordering")
    await until(async () => {
      const invoked = await app!.evaluate(() =>
        Boolean((globalThis as unknown as { orderE2eRun?: unknown }).orderE2eRun)
      )
      if (invoked) return true
      // The composer is visible before history hydration enables submission.
      // Retry only while the original draft is still present; an accepted
      // submission clears it and is guarded by the app's in-flight lock.
      if ((await composer.inputValue()) === "Verify parallel subagent tool ordering") {
        const submit = composer.locator("xpath=ancestor::form").locator('button[type="submit"]')
        if (await submit.isEnabled()) await submit.click()
      }
      return false
    }, "UI invocation")
    await emit(app, [
      stream(
        "AIMessage",
        {
          id: "order-main",
          content: "",
          tool_calls: [
            {
              id: taskId,
              name: "task",
              args: { description: "Parallel order regression", subagent_type: "general-purpose" }
            }
          ]
        },
        false
      ),
      stream("AIMessageChunk", {
        id: "order-inner",
        content: "",
        tool_call_chunks: [
          { id: "order-a", name: "read_file", index: 0, args: '{"path":"order-a' },
          { id: "order-b", name: "read_file", index: 1, args: '{"path":"order-b.txt"}' }
        ]
      })
    ])
    await openTranscript(page)
    // Finish A only after the first frame has been displayed (B was already complete).
    await emit(app, [
      stream("AIMessageChunk", {
        id: "order-inner",
        content: "",
        tool_call_chunks: [{ index: 0, args: '.txt"}' }]
      })
    ])
    await assertToolOrder(page, "live chunks retain A before B")
    await emit(app, [
      stream("AIMessage", { id: "order-inner", content: "", tool_calls: calls }),
      stream("ToolMessage", {
        id: "result-b",
        name: "read_file",
        tool_call_id: "order-b",
        content: "RESULT_B_SENTINEL"
      })
    ])
    await waitForToolStatus(page, "order-b.txt", "OK")
    await waitForToolStatus(page, "order-a.txt", "RUNNING")
    await assertToolOrder(page, "B returns first while pending A remains before B")
    await page.screenshot({ path: join(artifacts, "parallel-b-first.png"), fullPage: true })
    await emit(app, [
      stream("ToolMessage", {
        id: "result-a",
        name: "read_file",
        tool_call_id: "order-a",
        content: "RESULT_A_SENTINEL"
      }),
      stream(
        "ToolMessage",
        { id: "task-result", name: "task", tool_call_id: taskId, content: "ORDER_COMPLETE" },
        false
      ),
      stream("AIMessage", { id: "order-final", content: "ORDER_COMPLETE" }, false),
      { type: "done" }
    ])
    await waitForToolStatus(page, "order-a.txt", "OK")
    await assertToolOrder(page, "both completed tools retain A before B")
    await until(
      async () =>
        page!.evaluate(
          async ({ threadId, taskId }) => {
            const data = await (
              window as unknown as { api: TestApi }
            ).api.threads.getSubagentTranscript(threadId, taskId)
            const ordered = data.messages.find((message) => message.tool_calls?.length)?.tool_calls
            return (
              ordered?.map((call) => call.id).join(",") === "order-a,order-b" &&
              data.messages.some((message) => message.content === "RESULT_A_SENTINEL") &&
              data.messages.some((message) => message.content === "RESULT_B_SENTINEL")
            )
          },
          { threadId, taskId }
        ),
      "real persisted transcript contains ordered calls and both results"
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click({ timeout: 30_000 })
    await openTranscript(page)
    await assertToolOrder(page, "reload restores A before B from persistence")
    for (const [file, sentinel] of [
      ["order-a.txt", "RESULT_A_SENTINEL"],
      ["order-b.txt", "RESULT_B_SENTINEL"]
    ]) {
      const tool = page
        .locator("[data-subagent-stream-message-id] button")
        .filter({ hasText: file })
        .first()
      await tool.click()
      const details = tool.locator("../..")
      await until(
        async () => (await details.innerText()).includes(sentinel),
        `${file} owns its result`
      )
    }
    await page.screenshot({ path: join(artifacts, "parallel-after-reload.png"), fullPage: true })
    // Exercise the standing scheduler listener through the real renderer,
    // preload, IPC handler and SQLite sidecar path. Only the producer is synthetic.
    const sendInterior = async (events: Array<Record<string, unknown>>) => {
      await app!.evaluate(
        ({ BrowserWindow }, { threadId, events }) => {
          for (const event of events)
            BrowserWindow.getAllWindows()[0].webContents.send(`scheduler:stream:${threadId}`, event)
        },
        { threadId, events }
      )
    }
    const textFrame = (content: string, reasoning?: string, snapshot = false) => ({
      type: "message-delta",
      subagentId: taskId,
      id: "snapshot-inner",
      content,
      contentMode: snapshot ? "snapshot" : "delta",
      ...(reasoning !== undefined && { reasoning, reasoningMode: snapshot ? "snapshot" : "delta" })
    })
    const persisted = async () =>
      page!.evaluate(
        async ({ threadId, taskId }) =>
          (window as unknown as { api: TestApi }).api.threads.getSubagentTranscript(
            threadId,
            taskId
          ),
        { threadId, taskId }
      )
    const expectStored = async (content: string, reasoning: string, label: string) => {
      await until(
        async () =>
          (await persisted()).messages.some(
            (message) =>
              message.role === "assistant" &&
              message.content === content &&
              message.reasoning === reasoning
          ),
        label
      )
      console.log(`PASS ${label}`)
    }
    await sendInterior([textFrame("LONG_DRAFT_BODY", "LONG_DRAFT_REASONING", true)])
    await expectStored(
      "LONG_DRAFT_BODY",
      "LONG_DRAFT_REASONING",
      "initial scheduler snapshot reaches SQLite"
    )
    await sendInterior([textFrame("SHORT_BODY", undefined, true)])
    await expectStored("SHORT_BODY", "LONG_DRAFT_REASONING", "shorter body keeps omitted reasoning")
    await sendInterior([
      {
        type: "message-delta",
        subagentId: taskId,
        id: "snapshot-inner",
        content: "",
        contentMode: "delta",
        reasoning: "SHORT_REASONING",
        reasoningMode: "snapshot"
      }
    ])
    await expectStored("SHORT_BODY", "SHORT_REASONING", "reasoning-only rewrite keeps body")
    await sendInterior([textFrame("", "", true)])
    await expectStored("", "", "explicit empty snapshots clear both persisted fields")
    await sendInterior([textFrame("RESTORED_BODY", "RESTORED_REASONING")])
    await expectStored("RESTORED_BODY", "RESTORED_REASONING", "deltas continue after empty clear")
    await until(
      async () => (await page!.locator("body").innerText()).includes("RESTORED_BODY"),
      "live subagent corrected body visible"
    )
    for (const cycle of [1, 2]) {
      await sendInterior([
        {
          type: "message-delta",
          subagentId: taskId,
          id: "reused-cycle",
          content: `CYCLE_${cycle}`,
          contentMode: "snapshot",
          toolCalls: [
            { id: `cycle-call-${cycle}`, name: "read_file", args: { path: `cycle-${cycle}.txt` } }
          ]
        },
        {
          type: "tool-message",
          subagentId: taskId,
          id: "reused-cycle",
          content: `CYCLE_RESULT_${cycle}`,
          toolCallId: `cycle-call-${cycle}`,
          name: "read_file"
        }
      ])
    }
    await until(async () => {
      const rows = (await persisted()).messages
      const cycleRows = rows.filter(
        (message) => typeof message.content === "string" && /^CYCLE_/.test(message.content)
      )
      return (
        cycleRows.map((message) => message.content).join(",") ===
          "CYCLE_1,CYCLE_RESULT_1,CYCLE_2,CYCLE_RESULT_2" &&
        new Set(cycleRows.map((message) => message.id)).size === 4
      )
    }, "same raw ID assistant/tool cycles persist separately in order")
    // Delay only the reply, after the real IPC handler has committed SQLite.
    // A newer rewrite must survive the old sidecar acknowledgement.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>
        }
      )._invokeHandlers
      const original = handlers.get("threads:persistSubagentTranscripts")!
      const fixture = globalThis as unknown as { heldAck?: boolean; releaseAck?: () => void }
      ipcMain.removeHandler("threads:persistSubagentTranscripts")
      let holdNext = true
      ipcMain.handle("threads:persistSubagentTranscripts", async (...args) => {
        const result = await original(...args)
        if (holdNext) {
          holdNext = false
          fixture.heldAck = true
          await new Promise<void>((resolveAck) => {
            fixture.releaseAck = resolveAck
          })
        }
        return result
      })
    })
    const oldAck = "OLD_ACK_" + "x".repeat(4_000)
    const newAck = "NEW_ACK_" + "y".repeat(4_000)
    await sendInterior([{ ...textFrame(oldAck, "OLD_ACK_REASONING", true), id: "ack-inner" }])
    await until(
      () => app!.evaluate(() => Boolean((globalThis as unknown as { heldAck?: boolean }).heldAck)),
      "real SQLite write waits before ACK"
    )
    await sendInterior([
      { ...textFrame(newAck, "NEW_ACK_REASONING", true), id: "ack-inner" },
      { ...textFrame("_TAIL", "_TAIL"), id: "ack-inner" }
    ])
    await app.evaluate(() => (globalThis as unknown as { releaseAck: () => void }).releaseAck())
    await expectStored(
      newAck + "_TAIL",
      "NEW_ACK_REASONING_TAIL",
      "old ACK cannot erase newer snapshot and in-flight continuation"
    )
    await sendInterior([{ type: "done" }])
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click({ timeout: 30_000 })
    await openTranscript(page)
    await until(
      async () => (await page!.locator("body").innerText()).includes("RESTORED_BODY"),
      "done and reload preserve subagent body"
    )
    for (const button of await page.getByRole("button", { name: "思考", exact: true }).all()) {
      if ((await button.getAttribute("aria-expanded")) !== "true") await button.click()
    }
    await until(
      async () => (await page!.locator("body").innerText()).includes("RESTORED_REASONING"),
      "done and reload preserve subagent reasoning"
    )
    await page.screenshot({ path: join(artifacts, "snapshots-after-reload.png"), fullPage: true })
    writeFileSync(
      join(artifacts, "persisted-transcript.json"),
      JSON.stringify(await persisted(), null, 2)
    )
    writeFileSync(
      join(artifacts, "result.json"),
      JSON.stringify(
        {
          status: "passed",
          isolated,
          coverage: [
            "tool argument ordering",
            "out-of-order results",
            "live scheduler snapshots",
            "shorter rewrite",
            "field omission",
            "empty clear",
            "delta after clear",
            "same raw ID assistant/tool cycles",
            "old sidecar ACK after newer snapshot and delta",
            "SQLite readback",
            "done and reload"
          ],
          notCovered: [
            "real model or IM transport",
            "renderer crash during sidecar commit",
            "filesystem failure"
          ]
        },
        null,
        2
      )
    )
    assert.deepEqual(errors, [], "no renderer errors")
    console.log("ALL PASS subagent tool order Electron E2E")
  } catch (error) {
    writeFileSync(
      join(artifacts, "result.json"),
      JSON.stringify({ status: "failed", isolated, error: String(error) }, null, 2)
    )
    if (page) {
      await page
        .screenshot({ path: join(artifacts, "failure.png"), fullPage: true })
        .catch(() => {})
      writeFileSync(
        join(artifacts, "failure-ui.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      )
    }
    throw error
  } finally {
    if (app) await app.close()
    // Retain the isolated profile for diagnosis; never touch the user's profile.
    console.log(`Isolated test profile: ${isolated}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
