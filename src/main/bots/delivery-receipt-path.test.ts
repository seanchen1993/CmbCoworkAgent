import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { parseBotFileDelivery } from "../../shared/bots/file-delivery"
import * as transcript from "../db"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { bindThreadWorkspace } from "../services/workspace-metadata"
import { botAttachmentReceiptKey, workAttachmentStorage } from "./attachment-storage"
import { linkExistingConversation } from "./conversation-link-service"
import { readDesktopBotDelivery } from "./delivery-receipt"
import { BOT_FORK_DELIVERY_BOUNDARY } from "./history-input-projection"
import { LocalBotHost } from "./host"
import { BotStore } from "./store"
import { createBotDeliveryTools } from "./tools"

const fixture = vi.hoisted(() => ({ root: "" }))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => join(fixture.root, "app") }))
vi.mock("../storage", () => ({
  getDbPath: () => join(fixture.root, "transcript.sqlite"),
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("../agent/goals/runtime", () => ({ goalManager: { getActive: () => null } }))
vi.mock("../agent/pending-notification-scheduler", () => ({ pendingNotificationScheduler: { requestCheck: vi.fn() } }))
vi.mock("../agent/runtime", () => ({
  hasPendingApprovalForRuntimeThread: () => false,
  withCheckpointer: (_threadId: string, read: (saver: { getTuple: () => Promise<undefined> }) => Promise<unknown>) =>
    read({ getTuple: async () => undefined })
}))
vi.mock("../agent/workflow/run-manager", () => ({
  workflowRunManager: { withThreadTransitionLease: (_threadId: string, action: () => Promise<unknown>) => action() }
}))
vi.mock("../services/thread-external-run-busy", () => ({ isExternallyManagedThreadRunBusy: () => false }))

it("keeps only exact managed Markdown images after moving a linked workspace stored through an alias", async () => {
  fixture.root = await realpath(await mkdtemp(join(tmpdir(), "bot-delivery-path-")))
  const database = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(database)
  const host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} })
  try {
    await transcript.initializeDatabase()
    const parent = join(fixture.root, "real-parent")
    const alias = join(fixture.root, "workspace-parent-alias")
    const canonical = join(parent, "project")
    const workspace = join(alias, "project")
    await mkdir(canonical, { recursive: true })
    await symlink(parent, alias, process.platform === "win32" ? "junction" : "dir")
    const chart = join(canonical, "chart.png")
    const chartAlias = join(canonical, "chart-alias.png")
    const unrelated = join(canonical, "unrelated.png")
    const originalBytes = "retained chart"
    await writeFile(join(canonical, "report.md"), "![Chart](chart-alias.png)")
    await writeFile(chart, originalBytes)
    await symlink(chart, chartAlias)
    await writeFile(unrelated, "not delivered")

    const metadata = {}
    bindThreadWorkspace(metadata, workspace)
    const threadId = "original-thread"
    const row = transcript.createThread(threadId, metadata)
    const bot = store.create({ name: "Reports", instructions: "", color: "#123456", modelRef: null })
    const work = await linkExistingConversation(host, {
      botId: bot.id, operationId: "link", title: "Report", goal: "Deliver the report",
      conversation: { kind: "local_thread", threadId, incarnation: captureThreadIncarnation(row) }
    })
    const storage = workAttachmentStorage(workspace, work)!
    const [deliver] = createBotDeliveryTools(workspace, new AbortController().signal, undefined, undefined, false, storage, work.id)
    const content = String(await deliver.invoke({ files: ["report.md", "chart-alias.png"] }))
    const files = parseBotFileDelivery(content)!
    const assistantMessageId = "assistant-delivery", callId = "file-delivery"
    transcript.upsertThreadMessages(threadId, [
      { id: assistantMessageId, role: "assistant", content: "", created_at: new Date(), tool_calls: [{ id: callId, name: deliver.name, args: {} }] },
      { id: "delivery-result", role: "tool", content, created_at: new Date(), name: deliver.name, tool_call_id: callId }
    ])
    const read = () => readDesktopBotDelivery(host, { threadId, assistantMessageId, callId, fileIndex: 0 })
    const before = read()
    assert.ok("markdownImageSnapshot" in before, "Expected a Markdown image resolver before moving the project")
    expect(before.allowMarkdownWorkspaceFallback).toBe(true)
    expect(before.markdownImageSnapshot(chartAlias)?.path).toBe(files[1].attachmentPath)

    await rename(canonical, join(parent, "moved-project"))
    const after = read()
    assert.ok("markdownImageSnapshot" in after, "Expected a Markdown image resolver after moving the project")
    expect(after.markdownWorkspace).toBe(canonical)
    expect(after.allowMarkdownWorkspaceFallback).toBe(false)
    expect(after.markdownImageSnapshot(chartAlias)?.path).toBe(files[1].attachmentPath)
    expect(after.markdownImageSnapshot(join(canonical, "unrecorded-chart-alias.png"))).toBeUndefined()
    expect(after.markdownImageSnapshot(unrelated)).toBeUndefined()
    const retained = after.markdownImageSnapshot(chart)
    assert.ok(retained, "Expected the original chart snapshot")
    expect(retained.path).toBe(files[1].attachmentPath)
    await expect(readFile(retained.path, "utf8")).resolves.toBe(originalBytes)
  } finally {
    await host.stop()
    database.close()
    await transcript.closeDatabase()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

it("keeps a redelivered legacy Markdown batch after detaching its original native work", async () => {
  fixture.root = await realpath(await mkdtemp(join(tmpdir(), "bot-legacy-markdown-")))
  const database = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(database)
  const host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} })
  try {
    await transcript.initializeDatabase()
    const workspace = join(fixture.root, "work")
    await mkdir(workspace)
    const chart = join(workspace, "chart.png")
    const report = join(workspace, "report.md")
    await writeFile(report, "![Chart](chart.png)")
    await writeFile(chart, "retained chart")
    const bot = store.create({ name: "Reports", instructions: "", color: "#123456", modelRef: null })
    const { work, task } = store.createWork({ botId: bot.id, operationId: "report", title: "Report", goal: "Deliver" },
      undefined, { kind: "default", path: workspace })
    if (task) {
      store.transition(task.id, "running")
      store.settle(task.id, "completed", null)
    }
    const { id: workId, threadId } = work
    const row = transcript.createThread(threadId, { workspacePath: workspace,
      botId: bot.id, botHostId: "local", botWorkId: workId, botAudienceKey: "desktop" })
    store.initializeWorkThread(bot.id, workId)
    const ref = { kind: "local_thread" as const, threadId, incarnation: captureThreadIncarnation(row) }
    store.conversations.prepareCreated(bot.id, workId, ref)
    const bound = store.conversations.bound(bot.id, workId, ref)
    const metadata = JSON.parse(row.metadata!)
    transcript.updateThread(threadId, {
      metadata: JSON.stringify({ ...metadata, botLocalConversation: true, botWorkOrigin: "created" })
    })
    const signal = new AbortController().signal
    const [deliver] = createBotDeliveryTools(workspace, signal)
    const legacy = String(await deliver.invoke({ files: ["report.md", "chart.png"] }))
    const files = parseBotFileDelivery(legacy)!
    const previousSource = { assistantMessageId: "legacy-assistant", callId: "legacy-call", fileIndex: 0, resultId: "legacy-result" }
    const append = (assistantId: string, callId: string, resultId: string, content: string) =>
      transcript.upsertThreadMessages(threadId, [
        { id: assistantId, role: "assistant", content: "", created_at: new Date(),
          tool_calls: [{ id: callId, name: "bot_deliver_files", args: {} }] },
        { id: resultId, role: "tool", content, created_at: new Date(), name: "bot_deliver_files", tool_call_id: callId }
      ])
    append(previousSource.assistantMessageId, previousSource.callId, previousSource.resultId, legacy)
    append("current-assistant", "current-call", "current-result", JSON.stringify({
      kind: "bot-file-delivery", files: [files[0]], receiptWorkId: workId,
      receiptThread: botAttachmentReceiptKey(threadId, row), markdownSources: { 0: previousSource }
    }))
    store.conversations.beginDetach(bot.id, workId, bound.version)
    store.conversations.detached(bot.id, workId)
    const read = () => readDesktopBotDelivery(host, { threadId, assistantMessageId: "current-assistant",
      callId: "current-call", fileIndex: 0 })
    transcript.updateThread(threadId, { metadata: JSON.stringify({ workspacePath: workspace }) })
    await writeFile(chart, "new working image")
    await writeFile(join(workspace, "not-delivered.png"), "new mutable image")
    const receipt = read()
    assert.ok("markdownImageSnapshot" in receipt)
    expect(receipt.allowMarkdownWorkspaceFallback).toBe(false)
    const image = receipt.markdownImageSnapshot(chart)!
    expect(image.path).toBe(files[1].attachmentPath)
    await expect(readFile(image.path, "utf8")).resolves.toBe("retained chart")
    const readLegacy = () => readDesktopBotDelivery(host, { threadId,
      assistantMessageId: previousSource.assistantMessageId, callId: previousSource.callId, fileIndex: 0 })
    const direct = readLegacy()
    assert.ok("markdownImageSnapshot" in direct)
    expect(direct.allowMarkdownWorkspaceFallback).toBe(false)
    expect(direct.markdownImageSnapshot(chart)?.path).toBe(files[1].attachmentPath)
    expect(direct.markdownImageSnapshot(join(workspace, "not-delivered.png"))).toBeUndefined()
    const [legacyResult] = transcript.getThreadMessagesByIds(threadId, [previousSource.resultId])
    transcript.updateThread(threadId, { metadata: JSON.stringify({
      workspacePath: workspace, forkedFromThreadId: "source",
      [BOT_FORK_DELIVERY_BOUNDARY]: legacyResult.ordinal! + 1
    }) })
    const inherited = read()
    assert.ok("markdownImageSnapshot" in inherited)
    expect(() => inherited.markdownImageSnapshot(chart)).toThrow()
    expect(readLegacy).toThrow()
  } finally {
    await host.stop()
    database.close()
    await transcript.closeDatabase()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
