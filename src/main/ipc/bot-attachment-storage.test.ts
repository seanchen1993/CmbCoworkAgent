import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { ToolMessage } from "@langchain/core/messages"
import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { LocalBotHost } from "../bots/host"
import { BotStore } from "../bots/store"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import type { BotWorkItem } from "../../shared/bots/work"
import type { FileAttachment } from "../../shared/file-attachment"
import type { ToolPermissionResult } from "../../shared/tool-permission"
import { parseBotFileDelivery, type BotDeliveredFile } from "../../shared/bots/file-delivery"
import { buildAttachmentMessageParts } from "../../shared/attachment-message-parts"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import { EXTERNAL_FILE_READ_GRANT_TTL_MS, resolveExternalFileReadGrant } from "../services/external-file-read-tokens"
import { imRemoteGrantStore } from "../services/im/remote-grant-store"
import { deleteProjectThreadDataDirectory } from "../agent/context-history-path"

const fixtures = vi.hoisted(() => ({
  root: "", picked: "", pickedBatch: [] as string[], saved: "", workspace: "",
  mediaHost: undefined as LocalBotHost | undefined
}))
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: fixtures.pickedBatch.length ? fixtures.pickedBatch : [fixtures.picked] }),
    showSaveDialog: async () => ({ canceled: false, filePath: fixtures.saved })
  }
}))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => join(fixtures.root, "app") }))
vi.mock("../storage", () => ({
  getDbPath: () => join(fixtures.root, "threads.sqlite"),
  getOpenworkDir: () => join(fixtures.root, "app"),
  getBuiltinRobotSettings: () => ({ enabled: false }),
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn(),
  isMemoryEnabled: () => false
}))
vi.mock("../bots/runtime-adapter", () => ({ prepareBotThread: () => fixtures.workspace }))
vi.mock("../bots/local-service", () => ({ getLocalBotHost: () => fixtures.mediaHost }))
vi.mock("../file-parser", () => ({ isSupportedFile: (name: string) => name.endsWith(".txt") }))
vi.mock("../file-attachment-parser/client", () => ({
  getFileAttachmentParserClient: () => ({
    cancelLatest: vi.fn(),
    parse: async (input: { fileName: string; bytes: ArrayBuffer }) => {
      if (input.fileName === "bad.txt") throw new Error("无法解析附件")
      return { content: new TextDecoder().decode(input.bytes), mimeType: "text/plain", truncated: false }
    }
  })
}))
vi.mock("../workspace-file-scan/manager", () => ({ cancelWorkspaceFileScansForOwner: vi.fn() }))
vi.mock("../workspace-file-preview/client", async () => {
  const { readPreviewTextPage, resolvePreviewFile } = await import("../workspace-file-preview/reader")
  return { getWorkspaceFilePreviewClient: () => ({
    cancelLatest: vi.fn(),
    inspect: (source: Parameters<typeof resolvePreviewFile>[0], root: string) =>
      resolvePreviewFile(source, root, new Int32Array(new SharedArrayBuffer(4))),
    readText: (source: Parameters<typeof readPreviewTextPage>[0], root: string, offset: number) =>
      readPreviewTextPage(source, root, offset, new Int32Array(new SharedArrayBuffer(4)))
  }) }
})

import * as db from "../db"
import { createBotDeliveryTools, createBotReturnFileTools } from "../bots/tools"
import { findHistoricalBotWorkDelivery, type BotHistoricalDeliveryReference } from "../bots/delivery-receipt"
import { botAttachmentReceiptKey, workAttachmentStorage } from "../bots/attachment-storage"
import { projectSkillWorkInput } from "../bots/input-files"
import { createLocalBotWorkHistory } from "../bots/work-history"
import { createBotOrdinaryThreads } from "../bots/ordinary-threads"
import { localBotWorkspaces } from "../bots/workspace"
import { botHistoryInputProjection, setBotHistoryInputSource } from "../bots/history-input-projection"
import { registerBotFileHandlers } from "./bot-files"
import { registerWorkspaceFilePreviewHandlers } from "./file-preview"
import { handleWorkspaceFilePreviewProtocolRequest } from "../workspace-file-preview/media-protocol"

beforeAll(async () => {
  fixtures.root = await realpath(await mkdtemp(join(tmpdir(), "bot-managed-attachment-")))
  fixtures.workspace = join(fixtures.root, "project")
  fixtures.picked = join(fixtures.root, "picked.bin")
  fixtures.saved = join(fixtures.root, "saved.bin")
  await mkdir(fixtures.workspace)
  await db.initializeDatabase()
})
afterAll(async () => {
  await db.closeDatabase()
  await rm(fixtures.root, { recursive: true, force: true })
})

it.each([false, true])("signs workspace @file against the original thread and keeps its selected bytes (work=%s)", async managed => {
  fixtures.workspace = join(fixtures.root, `workspace-mention-${managed}`)
  await mkdir(fixtures.workspace)
  const outside = join(fixtures.root, "outside.txt")
  const source = join(fixtures.workspace, "report.txt")
  const original = "first report".repeat(200)
  await writeFile(source, original)
  await writeFile(outside, "unrelated")
  await symlink(outside, join(fixtures.workspace, "outside.txt"))
  const thread = db.createThread(`mention-thread-${managed}`, { workspacePath: fixtures.workspace })
  const work = managed ? {
    id: "work", botId: "bot", threadId: thread.thread_id, audienceKey: "desktop",
    workspace: { kind: "directory", path: fixtures.workspace }
  } as BotWorkItem : undefined
  const retainInputFile = vi.fn((_bot: string, attachment: FileAttachment, _path: string, _work?: string) =>
    ({ ...attachment, botInputId: "input-id" }))
  const host = {
    getWork: () => work, getBot: () => ({ id: "bot", archived: false, threadId: managed ? "main" : thread.thread_id }),
    initializeWorkThread: vi.fn(), retainInputFile
  } as unknown as LocalBotHost
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
  registerBotFileHandlers({
    handle: (name: string, handler: Parameters<IpcMain["handle"]>[1]) => handlers.set(name, handler)
  } as unknown as IpcMain, () => host)
  const frame = {}, sender = { id: 12347, mainFrame: frame, once: vi.fn(), removeListener: vi.fn() }
  const invoke = (id: string, path: string, senderFrame = frame) => handlers.get("bots:files:attach-workspace")!(
    { sender, senderFrame } as unknown as IpcMainInvokeEvent, "local", "bot", id, path, 1000, work?.id)

  await expect(invoke(thread.thread_id, "report.txt", {})).rejects.toThrow("桌面窗口")
  await expect(invoke("wrong-thread", "report.txt")).rejects.toThrow("当前桌面 Bot 会话")
  await expect(invoke(thread.thread_id, "../outside.txt")).rejects.toThrow("工作区文件引用")
  await expect(invoke(thread.thread_id, outside)).rejects.toThrow("工作区文件引用")
  await expect(invoke(thread.thread_id, "outside.txt")).rejects.toThrow("链接超出")
  expect(retainInputFile).not.toHaveBeenCalled()

  const attachment = await invoke(thread.thread_id, "report.txt") as FileAttachment
  expect(attachment).toMatchObject({ filename: "report.txt", size: original.length, botInputId: "input-id", truncated: true })
  expect(attachment.content).toHaveLength(1000)
  expect(attachment.content).toContain("first report")
  expect(retainInputFile).toHaveBeenCalledExactlyOnceWith("bot", expect.any(Object), expect.any(String), work?.id)
  const snapshot = retainInputFile.mock.calls[0][2]
  expect(attachment.filePath).toBe(managed ? snapshot : source)
  expect(snapshot).toContain(createHash("sha256").update(original).digest("hex"))
  if (managed) expect((await readdir(fixtures.workspace)).sort()).toEqual(["outside.txt", "report.txt"])
  await writeFile(source, "later edit")
  await expect(readFile(snapshot, "utf8")).resolves.toBe(original)
})

it.each(["attach-workspace", "attach", "attach-bytes"] as const)(
  "keeps the model's %s attachment path on the selected version in a created default workspace task",
  { timeout: 10_000 },
  async (mode) => {
    const { LocalSandbox } = await import("../agent/local-sandbox")
    const database = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    const store = new BotStore(database)
    const requestId = "use-selected-report"
    let permission: ToolPermissionResult | undefined
    let contents: string | undefined
    const host: LocalBotHost = new LocalBotHost(store, {
      acquire: (_bot, task, work) => {
        if (task.requestId !== requestId || !work?.workspace) return null
        const rootDir = work.workspace.path
        return {
          release() {},
          async execute(signal) {
            await host.verifyInputFilesForRun(task.id, task.id)
            const input = projectSkillWorkInput(task, host.inputFilesForTask(task.id))
            const path = /<attachment [^>]*\bpath="([^"]+)"/.exec(input)?.[1]
            if (!path) throw new Error("No attachment path in the Bot task")
            const sandbox = new LocalSandbox({ rootDir, virtualMode: false, abortSignal: signal })
            permission = await sandbox.queryToolPermission("read_file", { file_path: path })
            contents = await sandbox.read(path, 401, 1)
            return { state: "completed" }
          }
        }
      },
      onAvailable: () => () => {},
      workspaces: localBotWorkspaces
    })
    try {
      const bot = store.create({ name: "Reports", instructions: "", color: "#123456", modelRef: null })
      const { task, work } = await host.createWork({
        botId: bot.id, operationId: "default-workspace-attachment", title: "Report", goal: "Read report"
      })
      expect(work.workspace?.kind).toBe("default")
      fixtures.workspace = work.workspace!.path
      const row = db.createThread(work.threadId, {
        workspacePath: fixtures.workspace, botId: bot.id, botHostId: "local", botWorkId: work.id,
        botAudienceKey: "desktop", botLocalConversation: true, botWorkOrigin: "created"
      })
      const ref = { kind: "local_thread" as const, threadId: work.threadId, incarnation: captureThreadIncarnation(row) }
      store.conversations.prepareCreated(bot.id, work.id, ref)
      const bound = store.conversations.bound(bot.id, work.id, ref)
      store.transition(task.id, "running")
      store.settle(task.id, "completed", null, "Ready for files")
      const taken = host.changeWorkControl({
        botId: bot.id, workId: work.id, expectedVersion: bound.version,
        operationId: "take-default-workspace-attachment", action: "take"
      })
      expect(taken.userControl).toMatchObject({ settling: false })

      const filename = "report.txt"
      const original = "amount,comment\n" + "10,\n".repeat(400) + "23,original-last-row\n"
      const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
      registerBotFileHandlers({
        handle: (name: string, handler: Parameters<IpcMain["handle"]>[1]) => handlers.set(name, handler)
      } as unknown as IpcMain, () => host)
      const frame = {}, sender = { id: 12348, mainFrame: frame, once: vi.fn(), removeListener: vi.fn() }
      const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
      const attach = handlers.get(`bots:files:${mode}`)!
      let attachment: FileAttachment
      let editablePath = join(fixtures.workspace, filename)
      if (mode === "attach-workspace") {
        await writeFile(editablePath, original)
        attachment = await attach(event, "local", bot.id, work.threadId, filename, 600, work.id) as FileAttachment
      } else {
        let attachments: FileAttachment[]
        if (mode === "attach") {
          const selected = join(fixtures.root, filename)
          await writeFile(selected, original)
          fixtures.pickedBatch = [selected]
          try {
            attachments = await attach(event, "local", bot.id, 1, 600, undefined, work.id) as FileAttachment[]
          } finally {
            fixtures.pickedBatch = []
          }
        } else {
          const dropped = [{ fileName: filename, bytes: new TextEncoder().encode(original).buffer }]
          attachments = await attach(event, "local", bot.id, dropped, 600, undefined, work.id) as FileAttachment[]
        }
        expect(attachments).toHaveLength(1)
        attachment = attachments[0]
        // Find the editable import independently of the model attachment path.
        const shared = join(fixtures.workspace, "shared")
        const imports = await readdir(shared)
        expect(imports).toHaveLength(1)
        editablePath = join(shared, imports[0], filename)
      }
      expect(attachment).toMatchObject({ filename, truncated: true, botInputId: expect.any(String) })
      expect(attachment.content).not.toContain("original-last-row")
      const { attachmentModelBlocks } = buildAttachmentMessageParts([attachment], true)
      await expect(readFile(editablePath, "utf8")).resolves.toBe(original)
      const replacement = original.replace("23,original-last-row", "99,replacement-row")
      await writeFile(editablePath, replacement)
      const admitted = await host.sendDesktopMessage({
        botId: bot.id, workId: work.id, requestId,
        message: `Sum all rows using the attached version.${attachmentModelBlocks}`,
        inputFileIds: [attachment.botInputId!]
      })
      expect(admitted.message).toContain(`path="${attachment.filePath}"`)
      const [receipt] = host.inputFilesForTask(admitted.id)
      await expect(readFile(receipt.file.filePath, "utf8")).resolves.toBe(original)
      await vi.waitFor(() => expect(store.getTask(admitted.id)).toMatchObject({ state: "completed", error: null }))
      expect(permission).toEqual({ decision: "allow" })
      expect(contents).toContain("23,original-last-row")
      expect(attachment.filePath).toBe(receipt.file.filePath)
      expect(attachment.content).toContain(JSON.stringify(receipt.file.filePath))
      await expect(readFile(editablePath, "utf8")).resolves.toBe(replacement)
    } finally {
      await host.stop()
      database.close()
    }
  }
)

it.each(["attach", "attach-bytes"] as const)("keeps a failed %s batch private and reuses a formal version after success", async (mode) => {
  fixtures.workspace = join(fixtures.root, mode)
  const picks = join(fixtures.root, `${mode}-picks`)
  await mkdir(fixtures.workspace)
  await mkdir(picks)
  const row = db.createThread(`batch-${mode}`, { workspacePath: fixtures.workspace })
  const work = {
    id: "work", botId: "bot", threadId: row.thread_id, audienceKey: "desktop",
    workspace: { kind: "directory", path: fixtures.workspace }
  } as BotWorkItem
  const retainInputFile = vi.fn((_bot: string, attachment: FileAttachment) =>
    ({ ...attachment, botInputId: `input-${attachment.filename}` }))
  const host = {
    getWork: () => work, getBot: () => ({ id: "bot", archived: false }),
    initializeWorkThread: vi.fn(), retainInputFile
  } as unknown as LocalBotHost
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
  registerBotFileHandlers({
    handle: (name: string, handler: Parameters<IpcMain["handle"]>[1]) => handlers.set(name, handler)
  } as unknown as IpcMain, () => host)
  const event = { sender: { id: 12346, once: vi.fn() } } as unknown as IpcMainInvokeEvent
  const invoke = async (names: readonly string[]) => {
    const handler = handlers.get(`bots:files:${mode}`)!
    if (mode === "attach") {
      fixtures.pickedBatch = names.map(name => join(picks, name))
      try {
        return await handler(event, "local", "bot", names.length, 2000, undefined, work.id) as FileAttachment[]
      } finally {
        fixtures.pickedBatch = []
      }
    }
    const files = await Promise.all(names.map(async fileName => ({
      fileName, bytes: Uint8Array.from(await readFile(join(picks, fileName))).buffer
    })))
    return await handler(event, "local", "bot", files, 2000, undefined, work.id) as FileAttachment[]
  }

  const shared = "formal version", unique = "new picker bytes"
  await writeFile(join(fixtures.workspace, "shared.txt"), shared)
  await writeFile(join(picks, "shared.txt"), shared)
  await writeFile(join(picks, "unique.txt"), unique)
  await writeFile(join(picks, "bad.txt"), "broken")
  const storage = workAttachmentStorage(fixtures.workspace, work)!
  const [deliver] = createBotDeliveryTools(fixtures.workspace, new AbortController().signal,
    undefined, undefined, false, storage, work.id)
  const [formal] = parseBotFileDelivery(String(await deliver.invoke({ files: ["shared.txt"] })))!
  const existing = await stat(formal.attachmentPath!)

  await expect(invoke(["shared.txt", "unique.txt", "bad.txt"])).rejects.toThrow("无法解析附件")
  expect(retainInputFile).not.toHaveBeenCalled()
  expect(await readdir(storage)).toEqual([".bot-deliveries"])
  expect(await readdir(join(storage, ".bot-deliveries"))).toEqual([createHash("sha256").update(shared).digest("hex")])
  await expect(readFile(formal.attachmentPath!, "utf8")).resolves.toBe(shared)

  const attachments = await invoke(["shared.txt", "unique.txt"])
  expect(attachments.map(file => file.botInputId)).toEqual(["input-shared.txt", "input-unique.txt"])
  expect(attachments[0].filePath).toBe(formal.attachmentPath)
  expect((await stat(attachments[0].filePath)).ino).toBe(existing.ino)
  expect(attachments[1].filePath).toContain(createHash("sha256").update(unique).digest("hex"))
  expect(attachments[1].content).toContain(unique)
  await expect(readFile(attachments[1].filePath, "utf8")).resolves.toBe(unique)
  expect(await readdir(storage)).toEqual([".bot-deliveries"])
})

it.each(["existing", "created"] as const)("keeps the exact project delivery after detaching a %s task", async (origin) => {
  fixtures.workspace = join(fixtures.root, "project", origin)
  await mkdir(fixtures.workspace)
  const metadata = {
    workspacePath: fixtures.workspace, botId: "bot", botHostId: "local", botWorkId: "work",
    botAudienceKey: "desktop", botLocalConversation: true, botWorkOrigin: origin
  }
  const row = db.createThread(`work-thread-${origin}`, metadata)
  const work = {
    id: "work", botId: "bot", threadId: row.thread_id, audienceKey: "desktop",
    workspace: { kind: "directory", path: fixtures.workspace },
    conversation: { origin, state: "bound",
      ref: { kind: "local_thread", threadId: row.thread_id, incarnation: captureThreadIncarnation(row) } }
  } as BotWorkItem
  const retainInputFile = vi.fn((_bot: string, attachment: FileAttachment, _path: string, _workId: string) =>
    ({ ...attachment, botInputId: "input-id" }))
  const host = {
    getWork: () => work, getBot: () => ({ id: "bot", archived: false }),
    initializeWorkThread: vi.fn(), retainInputFile, desktopDeliveryWorks: () => [work]
  } as unknown as LocalBotHost
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
  registerBotFileHandlers({
    handle: (name: string, handler: Parameters<IpcMain["handle"]>[1]) => handlers.set(name, handler)
  } as unknown as IpcMain, () => host)
  const frame = {}, sender = { id: 12345, mainFrame: frame, once: vi.fn() }
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const invoke = async (name: string, ...args: unknown[]) =>
    handlers.get(`bots:files:${name}`)!(event, "local", ...args)

  await writeFile(fixtures.picked, "picked original")
  const [picked] = await invoke("attach", "bot", 1, 2000, undefined, work.id) as FileAttachment[]
  const [dropped] = await invoke("attach-bytes", "bot", [
    { fileName: "dropped.bin", bytes: new TextEncoder().encode("dropped original").buffer }
  ], 2000, undefined, work.id) as FileAttachment[]
  expect([picked.botInputId, dropped.botInputId]).toEqual(["input-id", "input-id"])
  expect(retainInputFile.mock.calls.map(call => call[3])).toEqual([work.id, work.id])
  await expect(readFile(picked.filePath, "utf8")).resolves.toBe("picked original")
  await expect(readFile(dropped.filePath, "utf8")).resolves.toBe("dropped original")
  expect(await readdir(fixtures.workspace)).toEqual([])

  const projectFile = join(fixtures.workspace, "report.txt")
  await writeFile(projectFile, "version delivered")
  const signal = new AbortController().signal
  const storage = workAttachmentStorage(fixtures.workspace, work)!
  const [deliver] = createBotDeliveryTools(fixtures.workspace, signal, undefined, undefined, false, storage, work.id)
  const content = String(await deliver.invoke({ files: ["report.txt"] }))
  const [file] = parseBotFileDelivery(content)!
  expect(file.attachmentRoot).toBe(storage)
  expect(await readdir(fixtures.workspace)).toEqual(["report.txt"])
  const messages = [
    { id: "assistant", role: "assistant" as const, content: "", created_at: new Date(),
      tool_calls: [{ id: "delivery", name: "bot_deliver_files", args: {} }] },
    { id: "receipt", role: "tool" as const, content, created_at: new Date(), name: "bot_deliver_files", tool_call_id: "delivery" }
  ]
  db.upsertThreadMessages(work.threadId, messages)
  const history = createLocalBotWorkHistory(() => host)
  const incarnation = createHash("sha256").update(JSON.stringify(captureThreadIncarnation(row))).digest("hex")
  const historySource = { workId: work.id, messageId: "assistant", incarnation }
  work.conversation!.state = "detached"
  db.updateThread(work.threadId, { metadata: JSON.stringify({ workspacePath: fixtures.workspace }) })
  await writeFile(projectFile, "later replacement")
  const source = { threadId: work.threadId, assistantMessageId: "assistant", callId: "delivery", fileIndex: 0 }
  await expect(history.resolve(work, historySource)).resolves.toMatchObject({ detached: true, threadId: work.threadId, messageId: "assistant" })
  await expect(invoke("authorize-delivery", { ...source, callId: "fake" })).rejects.toThrow("原交付")
  const grant = await invoke("authorize-delivery", source) as { grant: string; filePath: string; expiresAt: number }
  await expect(resolveExternalFileReadGrant(grant.grant, sender.id, grant.filePath))
    .resolves.toMatchObject({ filePath: file.attachmentPath })
  await expect(resolveExternalFileReadGrant(grant.grant, sender.id, picked.filePath))
    .resolves.toHaveProperty("error")
  await expect(resolveExternalFileReadGrant(grant.grant, sender.id + 1, grant.filePath))
    .resolves.toHaveProperty("error", "Sender mismatch")
  expect(grant.expiresAt).toBeGreaterThan(Date.now())
  const afterExpiry = Date.now() + EXTERNAL_FILE_READ_GRANT_TTL_MS + 1
  const clock = vi.spyOn(Date, "now").mockReturnValue(afterExpiry)
  try {
    await expect(resolveExternalFileReadGrant(grant.grant, sender.id, grant.filePath)).resolves.toHaveProperty("error")
    const renewed = await invoke("authorize-delivery", source) as typeof grant
    expect(renewed).toMatchObject({ filePath: grant.filePath, expiresAt: afterExpiry + EXTERNAL_FILE_READ_GRANT_TTL_MS })
    expect(renewed.grant).not.toBe(grant.grant)
    await expect(resolveExternalFileReadGrant(renewed.grant, sender.id, renewed.filePath))
      .resolves.toMatchObject({ filePath: file.attachmentPath })
  } finally { clock.mockRestore() }
  await expect(invoke("export-delivery", source)).resolves.toBe(true)
  await expect(readFile(fixtures.saved, "utf8")).resolves.toBe("version delivered")
  db.updateThread(work.threadId, { metadata: JSON.stringify({ workspacePath: fixtures.workspace, agentMode: "workflow" }) })
  await expect(history.resolve(work, historySource)).resolves.toMatchObject({ detached: true })
  await expect(invoke("authorize-delivery", source)).resolves.toMatchObject({ filePath: file.attachmentPath })
  const receiverRow = db.createThread(`receiver-${origin}`, { workspacePath: fixtures.workspace })
  const receiver = { ...work, id: "receiver", threadId: receiverRow.thread_id, conversation: undefined }
  const receiverStorage = workAttachmentStorage(fixtures.workspace, receiver)!
  const [forward] = createBotDeliveryTools(fixtures.workspace, signal, undefined,
    { workspacePath: fixtures.workspace, files: [file] }, false, receiverStorage, receiver.id)
  const [forwarded] = parseBotFileDelivery(String(await forward.invoke({ files: [file.filePath] })))!
  expect(forwarded.attachmentRoot).toBe(receiverStorage)
  expect(await readdir(fixtures.workspace)).toEqual(["report.txt"])
  // A retained delivery is not a mutable project file. Matching length alone
  // must not let a changed snapshot masquerade as the original formal result.
  await writeFile(file.attachmentPath!, "version corrupted")
  expect((await stat(file.attachmentPath!)).size).toBe(file.size)
  await expect(invoke("authorize-delivery", source)).rejects.toThrow("原交付附件的字节已变化")
  await expect(invoke("export-delivery", source)).rejects.toThrow("原交付附件的字节已变化")
  await expect(readFile(fixtures.saved, "utf8")).resolves.toBe("version delivered")
  await writeFile(file.attachmentPath!, "version delivered")
  await expect(invoke("authorize-delivery", source)).resolves.toMatchObject({ filePath: file.attachmentPath })
  await deleteProjectThreadDataDirectory(fixtures.workspace, work.threadId)
  await expect(readFile(file.attachmentPath!)).rejects.toHaveProperty("code", "ENOENT")
  await expect(readFile(forwarded.attachmentPath!, "utf8")).resolves.toBe("version delivered")
  await expect(readFile(projectFile, "utf8")).resolves.toBe("later replacement")
  db.deleteThread(work.threadId)
  db.createThread(work.threadId, { workspacePath: fixtures.workspace })
  db.upsertThreadMessages(work.threadId, messages)
  await expect(history.resolve(work, historySource)).rejects.toThrow("原交付")
  await expect(invoke("authorize-delivery", source)).rejects.toThrow("原交付")
})

it.each(["bound managed", "bound managed decomposed", "bound legacy", "unexposed directory", "unexposed default"])("reads formal Markdown images and limits workspace images to live deliveries (%s)", async mode => {
  const workspaceName = mode === "bound managed decomposed" ? "Cafe\u0301" : mode
  const workspace = join(fixtures.root, `markdown-project-${workspaceName}`)
  const reports = join(workspace, "reports")
  await mkdir(reports, { recursive: true })
  const markdown = join(reports, "report.md")
  const chart = join(workspace, "chart.png")
  const chartCaseAlias = join(workspace, "Chart.PNG")
  const chartAlias = join(reports, "chart-link.png")
  const unrecordedChartAlias = join(reports, "other-chart-link.png")
  const sameNameChart = join(reports, "chart.png")
  const workspaceImage = join(reports, "notes.png")
  const outside = join(fixtures.root, "unrelated.png")
  const reportBody = [
    "![Chart](../chart.png)", "![Case alias](../Chart.PNG)", "![Chart alias](chart-link.png)",
    "![Unrecorded chart alias](other-chart-link.png)", "![Other chart](chart.png)", "![Notes](notes.png)"
  ].join("\n")
  await writeFile(markdown, reportBody)
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC", "base64")
  const revisedImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64")
  await writeFile(chart, image)
  const caseInsensitiveWorkspace = await readFile(chartCaseAlias).then(() => true, () => false)
  if (!caseInsensitiveWorkspace) await writeFile(chartCaseAlias, revisedImage)
  await symlink("../chart.png", chartAlias)
  await symlink("../chart.png", unrecordedChartAlias)
  await writeFile(sameNameChart, revisedImage)
  await writeFile(workspaceImage, revisedImage)
  await writeFile(outside, "unrelated image")
  const database = mode === "unexposed default" ? new NativeSqliteAdapter(new DatabaseSync(":memory:")) : undefined
  const store = database && new BotStore(database)
  const bot = store?.create({ name: "Markdown", instructions: "", color: "#123456", modelRef: null })
  const nativeWork = bot && store?.createWork({ botId: bot.id, operationId: "create-markdown", title: "Report", goal: "Deliver the report" },
    undefined, { kind: "default", path: workspace }).work
  const nativeMetadata = {
    workspacePath: workspace, botId: bot?.id ?? "bot", botHostId: "local", botWorkId: nativeWork?.id ?? "markdown-work",
    botAudienceKey: "desktop"
  }
  const unexposed = mode.startsWith("unexposed")
  const origin = unexposed ? "created" : "existing"
  const boundMetadata = { ...nativeMetadata, botLocalConversation: true, botWorkOrigin: origin }
  const metadata = unexposed ? nativeMetadata : boundMetadata
  const row = db.createThread(nativeWork?.threadId ?? `markdown-thread-${mode}`, metadata)
  if (nativeWork) store!.initializeWorkThread(nativeWork.botId, nativeWork.id)
  const ref = { kind: "local_thread" as const, threadId: row.thread_id, incarnation: captureThreadIncarnation(row) }
  const work = {
    id: nativeMetadata.botWorkId, botId: nativeMetadata.botId, threadId: row.thread_id, audienceKey: "desktop",
    ...(unexposed
      ? { workspace: nativeWork?.workspace ?? { kind: "directory", path: workspace } }
      : { conversation: { origin, state: "bound", ref } })
  } as BotWorkItem
  let owners = nativeWork ? store!.desktopDeliveryWorks(row.thread_id) : [work]
  fixtures.mediaHost = { desktopDeliveryWorks: () => owners } as unknown as LocalBotHost
  const storage = mode === "bound legacy" ? undefined : workAttachmentStorage(workspace, work)
  const defaultReceipt = nativeWork ? botAttachmentReceiptKey(row.thread_id, row) : undefined
  const recordsAliases = Boolean(storage || defaultReceipt)
  const [deliver] = createBotDeliveryTools(workspace, new AbortController().signal,
    undefined, undefined, false, storage, work.id, undefined, defaultReceipt)
  const content = String(await deliver.invoke({ files: ["reports/report.md",
    ...(recordsAliases ? ["reports/chart-link.png"] : []), "chart.png", "reports/chart.png"] }))
  const [file, chartSnapshot, sameNameSnapshot] = parseBotFileDelivery(content)!
  if (nativeWork) {
    expect(storage).toBeUndefined()
    expect(file.attachmentRoot).toBeUndefined()
    expect(file.attachmentPath).toContain(join(workspace, ".bot-deliveries"))
    expect(JSON.parse(content)).toMatchObject({ receiptThread: defaultReceipt, receiptWorkId: nativeWork.id })
  }
  const messages = [
    { id: "assistant", role: "assistant" as const, content: "", created_at: new Date(),
      tool_calls: [{ id: "delivery", name: "bot_deliver_files", args: {} }] },
    { id: "receipt", role: "tool" as const, content, created_at: new Date(),
      name: "bot_deliver_files", tool_call_id: "delivery" }
  ]
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
  const ipc = {
    handle: (name: string, handler: Parameters<IpcMain["handle"]>[1]) => handlers.set(name, handler)
  } as unknown as IpcMain
  registerBotFileHandlers(ipc, () => fixtures.mediaHost!)
  registerWorkspaceFilePreviewHandlers(ipc)
  const frame = {}
  const sender = { id: 12346, mainFrame: frame, once: vi.fn(), isDestroyed: () => false }
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const receipt = { threadId: row.thread_id, assistantMessageId: "assistant", callId: "delivery", fileIndex: 0 }
  const legacyReceipt = { ...receipt, assistantMessageId: "legacy-assistant", callId: "legacy-delivery" }
  let redeliveredSource: typeof receipt | undefined
  const authorize = (source = receipt) => handlers.get("bots:files:authorize-delivery")!(event, "local", source)
  const openImage = (filePath: string, source = receipt) => handlers.get("workspace:filePreviewOpenMedia")!(event, {
    source: { threadId: row.thread_id, filePath, workspacePathKind: "absolute" },
    botDeliveryImage: source, lane: "delivery-image", requestToken: "review"
  })
  const expectImage = async (filePath: string, expected: Buffer, source = receipt) => {
    const media = await openImage(filePath, source)
    expect(media).toMatchObject({ success: true, inlineAllowed: true, mimeType: "image/png" })
    try {
      const response = await handleWorkspaceFilePreviewProtocolRequest(new Request(media.previewUrl))
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expected)
    } finally {
      await handlers.get("workspace:filePreviewRelease")!(event, { previewUrl: media.previewUrl })
    }
  }
  try {
    if (nativeWork) {
      // Existing default-workspace deliveries keep the original preview on the
      // exact native thread before the user has ever opened it in the workbench.
      db.upsertThreadMessages(row.thread_id, [
        { ...messages[0], id: legacyReceipt.assistantMessageId,
          tool_calls: [{ id: legacyReceipt.callId, name: "bot_deliver_files", args: {} }] },
        { ...messages[1], id: "legacy-receipt", tool_call_id: legacyReceipt.callId,
          content: JSON.stringify({ kind: "bot-file-delivery", files: [file] }) }
      ])
      expect(await authorize(legacyReceipt)).toMatchObject({ filePath: file.attachmentPath, markdownBasePath: markdown })
      await expectImage(chart, image, legacyReceipt)
    }
    db.upsertThreadMessages(row.thread_id, messages)
    await writeFile(markdown, "replacement in the working tree")
    await writeFile(chart, revisedImage)
    await writeFile(sameNameChart, image)
    const authorized = await authorize()
    expect(authorized).toMatchObject({ filePath: file.attachmentPath, markdownBasePath: markdown })
    await expect(resolveExternalFileReadGrant(authorized.grant, sender.id, chart)).resolves.toHaveProperty("error")
    await expect(handlers.get("workspace:filePreviewRead")!(event, {
      source: { externalGrant: authorized.grant, filePath: authorized.filePath },
      lane: "delivery-body", requestToken: "review"
    })).resolves.toMatchObject({ success: true, content: reportBody })
    const directImage = await authorize({ ...receipt, fileIndex: 1 })
    await expect(readFile(directImage.filePath)).resolves.toEqual(image)
    await expectImage(chart, image)
    await expectImage(chartCaseAlias, caseInsensitiveWorkspace ? image : revisedImage)
    await expectImage(unrecordedChartAlias, image)
    await expectImage(sameNameChart, revisedImage)
    await expectImage(workspaceImage, revisedImage)
    if (recordsAliases) await expectImage(chartAlias, image)
    if (nativeWork) await expectImage(chart, revisedImage, legacyReceipt)
    await rm(chart)
    await expectImage(chart, image)
    await expect(openImage(unrecordedChartAlias)).resolves.toMatchObject({ success: false })
    if (caseInsensitiveWorkspace)
      await expect(openImage(chartCaseAlias)).resolves.toMatchObject({ success: false })
    if (recordsAliases) {
      await expectImage(chartAlias, image)
      await rm(chartAlias)
      await symlink("notes.png", chartAlias)
      await expectImage(chartAlias, image)
      await rm(chartAlias)
      await expectImage(chartAlias, image)
    }
    await writeFile(chart, revisedImage)
    expect(revisedImage.length).toBe(image.length)
    await writeFile(chartSnapshot.attachmentPath!, revisedImage)
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    await rm(chartSnapshot.attachmentPath!)
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    const redirectedSnapshot = join(dirname(chartSnapshot.attachmentPath!), "redirected.png")
    await writeFile(redirectedSnapshot, image)
    await symlink(redirectedSnapshot, chartSnapshot.attachmentPath!)
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    await rm(chartSnapshot.attachmentPath!)
    await writeFile(chartSnapshot.attachmentPath!, image)

    const replaceReceipt = (body: string, resultId = messages[1].id) => db.getDb().run(
      "UPDATE thread_messages SET content_json = ? WHERE thread_id = ? AND message_id = ?",
      [JSON.stringify(body), row.thread_id, resultId]
    )
    const replaceImageRecord = (...images: BotDeliveredFile[]) =>
      replaceReceipt(JSON.stringify({ ...JSON.parse(content), files: [file, ...images] }))
    if (recordsAliases) {
      await symlink("notes.png", chartAlias)
      replaceReceipt(JSON.stringify({ ...JSON.parse(content),
        fileAliases: [["reports/chart-link.png", 1], ["reports/chart-link.png", 2]] }))
      await expect(openImage(chartAlias)).resolves.toMatchObject({ success: false })
      replaceReceipt(content)
      await rm(chartAlias)

      const selection = { attachmentPath: file.attachmentPath!, filePath: file.filePath }
      const redeliver = async (id: string, additionalFiles: BotHistoricalDeliveryReference[] = [],
        selected: BotHistoricalDeliveryReference = selection) => {
        const requestId = `user-${id}`
        db.upsertThreadMessages(row.thread_id, [{
          id: requestId, role: "user", content: "Send me the original report", created_at: new Date()
        }])
        const [tool] = createBotDeliveryTools(workspace, new AbortController().signal, undefined, undefined,
          false, storage, work.id, undefined, defaultReceipt,
          async reference => findHistoricalBotWorkDelivery(work, [requestId], storage ?? workspace, reference, "deliver")?.receipt)
        const reply = await tool.invoke({ type: "tool_call", id, name: tool.name,
          args: { files: [selected, ...additionalFiles] } })
        if (!ToolMessage.isInstance(reply) || typeof reply.content !== "string")
          throw new Error("expected the model-facing delivery tool receipt")
        const body = reply.content
        const source = { ...receipt, assistantMessageId: `assistant-${id}`, callId: id }
        db.upsertThreadMessages(row.thread_id, [
          { ...messages[0], id: source.assistantMessageId,
            tool_calls: [{ id, name: "bot_deliver_files", args: {} }] },
          { ...messages[1], id: `result-${id}`, tool_call_id: id, content: body,
            is_error: reply.status === "error" }
        ])
        return { source, body, status: reply.status }
      }
      // This fixture also seeds an older native MD-only legacy receipt.
      const resend = await redeliver("redeliver", [], nativeWork ? { ...selection, source: receipt } : selection)
      redeliveredSource = resend.source
      expect(parseBotFileDelivery(resend.body)).toEqual([file])
      const resent = await authorize(resend.source)
      await expect(handlers.get("workspace:filePreviewRead")!(event, {
        source: { externalGrant: resent.grant, filePath: resent.filePath },
        lane: "delivery-body", requestToken: "review"
      })).resolves.toMatchObject({ success: true, content: reportBody })
      await expectImage(chart, image, resend.source)
      await expectImage(chartAlias, image, resend.source)
      await expectImage(sameNameChart, revisedImage, resend.source)
      await expectImage(workspaceImage, revisedImage, resend.source)
      const again = await redeliver("redeliver-again", ["chart.png"],
        nativeWork ? { ...selection, source: resend.source } : selection)
      expect(JSON.parse(again.body).markdownSources).toEqual(JSON.parse(resend.body).markdownSources)
      expect(parseBotFileDelivery(again.body)).toHaveLength(2)
      await expectImage(chart, image, again.source)
      const newChart = await authorize({ ...again.source, fileIndex: 1 })
      await expect(readFile(newChart.filePath)).resolves.toEqual(revisedImage)
      await rm(chart)
      await expectImage(chart, image, again.source)
      await writeFile(chart, revisedImage)

      await writeFile(markdown, reportBody)
      const secondBatch = async (id: string) => {
        const body = String(await deliver.invoke({ files: ["reports/report.md", "chart.png"] }))
        const [report, chart] = parseBotFileDelivery(body)!
        expect(report).toEqual(file)
        expect(chart.attachmentPath).not.toBe(chartSnapshot.attachmentPath)
        const source = { ...receipt, assistantMessageId: `assistant-${id}`, callId: id }
        db.upsertThreadMessages(row.thread_id, [
          { ...messages[0], id: source.assistantMessageId,
            tool_calls: [{ id, name: "bot_deliver_files", args: {} }] },
          { ...messages[1], id: `result-${id}`, tool_call_id: id, content: body }
        ])
        return source
      }
      const second = await secondBatch("second-formal")
      await expectImage(chart, image)
      await expectImage(chart, revisedImage, second)

      const selectBatch = async (id: string) => {
        const { body, status } = await redeliver(id)
        expect(status).toBe("error")
        const conflict = JSON.parse(body) as {
          deliveryChoices: Array<{ selection: BotHistoricalDeliveryReference }>
        }
        expect(conflict).toMatchObject({ ok: false, moreDeliveryChoices: false })
        expect(conflict.deliveryChoices).toMatchObject([
          ...(nativeWork ? [{ selection: { ...selection, source: legacyReceipt }, deliveredAt: expect.any(Number) }] : []),
          { selection: { ...selection, source: receipt }, deliveredAt: expect.any(Number) },
          { selection: { ...selection, source: second }, deliveredAt: expect.any(Number) }
        ])
        return conflict.deliveryChoices.slice(-2).map(choice => choice.selection)
      }
      const [chooseFirst, chooseSecond] = await selectBatch("ambiguous")
      const firstExact = await redeliver("first-exact", [], chooseFirst)
      const secondExact = await redeliver("second-exact", [], chooseSecond)
      expect(parseBotFileDelivery(firstExact.body)).toEqual([file])
      expect(parseBotFileDelivery(secondExact.body)).toEqual([file])
      await expectImage(chart, image, firstExact.source)
      await expectImage(chart, revisedImage, secondExact.source)
      await expectImage(chartCaseAlias, caseInsensitiveWorkspace ? image : revisedImage, firstExact.source)
      await expectImage(unrecordedChartAlias, image, firstExact.source)
      await expectImage(unrecordedChartAlias, revisedImage, secondExact.source)
      expect(JSON.parse((await redeliver("two-distinct-batches", [chooseSecond], chooseFirst)).body))
        .toMatchObject({ ok: false, error: expect.stringContaining("选择了不同版本") })

      if (mode === "bound managed") {
        // Repeat a resend through its own receipt. It must always flatten to
        // the first original, even when repeats occupy more than a lookup page.
        let repeatSource = firstExact.source
        for (let index = 0; index < 9; index++) {
          const repeat = await redeliver(`same-original-${index}`, [], { ...selection, source: repeatSource })
          expect(JSON.parse(repeat.body).markdownSources).toEqual(JSON.parse(firstExact.body).markdownSources)
          repeatSource = repeat.source
        }
        await expectImage(chart, image, repeatSource)
        await selectBatch("ambiguous-after-repeats")

        for (let index = 0; index < 7; index++) {
          await writeFile(chart, Buffer.concat([revisedImage, Buffer.from([index])]))
          await secondBatch(`more-formal-${index}`)
        }
        const limited = JSON.parse((await redeliver("ambiguous-bounded")).body)
        expect(limited).toMatchObject({ ok: false, moreDeliveryChoices: true })
        expect(limited.deliveryChoices).toHaveLength(8)
        const earliest = await redeliver("earliest-with-many-batches", [], chooseFirst)
        await expectImage(chart, image, earliest.source)
        await writeFile(chart, revisedImage)
      }

      replaceReceipt(JSON.stringify({ ...JSON.parse(content), receiptWorkId: "different-work" }))
      await expect(openImage(chart, again.source)).resolves.toMatchObject({ success: false })
      replaceReceipt(JSON.stringify({ ...JSON.parse(content), markdownSources: JSON.parse(resend.body).markdownSources }))
      await expect(openImage(chart, again.source)).resolves.toMatchObject({ success: false })
      replaceReceipt(content)
      const other = db.createThread(`other-${row.thread_id}`, metadata)
      db.upsertThreadMessages(other.thread_id, [
        { ...messages[0], id: "other-thread-assistant" }, messages[1]
      ])
      replaceReceipt(JSON.stringify({ ...JSON.parse(again.body), markdownSources: {
        0: { threadId: other.thread_id, assistantMessageId: "other-thread-assistant",
          callId: "delivery", resultId: "receipt", fileIndex: 0 }
      } }), "result-redeliver-again")
      await expect(openImage(chart, again.source)).resolves.toMatchObject({ success: false })
    }
    replaceImageRecord({ filePath: chart, name: chartSnapshot.name, size: image.length }, sameNameSnapshot)
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    replaceImageRecord({ ...chartSnapshot, size: image.length + 1 }, sameNameSnapshot)
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    if (storage) {
      const otherWorkspace = join(fixtures.root, `other-markdown-project-${mode}`)
      await mkdir(otherWorkspace)
      const otherStorage = workAttachmentStorage(otherWorkspace, work)!
      const otherSnapshot = join(otherStorage, ".bot-deliveries", basename(dirname(chartSnapshot.attachmentPath!)), basename(chart))
      await mkdir(dirname(otherSnapshot), { recursive: true })
      await writeFile(otherSnapshot, image)
      replaceImageRecord({ ...chartSnapshot, attachmentRoot: otherStorage, attachmentPath: otherSnapshot })
      await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    }
    replaceImageRecord(chartSnapshot, { ...chartSnapshot, filePath: `${workspace}${sep}.${sep}${basename(chart)}` })
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    await expect(openImage(unrecordedChartAlias)).resolves.toMatchObject({ success: false })
    replaceReceipt(content)
    await expectImage(chart, image)

    await expect(openImage(markdown)).resolves.toMatchObject({ success: false })
    await expect(openImage(outside)).resolves.toMatchObject({ success: false })
    const symlinkPath = join(workspace, "outside.png")
    await symlink(outside, symlinkPath)
    await expect(openImage(symlinkPath)).resolves.toMatchObject({ success: false })
    await rm(unrecordedChartAlias)
    await symlink(outside, unrecordedChartAlias)
    await expect(openImage(unrecordedChartAlias)).resolves.toMatchObject({ success: false })
    db.updateThread(row.thread_id, { metadata: JSON.stringify({ ...metadata, workspacePath: fixtures.root }) })
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    db.updateThread(row.thread_id, { metadata: JSON.stringify({ ...metadata, remoteState: "remote" }) })
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    db.updateThread(row.thread_id, { metadata: JSON.stringify(metadata) })
    // A legacy active grant may predate the current mutual exclusion of linking and remote access.
    await imRemoteGrantStore.enableThreadGrant({
      threadId: row.thread_id, title: "Original report",
      route: { principalId: "owner", conversationKey: "legacy-remote-route" }
    })
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    await imRemoteGrantStore.revokeThreadGrant(row.thread_id)
    owners = []
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    owners = [work]

    if (storage) {
      const movedWorkspace = `${workspace}-moved`
      await rename(workspace, movedWorkspace)
      try {
        await expect(authorize()).resolves.toMatchObject({ filePath: file.attachmentPath, markdownBasePath: markdown })
        await expectImage(chart, image)
        expect(redeliveredSource).toBeDefined()
        await expectImage(chart, image, redeliveredSource)
        await expectImage(chartAlias, image)
        await expectImage(chartAlias, image, redeliveredSource)
        for (const path of [unrecordedChartAlias, workspaceImage, join(movedWorkspace, basename(chart))])
          await expect(openImage(path)).resolves.toMatchObject({ success: false })
      } finally {
        await rename(movedWorkspace, workspace)
      }
    }

    if (unexposed) {
      work.conversation = { origin, state: "bound", ref }
      db.updateThread(row.thread_id, { metadata: JSON.stringify(boundMetadata) })
      expect(await authorize()).toHaveProperty("markdownBasePath", markdown)
      if (nativeWork) expect(await authorize(legacyReceipt)).toHaveProperty("markdownBasePath", markdown)
    }
    work.conversation!.state = "detaching"
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    if (nativeWork) await expect(openImage(chart, legacyReceipt)).resolves.toMatchObject({ success: false })
    work.conversation!.state = "detached"
    db.updateThread(row.thread_id, { metadata: JSON.stringify({ workspacePath: workspace }) })
    await expect(authorize()).resolves.toMatchObject({ filePath: file.attachmentPath })
    if (recordsAliases) {
      expect(await authorize()).toHaveProperty("markdownBasePath", markdown)
      await expectImage(chart, image)
      await expectImage(chartAlias, image)
      expect(redeliveredSource).toBeDefined()
      await expectImage(chart, image, redeliveredSource)
      await expectImage(chartAlias, image, redeliveredSource)
      await rm(unrecordedChartAlias)
      await symlink("../chart.png", unrecordedChartAlias)
      await expect(openImage(unrecordedChartAlias)).resolves.toMatchObject({ success: false })
      await expect(openImage(chartCaseAlias)).resolves.toMatchObject({ success: false })
      await expect(openImage(workspaceImage)).resolves.toMatchObject({ success: false })
      await expect(openImage(workspaceImage, redeliveredSource)).resolves.toMatchObject({ success: false })
      if (mode === "bound managed") {
        // The original ordinary conversation may be granted IM access after unlinking.
        const grant = await imRemoteGrantStore.enableThreadGrant({
          threadId: row.thread_id, title: "Detached report",
          route: { principalId: "owner", conversationKey: "post-detach-route" }
        })
        expect(grant.state).toBe("active")
        try {
          expect(await authorize()).toHaveProperty("markdownBasePath", markdown)
          await expectImage(chart, image)
          await expectImage(chartAlias, image, redeliveredSource)
          await expect(openImage(workspaceImage)).resolves.toMatchObject({ success: false })
          await expect(openImage(unrecordedChartAlias)).resolves.toMatchObject({ success: false })
        } finally {
          await imRemoteGrantStore.revokeThreadGrant(row.thread_id)
        }
        expect(imRemoteGrantStore.getThreadGrant(row.thread_id)?.state).toBe("revoked")
        await expectImage(chart, image)
        await expect(openImage(workspaceImage)).resolves.toMatchObject({ success: false })
      }
      await writeFile(chartSnapshot.attachmentPath!, revisedImage)
      await expect(openImage(chart)).resolves.toMatchObject({ success: false })
      await writeFile(chartSnapshot.attachmentPath!, image)
    } else {
      expect(await authorize()).not.toHaveProperty("markdownBasePath")
      await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    }
    if (nativeWork) await expect(openImage(chart, legacyReceipt)).resolves.toMatchObject({ success: false })

    const replacement = { ...work, id: "replacement-work",
      conversation: { ...work.conversation!, state: "bound" as const } }
    owners = [replacement, work]
    db.updateThread(row.thread_id, { metadata: JSON.stringify({ ...boundMetadata, botWorkId: replacement.id }) })
    if (recordsAliases) {
      expect(await authorize()).toHaveProperty("markdownBasePath", markdown)
      await expectImage(chart, image)
      await expect(openImage(workspaceImage)).resolves.toMatchObject({ success: false })
    } else {
      expect(await authorize()).not.toHaveProperty("markdownBasePath")
      await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    }

    owners = [work]
    db.deleteThread(row.thread_id)
    db.createThread(row.thread_id, boundMetadata)
    db.upsertThreadMessages(row.thread_id, messages)
    work.conversation!.state = "bound"
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
  } finally {
    fixtures.mediaHost = undefined
    database?.close()
  }
})

it.each(["managed", "default"] as const)("previews only exact same-batch snapshots in a forwarded peer Markdown report (%s)", async (kind) => {
  const database = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(database)
  const host = new LocalBotHost(store, { acquire: () => null, onAvailable: () => () => {} })
  fixtures.mediaHost = host
  try {
    const workspace = join(fixtures.root, `forwarded-markdown-work-${kind}`)
    const peer = join(fixtures.root, `forwarded-markdown-peer-${kind}`)
    await mkdir(workspace)
    await mkdir(join(peer, "reports"), { recursive: true })
    await mkdir(join(peer, "images"))
    const markdown = join(peer, "reports", "report.md")
    const chart = join(peer, "images", "chart.png")
    const alias = join(peer, "images", "alias.png")
    const missing = join(peer, "images", "not-delivered.png")
    const currentWorkspaceImage = join(workspace, "images", "chart.png")
    const oldImportImage = join(workspace, "shared", "images", "chart.png")
    const body = [
      "![Chart](../images/chart.png)", "![Unrecorded alias](../images/alias.png)",
      "![Unpublished](../images/not-delivered.png)"
    ].join("\n")
    const originalImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC", "base64")
    const revisedImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64")
    await writeFile(markdown, body)
    await writeFile(chart, originalImage)
    await symlink("chart.png", alias)
    await writeFile(missing, revisedImage)
    const bot = store.create({ name: "Reports", instructions: "", color: "#123456", modelRef: null })
    const input = { botId: bot.id, operationId: "peer-report", title: "Report", goal: "Deliver the report" }
    const native = kind === "default" ? store.createWork(input, undefined, { kind, path: workspace }).work : undefined
    const row = db.createThread(native?.threadId ?? "forwarded-markdown-work", { workspacePath: workspace })
    const ref = { kind: "local_thread" as const, threadId: row.thread_id, incarnation: captureThreadIncarnation(row) }
    const work = native ?? store.conversations.prepare({ ...input, conversation: ref })
    if (native) store.initializeWorkThread(bot.id, work.id)
    const deliveryWork = native ?? store.conversations.bound(bot.id, work.id, ref)
    db.updateThread(row.thread_id, { metadata: JSON.stringify({
      workspacePath: workspace, botId: bot.id, botHostId: "local", botWorkId: work.id, botAudienceKey: "desktop",
      ...(native ? {} : { botLocalConversation: true, botWorkOrigin: "existing" })
    }) })
    const storage = workAttachmentStorage(workspace, deliveryWork)
    expect(Boolean(storage)).toBe(kind === "managed")
    const signal = new AbortController().signal
    let peerFiles: BotDeliveredFile[] = []
    const [returnFiles] = createBotReturnFileTools(peer, signal, files => { peerFiles = files })
    await returnFiles.invoke({ files: ["reports/report.md", "images/chart.png"] })
    expect(peerFiles.map(file => file.filePath)).toEqual([markdown, chart])
    await writeFile(chart, revisedImage)
    const [deliver] = createBotDeliveryTools(workspace, signal, undefined, { workspacePath: peer, files: peerFiles },
      false, storage, work.id, undefined, botAttachmentReceiptKey(row.thread_id, row), async () => undefined)
    const args = { files: peerFiles.map(({ filePath, attachmentPath }) => ({ filePath, attachmentPath })) }
    const content = String(await deliver.invoke(args))
    const files = parseBotFileDelivery(content)!
    expect(files.map(file => [file.filePath, file.attachmentRoot])).toEqual([[markdown, storage], [chart, storage]])
    expect(await readdir(workspace)).toEqual(native ? [".bot-deliveries"] : [])
    const [report, image] = files
    await expect(readFile(report.attachmentPath!, "utf8")).resolves.toBe(body)
    await expect(readFile(image.attachmentPath!)).resolves.toEqual(originalImage)
    db.upsertThreadMessages(row.thread_id, [
      { id: "peer-assistant", role: "assistant", content: "", created_at: new Date(),
        tool_calls: [{ id: "peer-delivery", name: "bot_deliver_files", args }] },
      { id: "peer-receipt", role: "tool", content, created_at: new Date(),
        name: "bot_deliver_files", tool_call_id: "peer-delivery" }
    ])

    const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
    const ipc = { handle: (name: string, handler: Parameters<IpcMain["handle"]>[1]) =>
      handlers.set(name, handler) } as unknown as IpcMain
    registerBotFileHandlers(ipc, () => host)
    registerWorkspaceFilePreviewHandlers(ipc)
    const frame = {}, sender = { id: 12348, mainFrame: frame, once: vi.fn(), isDestroyed: () => false }
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const source = { threadId: row.thread_id, assistantMessageId: "peer-assistant", callId: "peer-delivery", fileIndex: 0 }
    const authorize = () => handlers.get("bots:files:authorize-delivery")!(event, "local", source)
    const openImage = (filePath: string) => handlers.get("workspace:filePreviewOpenMedia")!(event, {
      source: { threadId: row.thread_id, filePath, workspacePathKind: "absolute" },
      botDeliveryImage: source, lane: "peer-markdown-image", requestToken: "peer-report"
    })
    const expectOriginalImage = async () => {
      const receipt = await authorize()
      expect(receipt).toMatchObject({ filePath: report.attachmentPath, markdownBasePath: markdown })
      const media = await openImage(join(dirname(receipt.markdownBasePath), "../images/chart.png"))
      expect(media).toMatchObject({ success: true, inlineAllowed: true, mimeType: "image/png" })
      try {
        const response = await handleWorkspaceFilePreviewProtocolRequest(new Request(media.previewUrl))
        expect(Buffer.from(await response.arrayBuffer())).toEqual(originalImage)
      } finally {
        await handlers.get("workspace:filePreviewRelease")!(event, { previewUrl: media.previewUrl })
      }
    }
    for (const decoy of [currentWorkspaceImage, oldImportImage]) {
      await mkdir(dirname(decoy), { recursive: true })
      await writeFile(decoy, revisedImage)
    }
    await expectOriginalImage()
    for (const path of [alias, missing, currentWorkspaceImage, oldImportImage])
      await expect(openImage(path)).resolves.toMatchObject({ success: false })

    if (!native) await rename(workspace, `${workspace}-moved`)
    await rm(peer, { recursive: true })
    await expectOriginalImage()
    for (const path of [alias, missing, currentWorkspaceImage, oldImportImage])
      await expect(openImage(path)).resolves.toMatchObject({ success: false })
    await writeFile(image.attachmentPath!, revisedImage)
    await expect(openImage(chart)).resolves.toMatchObject({ success: false })
    await writeFile(image.attachmentPath!, originalImage)

    if (!native) {
      store.conversations.beginDetach(bot.id, work.id, store.getWork(bot.id, work.id).version)
      store.conversations.detached(bot.id, work.id)
      db.updateThread(row.thread_id, { metadata: JSON.stringify({ workspacePath: workspace }) })
      await expectOriginalImage()
      await expect(openImage(currentWorkspaceImage)).resolves.toMatchObject({ success: false })
    }
  } finally {
    fixtures.mediaHost = undefined
    await host.stop()
    database.close()
  }
})

it("opens and saves the original formal receipt after relinking and deleting its Bot", async () => {
  const database = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(database)
  const host: LocalBotHost = new LocalBotHost(store, {
    acquire: () => null, onAvailable: () => () => {},
    workHistory: createLocalBotWorkHistory(() => host)
  })
  try {
    setBotHistoryInputSource({ works: id => host.desktopDeliveryWorks(id),
      inputs: (botId, id, ids, workIds) => host.inputProjections(botId, id, ids, workIds) })
    const workspace = join(fixtures.root, "project", "rebound-history")
    await mkdir(workspace)
    const row = db.createThread("rebound-history", { workspacePath: workspace })
    const ref = { kind: "local_thread" as const, threadId: row.thread_id, incarnation: captureThreadIncarnation(row) }
    const associate = (name: string) => {
      const bot = store.create({ name, instructions: "", color: "#123456", modelRef: null })
      const work = store.conversations.prepare({ botId: bot.id, operationId: name, conversation: ref, title: name, goal: "Report" })
      const bound = store.conversations.bound(bot.id, work.id, ref)
      db.updateThread(ref.threadId, { metadata: JSON.stringify({ workspacePath: workspace, botId: bot.id,
        botWorkId: work.id, botLocalConversation: true, botHostId: "local", botAudienceKey: "desktop",
        botWorkOrigin: "existing" }) })
      return { bot, work: bound }
    }
    const original = associate("original")
    const requests = [["rejected-input", null], ["rewritten-input", "Approved material"]] as const
    for (const [requestId, approved] of requests) {
      const task = store.enqueue({ botId: original.bot.id, workId: original.work.id, requestId, message: "Removed material" })
      store.transition(task.id, "running")
      store.beginInputPreparation(task.id)
      if (approved !== null) store.recordPreparedInput(task.id, approved)
      store.settle(task.id, approved === null ? "failed" : "completed", null)
      db.upsertThreadMessages(ref.threadId, [{ id: requestId, role: "user", content: task.message, created_at: new Date() }])
    }
    const filePath = join(workspace, "result.txt")
    await writeFile(filePath, "first result")
    const storage = workAttachmentStorage(workspace, original.work)!
    const [deliver] = createBotDeliveryTools(workspace, new AbortController().signal,
      undefined, undefined, false, storage, original.work.id)
    const content = String(await deliver.invoke({ files: ["result.txt"] }))
    const [file] = parseBotFileDelivery(content)!
    db.upsertThreadMessages(ref.threadId, [
      { id: "old-assistant", role: "assistant", content: "", created_at: new Date(),
        tool_calls: [{ id: "old-delivery", name: "bot_deliver_files", args: {} }] },
      { id: "old-receipt", role: "tool", content, created_at: new Date(), name: "bot_deliver_files", tool_call_id: "old-delivery" }
    ])
    store.conversations.beginDetach(original.bot.id, original.work.id, store.getWork(original.bot.id, original.work.id).version)
    store.conversations.detached(original.bot.id, original.work.id)
    const replacement = associate("replacement")
    await writeFile(filePath, "second result")
    const source = { threadId: ref.threadId, assistantMessageId: "old-assistant", callId: "old-delivery", fileIndex: 0 }
    const incarnation = createHash("sha256").update(JSON.stringify(ref.incarnation)).digest("hex")
    const historySource = { workId: original.work.id, messageId: "old-assistant", incarnation }
    const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
    registerBotFileHandlers({
      handle: (name: string, handler: Parameters<IpcMain["handle"]>[1]) => handlers.set(name, handler)
    } as unknown as IpcMain, () => host)
    const frame = {}, sender = { id: 12347, mainFrame: frame, once: vi.fn() }
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
    const invoke = async (name: string) => handlers.get(`bots:files:${name}`)!(event, "local", source)
    await expect(invoke("authorize-delivery")).resolves.toMatchObject({ filePath: file.attachmentPath })
    await expect(host.resolveWorkHistorySource(original.bot.id, historySource)).resolves.toMatchObject({ detached: true })
    await host.remove(original.bot.id, original.bot.version, async deletedThreads => {
      expect(deletedThreads).not.toContain(ref.threadId)
    })
    expect(store.conversations.forThread(ref.threadId)?.id).toBe(replacement.work.id)
    expect(() => host.getWork(original.bot.id, original.work.id)).toThrow()
    const history = createLocalBotWorkHistory(() => host)
    const ids = requests.map(([id]) => id)
    expect(botHistoryInputProjection(ref.threadId, db.getThreadCore(ref.threadId)!,
      { botId: replacement.bot.id, workId: replacement.work.id })?.(ids)).toEqual(new Map(requests))
    await expect(history.query(replacement.work, { workId: replacement.work.id, query: "Removed material" }))
      .resolves.toMatchObject({ entries: [] })
    await expect(history.query(replacement.work, { workId: replacement.work.id, query: "Approved material" }))
      .resolves.toMatchObject({ entries: [{ source: { messageId: "rewritten-input" } }] })
    expect(db.getThreadMessagesByIds(ref.threadId, ids).map(message => message.content))
      .toEqual(["Removed material", "Removed material"])
    await expect(host.resolveWorkHistorySource(original.bot.id, historySource)).resolves.toMatchObject({ detached: true })
    await expect(host.resolveWorkHistorySource(replacement.bot.id, historySource)).rejects.toThrow()
    await expect(invoke("authorize-delivery")).resolves.toMatchObject({ filePath: file.attachmentPath })
    await expect(invoke("export-delivery")).resolves.toBe(true)
    await expect(readFile(fixtures.saved, "utf8")).resolves.toBe("first result")
    await expect(readFile(filePath, "utf8")).resolves.toBe("second result")
    store.conversations.beginDetach(replacement.bot.id, replacement.work.id, replacement.work.version)
    store.conversations.detached(replacement.bot.id, replacement.work.id)
    db.updateThread(ref.threadId, { metadata: JSON.stringify({ workspacePath: workspace }) })
    const ordinary = createBotOrdinaryThreads(() => host)
    await expect(ordinary.read({ conversation: ref, query: "Removed material" }))
      .resolves.toMatchObject({ entries: [] })
    await expect(ordinary.read({ conversation: ref, query: "Approved material" }))
      .resolves.toMatchObject({ entries: [{ source: { messageId: "rewritten-input" } }] })
    db.deleteThread(ref.threadId)
    db.createThread(ref.threadId, { workspacePath: workspace })
    await expect(host.resolveWorkHistorySource(original.bot.id, historySource)).rejects.toThrow()
    await expect(invoke("authorize-delivery")).rejects.toThrow()
  } finally {
    setBotHistoryInputSource(undefined)
    await host.stop()
    database.close()
  }
})
