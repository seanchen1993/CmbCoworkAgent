/**
 * Actual Electron main/preload/IPC/React workflow panel regression, with a controlled
 * workflow IPC handlers and disposable profile/sidecars. No model calls or user sessions.
 * Covers renderer consumption of persisted snapshots, not the production run-store writer.
 * Run after build: tsx tests/workflow-output-e2e.spec.ts
 * Optional: WORKFLOW_OUTPUT_PACKAGED_EXE / WORKFLOW_OUTPUT_ARTIFACT_DIR.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron, type ElectronApplication } from "playwright"
import { AIMessage } from "@langchain/core/messages"
import { serializeWorkflowAgentSnapshotMessages } from "../src/main/agent/workflow/agent-snapshot"

interface Fixture {
  threadId: string
  run: Record<string, unknown>
  snapshots: unknown[][]
  sidecars: string[]
  interest: number | null
  reads: number
}
interface MainGlobal {
  workflowFixture: Fixture
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
const runId = "wf_123456789abc"
const title = "Workflow output regression"
const isolated = mkdtempSync(join(tmpdir(), "cmb-workflow-output-e2e-"))
const artifacts = resolve(
  root,
  process.env.WORKFLOW_OUTPUT_ARTIFACT_DIR || "output/workflow-output/e2e"
)
mkdirSync(artifacts, { recursive: true })

function snapshot(prefix: string, count = 40): unknown[] {
  return serializeWorkflowAgentSnapshotMessages({
    messages: Array.from(
      { length: count },
      (_, index) =>
        new AIMessage({
          id: `workflow-message-${index}`,
          content: `${prefix} response ${index}`
        })
    )
  })!
}

async function main(): Promise<void> {
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
  const packaged = process.env.WORKFLOW_OUTPUT_PACKAGED_EXE
  let app: ElectronApplication | undefined
  const errors: string[] = []
  const results: string[] = []
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
    const frames = [snapshot("A"), snapshot("B")]
    const sidecars = [0, 1].map((index) => join(isolated, `agent-${index}.toolstream`))
    sidecars.forEach((path, index) =>
      writeFileSync(path, JSON.stringify({ snapshotMessages: frames[index] }))
    )
    const run = {
      runId,
      workflowName: title,
      description: "Display-only regression",
      status: "running",
      phases: [],
      currentPhase: null,
      logs: [],
      worktrees: [],
      startedAt: new Date().toISOString(),
      agents: [0, 1].map((index) => ({
        index,
        label: `Regression agent ${index}`,
        phase: null,
        status: "running",
        outputTokens: 0,
        startedAt: new Date().toISOString(),
        promptPreview: "Regression input"
      })),
      stats: { agentsTotal: 2, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 1000 }
    }
    await app.evaluate(
      async ({ app, ipcMain, BrowserWindow }, fixture) => {
        const fs = process.getBuiltinModule("fs").promises
        const state = ((globalThis as unknown as MainGlobal).workflowFixture = fixture)
        ipcMain.removeHandler("open-login-page")
        ipcMain.handle("open-login-page", () => undefined)
        ipcMain.removeHandler("workflow:hydrate")
        ipcMain.handle("workflow:hydrate", (_event, payload) => ({
          latestRun: payload.threadId === state.threadId ? state.run : null,
          activeRunId: state.run.status === "running" ? state.run.runId : null,
          hasPendingNotification: false
        }))
        ipcMain.removeHandler("workflow:set-agent-stream-interest")
        ipcMain.handle("workflow:set-agent-stream-interest", (event, payload) => {
          if (payload.threadId !== state.threadId || payload.runId !== state.run.runId) return false
          state.interest = payload.interested ? payload.agentIndex : null
          if (payload.interested)
            setTimeout(() => {
              if (!event.sender.isDestroyed())
                event.sender.send(`agent:workflow-agent-stream:${state.threadId}`, {
                  runId: state.run.runId,
                  agentIndex: payload.agentIndex,
                  snapshotMessages: state.snapshots[payload.agentIndex]
                })
            }, 80)
          return true
        })
        ipcMain.removeHandler("workflow:get-agent-toolstream")
        ipcMain.handle("workflow:get-agent-toolstream", async (_event, payload) => {
          if (payload.threadId !== state.threadId || payload.runId !== state.run.runId) return null
          state.reads += 1
          return JSON.parse(await fs.readFile(state.sidecars[payload.agentIndex], "utf8"))
            .snapshotMessages
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
      { threadId: "", run, snapshots: frames, sidecars, interest: null, reads: 0 } as Fixture
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
          agentMode: "workflow"
        })
        const id = thread.thread_id || thread.id
        if (!id) throw new Error("Missing thread id")
        await api.workspace.set(id, workspace)
        return id
      },
      { title, workspace }
    )
    await app.evaluate((_electron, id) => {
      ;(globalThis as unknown as MainGlobal).workflowFixture.threadId = id
    }, threadId)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    const open = async (index: number) => {
      await page
        .getByRole("button", { name: "查看该子代理的实时工具流", exact: true })
        .nth(index)
        .click()
      await page.locator('[data-workflow-agent-stream-message-id="workflow-message-39"]').waitFor()
    }
    await open(0)
    const rows = page.locator("[data-workflow-agent-stream-message-id]")
    assert.equal(await rows.count(), 40)
    const send = async (messages: unknown[], agentIndex = 0, otherRunId = runId) => {
      await app!.evaluate(
        ({ BrowserWindow }, payload) => {
          const state = (globalThis as unknown as MainGlobal).workflowFixture
          if (payload.runId === state.run.runId)
            state.snapshots[payload.agentIndex] = payload.snapshotMessages
          BrowserWindow.getAllWindows()[0].webContents.send(
            `agent:workflow-agent-stream:${state.threadId}`,
            payload
          )
        },
        { runId: otherRunId, agentIndex, snapshotMessages: messages }
      )
    }
    const corrected = snapshot("A") as Array<{ kwargs: { content: string } }>
    corrected[0].kwargs.content = "Corrected earlier answer"
    corrected[39].kwargs.content = "A response 0"
    await send(corrected)
    await page.getByText("Corrected earlier answer", { exact: true }).waitFor()
    await page.getByText("A response 0", { exact: true }).waitFor()
    assert.equal(await rows.filter({ hasText: "A response 0" }).count(), 1)
    results.push("live prefix correction removes stale duplicate before completion")
    await send(corrected)
    await send(snapshot("wrong run"), 0, "wf_ffffffffffff")
    await send(snapshot("wrong agent"), 1)
    assert.equal(await rows.count(), 40)
    assert.equal(await rows.filter({ hasText: "Corrected earlier answer" }).count(), 1)
    results.push("repeated frames and other run/agent frames do not duplicate or overwrite")

    await page.getByRole("button", { name: "返回", exact: true }).click()
    await open(1)
    await page.getByText("wrong agent response 0", { exact: true }).waitFor()
    await page.getByRole("button", { name: "返回", exact: true }).click()
    await open(0)
    await page.getByText("Corrected earlier answer", { exact: true }).waitFor()
    results.push("focus switches with reused provider ids preserve agent isolation")

    const stressStart = performance.now()
    const stressFrames = 60
    for (let frame = 0; frame < stressFrames; frame += 1) {
      const messages = snapshot("History", 400) as Array<{ kwargs: { content: string } }>
      messages[399].kwargs.content = `Streaming frame ${frame}`
      await send(messages)
      await page.getByText(`Streaming frame ${frame}`, { exact: true }).waitFor()
    }
    assert.equal(await rows.count(), 240)
    assert.equal(
      await rows.first().getAttribute("data-workflow-agent-stream-message-id"),
      "workflow-message-160"
    )
    assert.equal(
      await rows.last().getAttribute("data-workflow-agent-stream-message-id"),
      "workflow-message-399"
    )
    await page.getByRole("button", { name: "前一页", exact: true }).click()
    await page.locator('[data-workflow-agent-stream-message-id="workflow-message-80"]').waitFor()
    assert.equal(
      await rows.first().getAttribute("data-workflow-agent-stream-message-id"),
      "workflow-message-80"
    )
    assert.equal(
      await rows.last().getAttribute("data-workflow-agent-stream-message-id"),
      "workflow-message-319"
    )
    await page.getByRole("button", { name: "最新", exact: true }).click()
    await page.locator('[data-workflow-agent-stream-message-id="workflow-message-399"]').waitFor()
    assert.equal(
      await rows.first().getAttribute("data-workflow-agent-stream-message-id"),
      "workflow-message-160"
    )
    assert.equal(
      await rows.last().getAttribute("data-workflow-agent-stream-message-id"),
      "workflow-message-399"
    )
    results.push("60 maximum-size snapshots keep the 240-row display window and pagination usable")
    const stressMs = performance.now() - stressStart

    await send(corrected)
    await page.getByText("Corrected earlier answer", { exact: true }).waitFor()
    const terminal = JSON.parse(JSON.stringify(corrected)) as typeof corrected
    terminal[0].kwargs.content = "Authoritative completed answer"
    writeFileSync(sidecars[0], JSON.stringify({ snapshotMessages: terminal }))
    await app.evaluate(
      ({ BrowserWindow }, finished) => {
        const state = (globalThis as unknown as MainGlobal).workflowFixture
        state.run = finished
        BrowserWindow.getAllWindows()[0].webContents.send(
          `agent:workflow-events:${state.threadId}`,
          {
            type: "workflow_progress",
            workflowEvent: {
              kind: "finished",
              runId: finished.runId,
              status: "completed",
              stats: finished.stats
            }
          }
        )
      },
      {
        ...run,
        status: "completed",
        agents: run.agents.map((agent) => ({ ...agent, status: "completed" }))
      }
    )
    await page.getByText("Authoritative completed answer", { exact: true }).waitFor()
    assert.equal(await rows.filter({ hasText: "A response 0" }).count(), 1)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(title, { exact: true }).first().click()
    await open(0)
    await page.getByText("Authoritative completed answer", { exact: true }).waitFor()
    assert.equal(await rows.count(), 40)
    results.push(
      "completion and renderer reload read the authoritative sidecar without duplicated rows"
    )
    await page.screenshot({ path: join(artifacts, "workflow-output-fixed.png") })
    assert.deepEqual(errors, [])
    const reads = await app.evaluate(
      () => (globalThis as unknown as MainGlobal).workflowFixture.reads
    )
    assert.ok(reads >= 2)
    writeFileSync(
      join(artifacts, "result.json"),
      JSON.stringify(
        { results, errors, stressFrames, stressMs, reads, packaged: Boolean(packaged) },
        null,
        2
      )
    )
    console.log(JSON.stringify({ results, stressFrames, stressMs, reads, artifacts }))
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
