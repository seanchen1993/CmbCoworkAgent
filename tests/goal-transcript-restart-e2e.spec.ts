/** Real Goal continuation, renderer, and SQLite reopen using a localhost-only model. */
import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { _electron as electron, type ElectronApplication, type Page } from "playwright"
import { GOAL_USER_MESSAGE_EVENT_PREFIX } from "../src/shared/goal-events"

const root = path.resolve(__dirname, "..")
const output = path.join(root, "output", "goal-transcript-restart-e2e", String(Date.now()))
const workspace = path.join(output, "workspace")
const modelId = "custom:goal-transcript-restart"
const title = "Goal transcript restart fixture"
const providerId = "goal-reused-provider"
const callId = "goal-reused-call"
const expectedAssistantText = [
  "checking first",
  "first verified",
  "first revision",
  "checking second",
  "second verified"
]

interface StoredMessage {
  id: string
  role: string
  content: unknown
  status?: string
  tool_calls?: { id?: string }[]
  tool_call_id?: string
  ordinal?: number
}

interface FixtureWindow {
  api: {
    models: {
      setCustomConfig(config: Record<string, unknown>): Promise<void>
      setDefault(id: string): Promise<void>
      setGoalSettings(settings: { evaluatorModelId: string }): Promise<void>
    }
    routing: { setMode(mode: string): Promise<void> }
    hooks: { create(config: Record<string, unknown>): Promise<unknown> }
    sandbox: { setMode(mode: string): Promise<void>; setYoloMode(value: boolean): Promise<void> }
    workspace: { set(id: string, workspace: string): Promise<void> }
    threads: {
      create(metadata: Record<string, unknown>): Promise<{ thread_id: string }>
      getGoalState(id: string): Promise<{ goal?: { status: string } }>
      getMessages(id: string): Promise<StoredMessage[]>
      getMessagesPage(
        id: string,
        options: { includeVisibleMessagePresence: boolean }
      ): Promise<{ legacyCheckpointMigrationStatus?: string }>
    }
  }
}

async function main(): Promise<void> {
  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(workspace, "first.txt"), "GOAL_FIRST_EVIDENCE\n")
  await writeFile(path.join(workspace, "second.txt"), "GOAL_SECOND_EVIDENCE\n")

  let executions = 0
  let evaluations = 0
  let revisionsRequested = 0
  const seenEvidence: boolean[] = []
  const serverErrors: string[] = []
  const pageErrors: string[] = []
  const server = createServer(async (request, response) => {
    try {
      let raw = ""
      for await (const data of request) raw += data
      const body = JSON.parse(raw)
      if (request.url === "/stop-hook") {
        const requestRevision =
          revisionsRequested === 0 &&
          body.stop_context?.assistantResponse?.includes("first verified")
        if (requestRevision) revisionsRequested++
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify(
            requestRevision
              ? { decision: "block", reason: "Add the requested first-file verification revision" }
              : { continue: true }
          )
        )
        return
      }
      const messages = JSON.stringify(body.messages)
      if (messages.includes("strict evaluator for an autonomous coding agent goal")) {
        evaluations++
        assert.ok(evaluations <= 2, "one evaluation per Goal subturn")
        const done = evaluations === 2
        assert.ok(messages.includes(done ? "second verified" : "first revision"))
        const verdict = {
          verdict: done ? "complete" : "continue",
          reason: done ? "Both evidence files were read" : "Read the second evidence file next",
          blocker_type: "other",
          ledger_patch: { evidence: [done ? "GOAL_SECOND_EVIDENCE" : "GOAL_FIRST_EVIDENCE"] }
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            id: "fixture-evaluation",
            object: "chat.completion",
            model: "deepseek-goal-transcript-restart",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: JSON.stringify(verdict) },
                finish_reason: "stop"
              }
            ]
          })
        )
        return
      }

      const index = executions++
      assert.ok(
        index < expectedAssistantText.length && body.stream,
        "two tool cycles and one revision"
      )
      const isToolCall = index === 0 || index === 3
      const file = index < 3 ? "first.txt" : "second.txt"
      if (index === 2) assert.ok(messages.includes("[[CMBDEVCLAW_STOP_HOOK_REVISION]]"))
      if (index >= 3) assert.ok(messages.includes("[Continuing active goal]"))
      if (index === 1 || index === 4) {
        seenEvidence.push(
          messages.includes(index === 1 ? "GOAL_FIRST_EVIDENCE" : "GOAL_SECOND_EVIDENCE")
        )
      }
      const toolCalls = [
        {
          index: 0,
          id: callId,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ file_path: path.join(workspace, file) })
          }
        }
      ]
      response.writeHead(200, { "content-type": "text/event-stream" })
      const send = (delta: Record<string, unknown>, finish: string | null) =>
        response.write(
          `data: ${JSON.stringify({
            id: providerId,
            object: "chat.completion.chunk",
            model: "deepseek-goal-transcript-restart",
            choices: [{ index: 0, delta, finish_reason: finish }]
          })}\n\n`
        )
      send(
        {
          role: "assistant",
          content: expectedAssistantText[index],
          ...(isToolCall && { tool_calls: toolCalls })
        },
        null
      )
      send({}, isToolCall ? "tool_calls" : "stop")
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
    const value = process.env[key]
    if (value) env[key] = value
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
      args: [root, `--user-data-dir=${path.join(output, "electron-profile")}`],
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
    const composer = view.locator(`[data-chat-thread-id="${threadId}"] .composer-textarea`)
    await composer.and(view.locator("textarea:enabled")).waitFor({ state: "visible" })
    return composer
  }
  const assertTranscript = async (view: Page, threadId: string, phase: string) => {
    const chat = view.locator(`[data-chat-thread-id="${threadId}"]`)
    await chat.getByText("second verified", { exact: true }).first().waitFor({ timeout: 90_000 })
    const assistantRows = chat.locator('[data-chat-message-row][data-message-role="assistant"]')
    const visible = await assistantRows.allInnerTexts()
    const stored = await view.evaluate(
      (id) => (window as unknown as FixtureWindow).api.threads.getMessages(id),
      threadId
    )
    await writeFile(
      path.join(output, `${phase}.json`),
      JSON.stringify({ visible, stored }, null, 2)
    )
    await view.screenshot({ path: path.join(output, `${phase}.png`) })
    assert.deepEqual(
      visible.map((row) => expectedAssistantText.find((marker) => row.includes(marker))),
      expectedAssistantText,
      `${phase}: each true assistant reply is shown once in chronological order`
    )
    assert.equal(await chat.getByText("INTERRUPTED", { exact: true }).count(), 0)
    assert.equal(await chat.getByText("OK", { exact: true }).count(), 2)
    assert.deepEqual(
      stored.map(({ role }) => role),
      ["user", "assistant", "tool", "assistant", "assistant", "assistant", "tool", "assistant"]
    )
    assert.deepEqual(
      stored.filter(({ role }) => role === "assistant").map(({ content }) => content),
      expectedAssistantText
    )
    assert.equal(new Set(stored.map(({ id }) => id)).size, stored.length)
    const results = stored.filter(({ role }) => role === "tool")
    assert.equal(results[0].tool_call_id, stored[1].tool_calls?.[0]?.id)
    assert.equal(results[1].tool_call_id, stored[5].tool_calls?.[0]?.id)
    assert.match(JSON.stringify(results[0].content), /GOAL_FIRST_EVIDENCE/)
    assert.match(JSON.stringify(results[1].content), /GOAL_SECOND_EVIDENCE/)
  }
  const waitForCheckpointBootstrap = async (view: Page, threadId: string) => {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const status = await view.evaluate(async (id) => {
        const api = (window as unknown as FixtureWindow).api
        return (await api.threads.getMessagesPage(id, { includeVisibleMessagePresence: true }))
          .legacyCheckpointMigrationStatus
      }, threadId)
      if (status === "complete") return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("Checkpoint transcript bootstrap did not finish after reopening")
  }

  try {
    const initial = await launch()
    const threadId = await initial.evaluate(
      async ({ port, workspace, modelId, title }) => {
        const api = (window as unknown as FixtureWindow).api
        await api.models.setCustomConfig({
          id: "goal-transcript-restart",
          name: "Goal transcript restart",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "deepseek-goal-transcript-restart",
          apiKey: "fixture-local",
          maxTokens: 64000,
          maxOutputTokens: 4096
        })
        await api.models.setDefault(modelId)
        await api.models.setGoalSettings({ evaluatorModelId: modelId })
        await api.routing.setMode("pinned")
        await api.sandbox.setMode("none")
        await api.sandbox.setYoloMode(true)
        await api.hooks.create({
          event: "Stop",
          type: "http",
          url: `http://127.0.0.1:${port}/stop-hook`,
          enabled: true
        })
        const thread = await api.threads.create({
          title,
          workspacePath: workspace,
          model: modelId,
          agentMode: "normal"
        })
        await api.workspace.set(thread.thread_id, workspace)
        return thread.thread_id
      },
      { port, workspace, modelId, title }
    )
    await initial.reload({ waitUntil: "domcontentloaded" })
    const composer = await openThread(initial, threadId)
    // The stream holder mounts after the new thread's initial hydration.
    await initial.waitForTimeout(1_000)
    await composer.fill(
      "/goal Read first.txt and second.txt in order, then report both. Do not modify files."
    )
    await composer.locator("xpath=ancestor::form").locator('button[type="submit"]').last().click()
    await initial.getByText("second verified", { exact: true }).last().waitFor({ timeout: 120_000 })
    await initial
      .getByRole("button", { name: "停止生成", exact: true })
      .waitFor({ state: "hidden" })
    assert.equal(
      await initial.evaluate(
        async (id) =>
          (await (window as unknown as FixtureWindow).api.threads.getGoalState(id)).goal?.status,
        threadId
      ),
      "complete"
    )
    await assertTranscript(initial, threadId, "live-complete")
    await app!.close()
    app = undefined

    // A legacy resume can have a saved event even if its visible user row was never written.
    const database = new DatabaseSync(path.join(output, "profile", "cmbcoworkagent.sqlite"))
    try {
      const goal = database
        .prepare("SELECT goal_id FROM thread_goals WHERE thread_id = ?")
        .get(threadId) as { goal_id: string } | undefined
      assert.ok(goal)
      database
        .prepare(
          "INSERT INTO thread_goal_events (thread_id, goal_id, active_window_id, message, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          threadId,
          goal.goal_id,
          "fixture-missing-window",
          `${GOAL_USER_MESSAGE_EVENT_PREFIX}/goal resume`,
          Date.now()
        )
    } finally {
      database.close()
    }

    const reopened = await launch()
    await openThread(reopened, threadId)
    await waitForCheckpointBootstrap(reopened, threadId)
    await assertTranscript(reopened, threadId, "cold-reopen")
    const chat = reopened.locator(`[data-chat-thread-id="${threadId}"]`)
    await chat.getByText("继续 Goal", { exact: true }).waitFor()
    const orderedRows = await chat.locator("[data-chat-message-row]").allInnerTexts()
    const lastAnswer = orderedRows.findIndex((row) => row.includes("second verified"))
    const resume = orderedRows.findIndex((row) => row.includes("继续 Goal"))
    assert.ok(lastAnswer >= 0 && resume > lastAnswer, "the unanchored resume stays after the Goal")
    assert.equal(executions, expectedAssistantText.length)
    assert.equal(evaluations, 2)
    assert.equal(revisionsRequested, 1)
    assert.deepEqual(
      seenEvidence,
      [true, true],
      "every real tool cycle reached the next model call"
    )
    assert.deepEqual(serverErrors, [])
    assert.deepEqual(pageErrors, [])
    console.log(
      "PASS Goal continuation and Stop revision, repeated IDs, cold order and tool status"
    )
  } catch (error) {
    await page?.screenshot({ path: path.join(output, "failure.png") }).catch(() => undefined)
    console.error({
      output,
      executions,
      evaluations,
      revisionsRequested,
      seenEvidence,
      serverErrors,
      pageErrors
    })
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
