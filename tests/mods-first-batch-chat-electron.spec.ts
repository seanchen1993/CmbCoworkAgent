/** Normal Electron build: ordinary chat while optional Mods are off or have no selection. */
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ElectronApplication, Page } from "playwright"
import { ProjectCompositionStore } from "../src/main/harness-board/project-runtime/composition-store"
import {
  assertCreatorLiveCandidate,
  createHeadlessProjectCompositionLaunch,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

const root = resolve(__dirname, "..")
const candidate = assertCreatorLiveCandidate(root)
assert.equal(candidate.execution, "built-output")
const fixture = projectCompositionEnvironment(root)
const unrelatedWriter = process.argv.includes("--unrelated-writer")
const legacyRestore = process.argv.includes("--legacy-restore")
const checks: string[] = []
const pageErrors: string[] = []
const modelErrors: string[] = []
const requests: string[] = []
let stoppingRequestClosed = false
let app: ElectronApplication | undefined
let page: Page | undefined

const promptTexts = {
  first: "local ordinary chat first turn",
  stop: "local ordinary chat stop this turn",
  next: "local ordinary chat continue after stop",
  enabled: "local ordinary chat with no selected Mod"
} as const
type Turn = keyof typeof promptTexts

const server = createServer((request, response) => {
  void (async () => {
    let text = ""
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text) as { messages: Array<{ role: string; content: unknown }> }
    const latest = [...body.messages].reverse().find((message) => message.role === "user")
    assert(latest)
    const turn = (Object.keys(promptTexts) as Turn[]).find((key) =>
      JSON.stringify(latest.content).includes(promptTexts[key])
    )
    assert(turn, "The most recent user message must belong to this isolated fixture")
    requests.push(turn)
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" })
    const send = (delta: object, finishReason: string | null = null) => {
      const event = {
        id: `chat-first-batch-${turn}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "first-batch-chat",
        choices: [{ index: 0, delta, finish_reason: finishReason }]
      }
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    send({ role: "assistant", content: `FIRST_BATCH_${turn.toUpperCase()}_BODY` })
    if (turn === "stop") {
      response.once("close", () => {
        stoppingRequestClosed = true
      })
      return
    }
    send({}, "stop")
    response.end("data: [DONE]\n\n")
  })().catch((error) => {
    modelErrors.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end()
  })
})

async function open(recordHistoryReads = false) {
  app = await createHeadlessProjectCompositionLaunch(root, fixture, {
    unobtrusivePresentation: true
  })()
  for (const [name, stream] of [
    ["stdout", app.process().stdout],
    ["stderr", app.process().stderr]
  ] as const) {
    stream?.on("data", (bytes) => appendFileSync(join(fixture.isolated, `main.${name}.log`), bytes))
  }
  const currentPage = await app.firstWindow({ timeout: 60000 })
  if (recordHistoryReads) {
    await app.evaluate(({ ipcMain }) => {
      type Handler = (...args: unknown[]) => unknown
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
        ._invokeHandlers
      const channel = "mods:function-site-read"
      const read = handlers.get(channel)
      if (!read) throw Error("Missing FunctionSite reader")
      const historyReads: string[] = []
      Object.assign(globalThis, { firstBatchHistoryReads: historyReads })
      handlers.set(channel, (...args) => {
        const input = args[1] as { component?: string; threadId?: string }
        if (
          input.threadId &&
          (input.component === "UserMessage" || input.component === "AssistantMessage")
        )
          historyReads.push(input.threadId)
        return read(...args)
      })
    })
  }
  page = currentPage
  currentPage.setDefaultTimeout(20000)
  currentPage.on("pageerror", (error) => pageErrors.push(error.message))
  await currentPage.addLocatorHandler(
    currentPage.getByRole("dialog", { name: "把助手变成适合你的工作台" }),
    async (intro) => {
      await intro.getByRole("button", { name: "先自己试试", exact: true }).click()
    }
  )
  await currentPage.addLocatorHandler(
    currentPage.locator('[aria-label="插件创作使用指引"], [aria-label="应用使用指引"]').first(),
    async (guide) => {
      await guide.getByRole("button", { name: "跳过指引", exact: true }).click()
    }
  )
  await currentPage.waitForFunction(() => Boolean(window.api?.agent && window.api?.mods))
  await currentPage.evaluate("window.__name = value => value")
  return currentPage
}

function holdUnrelatedCompositionWriter() {
  const workspace = join(fixture.isolated, "composition-A")
  mkdirSync(workspace)
  const database = join(fixture.env.CMB_COWORK_AGENT_HOME, "project-compositions", "state.sqlite")
  const store = new ProjectCompositionStore(database)
  try {
    store.create(
      {
        apiVersion: "devclaw.project-composition/v1",
        parentProjectId: "unrelated-A",
        workspace,
        units: [
          {
            id: "fixture-only",
            kind: "flow",
            inputs: [],
            outputs: [],
            source: { pluginId: "isolated", capabilityId: "fixture", packageDigest: "a".repeat(64) }
          }
        ]
      },
      "unrelated-writer"
    )
  } finally {
    store.close()
  }
  const writer = new DatabaseSync(database, { timeout: 0 })
  try {
    writer.exec("BEGIN IMMEDIATE")
    writer
      .prepare("UPDATE composition_runs SET version=version WHERE project_id=?")
      .run("unrelated-A")
    return writer
  } catch (error) {
    writer.close()
    throw error
  }
}

const legacyThreadId = "first-batch-legacy-chat"
const legacyTitle = "First-batch checkpoint-only chat"
const legacyReply = "restored quartz transcript"

function seedCheckpointOnlyChat() {
  const home = fixture.env.CMB_COWORK_AGENT_HOME
  const created = Date.now()
  const metadata = JSON.stringify({
    title: legacyTitle,
    workspacePath: fixture.workspace,
    agentMode: "normal"
  })
  const messages = new DatabaseSync(join(home, "cmbcoworkagent.sqlite"))
  try {
    messages
      .prepare(
        `INSERT INTO threads
      (thread_id,created_at,updated_at,metadata,status,title) VALUES (?,?,?,?,'idle',?)`
      )
      .run(legacyThreadId, created, created, metadata, legacyTitle)
  } finally {
    messages.close()
  }
  const directory = join(home, "threads")
  mkdirSync(directory, { recursive: true })
  const checkpoints = new DatabaseSync(join(directory, `${legacyThreadId}.sqlite`))
  try {
    checkpoints.exec(`CREATE TABLE checkpoints (thread_id TEXT, checkpoint_ns TEXT,
      checkpoint_id TEXT, parent_checkpoint_id TEXT, type TEXT, checkpoint TEXT, metadata TEXT,
      checkpoint_ts TEXT, PRIMARY KEY (thread_id,checkpoint_ns,checkpoint_id))`)
    const checkpoint = {
      id: "legacy-conversation",
      v: 1,
      ts: new Date(created).toISOString(),
      channel_versions: {},
      versions_seen: {},
      pending_sends: [],
      channel_values: {
        messages: [
          { id: "legacy-question", type: "human", content: "old checkpoint question" },
          { id: "legacy-answer", type: "ai", content: legacyReply }
        ]
      }
    }
    checkpoints
      .prepare(`INSERT INTO checkpoints VALUES (?,'',?,NULL,'json',?,?,?)`)
      .run(
        legacyThreadId,
        checkpoint.id,
        JSON.stringify(checkpoint),
        JSON.stringify({ source: "loop", step: 1, writes: null, parents: {} }),
        checkpoint.ts
      )
  } finally {
    checkpoints.close()
  }
}

async function main() {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const firstTitle = "First-batch original chat"
  const nextTitle = "First-batch other chat"
  let passed = false
  try {
    let currentPage = await open()
    const ids = await currentPage.evaluate(
      async ({ workspace, baseUrl, firstTitle, nextTitle }) => {
        const api = window.api
        await api.autoCommit.saveSettings({ mode: "off", push: false })
        await api.models.setCustomConfig({
          id: "first-batch-chat",
          name: "Local ordinary chat fixture",
          baseUrl,
          model: "first-batch-chat",
          apiKey: "isolated-loopback-only",
          maxTokens: 64000,
          maxOutputTokens: 2048
        })
        await api.models.setDefault("custom:first-batch-chat")
        await api.routing.setMode("pinned")
        if (await api.mods.globalEnabled()) throw Error("Expected default-disabled optional Mods")
        const ids: string[] = []
        for (const title of [firstTitle, nextTitle]) {
          const thread = await api.threads.create({
            title,
            workspacePath: workspace,
            agentMode: "normal"
          })
          await api.workspace.set(thread.thread_id, workspace)
          await api.threads.patchMetadata(thread.thread_id, {
            set: { model: "custom:first-batch-chat" }
          })
          ids.push(thread.thread_id)
        }
        return ids
      },
      { workspace: fixture.workspace, baseUrl, firstTitle, nextTitle }
    )
    await currentPage.reload({ waitUntil: "domcontentloaded" })
    await currentPage.evaluate("window.__name = value => value")
    const send = async (turn: Turn, threadId: string) => {
      const chat = currentPage.locator(`[data-chat-thread-id="${threadId}"]`)
      const composer = chat.locator("textarea.composer-textarea")
      await composer.fill(promptTexts[turn])
      await chat.getByRole("button", { name: "发送消息", exact: true }).click()
      await chat.getByText(`FIRST_BATCH_${turn.toUpperCase()}_BODY`, { exact: true }).waitFor()
      const stop = chat.getByRole("button", { name: "停止生成", exact: true })
      if (turn === "stop") await stop.click()
      await stop.waitFor({ state: "hidden" })
    }
    await currentPage.getByText(firstTitle, { exact: true }).first().click()
    await send("first", ids[0])
    await send("stop", ids[0])
    await send("next", ids[0])
    assert(stoppingRequestClosed, "Clicking Stop must close the actual in-flight model request")
    checks.push("Mods off: ordinary send, SSE, stop and a subsequent turn through the original UI")
    await currentPage.evaluate(async (threadId) => {
      const mods = window.api.mods
      await mods.configureGlobal(true)
      const status = await mods.status(threadId)
      await mods.configure(threadId, true, false, status.workspace)
    }, ids[1])
    await currentPage.getByText(nextTitle, { exact: true }).first().click()
    const writer = unrelatedWriter ? holdUnrelatedCompositionWriter() : undefined
    try {
      await send("enabled", ids[1])
      if (writer) {
        checks.push(
          "Workspace B sends and receives a live reply while workspace A holds a SQLite write transaction"
        )
      }
    } finally {
      // Closing an in-flight SQLite transaction rolls back the test writer.
      writer?.close()
    }
    checks.push("Mods on with no selection: ordinary composer still reaches the real provider")
    await app!.close()
    app = undefined
    if (legacyRestore) seedCheckpointOnlyChat()
    currentPage = await open(true)
    assert.deepEqual(
      await currentPage.evaluate(async (threadId) => {
        const mods = window.api.mods
        const status = await mods.status(threadId)
        return mods.chatPresentationCapability!(threadId, status.workspace)
      }, ids[0]),
      { enabled: true, nativeHistory: true }
    )
    await currentPage.getByText(firstTitle, { exact: true }).first().click()
    await currentPage.getByText("FIRST_BATCH_NEXT_BODY", { exact: true }).waitFor()
    await currentPage.getByText(nextTitle, { exact: true }).first().click()
    await currentPage.getByText("FIRST_BATCH_ENABLED_BODY", { exact: true }).waitFor()
    if (legacyRestore) {
      const openLegacy = async () => {
        await currentPage.getByText(legacyTitle, { exact: true }).first().click()
        const legacyChat = currentPage.locator(`[data-chat-thread-id="${legacyThreadId}"]`)
        const reply = legacyChat.getByText(legacyReply, { exact: true })
        await reply.waitFor()
        assert.equal(await reply.count(), 1)
      }
      await openLegacy()
      await currentPage.getByText(nextTitle, { exact: true }).first().click()
      await openLegacy()
      const result = await currentPage.evaluate(
        async ({ query, threadId }) => {
          const threads = window.api.threads
          let search = await threads.searchStart({ query })
          for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
            const match = search.results.find(
              (result) =>
                result.threadId === threadId &&
                result.navigation === "exact" &&
                result.snippet.includes(query)
            )
            if (match?.target?.kind === "durableMessage") {
              const { messageId } = match.target
              if (!(await threads.searchSummary(match))) return false
              const result = await threads.searchTargetWindow(match)
              if (result.status === "resolved")
                return result.page.messages.some((message) => message.id === messageId)
            }
            if (!search.nextCursor) return false
            search = await threads.searchContinue(search.nextCursor)
          }
          return false
        },
        { query: legacyReply, threadId: legacyThreadId }
      )
      assert(result, "Search must reopen the exact durable message migrated from the checkpoint")
      checks.push(
        "Checkpoint-only chat restores on first open, survives switching and has an exact search result"
      )
    }
    const historyReads = await app!.evaluate(() =>
      Reflect.get(globalThis, "firstBatchHistoryReads")
    )
    if (legacyRestore) {
      const errorLog = join(fixture.isolated, "main.stderr.log")
      const mainErrors = existsSync(errorLog) ? readFileSync(errorLog, "utf8") : ""
      assert(
        !mainErrors.includes("MODS_CONVERSATION_MIGRATION_REQUIRED"),
        "An unset native channel must not mark an ordinary checkpoint as protected history"
      )
    }
    assert.deepEqual(
      historyReads,
      [],
      "Restarted unprotected ordinary history must avoid per-row site reads"
    )
    checks.push("Restart and conversation switching retain persisted history in both conversations")
    checks.push(
      "Unprotected history without an enabled source renders with zero per-row site reads"
    )
    assert.deepEqual(requests, ["first", "stop", "next", "enabled"])
    assert.deepEqual(modelErrors, [])
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(assertCreatorLiveCandidate(root), candidate)
    passed = true
  } catch (error) {
    await page
      ?.screenshot({ path: join(fixture.isolated, "failure.png"), timeout: 5000 })
      .catch(() => {})
    throw error
  } finally {
    await app?.close()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    const artifact = join(fixture.isolated, "ordinary-chat-result.json")
    writeFileSync(
      artifact,
      JSON.stringify(
        {
          passed,
          candidate,
          unrelatedWriter,
          legacyRestore,
          checks,
          requests,
          stoppingRequestClosed,
          modelErrors,
          pageErrors
        },
        null,
        2
      ) + "\n"
    )
    console.log(artifact)
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
