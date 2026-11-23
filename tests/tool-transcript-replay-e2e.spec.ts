import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import AdmZip from "adm-zip"
import type { Checkpoint } from "@langchain/langgraph-checkpoint"
import { _electron as electron, type ElectronApplication } from "playwright"
import type { Message } from "../src/main/types"

const root = path.resolve(__dirname, "..")
const output = path.join(root, "output", "tool-transcript-replay-e2e", String(Date.now()))
const profile = path.join(output, "profile")
const workspace = path.join(output, "workspace")
const title = "Tool transcript replay fixture"
const threadId = "tool-replay-e2e"
const lastReply = "Replay fixture finished"
const callId = "reused-provider-tool-call"
const resultIds = [
  "1445a579-bd96-4e17-a5dd-91c06f999933",
  "edd6a76e-803b-4d4a-91b5-8bcd33ba0d7f",
  "11e6a77f-e4f6-460a-915f-fb932922bb7c",
  "08dec078-5601-43c6-b93d-6ad1713864a4"
]

function makeExchange(index: number): Message[] {
  const created_at = new Date(2026, 0, 1, 0, index)
  return [
    {
      id: `user-${index}`,
      role: "user",
      content: `Tool replay issue fixture request ${index}`,
      created_at
    },
    {
      id: `provider-${index}`,
      role: "assistant",
      content: `Checking fixture ${index}`,
      tool_calls: [{ id: callId, name: "read_file", args: { file_path: `fixture-${index}.txt` } }],
      created_at
    },
    {
      id: resultIds[index],
      role: "tool",
      name: "read_file",
      content: `Fixture result ${index}`,
      tool_call_id: callId,
      status: index === 2 ? "error" : "success",
      ...(index === 2 ? { is_error: true } : {}),
      created_at
    }
  ]
}

function setOccurrence(message: Message, provider_occurrence: number): Message {
  return {
    ...message,
    id: `${message.id}::cmb-same-role-duplicate:${message.role}:${provider_occurrence}`,
    provider_source_id: message.id,
    provider_occurrence
  }
}

async function seedHistory(): Promise<number> {
  const db = await import("../src/main/db")
  const { getThreadCheckpointPath } = await import("../src/main/storage")
  const { SqlJsSaver } = await import("../src/main/checkpointer/sqljs-saver")
  const first = makeExchange(0)
  const next = makeExchange(1)
  const mismatch = makeExchange(2)
  const nextAfterReplay = makeExchange(3)
  const final: Message = {
    id: "final",
    role: "assistant",
    content: lastReply,
    created_at: new Date(2026, 0, 1, 0, 3)
  }
  const legacy: Message = {
    ...final,
    id: "legacy-text",
    content: "Readable legacy response"
  }
  const nextFinal: Message = {
    ...final,
    id: "second-final",
    content: "Second fixture finished"
  }
  const nextWithLateResult = [next[0], next[1], nextFinal, next[2]]
  const repeated = [2, 3].flatMap((occurrence) =>
    first.slice(1).map((row) => setOccurrence(row, occurrence))
  )
  const updatedResult = { ...nextAfterReplay[2], content: "Updated fourth result" }
  const versionedCallId = "versioned-provider-tool-call"
  const versionedAssistant: Message = {
    ...nextAfterReplay[1],
    id: "versioned-assistant",
    content: "Checking versioned result",
    tool_calls: nextAfterReplay[1].tool_calls!.map((call) => ({ ...call, id: versionedCallId }))
  }
  const versionedResult: Message = {
    ...nextAfterReplay[2],
    id: "1c711082-5111-4632-976d-7c05ee064c33",
    content: "Earlier versioned result",
    tool_call_id: versionedCallId
  }
  const firstFinal: Message = {
    id: "first-final",
    role: "assistant",
    content: "First fixture finished",
    created_at: first[0].created_at
  }
  const interleaved = [
    first[0],
    first[1],
    ...repeated.filter((row) => row.role === "assistant"),
    first[2],
    ...repeated.filter((row) => row.role === "tool")
  ]
  const durable = [
    ...interleaved,
    firstFinal,
    setOccurrence(first[2], 4),
    ...nextWithLateResult,
    setOccurrence(next[1], 2),
    setOccurrence(next[2], 2),
    mismatch[0],
    setOccurrence(first[1], 5),
    setOccurrence(first[2], 5),
    ...mismatch.slice(1).map((row) => setOccurrence(row, 2)),
    final,
    ...nextAfterReplay.slice(0, 2),
    setOccurrence(first[2], 6),
    nextAfterReplay[2],
    setOccurrence(first[2], 7),
    setOccurrence(nextAfterReplay[2], 2),
    setOccurrence(updatedResult, 3),
    setOccurrence(updatedResult, 4),
    legacy,
    versionedAssistant,
    versionedResult,
    setOccurrence(versionedAssistant, 2),
    setOccurrence({ ...versionedResult, content: "Final versioned result" }, 2),
    setOccurrence(versionedAssistant, 3),
    setOccurrence(versionedResult, 3)
  ]
  await db.initializeDatabase()
  try {
    db.createThread(threadId, { title, workspacePath: workspace, agentMode: "normal" })
    db.upsertThreadMessages(threadId, durable)
    await db.flush()
  } finally {
    await db.closeDatabase()
  }

  const checkpoint: Checkpoint = {
    v: 1,
    id: "tool-replay-complete",
    ts: new Date().toISOString(),
    channel_values: {
      messages: [
        ...interleaved.map(toCheckpointMessage),
        toCheckpointMessage(firstFinal),
        {
          id: "hidden-team-turn",
          type: "human",
          content: "Hidden notification fixture",
          additional_kwargs: { cmb_internal_coordinator_notification: true }
        },
        ...[...nextWithLateResult, ...mismatch, final].map(toCheckpointMessage),
        {
          ...toCheckpointMessage(legacy),
          tool_calls: { length: 1 }
        }
      ]
    },
    channel_versions: { messages: 1 },
    versions_seen: {},
    pending_sends: []
  }
  const saver = new SqlJsSaver(getThreadCheckpointPath(threadId))
  try {
    await saver.put({ configurable: { thread_id: threadId, checkpoint_ns: "" } }, checkpoint, {
      source: "loop",
      step: 1,
      writes: {},
      parents: {}
    })
  } finally {
    await saver.close()
  }
  return durable.length
}

function toCheckpointMessage(message: Message) {
  return {
    ...message,
    type: message.role === "assistant" ? "ai" : message.role === "user" ? "human" : "tool",
    ...(message.provider_occurrence
      ? {
          additional_kwargs: {
            cmb_internal_provider_source_id: message.provider_source_id,
            cmb_internal_provider_occurrence: message.provider_occurrence
          }
        }
      : {})
  }
}

interface TestWindow {
  api: {
    threads: {
      exportSession(id: string): Promise<{ success: boolean; error?: string }>
      getMessages(id: string): Promise<Message[]>
    }
  }
}

async function main(): Promise<void> {
  await mkdir(workspace, { recursive: true })
  process.env.CMB_COWORK_AGENT_HOME = profile
  const rawRowCount = await seedHistory()
  const binary = createRequire(import.meta.url)("electron") as string
  const env: Record<string, string> = {
    CMB_E2E_ELECTRON_BIN: binary,
    CMB_E2E_DISABLE_GPU: "1",
    CMB_TASK_CARDS_MOCK: "1",
    CMB_COWORK_AGENT_HOME: profile,
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
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

  const failures: string[] = []
  const pageErrors: string[] = []
  for (const phase of ["initial", "cold-reopen"]) {
    let app: ElectronApplication | undefined
    try {
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
      const archivePath = path.join(output, `${phase}.zip`)
      const page = await app.firstWindow()
      await app.evaluate(({ dialog, ipcMain }, target) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
        const channel = "threads:search-target-window"
        const handlers = (
          ipcMain as unknown as {
            _invokeHandlers: Map<string, (event: unknown, request: unknown) => unknown>
          }
        )._invokeHandlers
        const open = handlers.get(channel)
        if (!open) throw new Error(`Missing production search handler: ${channel}`)
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (event, request) => {
          const state = globalThis as { replaySearchRequest?: unknown }
          state.replaySearchRequest = request
          return open(event, request)
        })
      }, archivePath)
      await page.route(/^https?:/, (route) => route.abort())
      page.on("pageerror", (error) => pageErrors.push(error.message))
      await page.getByText(title, { exact: true }).first().click({ timeout: 30_000 })
      const chat = page.locator(`[data-chat-thread-id="${threadId}"]`)
      await chat.getByText(lastReply, { exact: true }).waitFor({ timeout: 30_000 })
      const result = await page.evaluate(
        (id) => (window as unknown as TestWindow).api.threads.exportSession(id),
        threadId
      )
      assert.equal(result.success, true, result.error)
      const archive = new AdmZip(archivePath)
      const archived = JSON.parse(archive.readAsText("session.json")) as {
        messages: { role: string; content: string; toolCallId?: string }[]
      }
      const rows = await chat
        .locator('[data-chat-message-row][data-message-role="assistant"]')
        .allInnerTexts()
      const visible = rows.flatMap((row) => row.match(/Checking fixture \d/g) ?? [])
      const exported = archived.messages.filter((message) => message.role === "tool")
      const markdown = archive.readAsText("session.md")
      const stored = await page.evaluate(
        (id) => (window as unknown as TestWindow).api.threads.getMessages(id),
        threadId
      )
      console.log(JSON.stringify({ phase, visible, exported, rawRows: stored.length }))
      try {
        assert.deepEqual(visible, [
          "Checking fixture 0",
          "Checking fixture 1",
          "Checking fixture 2",
          "Checking fixture 3"
        ])
        assert.deepEqual(
          exported.map(({ content, toolCallId }) => [content, toolCallId]),
          [
            ["Fixture result 0", callId],
            ["Fixture result 1", callId],
            ["Fixture result 2", callId],
            ["Fixture result 3", callId],
            ["Updated fourth result", callId],
            ["Earlier versioned result", "versioned-provider-tool-call"],
            ["Final versioned result", "versioned-provider-tool-call"]
          ]
        )
        assert.equal(rows.filter((row) => row.includes("Checking versioned result")).length, 2)
        assert.equal(markdown.match(/Fixture result 0/g)?.length, 1)
        assert.equal(markdown.match(/Updated fourth result/g)?.length, 1)
        assert.match(markdown, /Readable legacy response/)
        assert.equal(stored.length, rawRowCount)
        assert.equal(await chat.getByText("INTERRUPTED", { exact: true }).count(), 0)
        const search = page.getByRole("dialog", { name: "搜索会话" })
        await page.getByRole("button", { name: "搜索会话", exact: true }).click()
        await search.getByRole("combobox", { name: "搜索会话" }).fill("Checking fixture 0")
        await search.locator(`[data-search-thread="${threadId}"]`).first().click()
        await page.waitForFunction(() => {
          const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights
          const range = [...(registry.get("chat-search-active") ?? [])][0]
          const row =
            range?.startContainer.parentElement?.closest<HTMLElement>("[data-chat-message-id]")
          return (
            row?.dataset.chatMessageId === "provider-0" &&
            range?.toString() === "Checking fixture 0"
          )
        })
        const request = await app.evaluate(
          () =>
            (
              globalThis as {
                replaySearchRequest?: { target?: { messageId?: string } }
              }
            ).replaySearchRequest
        )
        assert.match(
          request?.target?.messageId ?? "",
          /^provider-0::cmb-same-role-duplicate:assistant:/
        )
        await page.screenshot({
          animations: "disabled",
          path: path.join(output, `${phase}.png`),
          timeout: 60_000
        })
      } catch (error) {
        failures.push(`${phase}: ${String(error)}`)
      }
    } finally {
      await app?.close()
    }
  }
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(failures, [], output)
  console.log("PASS tool transcript replay disappears from chat and export after cold reopen")
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
