/** Real preload/IPC/runtime/tool/Goal evaluation against localhost only.
 * Defaults to built out/. STREAM_HARNESS_PACKAGED_EXE selects an installed/ASAR
 * executable; STREAM_HARNESS_ARTIFACT_DIR selects the parent of isolated run artifacts.
 */
import assert from "node:assert/strict"

interface CapturedMessage {
  id: string
  role: string
  content: unknown
  tool_call_id?: string
  tool_calls?: { id: string; name: string; args: unknown }[]
}
interface CapturedThread {
  id: string
  state: { goal: { status: string } }
  messages: CapturedMessage[]
  history: unknown[]
}
interface CapturedStop {
  hook_event_name: string
  session_id: string
  workspace_path: string
  stop_context: { assistantResponse: string; toolCalls: string[] }
}
interface HarnessWindow {
  api: {
    models: {
      setCustomConfig(config: Record<string, unknown>): Promise<void>
      setDefault(model: string): Promise<void>
      setGoalSettings(settings: { evaluatorModelId: string }): Promise<void>
    }
    routing: { setMode(mode: string): Promise<void> }
    hooks: { create(config: Record<string, unknown>): Promise<unknown> }
    workspace: { set(id: string, workspace: string): Promise<unknown> }
    threads: {
      create(metadata: Record<string, unknown>): Promise<{ thread_id: string }>
      getGoalState(id: string): Promise<CapturedThread["state"]>
      getHistory(id: string): Promise<unknown[]>
      getMessages(id: string): Promise<CapturedMessage[]>
      getGoalEvents(id: string): Promise<unknown[]>
    }
    agent: {
      invoke(
        id: string,
        prompt: string,
        callback: (event: { type: string; [key: string]: unknown }) => void,
        model: string,
        mode: string,
        internal: boolean,
        userMessageId: string
      ): () => void
      cancel(id: string): Promise<void>
    }
  }
}
import { createServer } from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { _electron as electron, type Page } from "playwright"

const root = path.resolve(__dirname, "..")
const artifactRoot = process.env.STREAM_HARNESS_ARTIFACT_DIR
  ? path.resolve(process.env.STREAM_HARNESS_ARTIFACT_DIR)
  : path.resolve(root, "output/e2e-comprehensive/harness")
const output = path.join(artifactRoot, String(Date.now()))
const workspace = path.join(output, "workspace")
const require = createRequire(import.meta.url)
const binary = require("electron") as string
const packagedExecutable = process.env.STREAM_HARNESS_PACKAGED_EXE
  ? path.resolve(process.env.STREAM_HARNESS_PACKAGED_EXE)
  : undefined
const requests: Record<string, unknown>[] = []
const stopHooks: unknown[] = []
const result: Record<string, unknown> = {
  output,
  stopHooks,
  execution: packagedExecutable
    ? { kind: "packaged", executable: packagedExecutable }
    : { kind: "built-out", executable: binary }
}
let actorCalls = 0
let uiActorCalls = 0
let evaluationCalls = 0
let injectedFailures = 0
let slowResponse: import("node:http").ServerResponse | undefined

async function main(): Promise<void> {
  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(workspace, "evidence.txt"), "LOCAL_TOOL_EVIDENCE_741\n")
  const server = createServer(async (req, res) => {
    try {
      let text = ""
      for await (const chunk of req) text += chunk
      const body = text ? JSON.parse(text) : {}
      requests.push({ url: req.url, body })
      if (req.url === "/stop-hook") {
        result.stopHook ??= body
        stopHooks.push(body)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ continue: true }))
        return
      }
      const messages = body.messages ?? []
      const all = JSON.stringify(messages)
      const evaluator = all.includes("strict evaluator for an autonomous coding agent goal")
      const slow = all.includes("CANCEL_FIXTURE_741")
      const ui = all.includes("UI_FIXTURE_741")
      if (!evaluator && !slow && injectedFailures === 0) {
        injectedFailures++
        res.writeHead(503, { "content-type": "application/json", "retry-after": "0" })
        res.end(JSON.stringify({ error: { message: "controlled transient localhost failure" } }))
        return
      }
      let reply = ""
      let deltas: Record<string, unknown>[] = []
      let finish = "stop"
      if (evaluator) {
        evaluationCalls++
        assert.match(all, /hahaha done/)
        assert.match(all, /LOCAL_TOOL_EVIDENCE_741/)
        const judgeText = messages
          .map((message: { content?: string }) => message.content ?? "")
          .join("\n")
        const finalText = judgeText.match(
          /<untrusted_assistant_response>\s*([\s\S]*?)\s*<\/untrusted_assistant_response>/
        )?.[1]
        assert.equal(
          finalText,
          "hahaha done",
          "evaluator sees the final assistant text, not the tool-call draft or args"
        )
        reply = JSON.stringify({
          verdict: "complete",
          reason: "Verified local evidence and exact repeated text",
          blocker_type: "other",
          ledger_patch: { evidence: ["LOCAL_TOOL_EVIDENCE_741"] }
        })
        result.evaluatorRequest = body
      } else if (slow) {
        deltas = [{ role: "assistant", content: "partial" }, { content: "partial" }]
      } else if ((ui ? uiActorCalls : actorCalls) >= 2) {
        if (ui) uiActorCalls++
        else actorCalls++
        deltas = [
          { role: "assistant", content: "ha", reasoning_content: "r" },
          { content: "ha", reasoning_content: "r" },
          { content: "ha" },
          { content: " done" }
        ]
      } else {
        if (ui) uiActorCalls++
        else actorCalls++
        const stage = ui ? uiActorCalls : actorCalls
        assert.ok(
          (body.tools ?? []).some(
            (t: { function?: { name?: string } }) => t.function?.name === "read_file"
          ),
          "runtime exposes read_file"
        )
        deltas = [
          {
            role: "assistant",
            content: `checking-${stage}`,
            tool_calls: [
              {
                index: 0,
                id: `call-local-741-${stage}`,
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ file_path: path.join(workspace, "evidence.txt") })
                }
              }
            ]
          }
        ]
        finish = "tool_calls"
      }
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id: "local-eval",
            object: "chat.completion",
            model: "local-harness",
            choices: [
              { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          })
        )
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
      const send = (delta: unknown, finish_reason: string | null = null): void => {
        res.write(
          `data: ${JSON.stringify({ id: "provider-reused-741", object: "chat.completion.chunk", model: "local-harness", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        )
      }
      for (const delta of reply ? [{ content: reply }] : deltas) {
        send(delta)
        await new Promise((resolve) => setTimeout(resolve, 35))
      }
      if (slow) {
        slowResponse = res
        return
      }
      if (ui) await new Promise((resolve) => setTimeout(resolve, 1200))
      send({}, finish)
      res.end("data: [DONE]\n\n")
    } catch (error) {
      result.serverError = String(error)
      res.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const env: Record<string, string> = {}
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
    if (process.env[key]) env[key] = process.env[key]!
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    env[key] = path.join(output, key)
    await mkdir(env[key], { recursive: true })
  }
  Object.assign(env, {
    CMB_COWORK_AGENT_HOME: path.join(output, "profile"),
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: binary,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1"
  })
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  let page: Page | undefined
  try {
    app = await electron.launch({
      executablePath:
        packagedExecutable ??
        (process.platform === "win32"
          ? path.join(root, "tests/support/electron-launcher.cmd")
          : binary),
      args: [
        ...(!packagedExecutable ? [path.join(root, "out/main/index.js")] : []),
        `--user-data-dir=${path.join(output, "electron-user-data")}`
      ],
      cwd: packagedExecutable ? path.dirname(packagedExecutable) : root,
      env,
      timeout: 60_000
    })
    await app.context().route(/^https?:/, (route) => {
      const hostname = new URL(route.request().url()).hostname
      return hostname === "127.0.0.1" || hostname === "localhost" ? route.continue() : route.abort()
    })
    if (packagedExecutable) {
      // An empty packaged profile triggers SSO; keep this localhost-only test
      // on the local application UI. Agent invoke/tool/runtime IPC stays real.
      await app.evaluate(async ({ app, BrowserWindow, ipcMain }) => {
        ipcMain.removeHandler("open-login-page")
        ipcMain.handle("open-login-page", () => undefined)
        const main = BrowserWindow.getAllWindows()[0]
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await main.loadFile(`${app.getAppPath()}/out/renderer/index.html`)
            break
          } catch (error) {
            if (attempt === 2 || !String(error).includes("(-3)")) throw error
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        }
      })
      result.packagedLoginIsolation =
        "Only open-login-page is disabled; agent IPC and runtime are unmodified."
    }
    app.process().stdout?.on("data", (data) => {
      void import("node:fs").then((fs) =>
        fs.appendFileSync(path.join(output, "electron.log"), data)
      )
    })
    app.process().stderr?.on("data", (data) => {
      void import("node:fs").then((fs) =>
        fs.appendFileSync(path.join(output, "electron.log"), data)
      )
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    // Packaged preload can expose api in the initial about:blank document.
    // Wait for the actual main UI before IPC setup spans any startup navigation.
    await page.getByText("新任务", { exact: true }).first().waitFor({ state: "visible" })
    await page.waitForFunction(() => Boolean((window as unknown as HarnessWindow).api))
    await page.evaluate(() => {
      ;(globalThis as unknown as { __name: (value: unknown) => unknown }).__name = (
        value: unknown
      ) => value
    })
    result.goal = await page.evaluate(
      async ({ baseUrl, workspace }) => {
        const api = (window as unknown as HarnessWindow).api
        await api.models.setCustomConfig({
          id: "harness-local",
          name: "Local harness",
          baseUrl,
          model: "local-harness",
          apiKey: "local-only",
          maxTokens: 64000,
          maxOutputTokens: 1024
        })
        await api.models.setDefault("custom:harness-local")
        await api.models.setGoalSettings({ evaluatorModelId: "custom:harness-local" })
        await api.routing.setMode("pinned")
        await api.hooks.create({
          event: "Stop",
          type: "http",
          url: baseUrl.replace(/\/v1$/, "/stop-hook"),
          enabled: true
        })
        const thread = await api.threads.create({
          title: "Local harness goal",
          workspacePath: workspace,
          model: "custom:harness-local"
        })
        const id = thread.thread_id
        await api.workspace.set(id, workspace)
        const events: unknown[] = []
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Goal invoke timeout")), 120000)
          const cleanup = api.agent.invoke(
            id,
            "/goal Read evidence.txt with read_file, then reply exactly hahaha done. Completion requires file evidence and the exact reply. Do not modify files.",
            (event) => {
              events.push(event)
              if (event.type === "done" || event.type === "error") {
                clearTimeout(timeout)
                cleanup()
                event.type === "error" ? reject(new Error(JSON.stringify(event))) : resolve()
              }
            },
            "custom:harness-local",
            "normal",
            false,
            "harness-goal-user"
          )
        })
        return {
          id,
          events,
          state: await api.threads.getGoalState(id),
          history: await api.threads.getHistory(id),
          messages: await api.threads.getMessages(id),
          notices: await api.threads.getGoalEvents(id)
        }
      },
      { baseUrl: `http://127.0.0.1:${address.port}/v1`, workspace }
    )
    assert.equal((result.goal as CapturedThread).state.goal.status, "complete")
    assert.ok(evaluationCalls > 0, "actual Goal evaluator reached localhost")
    assert.ok(actorCalls >= 2, "tool cycle caused a second runtime model call")
    assert.equal(result.serverError, undefined)
    assert.equal(
      (result.stopHook as CapturedStop)?.hook_event_name,
      "Stop",
      "actual runtime invokes the configured Stop hook"
    )
    assert.equal((result.stopHook as CapturedStop)?.stop_context?.assistantResponse, "hahaha done")
    assert.deepEqual((result.stopHook as CapturedStop)?.stop_context?.toolCalls, [
      "read_file",
      "read_file"
    ])
    assert.equal((result.stopHook as CapturedStop)?.session_id, (result.goal as CapturedThread).id)
    assert.equal((result.stopHook as CapturedStop)?.workspace_path, workspace)
    assert.equal(injectedFailures, 1)
    assert.equal(actorCalls, 3, "transient retry must not repeat the tool cycle")
    // A separate real ChatContainer submission exercises ThreadProvider's live
    // consumer. The Goal fixture above intentionally exercises raw preload IPC.
    const uiThread = await page.evaluate(
      async ({ workspace }) => {
        const api = (window as unknown as HarnessWindow).api
        const thread = await api.threads.create({
          title: "Harness UI repeated provider",
          workspacePath: workspace,
          model: "custom:harness-local"
        })
        await api.workspace.set(thread.thread_id, workspace)
        return thread.thread_id
      },
      { workspace }
    )
    result.ui = { id: uiThread }
    await page.reload()
    const expand = page.getByRole("button", { name: /展开显示/ }).first()
    if (await expand.isVisible()) await expand.click()
    await page.getByText("Harness UI repeated provider", { exact: true }).first().click()
    const composer = page.locator(".composer-textarea")
    await composer.waitFor({ state: "visible", timeout: 30000 })
    await page.waitForFunction(() => {
      const element = document.querySelector<HTMLTextAreaElement>(".composer-textarea")
      return Boolean(element && !element.disabled)
    })
    // UAT mounts the stream holder after ancillary hydration, as in the
    // existing session-checkpoint-recovery E2E's first UI send.
    await page.waitForTimeout(1000)
    await composer.fill(
      "UI_FIXTURE_741 Read evidence.txt twice, then reply hahaha done. Do not modify files."
    )
    await composer.locator("xpath=ancestor::form").locator('button[type="submit"]').last().click()
    const captureRows = () =>
      page.locator('[data-chat-message-row][data-message-role="assistant"]').evaluateAll((rows) =>
        rows.map((row) => ({
          id: row.getAttribute("data-chat-message-id"),
          text: (row as HTMLElement).innerText
        }))
      )
    for (const [index, text] of ["checking-1", "checking-2", "hahaha done"].entries()) {
      await page.getByText(text, { exact: true }).last().waitFor({ timeout: 60000 })
      const rows = await captureRows()
      ;(result.ui as Record<string, unknown>)[`stage${index + 1}`] = rows
      await page.screenshot({ path: path.join(output, `ui-stage-${index + 1}.png`) })
      const markedRows = rows.filter((row) => /checking-1|checking-2|hahaha done/.test(row.text))
      assert.deepEqual(
        markedRows.map((row) => row.text.match(/checking-1|checking-2|hahaha done/)?.[0]),
        ["checking-1", "checking-2", "hahaha done"].slice(0, index + 1),
        `live stage ${index + 1}: earlier cycles remain before done can restore history`
      )
      for (const earlier of markedRows.slice(0, index)) {
        assert.match(
          earlier.text,
          /evidence\.txt/,
          `live stage ${index + 1}: earlier row retains its tool card`
        )
      }
      assert.equal(new Set(markedRows.map((row) => row.id)).size, markedRows.length)
    }
    await page.waitForFunction(
      () =>
        !document.querySelector('button[aria-label="停止生成"]') &&
        !document.querySelector<HTMLTextAreaElement>(".composer-textarea")?.disabled
    )
    const assertUiRows = async (phase: string): Promise<void> => {
      const rows = await captureRows()
      ;(result.ui as Record<string, unknown>)[phase] = rows
      assert.deepEqual(
        rows.map((row) => row.text.match(/checking-1|checking-2|hahaha done/)?.[0]),
        ["checking-1", "checking-2", "hahaha done"],
        `${phase}: UI retains each assistant cycle`
      )
      assert.match(rows[0].text, /evidence\.txt/)
      assert.match(rows[1].text, /evidence\.txt/)
      assert.doesNotMatch(
        rows[2].text,
        /evidence\.txt/,
        `${phase}: final row does not inherit tool cards`
      )
    }
    await assertUiRows("completed")
    await page.reload()
    await page.getByText("hahaha done", { exact: true }).last().waitFor({ timeout: 30000 })
    await assertUiRows("reloaded")
    ;(result.ui as Record<string, unknown>).messages = await page.evaluate(
      (id) => (window as unknown as HarnessWindow).api.threads.getMessages(id),
      uiThread
    )
    await page.screenshot({ path: path.join(output, "ui-reloaded.png") })
    const persisted = (result.goal as CapturedThread).messages
    assert.deepEqual(
      persisted.map((message) => message.role),
      ["user", "assistant", "tool", "assistant", "tool", "assistant"]
    )
    assert.deepEqual(
      persisted.filter((message) => message.role === "assistant").map((message) => message.content),
      ["checking-1", "checking-2", "hahaha done"]
    )
    assert.deepEqual(
      persisted.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
      ["call-local-741-1", "call-local-741-2"]
    )
    assert.equal(new Set(persisted.map((message) => message.id)).size, persisted.length)
    assert.deepEqual(
      persisted
        .filter((message) => message.role === "assistant")
        .map((message) => (message.tool_calls ?? []).map((call) => call.id)),
      [["call-local-741-1"], ["call-local-741-2"], []],
      "each assistant tool cycle owns only its own tool call; final text must not inherit tools"
    )
    result.cancel = await page.evaluate(
      async ({ workspace }) => {
        const api = (window as unknown as HarnessWindow).api
        const thread = await api.threads.create({
          title: "Local harness cancel",
          workspacePath: workspace,
          model: "custom:harness-local"
        })
        const id = thread.thread_id
        await api.workspace.set(id, workspace)
        const events: unknown[] = []
        await new Promise<void>((resolve, reject) => {
          let stopping = false
          let partialEvents = 0
          const timer = setTimeout(() => reject(new Error("cancel timeout")), 60000)
          const cleanup = api.agent.invoke(
            id,
            "CANCEL_FIXTURE_741",
            (event) => {
              events.push(event)
              if (JSON.stringify(event).includes("partial")) partialEvents++
              if (!stopping && partialEvents >= 2) {
                stopping = true
                void api.agent.cancel(id).then(() => {
                  clearTimeout(timer)
                  cleanup()
                  resolve()
                }, reject)
              }
              if (event.type === "done" || event.type === "error") {
                clearTimeout(timer)
                cleanup()
                resolve()
              }
            },
            "custom:harness-local",
            "normal",
            false,
            "harness-cancel-user"
          )
        })
        return {
          id,
          events,
          history: await api.threads.getHistory(id),
          messages: await api.threads.getMessages(id)
        }
      },
      { workspace }
    )
    assert.ok(
      (result.cancel as CapturedThread).messages.some(
        (message) => message.role === "assistant" && message.content === "partialpartial"
      ),
      "cancel flush persists both repeated chunks"
    )
    result.actorCalls = actorCalls
    result.evaluationCalls = evaluationCalls
    result.injectedFailures = injectedFailures
    result.coverageLimits = [
      "OpenAI SSE carries deltas, not authoritative rewrites/clears; those remain separate serializer/UI/SQLite integration coverage.",
      "Cancel asserts the IPC flush contract and durable text, not a required done event or full worker teardown.",
      "Transient 503 exercises real model HTTP retry; it does not prove every post-token transport replay path."
    ]
    result.passed = true
    console.log(`PASS local runtime/tool/Goal/cancel E2E: ${output}`)
  } finally {
    if (page && !page.isClosed()) {
      result.finalDom = await page
        .locator("body")
        .innerText()
        .catch(() => "unavailable")
      await page.screenshot({ path: path.join(output, "final-window.png") }).catch(() => {})
    }
    slowResponse?.end()
    await app?.close().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await writeFile(
      path.join(output, "result.json"),
      JSON.stringify({ ...result, requests }, null, 2)
    )
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
