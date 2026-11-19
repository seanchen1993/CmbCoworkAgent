/** Real coordinator worker completion, main transcript and cold reopen. The model is localhost-only. */
import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { _electron as electron, type ElectronApplication, type Page } from "playwright"
import { TURN_COMPLETION_GATE_MARKER_PREFIX } from "../src/shared/checkpoint-transcript"
import { COORDINATOR_NOTIFICATION_PROMPT_PREFIX } from "../src/shared/internal-notification-turn"
import type { ThreadSearchPage, ThreadSearchStartRequest } from "../src/shared/thread-search-types"

const repairThroughGate = process.argv.includes("--gate")
const root = path.resolve(import.meta.dirname, "..")
const output = path.join(
  root,
  "output",
  "team-notification-e2e",
  (repairThroughGate ? "gate-" : "") + Date.now()
)
const workspace = path.join(output, "workspace")
const model = "deepseek-team-notification"
const modelId = "custom:team-notification"
const title = "Team worker notification transcript"
const submitText = "Launch one read-only worker and report its result."
const startText = "Fixture worker launch"
const waitingText = "Fixture worker launched"
const workerText = "TEAM_WORKER_RESULT"
const reportPrefix = "Fixture Team "
const reportText = reportPrefix + "worker result verified"
const invalidReport = "Fixture Team invalid report\n<function=fixture>"
const expectedMainReplies = [
  startText,
  waitingText,
  ...(repairThroughGate ? [invalidReport] : []),
  reportText
]
const workerCallId = "fixture-start-worker"

interface ModelRequest {
  stream?: boolean
  tools?: { function: { name: string } }[]
  messages: { role: string; content: unknown; tool_call_id?: string }[]
}

interface StoredMessage {
  id: string
  role: string
  content: unknown
  tool_calls?: { id?: string }[]
  tool_call_id?: string
  ordinal?: number
}

interface FixtureWindow {
  api: {
    models: {
      setCustomConfig(config: Record<string, unknown>): Promise<void>
      setDefault(id: string): Promise<void>
    }
    routing: { setMode(mode: string): Promise<void> }
    sandbox: { setMode(mode: string): Promise<void>; setYoloMode(value: boolean): Promise<void> }
    workspace: { set(id: string, workspace: string): Promise<void> }
    threads: {
      create(metadata: Record<string, unknown>): Promise<{ thread_id: string }>
      getMessages(id: string): Promise<StoredMessage[]>
      searchStart(request: ThreadSearchStartRequest): Promise<ThreadSearchPage>
      searchContinue(cursor: string): Promise<ThreadSearchPage>
      searchCancel(sessionId: string): Promise<unknown>
      getMessagesPage(
        id: string,
        options: { includeVisibleMessagePresence: boolean }
      ): Promise<{ legacyCheckpointMigrationStatus?: string }>
    }
  }
}

async function main(): Promise<void> {
  await mkdir(workspace, { recursive: true })
  let notifications = 0
  let workerRuns = 0
  let gateRepairs = 0
  let requests = 0
  const serverErrors: string[] = []
  const pageErrors: string[] = []
  const reportReady = Promise.withResolvers<void>()
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions")
      let raw = ""
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw) as ModelRequest
      assert.equal(body.stream, true)
      const hasWorkerTool = body.tools?.some(({ function: tool }) => tool.name === "start_worker")
      const latestUser = JSON.stringify(
        body.messages.findLast(({ role }) => role === "user")?.content
      )
      let text: string
      let toolCalls: unknown[] | undefined
      let streamSlowly = false
      if (latestUser?.includes(TURN_COMPLETION_GATE_MARKER_PREFIX)) {
        assert.ok(repairThroughGate && hasWorkerTool)
        gateRepairs++
        text = reportText
        streamSlowly = true
      } else if (latestUser?.includes(COORDINATOR_NOTIFICATION_PROMPT_PREFIX)) {
        assert.ok(hasWorkerTool)
        assert.ok(
          latestUser.includes(workerText),
          "the real worker evidence reached the coordinator"
        )
        notifications++
        text = repairThroughGate ? invalidReport : reportText
        streamSlowly = !repairThroughGate
      } else if (!hasWorkerTool) {
        assert.ok(latestUser?.includes("TEAM_WORKER_FIXTURE"))
        workerRuns++
        // Let the initial physical Team run finish before the notification turn.
        await delay(3_000)
        text = workerText
      } else if (body.messages.some(({ tool_call_id }) => tool_call_id === workerCallId)) {
        text = waitingText
      } else {
        assert.ok(latestUser?.includes(submitText))
        text = startText
        toolCalls = [
          {
            index: 0,
            id: workerCallId,
            type: "function",
            function: {
              name: "start_worker",
              arguments: JSON.stringify({
                subagent_type: "worker",
                role: "implementer",
                workload: "read_only",
                description: "Read-only Team notification fixture",
                prompt: "TEAM_WORKER_FIXTURE. Return the requested fixture evidence."
              })
            }
          }
        ]
      }

      const id = "team-notification-completion-" + ++requests
      response.writeHead(200, { "content-type": "text/event-stream" })
      const send = (delta: Record<string, unknown>, finishReason: string | null) => {
        const data = {
          id,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }]
        }
        response.write("data: " + JSON.stringify(data) + "\n\n")
      }
      const prefix = streamSlowly ? reportPrefix : text
      send(
        { role: "assistant", content: prefix, ...(toolCalls && { tool_calls: toolCalls }) },
        null
      )
      if (streamSlowly) {
        // Hold the final frame until the test observes the committed draft.
        const timeout = new AbortController()
        try {
          await Promise.race([
            reportReady.promise,
            delay(25_000, undefined, { signal: timeout.signal }).then(() => {
              throw new Error("Team notification draft was not observed")
            })
          ])
        } finally {
          timeout.abort()
        }
        send({ content: text.slice(prefix.length) }, null)
      }
      send({}, toolCalls ? "tool_calls" : "stop")
      response.end("data: [DONE]\n\n")
    } catch (error) {
      serverErrors.push(String(error))
      response.destroy()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  const binary = createRequire(import.meta.url)("electron") as string
  const env: Record<string, string> = {
    CMB_E2E_ELECTRON_BIN: binary,
    CMB_E2E_DISABLE_GPU: "1",
    CMB_TASK_CARDS_MOCK: "1",
    CMB_COWORK_AGENT_HOME: path.join(output, "profile"),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    NODE_USE_ENV_PROXY: "1"
  }
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  for (const key of ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    env[key] = path.join(output, key)
    await mkdir(env[key], { recursive: true })
  }

  let app: ElectronApplication | undefined
  let page: Page | undefined
  const launch = async () => {
    app = await electron.launch({
      executablePath:
        process.platform === "win32"
          ? path.join(root, "tests/support/electron-launcher.cmd")
          : binary,
      args: [root, "--user-data-dir=" + path.join(output, "electron-profile")],
      cwd: root,
      env,
      timeout: 60_000
    })
    for (const pipe of [app.process().stdout, app.process().stderr]) {
      pipe?.on("data", (data) => appendFileSync(path.join(output, "electron.log"), data))
    }
    page = await app.firstWindow()
    await page.route(/^https?:/, (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()
    )
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.getByText("新任务", { exact: true }).first().waitFor({ timeout: 60_000 })
    return page
  }
  const openThread = async (view: Page, threadId: string) => {
    await view.getByText(title, { exact: true }).first().click({ timeout: 30_000 })
    const chat = view.locator('[data-chat-thread-id="' + threadId + '"]')
    const composer = chat.locator("textarea.composer-textarea:enabled")
    await composer.waitFor()
    return { chat, composer }
  }
  const assertTranscript = async (view: Page, threadId: string, phase: string) => {
    const chat = view.locator('[data-chat-thread-id="' + threadId + '"]')
    await chat.getByText(reportText, { exact: true }).first().waitFor({ timeout: 90_000 })
    await chat.getByRole("button", { name: "停止生成", exact: true }).waitFor({ state: "hidden" })
    await chat.locator("textarea.composer-textarea:enabled").waitFor()
    const stored = await view.evaluate(
      (id) => (window as unknown as FixtureWindow).api.threads.getMessages(id),
      threadId
    )
    const visible = await chat
      .locator('[data-chat-message-row][data-message-role="assistant"]')
      .allInnerTexts()
    await writeFile(
      path.join(output, phase + ".json"),
      JSON.stringify({ visible, stored }, null, 2)
    )
    assert.deepEqual(
      stored.map(({ role }) => role),
      [
        "user",
        "assistant",
        "tool",
        "assistant",
        "assistant",
        ...(repairThroughGate ? ["assistant"] : [])
      ]
    )
    assert.deepEqual(
      stored.filter(({ role }) => role === "assistant").map(({ content }) => content),
      expectedMainReplies
    )
    const notificationReplies = stored.slice(4)
    for (const reply of notificationReplies) assert.match(reply.id, /^cmb-notification-assistant:/)
    assert.equal(new Set(notificationReplies.map(({ id }) => id)).size, notificationReplies.length)

    const searchAll = (query: string) => view.evaluate(async (value) => {
      const { threads } = (window as unknown as FixtureWindow).api
      let page = await threads.searchStart({ query: value })
      const sessionId = page.sessionId
      const results = [...page.results]
      try {
        while (page.nextCursor) {
          page = await threads.searchContinue(page.nextCursor)
          results.push(...page.results)
        }
        return results
      } finally {
        await threads.searchCancel(sessionId)
      }
    }, query)
    const report = await searchAll(reportText)
    assert.deepEqual(
      report.map(({ threadId: id, target }) => [
        id, target?.kind === "durableMessage" ? target.messageId : null
      ]),
      [[threadId, notificationReplies.at(-1)?.id]],
      phase + ": search must target the stable Team reply"
    )
    const internal = await searchAll(COORDINATOR_NOTIFICATION_PROMPT_PREFIX)
    assert.deepEqual(internal, [], phase + ": search must hide notification prompts")
    assert.ok(stored[2].tool_call_id && stored[2].tool_call_id === stored[1].tool_calls?.[0]?.id)
    assert.equal(await chat.getByText("INTERRUPTED", { exact: true }).count(), 0)
    for (const text of expectedMainReplies) {
      assert.equal(await chat.getByText(text, { exact: true }).count(), 1, phase + ": " + text)
    }
  }

  try {
    const initial = await launch()
    const threadId = await initial.evaluate(
      async ({ port, title, workspace, model, modelId }) => {
        const api = (window as unknown as FixtureWindow).api
        await api.models.setCustomConfig({
          id: "team-notification",
          name: title,
          baseUrl: "http://127.0.0.1:" + port + "/v1",
          model,
          apiKey: "fixture-local",
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await api.models.setDefault(modelId)
        await api.routing.setMode("pinned")
        await api.sandbox.setMode("none")
        await api.sandbox.setYoloMode(true)
        const thread = await api.threads.create({
          title,
          workspacePath: workspace,
          model: modelId,
          agentMode: "coordinator"
        })
        await api.workspace.set(thread.thread_id, workspace)
        return thread.thread_id
      },
      { port, title, workspace, model, modelId }
    )
    await initial.reload({ waitUntil: "domcontentloaded" })
    const { chat, composer } = await openThread(initial, threadId)
    await initial.waitForTimeout(1_000)
    await composer.fill(submitText)
    await composer.locator("xpath=ancestor::form").locator('button[type="submit"]').last().click()
    await chat.getByText(reportPrefix.trim(), { exact: true }).waitFor({ timeout: 20_000 })
    await initial.waitForFunction(
      async ({ threadId, reportPrefix }) => {
        const api = (window as unknown as FixtureWindow).api
        const messages = await api.threads.getMessages(threadId)
        return (
          messages.filter(({ role, content }) => role === "assistant" && content === reportPrefix)
            .length === 1
        )
      },
      { threadId, reportPrefix },
      { timeout: 20_000, polling: 100 }
    )
    reportReady.resolve()
    await assertTranscript(initial, threadId, "live")
    await app!.close()
    app = undefined
    const reopened = await launch()
    await openThread(reopened, threadId)
    await assertTranscript(reopened, threadId, "cold")
    assert.equal(workerRuns, 1)
    assert.equal(notifications, 1)
    assert.equal(gateRepairs, repairThroughGate ? 1 : 0)
    assert.deepEqual(serverErrors, [])
    assert.deepEqual(pageErrors, [])
    console.log(
      "PASS real Team worker notification, single main transcript and cold reopen" +
        (repairThroughGate ? " with completion-gate repair" : "")
    )
  } catch (error) {
    await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => undefined)
    console.error({ output, requests, workerRuns, notifications, serverErrors, pageErrors })
    throw error
  } finally {
    await app?.close().catch(() => undefined)
    server.closeAllConnections()
    server.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
