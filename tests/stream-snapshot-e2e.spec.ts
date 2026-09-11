/** Real Electron main/preload/IPC/React regression. Only the model producer and
 * native dialog answer are controlled; every run uses a disposable user profile.
 * Run after npm run build: node --import tsx tests/stream-snapshot-e2e.spec.ts
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron, type ElectronApplication } from "playwright"
import type { WebContents, MessageBoxOptions } from "electron"
import { createStreamDataSerializer } from "../src/main/ipc/stream-data-serialization"

interface MainFixture {
  fixtureWindowId: number
  fixtureRun: { sender: WebContents; channel: string }
  nativeDialogs: MessageBoxOptions[]
}
interface FixtureWindow {
  api: {
    threads: {
      create(metadata: Record<string, unknown>): Promise<{ thread_id?: string; id?: string }>
      appendMessages(id: string, messages: Array<Record<string, unknown>>): Promise<unknown>
      getMessagesPage(id: string, options: { limit: number }): Promise<{
        messages: Array<{ id: string; content: unknown; reasoning?: string }>
      }>
    }
    workspace: { set(id: string, workspace: string): Promise<unknown> }
  }
}

const root = resolve(import.meta.dirname, "..")
const require = createRequire(import.meta.url)
const isolated = mkdtempSync(join(tmpdir(), "cmb-stream-snapshot-e2e-"))
const artifacts = join(root, "output/stream-white-screen/e2e")
mkdirSync(artifacts, { recursive: true })

async function until(check: () => Promise<boolean>, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`Timeout: ${label}`)
}

async function main() {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  )
  env.CMB_TASK_CARDS_MOCK = "1"
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  for (const key of [
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "CMB_COWORK_AGENT_HOME",
    "TEMP",
    "TMP"
  ]) {
    env[key] = join(isolated, key)
    mkdirSync(env[key], { recursive: true })
  }
  const packaged = process.env.STREAM_SNAPSHOT_PACKAGED_EXE
  let app: ElectronApplication | undefined
  const errors: string[] = []
  const results: string[] = []
  try {
    app = await _electron.launch({
      executablePath: packaged || require("electron"),
      args: [...(packaged ? [] : [root]), `--user-data-dir=${join(isolated, "profile")}`],
      env,
      cwd: root,
      timeout: 45_000
    })
    await app.context().route(/^https?:/, (route) => route.abort())
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    page.on("pageerror", (error) => errors.push(error.stack || error.message))
    await app.evaluate(async ({ app, BrowserWindow, ipcMain }) => {
      const w = BrowserWindow.getAllWindows()[0]
      ;(globalThis as unknown as MainFixture).fixtureWindowId = w.id
      ipcMain.removeHandler("open-login-page")
      ipcMain.handle("open-login-page", () => undefined)
      ipcMain.removeAllListeners("agent:invoke")
      ipcMain.on("agent:invoke", (event, request) => {
        ;(globalThis as unknown as MainFixture).fixtureRun = {
          sender: event.sender,
          channel: `agent:stream:${request.threadId}:request:${encodeURIComponent(request.streamRequestId)}`
        }
      })
      for (let n = 0; n < 3; n += 1) {
        try {
          await w.loadFile(`${app.getAppPath()}/out/renderer/index.html`)
          break
        } catch (error) {
          if (n === 2 || !String(error).includes("(-3)")) throw error
          await new Promise((done) => setTimeout(done, 500))
        }
      }
    })
    await page.waitForFunction(
      () =>
        (window as unknown as FixtureWindow).api &&
        document.getElementById("root")?.childElementCount
    )
    const workspace = join(isolated, "workspace")
    mkdirSync(workspace)
    const titles = ["快照白屏回归", "工具流切换对照"]
    const ids = await page.evaluate(
      async ({ workspace, titles }) => {
        const api = (window as unknown as FixtureWindow).api
        const ids: string[] = []
        for (const [index, title] of titles.entries()) {
          const thread = await api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          const id = thread.thread_id || thread.id
          if (!id) throw new Error("Missing fixture thread ID")
          ids.push(id)
          await api.workspace.set(id, workspace)
          if (index === 1)
            await api.threads.appendMessages(
              id,
              Array.from({ length: 160 }, (_, n) => ({
                id: `history-${n}`,
                role: n % 2 ? "assistant" : "user",
                content: `历史 ${n}。`.repeat(30),
                created_at: new Date()
              }))
            )
        }
        return ids
      },
      { workspace, titles }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(titles[0], { exact: true }).first().click()
    await page.locator(`[data-chat-thread-id="${ids[0]}"]`).waitFor()
    await until(async () => {
      if (await app!.evaluate(() => Boolean((globalThis as unknown as MainFixture).fixtureRun)))
        return true
      const composer = page.locator("textarea.composer-textarea")
      await composer.fill("运行快照与工具显示回归")
      const submit = composer.locator("xpath=ancestor::form").locator('button[type="submit"]')
      if (await submit.isEnabled()) await submit.click()
      return false
    }, "UI stream submission")
    const send = async (payload: unknown) => {
      await app!.evaluate((_electron, payload) => {
        const run = (globalThis as unknown as MainFixture).fixtureRun
        run.sender.send(run.channel, payload)
      }, payload)
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      )
    }
    const serialized = (kind: string, kwargs: Record<string, unknown>) => ({
      lc: 1,
      type: "constructor",
      id: ["langchain_core", "messages", kind],
      kwargs
    })
    const chunk = (kind: string, kwargs: Record<string, unknown>) =>
      send({
        type: "stream",
        mode: "messages",
        data: [serialized(kind, kwargs), { langgraph_node: "agent" }]
      })
    await chunk("ToolMessage", {
      id: "sparse-1",
      tool_call_id: "tool-1",
      name: "read_file",
      content: "工具一结果"
    })
    await chunk("ToolMessage", {
      id: "sparse-2",
      tool_call_id: "tool-2",
      name: "read_file",
      content: "工具二结果"
    })
    await chunk("AIMessageChunk", { id: "sparse-3", content: "回归前半段。" })
    await until(
      async () => (await page.locator("body").innerText()).includes("回归前半段。"),
      "initial AI content"
    )
    await send({
      type: "stream",
      mode: "values",
      data: {
        messages: [
          serialized("ToolMessage", {
            id: "sparse-1",
            tool_call_id: "tool-1",
            name: "read_file",
            content: "工具一结果"
          })
        ]
      }
    })
    await chunk("AIMessageChunk", { id: "sparse-3", content: "继续后半段。" })
    await until(
      async () => (await page.locator("body").innerText()).includes("回归前半段。继续后半段。"),
      "preserved cumulative content after shorter snapshot"
    )
    assert.deepEqual(errors, [])
    results.push("original tool/tool/AI/short-snapshot/AI sequence retains both AI chunks")
    const chunks = Math.max(20, Number(process.env.STREAM_SNAPSHOT_CHUNKS) || 20)
    const delayMs = Math.max(0, Number(process.env.STREAM_SNAPSHOT_DELAY_MS) || 0)
    let toolLoops = 0
    for (let n = 0; n < chunks; n += 1) {
      if (n > 0 && n % 25 === 5) {
        const callId = `fixture-call-${n}`
        await chunk("AIMessageChunk", {
          id: "sparse-3",
          content: "",
          tool_calls: [{ id: callId, name: "read_file", args: { path: `fixture-${n}.txt` } }]
        })
        await chunk("ToolMessage", {
          id: `fixture-result-${n}`,
          tool_call_id: callId,
          name: "read_file",
          content: `工具循环 ${n} 的结果。`.repeat(100)
        })
        toolLoops += 1
      }
      if (n % 5 === 0) await page.getByText(titles[1], { exact: true }).first().click()
      await chunk("AIMessageChunk", { id: "sparse-3", content: `片段${n}。` })
      if (n % 5 === 0) await page.getByText(titles[0], { exact: true }).first().click()
      if (delayMs) await new Promise((done) => setTimeout(done, delayMs))
    }
    await until(
      async () => (await page.locator("body").innerText()).includes(`片段${chunks - 1}。`),
      "continued stream after navigation"
    )
    assert.deepEqual(errors, [])
    results.push(
      `${chunks} chunks, ${toolLoops} tool loops and ${Math.ceil(chunks / 5)} history-thread round trips remain responsive`
    )

    const integritySerializer = createStreamDataSerializer()
    for (const content of ["哈", "哈", "，重复分片完整保留。"]) {
      await send({
        type: "stream",
        mode: "messages",
        ...integritySerializer("messages", [
          serialized("AIMessageChunk", { id: "integrity-repeat", content }),
          { langgraph_node: "agent" }
        ])
      })
    }
    await until(
      async () => (await page.locator("body").innerText()).includes("哈哈，重复分片完整保留。"),
      "repeated initial provider deltas reach the UI intact"
    )
    const snapshotSerializer = createStreamDataSerializer({
      messageChunkModes: { content: "snapshot" }
    })
    const prefix = "a".repeat(400)
    const original = prefix + "b".repeat(400)
    const corrected = original.slice(0, 100) + "Z" + original.slice(101) + "已更正"
    for (const content of [prefix, original, corrected, corrected + "并继续输出"]) {
      await send({
        type: "stream",
        mode: "messages",
        ...snapshotSerializer("messages", [
          serialized("AIMessageChunk", { id: "integrity-rewrite", content }),
          { langgraph_node: "agent" }
        ])
      })
      await until(
        async () => (await page.locator("body").innerText()).includes(content),
        `authoritative snapshot correction and subsequent growth reach the UI (${content.length} characters)`
      )
    }
    assert.deepEqual(errors, [])
    results.push(
      "production serializer preserves repeated deltas, interior snapshot corrections and subsequent growth in React"
    )
    const collisionSerializer = createStreamDataSerializer()
    const collisionFrames: Array<[string, Record<string, unknown>]> = [
      [
        "AIMessageChunk",
        {
          id: "collision-request",
          content: "",
          tool_calls: [
            { id: "collision-call", name: "read_file", args: { path: "collision-proof.txt" } }
          ]
        }
      ],
      [
        "ToolMessage",
        {
          id: "collision-shared",
          tool_call_id: "collision-call",
          name: "read_file",
          content: "碰撞工具原始结果"
        }
      ],
      ["AIMessageChunk", { id: "collision-shared", content: "碰撞助手旧草稿" }],
      ["AIMessage", { id: "collision-shared", content: "碰撞助手更正正文" }],
      ["AIMessageChunk", { id: "collision-shared", content: "及后续分片" }],
      [
        "ToolMessage",
        {
          id: "collision-shared",
          tool_call_id: "collision-call",
          name: "read_file",
          content: "碰撞工具更新结果"
        }
      ]
    ]
    for (const [kind, kwargs] of collisionFrames) {
      await send({
        type: "stream",
        mode: "messages",
        ...collisionSerializer("messages", [serialized(kind, kwargs), { langgraph_node: "agent" }])
      })
    }
    await until(
      async () => (await page.locator("body").innerText()).includes("碰撞助手更正正文及后续分片"),
      "same-provider-ID assistant rewrite and continuation"
    )
    const toolHeader = page.getByRole("button").filter({ hasText: "collision-proof.txt" }).first()
    await toolHeader.click()
    await until(
      async () => (await page.locator("body").innerText()).includes("碰撞工具更新结果"),
      "same-provider-ID tool result remains in its tool card"
    )
    assert.equal((await page.locator("body").innerText()).includes("碰撞助手旧草稿"), false)
    assert.deepEqual(errors, [])
    results.push(
      "same provider ID preserves tool card, assistant rewrite and continuation in React"
    )
    const completionMessage = serialized("AIMessage", {
      id: "completion-visible",
      content: "完成交接后正文必须保留。",
      additional_kwargs: { reasoning_content: "完成交接后思考过程必须保留。" }
    })
    await chunk("AIMessageChunk", {
      id: "completion-visible",
      content: "完成交接后正文必须保留。",
      additional_kwargs: { reasoning_content: "完成交接后思考过程必须保留。" }
    })
    // A short final values frame followed by metadata-only values must retain
    // both final fields when the live layer hands off to durable history.
    await send({ type: "stream", mode: "values", data: { messages: [completionMessage] } })
    await send({ type: "stream", mode: "values", data: { todos: [] } })
    const assertCompletionVisible = async () => {
      await until(
        async () => (await page.locator("body").innerText()).includes("完成交接后正文必须保留。"),
        "completed answer remains visible"
      )
      const reasoningButtons = page.getByRole("button", { name: "思考", exact: true })
      for (const button of await reasoningButtons.all()) {
        if ((await button.getAttribute("aria-expanded")) !== "true") await button.click()
      }
      await until(
        async () =>
          (await page.locator("body").innerText()).includes("完成交接后思考过程必须保留。"),
        "completed reasoning remains visible"
      )
    }
    await assertCompletionVisible()
    await page.screenshot({ path: join(artifacts, "stream-fixed.png") })
    const metrics = await app.evaluate(({ app }) =>
      app.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu, memory: m.memory }))
    )
    await send({ type: "done" })
    await assertCompletionVisible()
    await until(
      () =>
        page.evaluate(async (threadId) => {
          const page = await (window as unknown as FixtureWindow).api.threads.getMessagesPage(
            threadId,
            { limit: 500 }
          )
          return page.messages.some(
            (message) =>
              message.content === "完成交接后正文必须保留。" &&
              message.reasoning === "完成交接后思考过程必须保留。"
          )
        }, ids[0]),
      "completion handoff persists both fields"
    )
    await page.getByText(titles[1], { exact: true }).first().click()
    await page.getByText(titles[0], { exact: true }).first().click()
    await assertCompletionVisible()
    assert.deepEqual(errors, [])
    results.push("answer and reasoning survive done, durable writeback and history navigation")
    await page.screenshot({ path: join(artifacts, "completion-visible.png") })

    // Remove the entire renderer UI to verify the real main-process timeout
    // fallback, then crash its process to verify the immediate native path.
    await app.evaluate(async ({ BrowserWindow, dialog }) => {
      ;(globalThis as unknown as MainFixture).nativeDialogs = []
      dialog.showMessageBox = (async (_window, options) => {
        ;(globalThis as unknown as MainFixture).nativeDialogs.push(options)
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      const w = BrowserWindow.fromId((globalThis as unknown as MainFixture).fixtureWindowId)!
      await w.loadURL("data:text/html,<title>Fixture blank renderer</title>")
      w.close()
    })
    await until(
      () => app!.evaluate(() => (globalThis as unknown as MainFixture).nativeDialogs.length === 1),
      "native close fallback after renderer timeout",
      20_000
    )
    results.push("blank renderer close prompt falls back to native dialog")
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.fromId(
        (globalThis as unknown as MainFixture).fixtureWindowId
      )!.webContents.forcefullyCrashRenderer()
    )
    await until(
      () =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.fromId(
            (globalThis as unknown as MainFixture).fixtureWindowId
          )!.webContents.isCrashed()
        ),
      "renderer crash"
    )
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.fromId((globalThis as unknown as MainFixture).fixtureWindowId)!.close()
    )
    await until(
      () => app!.evaluate(() => (globalThis as unknown as MainFixture).nativeDialogs.length === 2),
      "immediate native close after crash",
      3_000
    )
    results.push("crashed renderer immediately offers native close; cancel preserves window")
    writeFileSync(
      join(artifacts, "result.json"),
      JSON.stringify({ results, errors, metrics, isolated, packaged: Boolean(packaged) }, null, 2)
    )
    console.log(JSON.stringify({ results, errors, artifacts }))
  } finally {
    if (app) await app.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
