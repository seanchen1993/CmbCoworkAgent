/**
 * Real Electron E2E for bounded recovery of a broken local checkpoint message chain.
 *
 * The fixture mirrors the user-visible failure mode: a long durable transcript is intact,
 * the latest checkpoint points to a missing ancestor snapshot, and an ordinary message is
 * sent after reopening the task. The test proves that the normal UI -> preload -> IPC ->
 * Worker -> SQLite -> LangGraph path repairs the latest checkpoint before the model runs.
 *
 * Run through the safe build-and-test entry point:
 *   npm run test:session-recovery:e2e
 *
 * Set CMB_SESSION_RECOVERY_E2E_ITERATIONS=3 for a repeated stress run.
 * The runner rebuilds with remote reporters disabled, then uses Electron's bundled
 * Node runtime so node:sqlite works even when npm itself runs under Node 20.
 */

import { randomUUID } from "node:crypto"
import { execFile, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync } from "node:fs"
import { rm as rmAsync } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import type { BaseMessage } from "@langchain/core/messages"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import { _electron as electron, type ElectronApplication, type Page } from "playwright"

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const ELECTRON_BINARY = require("electron") as string
const ELECTRON_LAUNCHER =
  process.platform === "win32"
    ? join(PROJECT_ROOT, "tests", "support", "electron-launcher.cmd")
    : ELECTRON_BINARY
const MAIN_ENTRY = join(PROJECT_ROOT, "out", "main", "index.js")
const MODEL_CONFIG_ID = "session-recovery-e2e"
const MODEL_REF = `custom:${MODEL_CONFIG_ID}`
const MODEL_NAME = "session-recovery-test-model"
const TARGET_ERROR_CODE = "LOCAL_CHECKPOINT_MESSAGE_RECOVERY_FAILED"
const TARGET_ERROR_TEXT = "本地会话消息索引不完整，自动恢复失败"
const HISTORY_MESSAGE_COUNT = 1_002
const RECOVERED_TAIL_COUNT = 1_000
const DEFAULT_ITERATIONS = 1
const execFileAsync = promisify(execFile)

interface WindowWithApi {
  api: {
    models: {
      setCustomConfig: (config: {
        id: string
        name: string
        baseUrl: string
        model: string
        apiKey?: string
        maxTokens?: number
        maxOutputTokens?: number
      }) => Promise<void>
      setDefault: (modelId: string) => Promise<void>
    }
    routing: {
      setMode: (mode: "auto" | "pinned") => Promise<void>
    }
  }
}

interface SnapshotState {
  parent_checkpoint_id: string | null
  prefix_length: number
  message_count: number
  suffix_bytes: number
}

interface RecoveryFixture {
  index: number
  key: string
  threadId: string
  title: string
  checkpointPath: string
  baseCheckpointId: string
  latestCheckpointId: string
  historyPrefix: string
  originalMessageIds: string[]
  firstPrompt: string
  firstReply: string
  secondPrompt: string
  secondReply: string
}

interface ModelRequestRecord {
  body: Record<string, unknown>
  receivedAt: number
  fixture?: RecoveryFixture
  phase: "first" | "second" | "unknown"
  snapshot?: SnapshotState | null
}

interface ModelServerHandle {
  baseUrl: string
  requests: ModelRequestRecord[]
  errors: string[]
  close: () => Promise<void>
}

interface TimingResult {
  threadOpenMs: number
  firstModelRequestMs: number
  firstReplyMs: number
  secondReplyMs: number
  nextSendGapMs: number
}

interface ConversationMessage {
  role: string
  content: string
}

function log(message: string): void {
  console.log(`[session-recovery-e2e ${new Date().toISOString().slice(11, 19)}] ${message}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
  log(`PASS ${message}`)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizeIterationCount(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? String(DEFAULT_ITERATIONS), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_ITERATIONS
  return Math.min(5, Math.max(1, parsed))
}

function checkpointConfig(
  threadId: string,
  checkpointId?: string
): {
  configurable: { thread_id: string; checkpoint_ns: string; checkpoint_id?: string }
} {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: "",
      ...(checkpointId ? { checkpoint_id: checkpointId } : {})
    }
  }
}

function createCheckpoint(
  id: string,
  ts: string,
  order: number,
  messages: BaseMessage[]
): Checkpoint {
  return {
    v: 1,
    id,
    ts,
    channel_values: {
      messages,
      todos: []
    },
    channel_versions: { messages: order },
    versions_seen: {},
    pending_sends: []
  } as Checkpoint
}

const CHECKPOINT_METADATA = {
  source: "loop",
  step: 1,
  writes: {},
  parents: {}
} as CheckpointMetadata

const COMPLETED_CHECKPOINT_METADATA = {
  ...CHECKPOINT_METADATA,
  cmb_fork_boundary: {
    source: "agent_run_complete",
    outcome: "completed",
    markedAt: new Date().toISOString()
  }
} as CheckpointMetadata

function readSnapshot(
  checkpointPath: string,
  threadId: string,
  checkpointId: string
): SnapshotState | null {
  const database = new DatabaseSync(checkpointPath, { readOnly: true })
  try {
    const row = database
      .prepare(
        `SELECT parent_checkpoint_id, prefix_length, message_count,
                LENGTH(suffix) AS suffix_bytes
         FROM checkpoint_message_snapshots
         WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
      )
      .get(threadId, checkpointId) as SnapshotState | undefined
    return row ?? null
  } finally {
    database.close()
  }
}

async function seedRecoveryFixtures(
  openworkHome: string,
  workspace: string,
  iterations: number
): Promise<{ fixtures: RecoveryFixture[]; mainDatabasePath: string }> {
  process.env.CMB_COWORK_AGENT_HOME = openworkHome
  const db = await import("../src/main/db/index.ts")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  const { getDbPath, getThreadCheckpointPath } = await import("../src/main/storage.ts")
  const { AIMessage, HumanMessage } = await import("@langchain/core/messages")

  const fixtures: RecoveryFixture[] = []
  let databaseInitializationAttempted = false
  try {
    databaseInitializationAttempted = true
    await db.initializeDatabase()
    for (let index = 0; index < iterations; index += 1) {
      const key = `${process.pid}-${Date.now()}-${index}-${randomUUID().slice(0, 8)}`
      const threadId = `session-recovery-e2e-${key}`
      const title = `本地会话恢复 E2E ${key}`
      const historyPrefix = `history-${key}-`
      const firstPrompt = `E2E_RECOVERY_FIRST_${key}`
      const firstReply = `E2E_RECOVERY_REPLY_1_${key}`
      const secondPrompt = `E2E_RECOVERY_SECOND_${key}`
      const secondReply = `E2E_RECOVERY_REPLY_2_${key}`
      const baseCheckpointId = `cp-base-${key}`
      const latestCheckpointId = `cp-latest-${key}`
      const checkpointPath = getThreadCheckpointPath(threadId)
      const baseTime = Date.now() - 120_000 + index * 10_000
      const durableMessages = Array.from({ length: HISTORY_MESSAGE_COUNT }, (_, messageIndex) => {
        const paddedIndex = String(messageIndex).padStart(4, "0")
        return {
          id: `hist-${key}-${paddedIndex}`,
          role: messageIndex % 2 === 0 ? ("user" as const) : ("assistant" as const),
          content: `${historyPrefix}${paddedIndex}`,
          created_at: new Date(baseTime + messageIndex)
        }
      })

      db.createThread(threadId, {
        workspacePath: workspace,
        model: MODEL_REF,
        agentMode: "normal",
        title
      })
      const changed = db.upsertThreadMessages(threadId, durableMessages, {
        preserveExistingOrder: true
      })
      assert(changed === HISTORY_MESSAGE_COUNT, `第 ${index + 1} 组写入 1002 条 durable 消息`)

      const runtimeMessages = durableMessages.map((message) =>
        message.role === "user"
          ? new HumanMessage({ id: message.id, content: message.content })
          : new AIMessage({ id: message.id, content: message.content })
      )
      const saver = new SqlJsSaver(checkpointPath, undefined, {
        maxRootCheckpoints: 1,
        maxRootForkBoundaryCheckpoints: 0
      })
      try {
        await saver.put(
          checkpointConfig(threadId),
          createCheckpoint(
            baseCheckpointId,
            new Date(baseTime + HISTORY_MESSAGE_COUNT + 1_000).toISOString(),
            1,
            runtimeMessages.slice(0, RECOVERED_TAIL_COUNT)
          ),
          CHECKPOINT_METADATA
        )
        await saver.put(
          checkpointConfig(threadId, baseCheckpointId),
          createCheckpoint(
            latestCheckpointId,
            new Date(baseTime + HISTORY_MESSAGE_COUNT + 2_000).toISOString(),
            2,
            runtimeMessages
          ),
          COMPLETED_CHECKPOINT_METADATA
        )
      } finally {
        await saver.close()
      }

      // A current task has already completed the one-time legacy transcript
      // migration. Publishing that marker keeps renderer hydration on the
      // ordinary durable-page path instead of asking the legacy bootstrapper to
      // traverse the deliberately broken snapshot chain before the invoke.
      db.getDb().run(
        `INSERT INTO legacy_checkpoint_transcript_migrations (
           thread_id, checkpoint_id, total_messages, next_index,
           current_fragment_index, status, updated_at
         ) VALUES (?, ?, ?, ?, 0, 'complete', ?)`,
        [threadId, latestCheckpointId, HISTORY_MESSAGE_COUNT, HISTORY_MESSAGE_COUNT, Date.now()]
      )

      const raw = new DatabaseSync(checkpointPath)
      try {
        const checkpointRows = raw
          .prepare(
            `SELECT checkpoint_id FROM checkpoints
             WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id`
          )
          .all(threadId) as Array<{ checkpoint_id: string }>
        const snapshotRows = raw
          .prepare(
            `SELECT checkpoint_id, parent_checkpoint_id, prefix_length, message_count,
                    LENGTH(suffix) AS suffix_bytes
             FROM checkpoint_message_snapshots
             WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id`
          )
          .all(threadId) as Array<SnapshotState & { checkpoint_id: string }>
        assert(
          checkpointRows.length === 1 && checkpointRows[0]?.checkpoint_id === latestCheckpointId,
          `第 ${index + 1} 组只保留最新 checkpoint 行`
        )
        assert(snapshotRows.length === 2, `第 ${index + 1} 组原始快照链包含 base 和 delta`)
        const latestSnapshot = snapshotRows.find(
          (snapshot) => snapshot.checkpoint_id === latestCheckpointId
        )
        assert(
          latestSnapshot?.parent_checkpoint_id === baseCheckpointId &&
            Number(latestSnapshot.prefix_length) === RECOVERED_TAIL_COUNT &&
            Number(latestSnapshot.message_count) === HISTORY_MESSAGE_COUNT,
          `第 ${index + 1} 组 latest 是指向 base 的 1002 条 delta 快照`
        )
        const deletion = raw
          .prepare(
            `DELETE FROM checkpoint_message_snapshots
             WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ?`
          )
          .run(threadId, baseCheckpointId)
        assert(deletion.changes === 1, `第 ${index + 1} 组只删除祖先快照`)
      } finally {
        raw.close()
      }

      const exactReader = new SqlJsSaver(checkpointPath)
      let exactFailure: unknown
      try {
        // The broken fixture must fail before yielding its first tuple.
        await exactReader.list(checkpointConfig(threadId), { limit: 1 }).next()
      } catch (error) {
        exactFailure = error
      } finally {
        await exactReader.close()
      }
      assert(
        (exactFailure as { code?: unknown } | undefined)?.code === TARGET_ERROR_CODE,
        `第 ${index + 1} 组故障注入可稳定触发旧的恢复错误`
      )

      fixtures.push({
        index,
        key,
        threadId,
        title,
        checkpointPath,
        baseCheckpointId,
        latestCheckpointId,
        historyPrefix,
        originalMessageIds: durableMessages.map((message) => message.id),
        firstPrompt,
        firstReply,
        secondPrompt,
        secondReply
      })
    }
    await db.flushStrict()
  } finally {
    if (databaseInitializationAttempted) await db.closeDatabase()
  }

  return { fixtures, mainDatabasePath: getDbPath() }
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

function messageContentText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const record = part as Record<string, unknown>
      return typeof record.text === "string" ? record.text : ""
    })
    .join("")
}

function requestMessageTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.messages)) return []
  return body.messages.map((message) => {
    if (!message || typeof message !== "object") return ""
    return messageContentText((message as Record<string, unknown>).content)
  })
}

function requestConversationMessages(body: Record<string, unknown>): ConversationMessage[] {
  if (!Array.isArray(body.messages)) return []
  return body.messages.map((message) => {
    if (!message || typeof message !== "object") return { role: "", content: "" }
    const record = message as Record<string, unknown>
    return {
      role: typeof record.role === "string" ? record.role : "",
      content: messageContentText(record.content)
    }
  })
}

function expectedRecoveredHistory(fixture: RecoveryFixture): ConversationMessage[] {
  return Array.from({ length: RECOVERED_TAIL_COUNT }, (_, index) => {
    const originalIndex = index + 2
    return {
      role: originalIndex % 2 === 0 ? "user" : "assistant",
      content: `${fixture.historyPrefix}${String(originalIndex).padStart(4, "0")}`
    }
  })
}

function nonPromptMessages(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter((message) => message.role !== "system" && message.role !== "developer")
}

function baseMessageRole(message: BaseMessage): string {
  const kind = (message as BaseMessage & { _getType: () => string })._getType()
  if (kind === "human") return "user"
  if (kind === "ai") return "assistant"
  return kind
}

function countOccurrences(value: string, token: string): number {
  return value.split(token).length - 1
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" })
  response.end(JSON.stringify(payload))
}

function sendCompletion(response: ServerResponse, requestNumber: number, reply: string): void {
  const common = {
    id: `session-recovery-reply-${requestNumber}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: MODEL_NAME
  }
  // The app requests `stream_options.include_usage`. Include the terminal
  // usage-only chunk as a real OpenAI-compatible server would, so downstream
  // accounting and stream finalization are covered too.
  const events = [
    {
      ...common,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: reply },
          finish_reason: null
        }
      ]
    },
    {
      ...common,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    },
    {
      ...common,
      choices: [],
      usage: { prompt_tokens: 1_000, completion_tokens: 1, total_tokens: 1_001 }
    }
  ]
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close"
  })
  response.end(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
  )
}

async function startModelServer(fixtures: RecoveryFixture[]): Promise<ModelServerHandle> {
  const requests: ModelRequestRecord[] = []
  const errors: string[] = []
  const server: Server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        sendJson(response, 200, {
          object: "list",
          data: [{ id: MODEL_NAME, object: "model", owned_by: "e2e" }]
        })
        return
      }
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
        sendJson(response, 404, {
          error: { message: `Unexpected route ${request.method} ${request.url}` }
        })
        return
      }

      const body = await readRequestBody(request)
      const texts = requestMessageTexts(body)
      const fixture = fixtures.find(
        (candidate) =>
          texts.includes(candidate.firstPrompt) || texts.includes(candidate.secondPrompt)
      )
      const phase = fixture
        ? texts.includes(fixture.secondPrompt)
          ? "second"
          : "first"
        : "unknown"
      const record: ModelRequestRecord = {
        body,
        receivedAt: Date.now(),
        fixture,
        phase
      }
      requests.push(record)
      log(
        `模型请求 ${requests.length}: ${fixture ? `第 ${fixture.index + 1} 组 ${phase}` : "unknown"}`
      )

      if (fixture && phase === "first") {
        try {
          record.snapshot = readSnapshot(
            fixture.checkpointPath,
            fixture.threadId,
            fixture.latestCheckpointId
          )
        } catch (error) {
          errors.push(`读取第 ${fixture.index + 1} 组修复快照失败: ${String(error)}`)
        }
      }

      const reply =
        fixture && phase === "first"
          ? fixture.firstReply
          : fixture && phase === "second"
            ? fixture.secondReply
            : "E2E_UNEXPECTED_MODEL_REQUEST"
      sendCompletion(response, requests.length, reply)
    })().catch((error) => {
      errors.push(String(error instanceof Error ? error.stack || error.message : error))
      if (!response.headersSent) sendJson(response, 500, { error: { message: String(error) } })
      else response.end()
    })
  })

  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    errors,
    close: async () => {
      const closePromise = new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      })
      server.closeAllConnections()
      await withTimeout(closePromise, 5_000, "model server close")
    }
  }
}

async function waitForAppPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const candidate of app.windows().reverse()) {
      if (candidate.isClosed()) continue
      const hasApi = await candidate
        .evaluate(() => Boolean((window as unknown as Partial<WindowWithApi>).api))
        .catch(() => false)
      if (hasApi) return candidate
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
  throw new Error("No Electron renderer with preload API appeared within 30 seconds")
}

async function assertNoMmjCdnScript(page: Page, stage: string): Promise<void> {
  const injectedScriptCount = await page.locator("script[data-mmj-cdn]").count()
  assert(injectedScriptCount === 0, `${stage} 未加载真实 MMJ CDN 脚本`)
}

async function configureModel(page: Page, baseUrl: string): Promise<void> {
  await page.evaluate<
    void,
    { baseUrl: string; configId: string; modelName: string; modelRef: string }
  >(
    async ({ baseUrl, configId, modelName, modelRef }) => {
      const api = (window as unknown as WindowWithApi).api
      await api.models.setCustomConfig({
        id: configId,
        name: "本地会话恢复 E2E 模型",
        baseUrl,
        model: modelName,
        apiKey: "session-recovery-e2e-key",
        maxTokens: 256_000,
        maxOutputTokens: 1_024
      })
      await api.models.setDefault(modelRef)
      await api.routing.setMode("pinned")
    },
    { baseUrl, configId: MODEL_CONFIG_ID, modelName: MODEL_NAME, modelRef: MODEL_REF }
  )
}

async function waitForComposerReady(page: Page): Promise<void> {
  const composer = page.locator(".composer-textarea")
  await composer.waitFor({ state: "visible", timeout: 30_000 })
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLTextAreaElement>(".composer-textarea")
    return Boolean(element && !element.disabled)
  })
}

async function assertNoVisibleRecoveryError(page: Page, stage: string): Promise<void> {
  const bodyText = await page.locator("body").innerText()
  assert(!bodyText.includes(TARGET_ERROR_CODE), `${stage} 界面未出现恢复错误码`)
  assert(!bodyText.includes(TARGET_ERROR_TEXT), `${stage} 界面未出现恢复错误文案`)
}

async function sendMessageThroughUi(
  page: Page,
  prompt: string,
  expectedReply: string
): Promise<number> {
  await waitForComposerReady(page)
  const composer = page.locator(".composer-textarea")
  const startedAt = Date.now()
  await composer.fill(prompt)
  const sendButton = composer
    .locator("xpath=ancestor::form")
    .locator('button[type="submit"]')
    .last()
  await sendButton.waitFor({ state: "visible", timeout: 10_000 })
  await page.waitForFunction(() => {
    const composerElement = document.querySelector<HTMLTextAreaElement>(".composer-textarea")
    const form = composerElement?.closest("form")
    const buttons = form
      ? Array.from(form.querySelectorAll<HTMLButtonElement>('button[type="submit"]'))
      : []
    return buttons.length > 0 && buttons.some((button) => !button.disabled)
  })
  await sendButton.click()
  await page.getByText(prompt, { exact: true }).last().waitFor({ timeout: 10_000 })
  await page.getByText(expectedReply, { exact: true }).last().waitFor({ timeout: 60_000 })
  await waitForComposerReady(page)
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLTextAreaElement>(".composer-textarea")
    return element?.value === ""
  })
  return Date.now() - startedAt
}

async function exerciseFixture(
  page: Page,
  fixture: RecoveryFixture,
  requests: ModelRequestRecord[]
): Promise<TimingResult> {
  const openedAt = Date.now()
  const threadEntry = page.getByText(fixture.title, { exact: true }).first()
  await threadEntry.waitFor({ timeout: 30_000 })
  await threadEntry.click()
  await waitForComposerReady(page)
  await page.getByText(`${fixture.historyPrefix}1001`, { exact: true }).last().waitFor({
    timeout: 30_000
  })
  const threadOpenMs = Date.now() - openedAt
  await assertNoVisibleRecoveryError(page, `第 ${fixture.index + 1} 组打开长会话后`)

  const firstSendStartedAt = Date.now()
  const firstReplyMs = await sendMessageThroughUi(page, fixture.firstPrompt, fixture.firstReply)
  await assertNoVisibleRecoveryError(page, `第 ${fixture.index + 1} 组首轮恢复后`)

  const firstRequest = [...requests]
    .reverse()
    .find((request) => request.fixture?.threadId === fixture.threadId && request.phase === "first")
  const readyForSecondAt = Date.now()
  const secondReplyMs = await sendMessageThroughUi(page, fixture.secondPrompt, fixture.secondReply)
  const secondRequest = [...requests]
    .reverse()
    .find((request) => request.fixture?.threadId === fixture.threadId && request.phase === "second")
  await assertNoVisibleRecoveryError(page, `第 ${fixture.index + 1} 组紧接发送第二轮后`)
  const visibleText = await page.locator("body").innerText()
  for (const expected of [
    fixture.firstPrompt,
    fixture.firstReply,
    fixture.secondPrompt,
    fixture.secondReply
  ]) {
    assert(
      countOccurrences(visibleText, expected) === 1,
      `第 ${fixture.index + 1} 组界面只显示一次 ${expected}`
    )
  }
  const visibleSequence = [
    fixture.firstPrompt,
    fixture.firstReply,
    fixture.secondPrompt,
    fixture.secondReply
  ].map((expected) => visibleText.indexOf(expected))
  assert(
    visibleSequence.every(
      (position, index) => index === 0 || position > visibleSequence[index - 1]
    ),
    `第 ${fixture.index + 1} 组界面按首问、首答、次问、次答顺序显示`
  )

  return {
    threadOpenMs,
    firstModelRequestMs: firstRequest
      ? Math.max(0, firstRequest.receivedAt - firstSendStartedAt)
      : Number.NaN,
    firstReplyMs,
    secondReplyMs,
    nextSendGapMs:
      firstRequest && secondRequest
        ? Math.max(0, secondRequest.receivedAt - readyForSecondAt)
        : Number.NaN
  }
}

function assertModelRequests(fixtures: RecoveryFixture[], requests: ModelRequestRecord[]): void {
  const unknownRequests = requests.filter((request) => request.phase === "unknown")
  assert(unknownRequests.length === 0, "模型服务未收到非预期请求")

  for (const fixture of fixtures) {
    const firstRequests = requests.filter(
      (request) => request.fixture?.threadId === fixture.threadId && request.phase === "first"
    )
    const secondRequests = requests.filter(
      (request) => request.fixture?.threadId === fixture.threadId && request.phase === "second"
    )
    assert(firstRequests.length === 1, `第 ${fixture.index + 1} 组首轮只请求模型一次`)
    assert(secondRequests.length === 1, `第 ${fixture.index + 1} 组第二轮只请求模型一次`)

    const firstRequest = firstRequests[0]
    assert(
      firstRequest.snapshot?.parent_checkpoint_id === null &&
        Number(firstRequest.snapshot.prefix_length) === 0 &&
        Number(firstRequest.snapshot.message_count) === RECOVERED_TAIL_COUNT,
      `第 ${fixture.index + 1} 组模型执行前 latest 已修复为 1000 条自包含快照`
    )
    assert(
      Number(firstRequest.snapshot?.suffix_bytes) > 0 &&
        Number(firstRequest.snapshot?.suffix_bytes) < 4 * 1024 * 1024,
      `第 ${fixture.index + 1} 组修复快照未超过 4 MiB 恢复预算`
    )

    const recoveredHistory = expectedRecoveredHistory(fixture)
    const firstConversation = nonPromptMessages(requestConversationMessages(firstRequest.body))
    assert(
      JSON.stringify(firstConversation) ===
        JSON.stringify([...recoveredHistory, { role: "user", content: fixture.firstPrompt }]),
      `第 ${fixture.index + 1} 组首轮模型上下文角色和内容逐条严格正确`
    )

    const secondConversation = nonPromptMessages(
      requestConversationMessages(secondRequests[0].body)
    )
    assert(
      JSON.stringify(secondConversation) ===
        JSON.stringify([
          ...recoveredHistory,
          { role: "user", content: fixture.firstPrompt },
          { role: "assistant", content: fixture.firstReply },
          { role: "user", content: fixture.secondPrompt }
        ]),
      `第 ${fixture.index + 1} 组第二轮模型上下文角色、内容和顺序逐条正确`
    )
  }
}

async function assertDurableMessagesAndCheckpoints(
  fixtures: RecoveryFixture[],
  mainDatabasePath: string
): Promise<void> {
  const expectedCheckpointRows = new Map<
    string,
    Array<{ messageId: string; role: string; content: unknown }>
  >()
  const mainDatabase = new DatabaseSync(mainDatabasePath, { readOnly: true })
  try {
    for (const fixture of fixtures) {
      const rows = mainDatabase
        .prepare(
          `SELECT message_id, role, content_json, ordinal
           FROM thread_messages WHERE thread_id = ? ORDER BY ordinal`
        )
        .all(fixture.threadId) as Array<{
        message_id: string
        role: string
        content_json: string
        ordinal: number
      }>
      const ids = new Set(rows.map((row) => row.message_id))
      assert(
        fixture.originalMessageIds.every((messageId) => ids.has(messageId)),
        `第 ${fixture.index + 1} 组原始 1002 条 durable 消息全部保留`
      )
      const contents = rows.map((row) => JSON.parse(row.content_json) as unknown)
      assert(
        fixture.originalMessageIds.every(
          (messageId, messageIndex) => rows[messageIndex]?.message_id === messageId
        ),
        `第 ${fixture.index + 1} 组原始 durable 消息顺序保持不变`
      )
      assert(
        rows.slice(0, HISTORY_MESSAGE_COUNT).every((row, messageIndex) => {
          const expectedRole = messageIndex % 2 === 0 ? "user" : "assistant"
          const expectedContent = `${fixture.historyPrefix}${String(messageIndex).padStart(4, "0")}`
          return row.role === expectedRole && contents[messageIndex] === expectedContent
        }),
        `第 ${fixture.index + 1} 组原始 durable 消息角色和内容逐条保持不变`
      )
      assert(
        rows.every((row, messageIndex) => Number(row.ordinal) === messageIndex),
        `第 ${fixture.index + 1} 组 durable ordinal 连续且无重排`
      )
      for (const expected of [
        fixture.firstPrompt,
        fixture.firstReply,
        fixture.secondPrompt,
        fixture.secondReply
      ]) {
        assert(
          contents.filter((content) => content === expected).length === 1,
          `第 ${fixture.index + 1} 组 ${expected} 只持久化一次`
        )
      }
      assert(
        rows.length === HISTORY_MESSAGE_COUNT + 4,
        `第 ${fixture.index + 1} 组最终消息数为 1006，无丢失或重复`
      )
      assert(
        JSON.stringify(contents.slice(-4)) ===
          JSON.stringify([
            fixture.firstPrompt,
            fixture.firstReply,
            fixture.secondPrompt,
            fixture.secondReply
          ]),
        `第 ${fixture.index + 1} 组两轮新消息顺序正确`
      )
      assert(
        JSON.stringify(rows.slice(-4).map((row) => row.role)) ===
          JSON.stringify(["user", "assistant", "user", "assistant"]),
        `第 ${fixture.index + 1} 组两轮新消息角色正确`
      )
      expectedCheckpointRows.set(
        fixture.threadId,
        rows.slice(2).map((row, rowIndex) => ({
          messageId: row.message_id,
          role: row.role,
          content: contents[rowIndex + 2]
        }))
      )
    }
  } finally {
    mainDatabase.close()
  }

  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver.ts")
  for (const fixture of fixtures) {
    const reader = new SqlJsSaver(fixture.checkpointPath)
    let latest: Checkpoint | undefined
    try {
      for await (const tuple of reader.list(checkpointConfig(fixture.threadId), { limit: 1 })) {
        latest = tuple.checkpoint
      }
    } finally {
      await reader.close()
    }
    const messages = latest?.channel_values.messages
    assert(
      Array.isArray(messages),
      `第 ${fixture.index + 1} 组应用重启所需的最新 checkpoint 可严格读取`
    )
    const expectedRows = expectedCheckpointRows.get(fixture.threadId)
    assert(expectedRows, `第 ${fixture.index + 1} 组已记录 durable 尾部基准`)
    const checkpointRows = messages.map((message) => {
      const record = message as BaseMessage
      return {
        messageId: record.id,
        role: baseMessageRole(record),
        content: messageContentText(record.content)
      }
    })
    assert(
      checkpointRows.length === RECOVERED_TAIL_COUNT + 4 &&
        checkpointRows.every(
          (row, rowIndex) =>
            row.messageId === expectedRows[rowIndex]?.messageId &&
            row.role === expectedRows[rowIndex]?.role &&
            row.content === expectedRows[rowIndex]?.content
        ),
      `第 ${fixture.index + 1} 组最新 checkpoint 的 1004 条 ID、角色、内容和顺序与 durable 尾部完全一致`
    )
  }
}

interface IsolatedPaths {
  isolatedHome: string
  appData: string
  localAppData: string
  openworkHome: string
  isolatedTemp: string
  xdgConfigHome: string
  xdgCacheHome: string
  xdgDataHome: string
}

function applyParentProcessIsolation(paths: IsolatedPaths): void {
  Object.assign(process.env, {
    HOME: paths.isolatedHome,
    USERPROFILE: paths.isolatedHome,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    CMB_COWORK_AGENT_HOME: paths.openworkHome,
    CMB_TASK_CARDS_MOCK: "1",
    TEMP: paths.isolatedTemp,
    TMP: paths.isolatedTemp,
    TMPDIR: paths.isolatedTemp,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    XDG_DATA_HOME: paths.xdgDataHome
  })
  for (const key of [
    "CMB_TASK_CARDS_ENDPOINT",
    "VITE_API_TRACE_BASE_URL",
    "VITE_ES_NODES",
    "VITE_ES_USERNAME",
    "VITE_ES_PASSWORD",
    "VITE_TASK_CARDS_ENDPOINT"
  ]) {
    delete process.env[key]
  }
}

function createElectronEnvironment(paths: IsolatedPaths): NodeJS.ProcessEnv {
  const allowedKeys = new Set(
    [
      "PATH",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "PATHEXT",
      "OS",
      "PROCESSOR_ARCHITECTURE",
      "NUMBER_OF_PROCESSORS",
      "PROGRAMFILES",
      "PROGRAMFILES(X86)",
      "PROGRAMW6432",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XAUTHORITY",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "LD_LIBRARY_PATH",
      "DYLD_LIBRARY_PATH",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "SHELL"
    ].map((key) => key.toLowerCase())
  )
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowedKeys.has(key.toLowerCase())) environment[key] = value
  }
  Object.assign(environment, {
    HOME: paths.isolatedHome,
    USERPROFILE: paths.isolatedHome,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    CMB_COWORK_AGENT_HOME: paths.openworkHome,
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: ELECTRON_BINARY,
    TEMP: paths.isolatedTemp,
    TMP: paths.isolatedTemp,
    TMPDIR: paths.isolatedTemp,
    XDG_CONFIG_HOME: paths.xdgConfigHome,
    XDG_CACHE_HOME: paths.xdgCacheHome,
    XDG_DATA_HOME: paths.xdgDataHome,
    ELECTRON_ENABLE_LOGGING: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost"
  })
  delete environment.ELECTRON_RUN_AS_NODE
  return environment
}

function childHasExited(processHandle: ChildProcess): boolean {
  return processHandle.exitCode !== null || processHandle.signalCode !== null
}

async function waitForChildExit(processHandle: ChildProcess, timeoutMs: number): Promise<void> {
  if (childHasExited(processHandle)) return
  await withTimeout(
    new Promise<void>((resolveExit) => {
      const onExit = (): void => resolveExit()
      processHandle.once("exit", onExit)
      if (childHasExited(processHandle)) {
        processHandle.off("exit", onExit)
        resolveExit()
      }
    }),
    timeoutMs,
    "Electron process exit"
  )
}

async function forceTerminateElectronTree(processHandle: ChildProcess): Promise<void> {
  if (childHasExited(processHandle)) return
  const pid = processHandle.pid
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    throw new Error("Cannot terminate Electron process tree without a valid PID")
  }
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout: 5_000
    })
  } else {
    try {
      process.kill(-pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  await waitForChildExit(processHandle, 5_000)
}

async function closeElectronApplication(app: ElectronApplication): Promise<void> {
  let processHandle: ChildProcess | undefined
  try {
    processHandle = app.process()
  } catch {
    // Playwright may already have disposed the process wrapper.
  }

  let gracefulFailure: unknown
  try {
    await withTimeout(app.close(), 10_000, "Electron close")
  } catch (error) {
    gracefulFailure = error
  }

  if (processHandle && !childHasExited(processHandle)) {
    try {
      await waitForChildExit(processHandle, 2_000)
    } catch {
      await forceTerminateElectronTree(processHandle)
      gracefulFailure ??= new Error("Electron required forced process-tree termination")
    }
  }
  if (gracefulFailure) throw gracefulFailure
}

async function main(): Promise<void> {
  const runLockPath = process.env.CMB_SESSION_RECOVERY_E2E_RUN_LOCK
  const configuredTestRoot = process.env.CMB_SESSION_RECOVERY_E2E_TEST_ROOT
  if (
    process.env.CMB_SESSION_RECOVERY_E2E_SAFE_BUILD !== "1" ||
    !runLockPath ||
    !configuredTestRoot ||
    !existsSync(runLockPath) ||
    !existsSync(configuredTestRoot) ||
    !existsSync(MAIN_ENTRY)
  ) {
    throw new Error("Run npm run test:session-recovery:e2e so the E2E cannot use a stale build")
  }

  const iterations = normalizeIterationCount(process.env.CMB_SESSION_RECOVERY_E2E_ITERATIONS)
  const testRoot = resolve(configuredTestRoot)
  const expectedTempPrefix = `${resolve(tmpdir())}${sep}`
  if (
    !testRoot.startsWith(expectedTempPrefix) ||
    !basename(testRoot).startsWith("cmb-session-recovery-e2e-")
  ) {
    throw new Error(`Unsafe E2E test root: ${testRoot}`)
  }
  // Third-party Windows IMEs can inherit USERPROFILE from Electron and hold files
  // open after Electron exits. Reuse a dedicated, non-user OS profile so those
  // files neither touch the real profile nor prevent the per-run root cleanup.
  const profileKey = basename(PROJECT_ROOT).replace(/[^a-zA-Z0-9._-]/g, "-")
  const isolatedHome =
    process.platform === "win32"
      ? join(tmpdir(), "cmb-session-recovery-e2e-os-profile", profileKey)
      : join(testRoot, "home")
  const appData = join(isolatedHome, "AppData", "Roaming")
  const localAppData = join(isolatedHome, "AppData", "Local")
  const openworkHome = join(testRoot, "cmbcoworkagent-home")
  const isolatedTemp = join(isolatedHome, "temp")
  const xdgConfigHome = join(isolatedHome, ".config")
  const xdgCacheHome = join(isolatedHome, ".cache")
  const xdgDataHome = join(isolatedHome, ".local", "share")
  const electronUserData = join(testRoot, "electron-user-data")
  const workspace = join(testRoot, "workspace")
  const isolatedPaths: IsolatedPaths = {
    isolatedHome,
    appData,
    localAppData,
    openworkHome,
    isolatedTemp,
    xdgConfigHome,
    xdgCacheHome,
    xdgDataHome
  }
  const capturedLogs: string[] = []
  const timings: TimingResult[] = []
  let fixtures: RecoveryFixture[] = []
  let mainDatabasePath = ""
  let modelServer: ModelServerHandle | undefined
  let app: ElectronApplication | undefined
  let page: Page | undefined
  let runError: unknown
  const teardownErrors: unknown[] = []
  let interruptedSignal: NodeJS.Signals | undefined
  let appClosePromise: Promise<void> | undefined
  let modelServerClosePromise: Promise<void> | undefined
  let signalCleanupPromise: Promise<void> | undefined
  const closeElectronOnce = (): Promise<void> => {
    if (!app) return Promise.resolve()
    appClosePromise ??= closeElectronApplication(app)
    return appClosePromise
  }
  const closeModelServerOnce = (): Promise<void> => {
    if (!modelServer) return Promise.resolve()
    modelServerClosePromise ??= modelServer.close()
    return modelServerClosePromise
  }
  const throwIfInterrupted = (): void => {
    if (interruptedSignal) throw new Error(`E2E interrupted by ${interruptedSignal}`)
  }
  const handledSignals: NodeJS.Signals[] =
    process.platform === "win32"
      ? ["SIGINT", "SIGTERM", "SIGBREAK"]
      : ["SIGINT", "SIGTERM", "SIGHUP"]
  const signalHandlers = new Map<NodeJS.Signals, () => void>(
    handledSignals.map((signal) => [
      signal,
      () => {
        if (interruptedSignal) return
        interruptedSignal = signal
        signalCleanupPromise = (async () => {
          await closeElectronOnce().catch(() => undefined)
          await closeModelServerOnce().catch(() => undefined)
        })()
      }
    ])
  )
  for (const [signal, handler] of signalHandlers) process.on(signal, handler)
  const profileOwnedPaths = [join(isolatedHome, ".codex"), join(isolatedHome, ".cmbcoworkagent")]
  try {
    for (const directory of [
      appData,
      localAppData,
      workspace,
      isolatedTemp,
      xdgConfigHome,
      xdgCacheHome,
      xdgDataHome
    ]) {
      mkdirSync(directory, { recursive: true })
    }
    for (const ownedPath of profileOwnedPaths) {
      await rmAsync(ownedPath, { recursive: true, force: true })
    }
    throwIfInterrupted()
    applyParentProcessIsolation(isolatedPaths)
    log(`隔离测试目录: ${testRoot}`)
    log(`重复轮数: ${iterations}`)

    const seeded = await seedRecoveryFixtures(openworkHome, workspace, iterations)
    throwIfInterrupted()
    fixtures = seeded.fixtures
    mainDatabasePath = seeded.mainDatabasePath
    modelServer = await startModelServer(fixtures)
    throwIfInterrupted()

    const launchStartedAt = Date.now()
    app = await electron.launch({
      executablePath: ELECTRON_LAUNCHER,
      args: [MAIN_ENTRY, `--user-data-dir=${electronUserData}`],
      cwd: PROJECT_ROOT,
      env: createElectronEnvironment(isolatedPaths),
      timeout: 60_000
    })
    throwIfInterrupted()
    const processHandle = app.process()
    processHandle.stdout?.on("data", (chunk) => capturedLogs.push(`[main:stdout] ${String(chunk)}`))
    processHandle.stderr?.on("data", (chunk) => capturedLogs.push(`[main:stderr] ${String(chunk)}`))
    page = await waitForAppPage(app)
    page.on("console", (message) =>
      capturedLogs.push(`[renderer:${message.type()}] ${message.text()}`)
    )
    page.on("pageerror", (error) => capturedLogs.push(`[renderer:pageerror] ${error.stack}`))
    log(`Electron 和 preload 就绪: ${Date.now() - launchStartedAt}ms`)
    await assertNoMmjCdnScript(page, "首次启动")

    await configureModel(page, modelServer.baseUrl)
    await page.reload({ waitUntil: "domcontentloaded" })
    page = await waitForAppPage(app)
    await assertNoMmjCdnScript(page, "模型配置后重载")

    // The app selects the most recently created task on startup. Start there to
    // avoid manufacturing a hydration cancellation before the first submit;
    // subsequent iterations still exercise real task switching.
    for (const fixture of [...fixtures].reverse()) {
      throwIfInterrupted()
      const timing = await exerciseFixture(page, fixture, modelServer.requests)
      throwIfInterrupted()
      timings.push(timing)
      log(
        `第 ${fixture.index + 1} 组耗时: 打开 ${timing.threadOpenMs}ms，` +
          `首轮命中模型 ${timing.firstModelRequestMs}ms，首轮完成 ${timing.firstReplyMs}ms，` +
          `紧接第二轮 ${timing.secondReplyMs}ms，` +
          `第二轮命中模型 ${timing.nextSendGapMs}ms`
      )
    }

    assert(modelServer.errors.length === 0, "本地模型服务及并发 SQLite 核验无异常")
    assertModelRequests(fixtures, modelServer.requests)
    const recoveryLogFailures = capturedLogs.filter(
      (entry) => entry.includes(TARGET_ERROR_CODE) || entry.includes(TARGET_ERROR_TEXT)
    )
    assert(recoveryLogFailures.length === 0, "Electron 主进程和 renderer 日志均未再出现目标错误")
  } catch (error) {
    if (page && !page.isClosed()) {
      const bodyText = await page
        .locator("body")
        .innerText()
        .catch(() => "<body unavailable>")
      console.error(`[session-recovery-e2e] UI failure snapshot:\n${bodyText.slice(0, 12_000)}`)
    }
    console.error(
      `[session-recovery-e2e] captured log tail:\n${capturedLogs.join("").slice(-20_000)}`
    )
    runError = interruptedSignal
      ? new Error(`E2E interrupted by ${interruptedSignal}`, { cause: error })
      : error
  } finally {
    if (app) {
      try {
        await closeElectronOnce()
      } catch (error) {
        teardownErrors.push(new Error(`Electron teardown failed: ${String(error)}`))
      }
    }
    if (modelServer) {
      try {
        await closeModelServerOnce()
      } catch (error) {
        teardownErrors.push(new Error(`Model server teardown failed: ${String(error)}`))
      }
    }
    if (signalCleanupPromise) await signalCleanupPromise
  }

  if (interruptedSignal && !runError)
    runError = new Error(`E2E interrupted by ${interruptedSignal}`)

  if (!runError && teardownErrors.length === 0) {
    try {
      await assertDurableMessagesAndCheckpoints(fixtures, mainDatabasePath)
      assert(
        timings.every(
          (timing) =>
            timing.threadOpenMs < 30_000 &&
            timing.firstModelRequestMs < 12_000 &&
            timing.firstReplyMs < 25_000 &&
            timing.secondReplyMs < 10_000 &&
            timing.nextSendGapMs < 5_000
        ),
        "所有 UI 恢复步骤均在超时预算内完成"
      )
    } catch (error) {
      runError = error
    }
  }

  try {
    for (const ownedPath of profileOwnedPaths) {
      await rmAsync(ownedPath, { recursive: true, force: true })
    }
    await rmAsync(testRoot, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 10 : 2,
      retryDelay: 250
    })
  } catch (error) {
    teardownErrors.push(
      new Error(`Temporary directory cleanup failed; retained ${testRoot}: ${String(error)}`)
    )
  }
  for (const [signal, handler] of signalHandlers) process.off(signal, handler)
  const failures = [...(runError ? [runError] : []), ...teardownErrors]
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "E2E run or cleanup failed")
  log(`ALL PASS ${iterations} 组真实 Electron 本地会话恢复 E2E`)
}

void main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack || error.message : String(error)
  console.error(`\n❌ ${detail}`)
  process.exitCode = 1
})
