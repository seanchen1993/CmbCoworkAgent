/** Real Electron runtime with a local SSE provider and an isolated workspace.
 * Run after npm run build: node --import tsx tests/bash-monitor-e2e.spec.ts
 */
import assert from "node:assert/strict"
import { once } from "node:events"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { setTimeout } from "node:timers/promises"
import { _electron, type ElectronApplication } from "playwright"

interface TestApi {
  models: {
    setCustomConfig(config: Record<string, unknown>): Promise<void>
    setDefault(id: string): Promise<void>
  }
  routing: { setMode(mode: string): Promise<void> }
  sandbox: {
    setMode(mode: "none"): Promise<void>
    setYoloMode(enabled: boolean): Promise<void>
  }
  threads: { create(metadata: Record<string, unknown>): Promise<{ thread_id: string }> }
  workspace: { set(threadId: string, path: string): Promise<unknown> }
  agent: {
    invoke(id: string, prompt: string, callback: (event: AgentEvent) => void): () => void
  }
}

type AgentEvent = { type: string; error?: unknown }

interface ModelRequest {
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>
  tools: Array<{ function: { name: string } }>
}

const root = resolve(import.meta.dirname, "..")
const output = join(root, "output/bash-monitor-e2e", String(Date.now()))
const workspace = join(output, "workspace")
const toolsById = new Map<string, string>()
let detachedId: string | undefined
let responseId = 0

function planTool(body: ModelRequest) {
  const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
    index: 0,
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) }
  })
  const user = body.messages.findLast((message) => message.role === "user")
  const scenario = (JSON.stringify(user?.content) ?? "").match(
    /SHELL_MONITOR_(QUICK|AUTO|DETACH|CHECK)/
  )?.[1]
  assert.ok(scenario, "request has an isolated shell fixture")
  assert.ok(
    body.tools.some((item) => item.function.name === "monitor"),
    "monitor is advertised"
  )
  for (const message of body.messages) {
    if (message.role === "tool" && message.tool_call_id) {
      toolsById.set(message.tool_call_id, String(message.content))
    }
  }

  if (scenario === "CHECK") {
    assert.ok(detachedId)
    return toolsById.has("check-stop")
      ? undefined
      : toolCall("check-stop", "monitor", { task_id: detachedId })
  }

  const executeResult = toolsById.get("execute-" + scenario)
  if (!executeResult) {
    return toolCall("execute-" + scenario, "execute", {
      command: "node shell-monitor-probe.cjs " + scenario
    })
  }
  if (scenario === "QUICK") return undefined

  const taskId = executeResult.match(/\bid:\s*([a-f0-9-]+)/i)?.[1]
  assert.ok(taskId, "execute returned a background task ID")
  if (scenario === "DETACH") {
    detachedId = taskId
    return undefined
  }
  if (!toolsById.has("auto-snapshot")) {
    return toolCall("auto-snapshot", "monitor", { task_id: taskId, block: false })
  }
  if (!toolsById.has("auto-result")) {
    return toolCall("auto-result", "monitor", { task_id: taskId })
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

async function main(): Promise<void> {
  mkdirSync(workspace, { recursive: true })
  writeFileSync(
    join(workspace, "shell-monitor-probe.cjs"),
    [
      'const { appendFileSync, writeFileSync } = require("node:fs")',
      "const scenario = process.argv[2]",
      'appendFileSync(scenario + ".log", "started " + process.pid + "\\n")',
      'writeFileSync(scenario + ".pid", String(process.pid))',
      'console.log("probe-start " + process.pid)',
      "const duration = { QUICK: 10, AUTO: 72000, DETACH: 120000 }[scenario]",
      "setTimeout(() => {",
      '  appendFileSync(scenario + ".log", "finished " + process.pid + "\\n")',
      '  console.log("probe-finish " + process.pid)',
      "}, duration)"
    ].join("\n")
  )

  const modelErrors: unknown[] = []
  const pageErrors: string[] = []
  const server = createServer((req, res) => {
    void (async () => {
      let text = ""
      for await (const chunk of req) text += chunk
      const call = planTool(JSON.parse(text) as ModelRequest)
      const send = (delta: unknown, finish_reason: string | null) => {
        const data = {
          id: "shell-" + responseId,
          object: "chat.completion.chunk",
          model: "deepseek-shell-monitor-local",
          choices: [{ index: 0, delta, finish_reason }]
        }
        res.write("data: " + JSON.stringify(data) + "\n\n")
      }
      responseId++
      res.writeHead(200, { "content-type": "text/event-stream" })
      send(
        call ? { role: "assistant", tool_calls: [call] } : { role: "assistant", content: "DONE" },
        null
      )
      send({}, call ? "tool_calls" : "stop")
      res.end("data: [DONE]\n\n")
    })().catch((error) => {
      modelErrors.push(error)
      res.destroy()
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as { port: number }
  const binary = createRequire(import.meta.url)("electron") as string
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    env[key] = join(output, key)
    mkdirSync(env[key], { recursive: true })
  }
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: join(output, "profile"),
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1"
  })

  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({
      executablePath:
        process.platform === "win32" ? join(root, "tests/support/electron-launcher.cmd") : binary,
      args: [
        join(root, "out/main/index.js"),
        "--user-data-dir=" + join(output, "electron-profile")
      ],
      cwd: root,
      env,
      timeout: 60_000
    })
    for (const stream of [app.process().stdout, app.process().stderr]) {
      stream?.on("data", (data) => appendFileSync(join(output, "electron.log"), data))
    }
    await app
      .context()
      .route(/^https?:/, (route) =>
        ["127.0.0.1", "localhost"].includes(new URL(route.request().url()).hostname)
          ? route.continue()
          : route.abort()
      )
    const page = await app.firstWindow()
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.getByText("新任务", { exact: true }).first().waitFor({ timeout: 60_000 })
    const { thread_id: threadId } = await page.evaluate(
      async ({ port, workspace }) => {
        const api = (window as unknown as { api: TestApi }).api
        await api.models.setCustomConfig({
          id: "shell-monitor-local",
          name: "Shell monitor local",
          baseUrl: "http://127.0.0.1:" + port + "/v1",
          model: "deepseek-shell-monitor-local",
          apiKey: "local-only",
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await api.models.setDefault("custom:shell-monitor-local")
        await api.routing.setMode("pinned")
        await api.sandbox.setMode("none")
        await api.sandbox.setYoloMode(true)
        const thread = await api.threads.create({
          title: "Bash monitor E2E",
          workspacePath: workspace,
          agentMode: "normal",
          model: "custom:shell-monitor-local"
        })
        await api.workspace.set(thread.thread_id, workspace)
        return thread
      },
      { port, workspace }
    )
    const invoke = async (scenario: string) => {
      const terminal = await page.evaluate(
        ({ threadId, scenario }) =>
          new Promise<AgentEvent>((resolve) => {
            const api = (window as unknown as { api: TestApi }).api
            const timer = window.setTimeout(() => {
              clean()
              resolve({ type: "fixture_timeout" })
            }, 135_000)
            const clean = api.agent.invoke(threadId, "SHELL_MONITOR_" + scenario, (event) => {
              if (event.type === "done" || event.type === "error") {
                window.clearTimeout(timer)
                clean()
                resolve(event)
              }
            })
          }),
        { threadId, scenario }
      )
      assert.equal(
        terminal.type,
        "done",
        JSON.stringify({ terminal, modelErrors: modelErrors.map(String) })
      )
    }
    await invoke("QUICK")
    assert.match(toolsById.get("execute-QUICK") ?? "", /probe-finish \d+[\s\S]*exit code 0/)
    await invoke("AUTO")
    const auto = toolsById.get("auto-result") ?? ""
    const pid = readFileSync(join(workspace, "AUTO.pid"), "utf8")
    assert.equal(
      readFileSync(join(workspace, "AUTO.log"), "utf8"),
      "started " + pid + "\nfinished " + pid + "\n"
    )
    assert.ok(auto.includes("probe-start " + pid) && auto.includes("probe-finish " + pid))
    assert.match(auto, /exit code 0/)
    const snapshot = JSON.parse(toolsById.get("auto-snapshot") ?? "{}")
    assert.equal(snapshot.retrieval_status, "not_ready")
    assert.match(snapshot.partialOutput, /probe-start \d+/)
    console.log("PASS auto handoff, one process, live snapshot and final monitor result")

    const openChat = async (): Promise<void> => {
      await page.reload({ waitUntil: "domcontentloaded" })
      await page.getByText("Bash monitor E2E", { exact: true }).first().click({ timeout: 60_000 })
    }
    const emitExternalTurnLifecycle = (type: "started" | "done") =>
      app!.evaluate(
        ({ BrowserWindow }, { threadId, type }) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(`scheduler:stream:${threadId}`, { type })
            window.webContents.send("scheduler:thread-activity", { threadId, type })
          }
        },
        { threadId, type }
      )
    const stopShell = page.getByRole("button", { name: "停止后台 Bash", exact: true })
    const stopGeneration = page.getByRole("button", { name: "停止生成", exact: true })
    await openChat()
    await stopShell.waitFor({ state: "hidden" })
    await invoke("DETACH")
    assert.ok(detachedId)
    await stopShell.waitFor({ state: "visible" })
    let detachedPid: number | undefined
    for (let i = 0; i < 50; i++) {
      try {
        detachedPid = Number(readFileSync(join(workspace, "DETACH.pid"), "utf8"))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        await setTimeout(100)
      }
    }
    assert.ok(
      detachedPid && processAlive(detachedPid),
      "detached shell is alive after turn settles"
    )
    await openChat()
    await stopShell.waitFor({ state: "visible", timeout: 30_000 })
    await emitExternalTurnLifecycle("started")
    await stopGeneration.waitFor({ state: "visible", timeout: 30_000 })
    await stopShell.click({ timeout: 10_000 })
    await stopShell.waitFor({ state: "hidden" })
    assert.equal(await stopGeneration.isVisible(), true, "the external turn is still running")
    await emitExternalTurnLifecycle("done")
    await stopGeneration.waitFor({ state: "hidden" })
    await invoke("CHECK")
    assert.match(toolsById.get("check-stop") ?? "", /exit code 130/)
    for (let i = 0; i < 50 && processAlive(detachedPid); i++) await setTimeout(100)
    assert.equal(processAlive(detachedPid), false, "Stop terminates the detached process tree")
    assert.deepEqual(modelErrors, [])
    assert.deepEqual(pageErrors, [])
    console.log(
      "PASS Bash Stop survives reload and cancels the detached shell during an external turn"
    )
  } finally {
    await app?.close().catch(() => undefined)
    server.closeAllConnections()
    server.close()
  }
}

main().catch((error) => {
  console.error(error)
  console.error("Artifacts: " + output)
  process.exitCode = 1
})
