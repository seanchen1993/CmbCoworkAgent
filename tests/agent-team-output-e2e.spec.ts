/** Real Electron/preload/IPC/React replay with controlled producers and an isolated profile.
 * Run after build: tsx tests/agent-team-output-e2e.spec.ts
 * Optional TEAM_OUTPUT_PACKAGED_EXE / TEAM_OUTPUT_ARTIFACT_DIR / TEAM_OUTPUT_ONLY_WORKER.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron, type ElectronApplication } from "playwright"
import type { WebContents } from "electron"
import recorded from "./fixtures/reused-provider-live-stream.json"
import { createStreamDataSerializer } from "../src/main/ipc/stream-data-serialization"
import { STREAM_MESSAGE_CONTENT_MODE_KEY } from "../src/shared/stream-message-wire-mode"

interface Fixture {
  threadId: string
  workers: Array<Record<string, unknown>>
  history: unknown[][]
  focused: string | null
  reads: number
  run?: { sender: WebContents; channel: string }
}
interface MainGlobal {
  teamFixture: Fixture
}
interface AppWindow {
  api: {
    threads: {
      create(metadata: Record<string, unknown>): Promise<{ id?: string; thread_id?: string }>
    }
    workspace: { set(threadId: string, path: string): Promise<unknown> }
  }
}
const root = resolve(import.meta.dirname, "..")
const require = createRequire(import.meta.url)
const isolated = mkdtempSync(join(tmpdir(), "cmb-team-output-e2e-"))
const artifacts = resolve(root, process.env.TEAM_OUTPUT_ARTIFACT_DIR || "output/team-output/e2e")
mkdirSync(artifacts, { recursive: true })
const title = "Agent Team output regression"
const draft = "Earlier draft moved to final answer. ".repeat(4).trim()
function wire(content: string, id: string, kind = "AIMessage") {
  return { id: ["langchain_core", "messages", kind], kwargs: { id, content } }
}
function frame(prefix: string, count = 40) {
  return [
    wire("Worker request", "user", "HumanMessage"),
    ...Array.from({ length: count }, (_, i) =>
      wire(i === 0 ? draft : `${prefix} row ${i}`, `row-${i}`)
    )
  ]
}
function toolFrame(corrected = false) {
  return [
    wire("Tool request", "tool-user", "HumanMessage"),
    {
      ...wire(corrected ? "Tool draft fixed" : draft, "tool-call"),
      kwargs: {
        id: "tool-call",
        content: corrected ? "Tool draft fixed" : draft,
        tool_calls: [{ id: "read-call", name: "read_file", args: { path: "file.txt" } }]
      }
    },
    {
      ...wire("Tool result", "tool-result", "ToolMessage"),
      kwargs: {
        id: "tool-result",
        content: "Tool result",
        tool_call_id: "read-call",
        name: "read_file"
      }
    },
    wire("Worker tool final", "tool-final")
  ]
}
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 80))
  }
  throw new Error(`Timeout: ${label}`)
}
async function main() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  )
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  env.CMB_TASK_CARDS_MOCK = "1"
  env.CMB_E2E_DISABLE_GPU = "1"
  env.CMB_E2E_ELECTRON_BIN = require("electron") as string
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
  let app: ElectronApplication | undefined
  const results: string[] = []
  const errors: string[] = []
  const packaged = process.env.TEAM_OUTPUT_PACKAGED_EXE
  try {
    app = await _electron.launch({
      executablePath:
        packaged ||
        (process.platform === "win32"
          ? join(root, "tests/support/electron-launcher.cmd")
          : require("electron")),
      args: [
        ...(packaged ? ["--disable-gpu", "--in-process-gpu"] : [root]),
        `--user-data-dir=${join(isolated, "profile")}`
      ],
      cwd: root,
      env,
      timeout: 60_000
    })
    await app.context().route(/^https?:/, (route) => route.abort())
    const page = await app.firstWindow()
    page.setDefaultTimeout(20_000)
    page.on("pageerror", (error) => errors.push(error.stack || error.message))
    await app.evaluate(
      async ({ app, ipcMain, BrowserWindow }, history) => {
        const state = ((globalThis as unknown as MainGlobal).teamFixture = {
          threadId: "",
          workers: [],
          history,
          focused: null,
          reads: 0
        })
        ipcMain.removeHandler("open-login-page")
        ipcMain.handle("open-login-page", () => undefined)
        ipcMain.removeHandler("agent:coordinator-workers")
        ipcMain.handle("agent:coordinator-workers", (_event, payload) =>
          payload.threadId === state.threadId ? state.workers : []
        )
        ipcMain.removeHandler("agent:coordinator-worker-stream-focus")
        ipcMain.handle("agent:coordinator-worker-stream-focus", (_event, payload) => {
          if (payload.workerThreadId || payload.expectedWorkerThreadId === state.focused)
            state.focused = payload.workerThreadId
        })
        ipcMain.removeHandler("threads:latest-checkpoint")
        ipcMain.handle("threads:latest-checkpoint", (_event, id) => {
          const index = state.workers.findIndex((worker) => worker.worker_thread_id === id)
          if (index < 0) return null
          state.reads += 1
          return { checkpoint: { channel_values: { messages: state.history[index] } } }
        })
        ipcMain.removeAllListeners("agent:invoke")
        ipcMain.on("agent:invoke", (event, request) => {
          state.run = {
            sender: event.sender,
            channel: `agent:stream:${request.threadId}:request:${encodeURIComponent(request.streamRequestId)}`
          }
        })
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await BrowserWindow.getAllWindows()[0].loadFile(
              `${app.getAppPath()}/out/renderer/index.html`
            )
            break
          } catch (error) {
            if (attempt === 2 || !String(error).includes("(-3)")) throw error
            await new Promise((done) => setTimeout(done, 500))
          }
        }
      },
      [frame("A"), toolFrame()]
    )
    await page.waitForFunction(() =>
      Boolean(
        (window as unknown as AppWindow).api && document.getElementById("root")?.childElementCount
      )
    )
    const workspace = join(isolated, "workspace")
    mkdirSync(workspace)
    const threadId = await page.evaluate(
      async ({ title, workspace }) => {
        const api = (window as unknown as AppWindow).api
        const thread = await api.threads.create({
          title,
          workspacePath: workspace,
          agentMode: "coordinator"
        })
        const id = thread.thread_id || thread.id
        if (!id) throw new Error("Missing thread id")
        await api.workspace.set(id, workspace)
        return id
      },
      { title, workspace }
    )
    await app.evaluate((_electron, id) => {
      const state = (globalThis as unknown as MainGlobal).teamFixture
      state.threadId = id
      state.workers = [0, 1].map((i) => ({
        worker_id: `worker-${i}`,
        worker_thread_id: `${id}__worker__${i}`,
        parent_thread_id: id,
        role: "implementer",
        description: `Regression worker ${i}`,
        status: "running",
        turns: 1,
        workload: "read_only",
        owned_files: [],
        tool_call_count: 0,
        last_event: "started",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        suppress_notification_auto_run: true
      }))
    }, threadId)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    if (!process.env.TEAM_OUTPUT_ONLY_WORKER) {
      await until(async () => {
        if (
          await app!.evaluate(() => Boolean((globalThis as unknown as MainGlobal).teamFixture.run))
        )
          return true
        const composer = page.locator("textarea.composer-textarea")
        await composer.fill("运行 Team 消息回归")
        const submit = composer.locator("xpath=ancestor::form").locator('button[type="submit"]')
        if (await submit.isEnabled()) await submit.click()
        return false
      }, "Team main submission")
      for (const packet of recorded) {
        await app.evaluate((_electron, packet) => {
          const run = (globalThis as unknown as MainGlobal).teamFixture.run!
          run.sender.send(run.channel, packet)
        }, packet)
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
        )
      }
      const chat = page.locator(`[data-chat-thread-id="${threadId}"]`)
      for (const text of ["checking-1", "checking-2", "hahaha done"]) {
        await chat.getByText(text, { exact: true }).waitFor()
        assert.equal(await chat.getByText(text, { exact: true }).count(), 1)
      }
      await page.screenshot({ path: join(artifacts, "team-main-fixed.png") })
      results.push("recorded provider-ID reuse retains three distinct main replies exactly once")
    }
    const open = async (index: number) => {
      await page
        .getByRole("button", { name: /打开工具流/ })
        .nth(index)
        .click()
      await until(
        () =>
          app!.evaluate((_electron, i) => {
            const state = (globalThis as unknown as MainGlobal).teamFixture
            return state.focused === state.workers[i].worker_thread_id
          }, index),
        "worker focus"
      )
      await page.getByText(index ? "Worker tool final" : "A row 39", { exact: true }).waitFor()
    }
    await open(0)
    const rows = page.locator('[data-worker-message-row="true"]')
    const serialize = createStreamDataSerializer()
    const emit = async (event: Record<string, unknown>) => {
      await app!.evaluate(({ BrowserWindow }, event) => {
        const state = (globalThis as unknown as MainGlobal).teamFixture
        BrowserWindow.getAllWindows()[0].webContents.send(
          `agent:coordinator-worker-stream:${state.threadId}`,
          event
        )
      }, event)
    }
    const send = async (messages: unknown[]) =>
      emit({
        type: "stream",
        mode: "values",
        workerTurn: 1,
        ...serialize("values", { messages })
      })
    await send(frame("A"))
    assert.equal(await rows.count(), 41)
    const corrected = frame("A")
    corrected[1].kwargs.content = "Corrected"
    corrected[40].kwargs.content = draft
    await send(corrected)
    await page.getByText("Corrected", { exact: true }).waitFor()
    await page.getByText(draft, { exact: true }).waitFor()
    assert.equal(await rows.filter({ hasText: draft }).count(), 1)
    await send(corrected)
    assert.equal(await rows.count(), 41)
    results.push(
      "complete values correction overrides old checkpoint/live draft without duplication"
    )
    corrected[40] = wire("Tail fixed", "row-39")
    await send(corrected)
    await page.getByText("Tail fixed", { exact: true }).waitFor()
    results.push("tail values correction remains visible over longer checkpoint text")
    await app.evaluate((_electron, corrected) => {
      const state = (globalThis as unknown as MainGlobal).teamFixture
      state.history[0] = corrected
    }, corrected)
    await page.getByRole("button", { name: "返回", exact: true }).click()
    await open(1)
    assert.equal(await rows.filter({ hasText: "Corrected" }).count(), 0)
    await send(toolFrame())
    await send(toolFrame(true))
    await page.getByText("Tool draft fixed", { exact: true }).waitFor()
    assert.equal(await rows.count(), 3) // Tool result is rendered inside its assistant tool call.
    assert.equal(await rows.filter({ hasText: draft }).count(), 0)
    results.push(
      "worker correction across a tool call/result preserves all four message identities"
    )
    await emit({
      type: "stream",
      mode: "values",
      workerTurn: 2,
      data: {
        messages: [
          ...toolFrame(true),
          wire("Second tool request", "tool-user", "HumanMessage"),
          wire("Active second answer", "tool-final")
        ]
      }
    })
    await page.getByText("Active second answer", { exact: true }).waitFor()
    for (const [content, mode] of [
      ["", "snapshot"],
      ["Late corrected answer", "delta"]
    ]) {
      await emit({
        type: "stream",
        mode: "messages",
        workerTurn: 1,
        data: [
          wire(content, "tool-final", "AIMessageChunk"),
          { [STREAM_MESSAGE_CONTENT_MODE_KEY]: mode }
        ]
      })
    }
    await page.getByText("Late corrected answer", { exact: true }).waitFor()
    assert.equal(await rows.count(), 5)
    assert.equal(await rows.filter({ hasText: "Worker tool final" }).count(), 0)
    assert.equal(await page.getByText("Active second answer", { exact: true }).count(), 1)
    results.push("late previous-turn clear and delta update one slot without duplicating messages")
    await page.getByRole("button", { name: "返回", exact: true }).click()
    await page
      .getByRole("button", { name: /打开工具流/ })
      .nth(0)
      .click()
    await page.getByText("Corrected", { exact: true }).waitFor()
    results.push("switching workers with reused IDs restores their own checkpoint history")
    const started = performance.now()
    const large = frame("History", 400)
    for (let n = 0; n < 30; n += 1) {
      large[400] = wire(`Streaming frame ${n}`, "row-399")
      await send(large)
      await page.getByText(`Streaming frame ${n}`, { exact: true }).waitFor()
    }
    assert.equal(await rows.count(), 240)
    await page.getByRole("button", { name: "更早", exact: true }).click()
    await page.getByRole("button", { name: "最新", exact: true }).click()
    await page.getByText("Streaming frame 29", { exact: true }).waitFor()
    const stressMs = performance.now() - started
    results.push(
      "400-message history and 30 tail frames preserve the bounded window and navigation"
    )
    await app.evaluate(() => {
      const state = (globalThis as unknown as MainGlobal).teamFixture
      state.workers = state.workers.map((worker) => ({ ...worker, status: "completed" }))
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    await page.getByText("代理", { exact: true }).click()
    await page
      .getByRole("button", { name: /打开工具流/ })
      .nth(0)
      .click()
    await page.getByText("Corrected", { exact: true }).waitFor()
    assert.equal(await rows.count(), 41)
    results.push("completed worker reload reads corrected checkpoint once")
    await page.screenshot({ path: join(artifacts, "team-worker-fixed.png") })
    assert.deepEqual(errors, [])
    const result = { results, errors, stressMs, packaged: Boolean(packaged) }
    writeFileSync(join(artifacts, "result.json"), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } catch (error) {
    const page = app?.windows()[0]
    if (page) {
      await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined)
      writeFileSync(
        join(artifacts, "failure.txt"),
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      )
    }
    throw error
  } finally {
    if (app) await app.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
