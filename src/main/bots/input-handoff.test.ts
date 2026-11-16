import { afterEach, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, readFile, readdir, realpath, rm, writeFile, mkdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import { botImportDestination, copyBotFile, snapshotBotDeliveryFile } from "./file-copy"
import * as fileCopy from "./file-copy"
import { verifyInputFiles, retainedInputFileIds, workInputPinKey } from "./input-files"
import { buildAttachmentMessageParts } from "../../shared/attachment-message-parts"
import { createBotWorkTools } from "./work-tools"
import { createBotBrowserTools, createBotDeliveryTools } from "./tools"
import { deleteProjectThreadDataDirectory, getProjectThreadDataDirectory } from "../agent/context-history-path"
import { createBotInputHistoryResolver, workAttachmentStorage, workInputPinStorage } from "./attachment-storage"
import { parseBotFileDelivery } from "../../shared/bots/file-delivery"
import { captureBotWorkDeletionTarget, removeBotWork } from "./work-deletion"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import type { ThreadSummaryRow } from "../db"
import type { BotBrowserService } from "./browser"
import { localBotWorkspaces } from "./workspace"
import type { BotTask } from "../../shared/bots/contracts"
import type { BotWorkItem, BotWorkReceipt } from "../../shared/bots/work"
import { verifiedWorkResultThread } from "./work-result-thread"

const threadRows = vi.hoisted(() => new Map<string, ThreadSummaryRow>())
vi.mock("../db", () => ({
  getThreadCore: (id: string) => threadRows.get(id) ?? null,
  getDb: () => { throw new Error("Unexpected transcript database access") },
  saveToDisk: vi.fn(),
  flushStrict: vi.fn()
}))

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  try { for (const fn of cleanup.splice(0)) await fn() }
  finally { vi.unstubAllEnvs(); threadRows.clear() }
})
type TestSteer = (prepare: () => void, inject: () => boolean) => Promise<boolean | { rejected: true }>

async function fixture(
  interruptOnSteer = false, concurrency?: number, injectSteers: boolean | TestSteer = false,
  useLocalWorkspaces = false, now?: () => number
) {
  const root = await mkdtemp(join(tmpdir(), "bot-input-handoff-"))
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db, now)
  const bot = store.create({ name: "Attachments", instructions: "", color: "#ea2845", modelRef: null })
  const project = join(root, "project")
  await mkdir(project)
  const finishes = new Map<string, (state: "completed" | "failed" | "outcome_unknown" | "superseded") => void>()
  const host: LocalBotHost = new LocalBotHost(store, {
    onAvailable: () => () => {},
    workspaces: useLocalWorkspaces ? localBotWorkspaces :
      { resolve: async () => ({ kind: "directory", path: project }), projects: async () => ({ items: [], nextCursor: null }) },
    acquire: (_bot, task) => ({
      release() {},
      execute: signal => new Promise(resolve => {
        finishes.set(task.id, state => resolve({ state }))
        const abort = () => resolve({ state: "completed" })
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
      }),
      ...(interruptOnSteer ? { steer: async () => {
        // Model-round interruption leaves the incoming message in the Host inbox.
        finishes.get(task.id)!("superseded")
        return false
      } } : injectSteers ? { steer: async (incoming, beforeInject) => {
        host.beginInputPreparation(task.id, incoming.id)
        const prepare = () => host.recordPreparedInput(task.id, incoming.id, incoming.message)
        if (typeof injectSteers === "function") return injectSteers(prepare, beforeInject)
        prepare()
        return beforeInject()
      } } : {})
    })
  }, concurrency)
  cleanup.push(async () => { await host.stop(); db.close(); await rm(root, { recursive: true, force: true }) })
  const pick = async (name: string, content: string, storage = root) => {
    const source = join(root, name)
    await writeFile(source, content)
    const snapshot = await snapshotBotDeliveryFile(storage, source, new AbortController().signal, root)
    return store.retainInputFile(bot.id, { filename: name, filePath: source,
      content: `Original file retained in your workspace: ${JSON.stringify(source)}.\n\n${content}`,
      mimeType: "text/plain", size: Buffer.byteLength(content), truncated: false }, snapshot.attachmentPath)
  }
  return { root, project, db, store, bot, host, pick, finishes }
}

it("passes the selected immutable versions through real work tools, with replay before IO and no project writes", async () => {
  const f = await fixture()
  const one = await f.pick("sample.txt", "VERSION ONE"), two = await f.pick("sample.txt", "VERSION TWO")
  const body = "Create a separate task with the first sample" + buildAttachmentMessageParts([one, two]).attachmentModelBlocks
  const source = f.host.send({ botId: f.bot.id, requestId: "source", message: body, inputFileIds: [one.botInputId!, two.botInputId!] })
  await vi.waitFor(() => expect(f.store.getTask(source.id).state).toBe("running"))
  f.host.recordPreparedInput(source.id, source.id, body)
  const tools = createBotWorkTools(source, () => f.host, new AbortController().signal)
  const create = tools.find(tool => tool.name === "bot_work_create")!
  const args = { requestKey: "create", title: "Read", goal: "Read the supplied sample", inputFileIds: [one.botInputId!] }
  const response = await create.invoke({ type: "tool_call", id: "create", name: create.name, args }) as { content: string }
  const created = JSON.parse(response.content).receipt
  expect(created.task.message).toContain("VERSION ONE")
  expect(created.task.message).not.toContain("VERSION TWO")
  expect(created.task.origin.inputFileIds).toHaveLength(1)
  expect(created.task.origin.inputFileIds[0]).not.toBe(one.botInputId)
  const [target] = f.store.inputFiles(f.bot.id, created.task.origin.inputFileIds)
  expect(await readFile(target.file.filePath, "utf8")).toBe("VERSION ONE")
  expect(target.attachment!.filePath).toBe(target.file.filePath)
  expect(await readdir(f.project)).toEqual([])
  // Same request key under a replacement tool call recovers the exact accepted operation.
  await rm(target.file.filePath)
  const replay = await create.invoke({ type: "tool_call", id: "create-retry", name: create.name, args }) as { content: string }
  expect(JSON.parse(replay.content).receipt.task.id).toBe(created.task.id)
  const send = tools.find(tool => tool.name === "bot_work_send")!
  const sendArgs = { requestKey: "send", workId: created.work.id, message: "Now use the second sample", inputFileIds: [two.botInputId!] }
  const sent = JSON.parse((await send.invoke({ type: "tool_call", id: "send", name: send.name, args: sendArgs }) as { content: string }).content).receipt
  expect(sent.message).toContain("VERSION TWO")
  const [second] = f.store.inputFiles(f.bot.id, sent.origin.inputFileIds)
  await rm(second.file.filePath)
  const resent = JSON.parse((await send.invoke({ type: "tool_call", id: "send-retry", name: send.name, args: sendArgs }) as { content: string }).content).receipt
  expect(resent.id).toBe(sent.id)
  expect(f.store.recentTasks().filter(task => task.workId === created.work.id)).toHaveLength(2)
})

it("rejects removed, rewritten, duplicated, foreign and merely queued input blocks", async () => {
  const f = await fixture(), file = await f.pick("sample.txt", "PRIVATE VALUE")
  const block = buildAttachmentMessageParts([file]).attachmentModelBlocks
  const source = f.host.send({ botId: f.bot.id, requestId: "source", message: block, inputFileIds: [file.botInputId!] })
  await vi.waitFor(() => expect(f.store.getTask(source.id).state).toBe("running"))
  const input = { botId: f.bot.id, operationId: "create", title: "Read", goal: "Read", inputFileIds: [file.botInputId!] }
  const command = { taskId: source.id, callId: "create", key: "create" }
  for (const prepared of ["Only say hello", block.replace("PRIVATE VALUE", "[redacted]"), block + block]) {
    f.host.recordPreparedInput(source.id, source.id, prepared)
    await expect(f.host.createWork(input, command)).rejects.toThrow("未在当前请求")
    expect(f.store.listWorks(f.bot.id).items).toEqual([])
  }
  const later = f.host.send({ botId: f.bot.id, requestId: "later", message: block, inputFileIds: [file.botInputId!] })
  f.host.recordPreparedInput(source.id, later.id, block)
  expect(() => f.store.workInputFiles(source.id, [file.botInputId!])).toThrow("未在当前请求")
  expect(f.store.injectIntoRun(later.id, source.id)).toBe(true)
  expect(f.store.workInputFiles(source.id, [file.botInputId!])).toHaveLength(1)
  f.host.recordPreparedInput(source.id, source.id, block)
  f.host.recordPreparedInput(source.id, source.id, null)
  // Internal Goal receipts revoke grants without writing an empty user-body rewrite.
  expect(f.store.getTask(source.id).origin).toMatchObject({ allowedInputFileIds: [] })
  const foreign = await f.pick("other.txt", "not selected")
  expect(() => f.store.workInputFiles(source.id, [foreign.botInputId!])).toThrow("未在当前请求")
})

it("rejects same-size snapshot tampering before admission and cancels without new work", async () => {
  const f = await fixture(), file = await f.pick("sample.txt", "VERSION ONE")
  const body = buildAttachmentMessageParts([file]).attachmentModelBlocks
  const source = f.host.send({ botId: f.bot.id, requestId: "source", message: body, inputFileIds: [file.botInputId!] })
  await vi.waitFor(() => expect(f.store.getTask(source.id).state).toBe("running"))
  f.host.recordPreparedInput(source.id, source.id, body)
  const [retained] = f.store.inputFiles(f.bot.id, [file.botInputId!])
  await writeFile(retained.file.filePath, "VERSION TWO")
  await expect(f.host.createWork({ botId: f.bot.id, operationId: "bad", title: "Read", goal: "Read", inputFileIds: [file.botInputId!] },
    { taskId: source.id, callId: "bad", key: "bad" })).rejects.toThrow("已变化")
  expect(f.store.listWorks(f.bot.id).items).toEqual([])
  const controller = new AbortController(); controller.abort()
  await expect(verifyInputFiles([retained], controller.signal)).rejects.toThrow()
  expect(retainedInputFileIds([{ ...retained, blockHash: undefined }], body)).toEqual([])
})

it.each([false, true])("sends an unused retained draft after same-thread relink (different Bot: %s)", async differentBot => {
  let now = Date.now()
  const f = await fixture(false, undefined, false, false, () => now)
  const destination = differentBot
    ? f.store.create({ name: "Next owner", instructions: "", color: "#ea2845", modelRef: null })
    : f.bot
  vi.stubEnv("CMB_COWORK_AGENT_HOME", join(f.root, ".cmbcoworkagent"))
  const metadata = { workspacePath: f.project, cmb_thread_incarnation: "draft-incarnation" }
  const row = { thread_id: "original-draft-thread", created_at: Date.now(),
    metadata: JSON.stringify(metadata) } as ThreadSummaryRow
  threadRows.set(row.thread_id, row)
  const associate = (operationId: string, owner = f.bot, thread = row) => {
    const ref = { kind: "local_thread" as const, threadId: thread.thread_id, incarnation: captureThreadIncarnation(thread) }
    const work = f.store.conversations.prepare({
      botId: owner.id, conversation: ref, operationId, title: "Original draft", goal: "Check the retained input"
    })
    thread.metadata = JSON.stringify({ ...JSON.parse(thread.metadata!), botHostId: "local", botLocalConversation: true,
      botId: owner.id, botWorkId: work.id, botAudienceKey: "desktop", botWorkOrigin: "existing" })
    return f.store.conversations.bound(owner.id, work.id, ref)
  }
  const detach = (workId: string) => {
    f.store.conversations.beginDetach(f.bot.id, workId, f.host.getWork(f.bot.id, workId).version)
    f.store.conversations.detached(f.bot.id, workId)
    row.metadata = JSON.stringify(metadata)
  }
  const old = associate("old-link")
  const storage = workAttachmentStorage(f.project, old)!
  const editable = join(f.root, "source.txt")
  await writeFile(editable, "frozen contents")
  const snapshot = await snapshotBotDeliveryFile(storage, editable, new AbortController().signal, f.root)
  const pick = () => f.host.retainInputFile(f.bot.id, {
    filename: "source.txt", filePath: snapshot.attachmentPath, content: "frozen contents",
    size: snapshot.size, mimeType: "text/plain", truncated: false
  }, snapshot.attachmentPath, old.id)
  const original = pick()
  const previouslySent = pick()
  const sendInput = (workId: string, requestId: string, attachment: ReturnType<typeof pick>, owner = f.bot) => ({
    botId: owner.id, workId, requestId, inputFileIds: [attachment.botInputId!],
    message: "Read this attachment" + buildAttachmentMessageParts([attachment]).attachmentModelBlocks
  })
  const historical = f.store.enqueue(sendInput(old.id, "old-request", previouslySent))
  f.store.transition(historical.id, "cancelled")
  detach(old.id)
  const current = associate("new-link", destination)
  expect(current.id).not.toBe(old.id)
  const input = sendInput(current.id, "draft-request", original, destination)
  expect(() => f.host.sendDesktopMessage(input)).toThrow("先获取控制权")
  f.host.changeWorkControl({
    botId: destination.id, workId: current.id, expectedVersion: current.version, operationId: "take", action: "take"
  })
  await expect(async () => f.host.sendDesktopMessage(sendInput(current.id, "historic", previouslySent, destination)))
    .rejects.toThrow("未发送草稿")
  await expect(async () => f.host.sendDesktopMessage({ ...input, message: input.message.replace("frozen contents", "forged") }))
    .rejects.toThrow("未发送草稿")
  await expect(async () => f.host.sendDesktopMessage({ ...input, requestId: historical.requestId }))
    .rejects.toThrow("请求标识已用于另一条消息")
  expect(f.store.desktopInputFiles(f.bot.id, input.inputFileIds, old.id)).toHaveLength(1)

  if (differentBot) {
    const otherThread = { ...row, thread_id: "different-draft-thread", metadata: JSON.stringify(metadata) }
    threadRows.set(otherThread.thread_id, otherThread)
    const other = associate("other-link", f.bot, otherThread)
    const otherSnapshot = await snapshotBotDeliveryFile(workAttachmentStorage(f.project, other)!,
      editable, new AbortController().signal, f.root)
    const otherInput = f.host.retainInputFile(f.bot.id, { ...original, filePath: otherSnapshot.attachmentPath },
      otherSnapshot.attachmentPath, other.id)
    f.store.conversations.beginDetach(f.bot.id, other.id, other.version)
    f.store.conversations.detached(f.bot.id, other.id)
    await expect(async () => f.host.sendDesktopMessage(sendInput(current.id, "other-thread", otherInput, destination)))
      .rejects.toThrow("未发送草稿")
  }

  // Keep the real recent tail and age out the admitted but cancelled input.
  now += 31 * 24 * 60 * 60 * 1000
  for (let i = 0; i < 100; i++) {
    const recent = f.store.enqueue({ botId: f.bot.id, requestId: `recent-${i}`, message: "Later request" })
    f.store.transition(recent.id, "cancelled")
  }
  expect(f.store.pruneTaskHistory()).toBe(1)
  expect(() => f.store.getTask(historical.id)).toThrow()
  expect(f.db.exec("SELECT state FROM bot_exchange_archive WHERE id=?", [historical.id])[0].values)
    .toEqual([["cancelled"]])

  const queries = vi.spyOn(f.db, "prepare")
  try {
    await expect(async () => f.host.sendDesktopMessage(sendInput(current.id, "archived", previouslySent, destination)))
      .rejects.toThrow("未发送草稿")
    const lookup = queries.mock.calls.find(([sql]) => sql.startsWith("SELECT 1 FROM bot_exchange_archive WHERE work_id="))
    expect(lookup).toBeDefined()
    const plan = f.db.exec(`EXPLAIN QUERY PLAN ${lookup![0]}`, [old.id, f.bot.id, row.thread_id,
      JSON.stringify([previouslySent.botInputId!])])[0].values.map(entry => String(entry[3]))
    expect(plan.some(detail => detail.startsWith("SEARCH bot_exchange_archive USING INDEX bot_exchange_work_request_inputs")))
      .toBe(true)
  } finally {
    queries.mockRestore()
  }

  await writeFile(editable, "edited source")
  const [task, retry] = await Promise.all([f.host.sendDesktopMessage(input), f.host.sendDesktopMessage(input)])
  expect(retry.id).toBe(task.id)
  expect(task).toMatchObject({ workId: current.id, threadId: row.thread_id, message: input.message,
    origin: { inputFileIds: input.inputFileIds } })
  expect(f.store.desktopInputFiles(destination.id, input.inputFileIds, current.id)[0].file.filePath)
    .toBe(snapshot.attachmentPath)
  if (differentBot) expect(() => f.store.inputFiles(f.bot.id, input.inputFileIds)).toThrow("不属于当前 Bot")
  expect(f.store.desktopInputFiles(f.bot.id, [previouslySent.botInputId!], old.id)).toHaveLength(1)
  expect(await readFile(snapshot.attachmentPath, "utf8")).toBe("frozen contents")
})

async function projectInput(interruptOnSteer = false, injectSteers = false, useLocalWorkspaces = false) {
  const f = await fixture(interruptOnSteer, Number.POSITIVE_INFINITY, injectSteers, useLocalWorkspaces)
  vi.stubEnv("CMB_COWORK_AGENT_HOME", join(f.root, ".cmbcoworkagent"))
  const { work, task } = await f.host.createWork({
    botId: f.bot.id, operationId: "source-work", title: "Source", goal: "Original task",
    workspace: { kind: "directory", path: f.project }
  })
  await vi.waitFor(() => expect(f.store.getTask(task.id).state).toBe("running"))
  f.host.cancel(task.id)
  const threadData = await getProjectThreadDataDirectory(f.project, work.threadId, f.root)
  const storage = join(threadData, "attachments", `thread-${"f".repeat(64)}`)
  await mkdir(storage, { recursive: true })
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
  const original = join(f.root, "input.zip")
  await writeFile(original, bytes)
  const snapshot = await snapshotBotDeliveryFile(storage, original, new AbortController().signal, f.root)
  const picker = f.store.retainInputFile(f.bot.id, {
    filename: "input.zip", filePath: snapshot.attachmentPath, size: bytes.length,
    content: `Original file retained at ${JSON.stringify(snapshot.attachmentPath)}.`,
    mimeType: "application/zip", truncated: false
  }, snapshot.attachmentPath, work.id)
  const body = "Use the retained ZIP unchanged." + buildAttachmentMessageParts([picker]).attachmentModelBlocks
  const source = f.host.send({ botId: f.bot.id, workId: work.id, requestId: "selected-input",
    message: body, inputFileIds: [picker.botInputId!] })
  await vi.waitFor(() => expect(f.store.getTask(source.id).state).toBe("running"))
  return { ...f, work, source, storage, original, snapshot, picker, body, bytes }
}

const pickerHistory = (pickerRoot: string, workId: string) =>
  () => ({ pickerRoot, pinRoot: join(dirname(pickerRoot), workInputPinKey(workId)) })

it.each(["main chat", "work picker"] as const)("reuses the original default-work attachment from the %s", async (source) => {
  const f = await fixture(false, Number.POSITIVE_INFINITY, false, true)
  vi.stubEnv("CMB_COWORK_AGENT_HOME", join(f.root, ".cmbcoworkagent"))
  const workspace = (await localBotWorkspaces.resolve(f.bot.id)).path
  const signal = new AbortController().signal
  const original = join(f.root, "selected.csv")
  const bytes = "year,total\n2025,42\n"
  const modified = "year,total\n2025,99\n"
  await writeFile(original, bytes)
  const editable = await botImportDestination(workspace, original)
  await copyBotFile(f.root, original, editable.path)
  const snapshot = await snapshotBotDeliveryFile(workspace, editable.path, signal)
  const pick = (workId?: string) => f.host.retainInputFile(f.bot.id, {
    filename: "selected.csv", filePath: editable.id, size: Buffer.byteLength(bytes),
    content: `Original file retained in your workspace: ${JSON.stringify(editable.id)}.\n\n${bytes}`,
    mimeType: "text/plain", truncated: false
  }, snapshot.attachmentPath, workId)
  const body = (file: ReturnType<typeof pick>) =>
    "Inspect this CSV without publishing it." + buildAttachmentMessageParts([file]).attachmentModelBlocks
  const start = (id: string) => vi.waitFor(() => expect(f.finishes.has(id)).toBe(true))
  const settle = async (id: string) => {
    await start(id)
    f.finishes.get(id)!("completed")
    await vi.waitFor(() => expect(f.store.getTask(id).state).toBe("completed"))
  }
  const take = (workId: string) => f.host.changeWorkControl({
    botId: f.bot.id, workId, action: "take", operationId: `take-${workId}`,
    expectedVersion: f.host.getWork(f.bot.id, workId).version
  })
  const send = (workId: string, requestId: string, message: string, inputFileIds?: string[]) =>
    f.host.sendDesktopMessage({ botId: f.bot.id, workId, requestId, message, inputFileIds })

  let target: Awaited<ReturnType<LocalBotHost["createWork"]>>
  if (source === "main chat") {
    const file = pick()
    const main = await f.host.sendDesktopMessage({ botId: f.bot.id, requestId: "original-main-request",
      message: body(file), inputFileIds: [file.botInputId!] })
    await start(main.id)
    f.host.recordPreparedInput(main.id, main.id, main.message)
    const create = createBotWorkTools(main, () => f.host, signal).find(tool => tool.name === "bot_work_create")!
    const response = await create.invoke({ type: "tool_call", id: "assign-default", name: create.name, args: {
      requestKey: "assign-default", title: "Default", goal: "Inspect the selected CSV", inputFileIds: [file.botInputId!]
    } })
    expect(response.status).not.toBe("error")
    target = JSON.parse(response.content as string).receipt
    await settle(main.id)
  } else {
    const created = await f.host.createWork({ botId: f.bot.id, operationId: "default-work", title: "Default", goal: "Inspect files" })
    await settle(created.task.id)
    take(created.work.id)
    const file = pick(created.work.id)
    target = { work: created.work, task: await send(created.work.id, "work-picker-request", body(file), [file.botInputId!]) }
  }
  expect(target.work.workspace).toEqual({ kind: "default", path: workspace })
  const work = target.work
  const historyFor = (work: typeof target.work) => {
    const row = { thread_id: work.threadId, created_at: Date.now(), metadata: JSON.stringify({
      cmb_thread_incarnation: `incarnation-${work.id}`, botHostId: "local", botId: f.bot.id,
      botWorkId: work.id, botAudienceKey: "desktop", workspacePath: workspace
    }) } as ThreadSummaryRow
    threadRows.set(row.thread_id, row)
    f.host.initializeWorkThread(f.bot.id, work.id)
    const storage = workAttachmentStorage(workspace, work)
    expect(storage).toBeUndefined()
    return createBotInputHistoryResolver(work, row, workspace, () => f.host.getWork(f.bot.id, work.id), storage)
  }
  const history = historyFor(work)
  await start(target.task.id)
  f.host.recordPreparedInput(target.task.id, target.task.id, target.task.message)
  const [input] = f.host.inputFilesForTask(target.task.id)
  expect(input.file.filePath).toBe(snapshot.attachmentPath)
  await expect(f.host.acceptedBrowserInputPath(target.task.id, input.id, signal, history)).resolves.toBe(snapshot.attachmentPath)
  await settle(target.task.id)
  if (source === "main chat") take(work.id)
  await writeFile(editable.path, modified)

  const resolveUpload = (taskId: string, reference: string, resolver = history) =>
    f.host.acceptedBrowserInputPath(taskId, reference, signal, resolver)
  const attachmentTool = (taskId: string) => createBotDeliveryTools(workspace, signal, undefined, undefined,
    false, undefined, work.id, reference => f.host.acceptedDeliveryInputFile(taskId, reference, history),
    "default-thread-receipt", async () => undefined)[0]
  const attach = (tool: ReturnType<typeof attachmentTool>, reference: string, id: string) =>
    tool.invoke({ type: "tool_call", id, name: tool.name, args: { files: [reference] } })
  const follow = await send(work.id, "reuse-original", "Attach the previously selected CSV version.")
  await start(follow.id)
  await expect(resolveUpload(follow.id, input.id)).resolves.toBeUndefined()
  f.host.recordPreparedInput(follow.id, follow.id, follow.message)
  const tool = attachmentTool(follow.id)
  for (const [index, reference] of [input.id, snapshot.attachmentPath].entries()) {
    await expect(resolveUpload(follow.id, reference)).resolves.toBe(snapshot.attachmentPath)
    const delivery = await attach(tool, reference, `original-${index}`)
    expect(delivery.status).toBe("success")
    expect(parseBotFileDelivery(delivery.content)?.[0].attachmentPath).toBe(snapshot.attachmentPath)
  }
  await expect(readFile(snapshot.attachmentPath, "utf8")).resolves.toBe(bytes)
  const local = await attach(tool, editable.id, "editable-copy")
  const [current] = parseBotFileDelivery(local.content)!
  expect(current.attachmentPath).not.toBe(snapshot.attachmentPath)
  await expect(readFile(current.attachmentPath!, "utf8")).resolves.toBe(modified)

  const foreign = await f.host.createWork({ botId: f.bot.id, operationId: "foreign-work", title: "Foreign", goal: "Inspect files" })
  const foreignHistory = historyFor(foreign.work)
  await start(foreign.task.id)
  f.host.recordPreparedInput(foreign.task.id, foreign.task.id, foreign.task.message)
  for (const reference of [input.id, snapshot.attachmentPath])
    await expect(resolveUpload(foreign.task.id, reference, foreignHistory)).resolves.toBeUndefined()
  await settle(foreign.task.id)

  await writeFile(snapshot.attachmentPath, modified)
  await expect(resolveUpload(follow.id, input.id)).rejects.toThrow("已变化")
  expect((await attach(tool, snapshot.attachmentPath, "tampered")).status).toBe("error")
  await writeFile(snapshot.attachmentPath, bytes)
  await settle(follow.id)

  const selectedAgain = pick(work.id)
  const redacted = await send(work.id, "remove-current-selection", body(selectedAgain), [selectedAgain.botInputId!])
  await start(redacted.id)
  f.host.recordPreparedInput(redacted.id, redacted.id, "The submit Hook removed this attachment.")
  for (const [index, reference] of [input.id, snapshot.attachmentPath].entries()) {
    await expect(resolveUpload(redacted.id, reference)).resolves.toBeUndefined()
    expect((await attach(attachmentTool(redacted.id), reference, `redacted-${index}`)).status).toBe("error")
  }
})

it("reuses an approved input during a repair only after injecting the desktop follow-up", async () => {
  let rejectFollowUp = true
  let injectFollowUp: (() => boolean) | undefined
  const f = await fixture(false, Number.POSITIVE_INFINITY, async (prepare, inject) => {
    if (rejectFollowUp) return { rejected: true }
    prepare()
    injectFollowUp = inject
    return true
  }, true)
  vi.stubEnv("CMB_COWORK_AGENT_HOME", join(f.root, ".cmbcoworkagent"))
  const workspace = (await localBotWorkspaces.resolve(f.bot.id)).path
  const signal = new AbortController().signal
  const picker = await f.pick("source.csv", "year,total\n2025,42\n", workspace)
  const start = (task: BotTask) => vi.waitFor(() => expect(f.finishes.has(task.id)).toBe(true))
  const settle = async (task: BotTask) => {
    await start(task)
    f.finishes.get(task.id)!("completed")
    await vi.waitFor(() => expect(f.store.getTask(task.id).state).toBe("completed"))
  }
  const historyFor = (work: BotWorkItem) => {
    const row = { thread_id: work.threadId, created_at: Date.now(), metadata: JSON.stringify({
      cmb_thread_incarnation: `incarnation-${work.id}`, botHostId: "local", botId: f.bot.id,
      botWorkId: work.id, botAudienceKey: "desktop", workspacePath: workspace
    }) } as ThreadSummaryRow
    threadRows.set(row.thread_id, row)
    f.host.initializeWorkThread(f.bot.id, work.id)
    return createBotInputHistoryResolver(work, row, workspace, () => f.host.getWork(f.bot.id, work.id))
  }
  const main = await f.host.sendDesktopMessage({ botId: f.bot.id, requestId: "assign-input",
    message: "Inspect this CSV." + buildAttachmentMessageParts([picker]).attachmentModelBlocks,
    inputFileIds: [picker.botInputId!] })
  await start(main)
  f.host.recordPreparedInput(main.id, main.id, main.message)
  const create = createBotWorkTools(main, () => f.host, signal).find(tool => tool.name === "bot_work_create")!
  const assignment = await create.invoke({ type: "tool_call", id: "create", name: create.name, args: {
    requestKey: "create", title: "Inspect CSV", goal: "Inspect the CSV without publishing it.",
    inputFileIds: [picker.botInputId!]
  } })
  expect(assignment.status).toBe("success")
  const { work, task: first } = JSON.parse(assignment.content as string).receipt as BotWorkReceipt
  const history = historyFor(work)
  await settle(main)
  await start(first)
  f.host.recordPreparedInput(first.id, first.id, first.message)
  const [input] = f.host.inputFilesForTask(first.id)
  expect(f.host.armWorkResultReview(first.id, verifiedWorkResultThread(work).incarnation)).toBe(true)
  await settle(first)
  const review = await vi.waitFor(() => {
    const task = f.store.recentTasks().find(candidate => candidate.state === "running" &&
      candidate.origin.kind === "work_result" && candidate.origin.review?.phase === "review")
    expect(task).toBeDefined()
    return task!
  })
  const decision = f.host.commitWorkResultReview(review.id, {
    kind: "repair", gap: "The CSV was not checked", instruction: "Verify its totals", evidenceIds: []
  }, [])
  if (decision.state !== "repair") throw new Error("Expected the original task to enter repair")
  const { task: repair } = decision
  await settle(review)
  await start(repair)
  f.host.recordPreparedInput(repair.id, repair.id, repair.message)
  f.host.onSteeringReady(repair.id)

  const resolve = (reference: string) => f.host.acceptedBrowserInputPath(repair.id, reference, signal, history)
  const [deliver] = createBotDeliveryTools(workspace, signal, undefined, undefined, false, undefined, work.id,
    reference => f.host.acceptedDeliveryInputFile(repair.id, reference, history),
    "default-thread-receipt", async () => undefined)
  const attach = (reference: string, id: string) =>
    deliver.invoke({ type: "tool_call", id, name: deliver.name, args: { files: [reference] } })
  const references = [input.id, input.file.filePath]
  const expectDenied = async (phase: string) => {
    for (const [index, reference] of references.entries()) {
      await expect(resolve(reference)).resolves.toBeUndefined()
      expect((await attach(reference, `${phase}-${index}`)).status).toBe("error")
    }
  }
  await expectDenied("no-follow-up")

  const followUp = f.host.send({ botId: f.bot.id, requestId: "follow-up",
    message: "Attach the originally selected CSV unchanged." })
  await start(followUp)
  f.host.recordPreparedInput(followUp.id, followUp.id, followUp.message)
  const send = createBotWorkTools(followUp, () => f.host, signal).find(tool => tool.name === "bot_work_send")!
  const submit = async (id: string) => {
    const result = await send.invoke({ type: "tool_call", id, name: send.name, args: {
      requestKey: id, workId: work.id, message: followUp.message
    } })
    expect(result.status).toBe("success")
    return (JSON.parse(result.content as string).receipt as BotTask).id
  }
  const refused = await submit("refused")
  await vi.waitFor(() => expect(f.store.getTask(refused)).toMatchObject({
    state: "failed", error: "输入检查未通过，未执行这条补充消息。"
  }))
  await expectDenied("hook-refused")

  rejectFollowUp = false
  const accepted = await submit("accepted")
  await vi.waitFor(() => expect(injectFollowUp).toBeDefined())
  expect(f.store.getTask(accepted).state).toBe("queued")
  await expectDenied("prepared-only")
  expect(injectFollowUp!()).toBe(true)
  expect(f.store.getTask(accepted)).toMatchObject({ state: "running", injectedInto: repair.id })

  const foreign = await f.host.createWork({ botId: f.bot.id, operationId: "foreign-work",
    title: "Other task", goal: "Look for a CSV" })
  const foreignHistory = historyFor(foreign.work)
  await start(foreign.task)
  f.host.recordPreparedInput(foreign.task.id, foreign.task.id, foreign.task.message)
  for (const [index, reference] of references.entries()) {
    await expect(f.host.acceptedBrowserInputPath(foreign.task.id, reference, signal, foreignHistory))
      .resolves.toBeUndefined()
    await expect.soft(resolve(reference)).resolves.toBe(input.file.filePath)
    const result = await attach(reference, `injected-${index}`)
    expect.soft(result.status).toBe("success")
    expect.soft(parseBotFileDelivery(result.content)?.[0].attachmentPath).toBe(input.file.filePath)
  }
})

it("uploads and formally attaches an approved transferred pin in a later default-work turn", async () => {
  const f = await projectInput(false, false, true)
  const target = await f.host.createWork({
    botId: f.bot.id, operationId: "default-work", title: "Default", goal: "Keep the input"
  })
  expect(target.work.workspace?.kind).toBe("default")
  const workspace = target.work.workspace!.path
  const metadata = {
    cmb_thread_incarnation: "default-incarnation", botHostId: "local", botId: f.bot.id,
    botWorkId: target.work.id, botAudienceKey: "desktop", workspacePath: workspace
  }
  const row = { thread_id: target.work.threadId, created_at: Date.now(),
    metadata: JSON.stringify(metadata) } as ThreadSummaryRow
  threadRows.set(row.thread_id, row)
  const storage = workAttachmentStorage(workspace, target.work)
  expect(storage).toBeUndefined()
  const history = createBotInputHistoryResolver(target.work, row, workspace,
    () => f.host.getWork(f.bot.id, target.work.id), storage)
  const settle = async (id: string) => {
    await vi.waitFor(() => expect(f.finishes.has(id)).toBe(true))
    f.finishes.get(id)!("completed")
    await vi.waitFor(() => expect(f.store.getTask(id).state).toBe("completed"))
  }

  f.host.recordPreparedInput(f.source.id, f.source.id, f.body)
  const sent = await f.host.sendWorkWithFiles({ taskId: f.source.id, callId: "transfer", key: "transfer" },
    target.work.id, "Keep these exact bytes", undefined, [f.picker.botInputId!])
  const [pin] = f.host.inputFilesForTask(sent.id)
  await settle(target.task.id)
  await vi.waitFor(() => expect(f.finishes.has(sent.id)).toBe(true))
  f.host.recordPreparedInput(sent.id, sent.id, sent.message)
  await settle(sent.id)
  await deleteProjectThreadDataDirectory(f.project, f.work.threadId, f.root)
  await expect(stat(f.snapshot.attachmentPath)).rejects.toMatchObject({ code: "ENOENT" })
  await expect(readFile(pin.file.filePath)).resolves.toEqual(f.bytes)

  const signal = new AbortController().signal
  const unrelated = f.store.retainInputFile(f.bot.id, pin.attachment!, pin.file.filePath, target.work.id)
  const legacyPath = join(f.root, "legacy.zip")
  await writeFile(legacyPath, f.bytes)
  const legacy = await snapshotBotDeliveryFile(f.root, legacyPath, signal)
  const legacyPicker = f.store.retainInputFile(f.bot.id, {
    ...f.picker, filename: "legacy.zip", filePath: legacy.attachmentPath
  }, legacy.attachmentPath, target.work.id)
  const selected = f.host.send({ botId: f.bot.id, workId: target.work.id, requestId: "legacy",
    message: buildAttachmentMessageParts([legacyPicker]).attachmentModelBlocks, inputFileIds: [legacyPicker.botInputId!] })
  await vi.waitFor(() => expect(f.finishes.has(selected.id)).toBe(true))
  f.host.recordPreparedInput(selected.id, selected.id, selected.message)
  await settle(selected.id)

  const follow = f.host.send({ botId: f.bot.id, workId: target.work.id, requestId: "reuse-default-pin",
    message: "Upload and attach the previously transferred ZIP unchanged" })
  await vi.waitFor(() => expect(f.finishes.has(follow.id)).toBe(true))
  const uploaded = vi.fn()
  const browser = { act: async (...[, action, , , , resolveUpload]: Parameters<BotBrowserService["act"]>) => {
    const file = action.fileId && await resolveUpload?.(action.fileId)
    if (!file) throw new Error("No approved upload")
    uploaded(await readFile(file))
    return "uploaded"
  } } as BotBrowserService
  const [upload] = createBotBrowserTools(f.bot, browser, signal, () => {}, undefined, undefined,
    reference => f.host.acceptedBrowserInputPath(follow.id, reference, signal, history))
  const [deliver] = createBotDeliveryTools(workspace, signal, undefined, undefined, false, storage,
    target.work.id, reference => f.host.acceptedDeliveryInputFile(follow.id, reference, history))
  const uploadFile = (fileId: string) => upload.invoke({
    type: "tool_call", id: "upload", name: upload.name, args: { action: "upload", ref: "input", fileId }
  })
  const attach = (file: string) => deliver.invoke({
    type: "tool_call", id: "attach", name: deliver.name, args: { files: [file] }
  })
  expect((await uploadFile(pin.id)).status).toBe("error")
  f.host.recordPreparedInput(follow.id, follow.id, follow.message)
  for (const id of [unrelated.botInputId!, legacyPicker.botInputId!]) {
    expect((await uploadFile(id)).status).toBe("error")
    expect((await attach(id)).status).toBe("error")
  }
  await writeFile(pin.file.filePath, Buffer.alloc(f.bytes.length))
  expect((await uploadFile(pin.id)).status).toBe("error")
  expect((await attach(pin.id)).status).toBe("error")
  await writeFile(pin.file.filePath, f.bytes)

  expect((await uploadFile(pin.id)).content).toBe("uploaded")
  expect(uploaded).toHaveBeenCalledExactlyOnceWith(f.bytes)
  const result = await attach(pin.file.filePath)
  expect(result.status).toBe("success")
  const [delivered] = parseBotFileDelivery(result.content)!
  expect(delivered.attachmentRoot).toBeUndefined()
  expect(delivered.attachmentPath).toBe(join(
    workspace, ".bot-deliveries", basename(dirname(pin.file.filePath)), basename(pin.file.filePath)
  ))
  await expect(readFile(delivered.attachmentPath!)).resolves.toEqual(f.bytes)

  row.metadata = JSON.stringify({ ...metadata, cmb_thread_incarnation: "replacement" })
  expect((await uploadFile(pin.id)).status).toBe("error")
  expect((await attach(pin.id)).status).toBe("error")
})

it.each([false, true])("retains exact bytes through multi-hop cleanup without creating native threads (whole Bot=%s)", async (wholeBot) => {
  const f = await projectInput(false, true)
  const target = await f.host.createWork({
    botId: f.bot.id, operationId: "target-work", title: "Target", goal: "Read files"
  })
  await vi.waitFor(() => expect(f.finishes.has(target.task.id)).toBe(true))
  f.host.onSteeringReady(target.task.id)
  const send = createBotWorkTools(f.source, () => f.host, new AbortController().signal)
    .find(tool => tool.name === "bot_work_send")!
  const submit = async (id: string, workId: string, requestKey: string, expectedVersion?: number) =>
    JSON.parse((await send.invoke({ type: "tool_call", id, name: send.name, args: {
      workId, requestKey, message: "Read the selected ZIP", inputFileIds: [f.picker.botInputId!], expectedVersion
    } })).content as string)
  expect(await submit("unprepared", target.work.id, "unprepared")).toMatchObject({ ok: false })
  f.host.recordPreparedInput(f.source.id, f.source.id, f.body)
  expect(await submit("stale", target.work.id, "stale", target.work.version + 1))
    .toMatchObject({ ok: false, error: expect.stringContaining("工作状态已变化") })
  await expect(stat(join(f.root, ".cmbcoworkagent", "bots", "workspaces", f.bot.id)))
    .rejects.toMatchObject({ code: "ENOENT" })
  const same = (await submit("same-work", f.work.id, "same")).receipt
  expect(f.host.inputFilesForTask(same.id)[0].file.filePath).toBe(f.snapshot.attachmentPath)
  const sent = (await submit("other-work", target.work.id, "other")).receipt
  expect(sent.state).toBe("queued")
  expect(f.store.getWork(f.bot.id, target.work.id).threadInitialized).toBe(false)
  const [retained] = f.host.inputFilesForTask(sent.id)
  expect(retained.id).not.toBe(f.picker.botInputId)
  expect(retained.file.filePath).toContain(workInputPinStorage(target.work))
  expect(retained.attachment?.content).toContain(retained.file.filePath)
  expect(retained.attachment?.content).not.toContain(f.snapshot.attachmentPath)
  const before = await stat(retained.file.filePath)
  expect(before.ino).not.toBe((await stat(f.snapshot.attachmentPath)).ino)
  const again = (await submit("other-repeat", target.work.id, "different-operation")).receipt
  expect(f.host.inputFilesForTask(again.id)[0].file.filePath).toBe(retained.file.filePath)
  expect((await stat(retained.file.filePath)).ino).toBe(before.ino)
  await deleteProjectThreadDataDirectory(f.project, f.work.threadId, f.root)
  await expect(stat(f.snapshot.attachmentPath)).rejects.toMatchObject({ code: "ENOENT" })
  expect((await submit("lost-response", target.work.id, "other")).receipt.id).toBe(sent.id)
  await verifyInputFiles([retained], new AbortController().signal)
  expect(await readFile(retained.file.filePath)).toEqual(f.bytes)
  expect(f.store.getTask(sent.id).injectedInto).toBe(target.task.id)
  const third = await f.host.createWork({
    botId: f.bot.id, operationId: "third-work", title: "Third", goal: "Read the same ZIP"
  })
  const forwarded = await f.host.sendWorkWithFiles({ taskId: target.task.id, callId: "forward", key: "forward" },
    third.work.id, "Read the ZIP unchanged", undefined, [retained.id])
  const [thirdFile] = f.host.inputFilesForTask(forwarded.id)
  expect(thirdFile.file.filePath).toContain(workInputPinStorage(third.work))
  expect((await stat(thirdFile.file.filePath)).ino).not.toBe(before.ino)
  const deleteThread = vi.fn()
  const remove = (workId: string) => removeBotWork(f.host,
    captureBotWorkDeletionTarget(f.host, f.bot.id, workId, f.host.getWork(f.bot.id, workId).version), deleteThread)
  await expect(remove(target.work.id)).resolves.toMatchObject({ state: "deleted" })
  await expect(stat(retained.file.filePath)).rejects.toMatchObject({ code: "ENOENT" })
  expect(await readFile(thirdFile.file.filePath)).toEqual(f.bytes)
  expect((await stat(thirdFile.file.filePath)).nlink).toBe(1)
  if (wholeBot) {
    f.host.stopConversation(f.bot.id, undefined, f.work.id)
    f.host.stopConversation(f.bot.id, undefined, third.work.id)
    await vi.waitFor(() => expect(f.store.pendingWorkFamily(f.bot.id, f.work.id)).toEqual([]))
    await vi.waitFor(() => expect(f.store.pendingWorkFamily(f.bot.id, third.work.id)).toEqual([]))
    f.host.stopConversation(f.bot.id)
    await vi.waitFor(() => expect(f.host.hasActiveRuns()).toBe(false))
    await f.host.remove(f.bot.id, f.host.getBot(f.bot.id).version, async () => {})
  } else await expect(remove(third.work.id)).resolves.toMatchObject({ state: "deleted" })
  await expect(stat(thirdFile.file.filePath)).rejects.toMatchObject({ code: "ENOENT" })
  expect(deleteThread).not.toHaveBeenCalled()
  expect(await readFile(f.original)).toEqual(f.bytes)
  expect(await readdir(f.project)).toEqual([])
})

it.each([false, true])("rolls back only aliases from this uncommitted transfer (cancelled=%s)", async (cancelled) => {
  const f = await projectInput()
  const target = await f.host.createWork({
    botId: f.bot.id, operationId: "rollback-work", title: "Target", goal: "Read files"
  })
  f.host.recordPreparedInput(f.source.id, f.source.id, f.body)
  const sent = await f.host.sendWorkWithFiles({ taskId: f.source.id, callId: "keep", key: "keep" },
    target.work.id, "Keep this ZIP", undefined, [f.picker.botInputId!])
  const [existing] = f.host.inputFilesForTask(sent.id)
  const storage = await realpath(workInputPinStorage(target.work))
  const formalStorage = join(storage, "..", `thread-${"e".repeat(64)}`)
  await mkdir(formalStorage, { recursive: true })
  await writeFile(join(f.project, "input.zip"), f.bytes)
  const [deliver] = createBotDeliveryTools(f.project, new AbortController().signal, undefined, undefined,
    false, formalStorage, target.work.id)
  const [formal] = parseBotFileDelivery(String(await deliver.invoke({ files: ["input.zip"] })))!
  expect(formal.attachmentPath).not.toBe(existing.file.filePath)

  f.finishes.get(f.source.id)!("completed")
  const newer = Buffer.from("another version")
  await writeFile(f.original, newer)
  const snapshot = await snapshotBotDeliveryFile(f.storage, f.original, new AbortController().signal, f.root)
  const other = f.store.retainInputFile(f.bot.id, { ...f.picker, filePath: snapshot.attachmentPath,
    size: newer.length, content: "Second version" }, snapshot.attachmentPath, f.work.id)
  const ids = [f.picker.botInputId!, other.botInputId!]
  const body = "Send both versions" + buildAttachmentMessageParts([f.picker, other]).attachmentModelBlocks
  const source = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId: "rollback-source", message: body, inputFileIds: ids })
  await vi.waitFor(() => expect(f.store.getTask(source.id).state).toBe("running"))
  f.host.recordPreparedInput(source.id, source.id, body)
  let attemptedPath: string | undefined
  const originalSnapshot = fileCopy.snapshotBotDeliveryFile
  const intercept = vi.spyOn(fileCopy, "snapshotBotDeliveryFile").mockImplementation(async (...args) => {
    const result = await originalSnapshot(...args)
    if (args[1] === snapshot.attachmentPath) {
      attemptedPath = result.attachmentPath
      if (cancelled) f.host.cancel(source.id)
      else f.host.changeWorkControl({ botId: f.bot.id, workId: target.work.id,
        expectedVersion: f.host.getWork(f.bot.id, target.work.id).version, operationId: "take-control", action: "take" })
    }
    return result
  })
  const rejected = { taskId: source.id, callId: "failed-transfer", key: "failed-transfer" }
  try {
    await expect(f.host.sendWorkWithFiles(rejected, target.work.id, "Send both versions", undefined, ids))
      .rejects.toThrow(cancelled ? "aborted" : "任务由用户接管")
  } finally { intercept.mockRestore() }
  expect(attemptedPath).toBeDefined()
  await expect(stat(attemptedPath!)).rejects.toMatchObject({ code: "ENOENT" })
  await expect(readFile(existing.file.filePath)).resolves.toEqual(f.bytes)
  await expect(readFile(formal.attachmentPath!)).resolves.toEqual(f.bytes)
  await expect(readFile(snapshot.attachmentPath)).resolves.toEqual(newer)
})

it("reuses a transferred pin from the exact receiving work history and preserves it on unlink", async () => {
  const f = await projectInput()
  const target = await f.host.createWork({
    botId: f.bot.id, operationId: "linked-work", title: "Linked", goal: "Read files"
  })
  const row = { thread_id: target.work.threadId, created_at: Date.now(), metadata: JSON.stringify({
    botHostId: "local", botLocalConversation: true, botId: f.bot.id, botWorkId: target.work.id,
    botAudienceKey: "desktop", botWorkOrigin: "created", workspacePath: f.project
  }) } as ThreadSummaryRow
  threadRows.set(row.thread_id, row)
  const ref = { kind: "local_thread" as const, threadId: row.thread_id, incarnation: captureThreadIncarnation(row) }
  f.store.conversations.prepareCreated(f.bot.id, target.work.id, ref)
  const bound = f.store.conversations.bound(f.bot.id, target.work.id, ref)
  const storage = workAttachmentStorage(f.project, bound)!
  f.host.recordPreparedInput(f.source.id, f.source.id, f.body)
  const sent = await f.host.sendWorkWithFiles({ taskId: f.source.id, callId: "linked", key: "linked" },
    target.work.id, "Read this ZIP", undefined, [f.picker.botInputId!])
  const [pin] = f.host.inputFilesForTask(sent.id)
  await vi.waitFor(() => expect(f.finishes.has(target.task.id)).toBe(true))
  f.finishes.get(target.task.id)!("completed")
  await vi.waitFor(() => expect(f.finishes.has(sent.id)).toBe(true))
  f.host.recordPreparedInput(sent.id, sent.id, sent.message)
  f.finishes.get(sent.id)!("completed")
  await vi.waitFor(() => expect(f.store.getTask(sent.id).state).toBe("completed"))
  const follow = f.host.send({ botId: f.bot.id, workId: target.work.id, requestId: "reuse-pin", message: "Use the previous ZIP" })
  await vi.waitFor(() => expect(f.finishes.has(follow.id)).toBe(true))
  f.host.recordPreparedInput(follow.id, follow.id, follow.message)
  const signal = new AbortController().signal
  await expect(f.host.acceptedBrowserInputPath(follow.id, pin.id, signal, pickerHistory(storage, target.work.id)))
    .resolves.toBe(pin.file.filePath)
  await expect(f.host.acceptedBrowserInputPath(follow.id, pin.id, signal, pickerHistory(f.storage, target.work.id)))
    .resolves.toBeUndefined()
  f.finishes.get(follow.id)!("completed")
  await vi.waitFor(() => expect(f.store.getTask(follow.id).state).toBe("completed"))
  f.store.conversations.beginDetach(f.bot.id, target.work.id, f.host.getWork(f.bot.id, target.work.id).version)
  f.store.conversations.detached(f.bot.id, target.work.id)
  await expect(readFile(pin.file.filePath)).resolves.toEqual(f.bytes)
  await deleteProjectThreadDataDirectory(f.project, target.work.threadId, f.root)
  await expect(stat(pin.file.filePath)).rejects.toMatchObject({ code: "ENOENT" })
})

it("formally delivers only this execution's approved input and reuses its binary snapshot", async () => {
  const f = await projectInput()
  const controller = new AbortController()
  const publish = vi.fn()
  const [deliver] = createBotDeliveryTools(f.project, controller.signal, publish, undefined, false,
    f.storage, f.work.id, reference => f.host.acceptedDeliveryInputFile(f.source.id, reference))
  const submit = (file: string, id: string) =>
    deliver.invoke({ type: "tool_call", id, name: deliver.name, args: { files: [file] } })
  expect((await submit(f.snapshot.attachmentPath, "unprepared")).status).toBe("error")
  f.host.recordPreparedInput(f.source.id, f.source.id, "The attachment was removed.")
  expect((await submit(f.picker.botInputId!, "rewritten")).status).toBe("error")
  f.host.recordPreparedInput(f.source.id, f.source.id, f.body)
  const unrelated = f.store.retainInputFile(f.bot.id, f.picker, f.snapshot.attachmentPath, f.work.id)
  expect((await submit(unrelated.botInputId!, "unrelated-picker")).status).toBe("error")
  expect((await submit(f.original, "arbitrary-path")).status).toBe("error")
  expect(publish).not.toHaveBeenCalled()
  const byId = await submit(f.picker.botInputId!, "picked")
  const byPath = await submit(f.snapshot.attachmentPath, "snapshot")
  expect(byId.status).toBe("success")
  expect(parseBotFileDelivery(byId.content)).toEqual(parseBotFileDelivery(byPath.content))
  expect(parseBotFileDelivery(byPath.content)?.[0]).toMatchObject({
    attachmentPath: f.snapshot.attachmentPath, name: "input.zip", size: f.bytes.length
  })
  expect(await readFile(f.snapshot.attachmentPath)).toEqual(f.bytes)
  expect(await readdir(f.project)).toEqual([])
  await writeFile(f.snapshot.attachmentPath, Buffer.alloc(f.bytes.length))
  expect((await submit(f.picker.botInputId!, "wrong-digest")).status).toBe("error")
  controller.abort()
  await expect(submit(f.picker.botInputId!, "cancelled")).rejects.toMatchObject({ name: "AbortError" })
  expect(publish).toHaveBeenCalledTimes(2)
})

it.each(["denied", "withdrawn", "queue-rejected", "archived", "preflight-failed", "preflight-stopped", "approved-again", "rewritten-again"] as const)(
  "does not retain an unconsumed picker approval after %s", async outcome => {
    const f = await projectInput()
    f.finishes.get(f.source.id)!("completed")
    await vi.waitFor(() => expect(f.store.getTask(f.source.id).state).toBe("completed"))
    await f.host.stop()
    // Preparing a supplement is not committing it to the execution transcript.
    const input = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: `preparation-${outcome}`,
      message: f.body, inputFileIds: [f.picker.botInputId!] })
    f.store.beginInputPreparation(input.id)
    f.store.recordPreparedInput(input.id, f.body)
    if (outcome === "withdrawn" || outcome === "queue-rejected") {
      f.store.transition(input.id, outcome === "withdrawn" ? "cancelled" : "failed")
    } else if (outcome === "archived") {
      f.store.update({ ...f.bot, expectedVersion: f.store.getBot(f.bot.id).version, archived: true })
      f.store.update({ ...f.bot, expectedVersion: f.store.getBot(f.bot.id).version, archived: false })
    } else if (outcome === "preflight-failed" || outcome === "preflight-stopped") {
      f.store.transition(input.id, "running")
      const controller = new AbortController()
      if (outcome === "preflight-stopped") controller.abort()
      else await rm(f.snapshot.attachmentPath)
      await expect(verifyInputFiles(f.store.inputFiles(f.bot.id, [f.picker.botInputId!]), controller.signal)).rejects.toThrow()
      f.store.settleRun(input.id, [], outcome === "preflight-stopped" ? "cancelled" : "failed", "Input preflight stopped")
    } else {
      f.store.transition(input.id, "running")
      f.store.beginInputPreparation(input.id)
      if (outcome !== "denied") f.store.recordPreparedInput(input.id,
        outcome === "approved-again" ? f.body : "Only inspect the current status")
      f.store.settle(input.id, outcome === "denied" ? "failed" : "completed", null)
    }
    const follow = f.store.enqueue({ botId: f.bot.id, workId: f.work.id, requestId: `later-${outcome}`, message: "Use approved materials" })
    f.store.transition(follow.id, "running")
    f.store.beginInputPreparation(follow.id)
    f.store.recordPreparedInput(follow.id, follow.message)
    const selected = f.store.acceptedDesktopInputFile(follow.id, f.picker.botInputId!, false,
      pickerHistory(await realpath(f.storage), f.work.id))
    expect(selected?.id).toBe(outcome === "approved-again" ? f.picker.botInputId : undefined)
    const projection = f.store.inputProjections(f.bot.id, f.work.threadId, [input.requestId])
    if (["denied", "withdrawn", "queue-rejected", "archived", "preflight-failed", "preflight-stopped"].includes(outcome)) expect(projection.get(input.requestId)).toBeNull()
    else if (outcome === "rewritten-again") expect(projection.get(input.requestId)).toBe("Only inspect the current status")
    else expect(projection.has(input.requestId)).toBe(false)
  }
)

it("reuses the exact approved version after stopping a project turn without granting a new handoff", async () => {
  const f = await projectInput()
  const signal = new AbortController().signal
  const storageRoot = await realpath(f.storage)
  const historyStorage = pickerHistory(storageRoot, f.work.id)
  const settle = async (taskId: string) => {
    f.finishes.get(taskId)!("completed")
    await vi.waitFor(() => expect(f.store.getTask(taskId).state).toBe("completed"))
  }
  const send = async (requestId: string, message: string, inputFileIds?: string[]) => {
    const task = f.host.send({ botId: f.bot.id, workId: f.work.id, requestId, message, inputFileIds })
    await vi.waitFor(() => expect(f.finishes.has(task.id)).toBe(true))
    return task
  }
  const pickVersion = async (fill: number) => {
    await writeFile(f.original, Buffer.alloc(f.bytes.length, fill))
    const snapshot = await snapshotBotDeliveryFile(f.storage, f.original, signal, f.root)
    const picker = f.store.retainInputFile(f.bot.id, {
      ...f.picker, filePath: snapshot.attachmentPath, content: "Selected ZIP"
    }, snapshot.attachmentPath, f.work.id)
    return { picker, snapshot, block: buildAttachmentMessageParts([picker]).attachmentModelBlocks }
  }
  f.host.recordPreparedInput(f.source.id, f.source.id, f.body)
  f.host.stopConversation(f.bot.id, undefined, f.work.id)
  await vi.waitFor(() => expect(f.store.getTask(f.source.id).state).toBe("cancelled"))

  const other = await pickVersion(2)
  const alternate = await send("alternate-input", other.block, [other.picker.botInputId!])
  f.host.recordPreparedInput(alternate.id, alternate.id, other.block)
  await settle(alternate.id)

  const rejected = await pickVersion(3)
  const rejectedInput = await send("blocked-input", rejected.block, [rejected.picker.botInputId!])
  f.host.beginInputPreparation(rejectedInput.id, rejectedInput.id)
  f.host.cancel(rejectedInput.id)
  await vi.waitFor(() => expect(f.store.getTask(rejectedInput.id).state).toBe("cancelled"))
  const rewritten = await pickVersion(4)
  const rewrittenInput = await send("rewritten-input", rewritten.block, [rewritten.picker.botInputId!])
  f.host.recordPreparedInput(rewrittenInput.id, rewrittenInput.id, "The submit Hook removed the attachment.")
  f.host.cancel(rewrittenInput.id)
  await vi.waitFor(() => expect(f.store.getTask(rewrittenInput.id).state).toBe("cancelled"))

  const follow = await send("use-original-attachment", "Use the original ZIP again.")
  const browserPath = (reference: string) => f.host.acceptedBrowserInputPath(follow.id, reference, signal, historyStorage)
  await expect(browserPath(f.picker.botInputId!)).resolves.toBeUndefined()
  f.host.recordPreparedInput(follow.id, follow.id, follow.message)
  await expect(browserPath(f.picker.botInputId!)).resolves.toBe(f.snapshot.attachmentPath)
  await expect(browserPath(f.snapshot.attachmentPath)).resolves.toBe(f.snapshot.attachmentPath)
  await expect(browserPath(other.picker.botInputId!)).resolves.toBe(other.snapshot.attachmentPath)
  await expect(browserPath(f.picker.filename)).resolves.toBeUndefined()
  await expect(browserPath(rejected.picker.botInputId!)).resolves.toBeUndefined()
  await expect(browserPath(rewritten.snapshot.attachmentPath)).resolves.toBeUndefined()
  expect(f.store.acceptedDesktopInputFile(follow.id, f.picker.botInputId!, false,
    pickerHistory(other.snapshot.attachmentPath, f.work.id)))
    .toBeUndefined()
  expect(f.store.acceptedDesktopInputFile(follow.id, f.picker.botInputId!)).toBeUndefined()
  expect(() => f.store.workInputFiles(follow.id, [f.picker.botInputId!])).toThrow("未在当前请求")

  const reopened = new BotStore(f.db)
  expect(reopened.acceptedDesktopInputFile(follow.id, f.picker.botInputId!, false, historyStorage)?.file.filePath)
    .toBe(f.snapshot.attachmentPath)
  const { task: foreign } = f.store.createWork({
    botId: f.bot.id, operationId: "foreign-work", title: "Other work", goal: "Use a ZIP"
  })
  f.store.transition(foreign.id, "running")
  f.store.recordPreparedInput(foreign.id, foreign.message)
  expect(f.store.acceptedDesktopInputFile(foreign.id, f.picker.botInputId!, false, historyStorage)).toBeUndefined()

  const [deliver] = createBotDeliveryTools(f.project, signal, undefined, undefined, false, storageRoot, f.work.id,
    reference => f.host.acceptedDeliveryInputFile(follow.id, reference, historyStorage))
  for (const [index, reference] of [f.picker.botInputId!, f.snapshot.attachmentPath].entries()) {
    const delivered = await deliver.invoke({
      type: "tool_call", id: `redeliver-approved-input-${index}`, name: deliver.name, args: { files: [reference] }
    })
    expect(delivered.status).toBe("success")
    expect(parseBotFileDelivery(delivered.content)?.[0].attachmentPath).toBe(f.snapshot.attachmentPath)
  }
  expect(await readFile(f.snapshot.attachmentPath)).toEqual(f.bytes)
  expect(await readdir(f.project)).toEqual([])
  await writeFile(f.snapshot.attachmentPath, Buffer.alloc(f.bytes.length))
  await expect(browserPath(f.picker.botInputId!)).rejects.toThrow("已变化")

  await settle(follow.id)
  const duplicate = f.store.retainInputFile(f.bot.id, f.picker, f.snapshot.attachmentPath, f.work.id)
  const redacted = await send("reattach-original", buildAttachmentMessageParts([duplicate]).attachmentModelBlocks,
    [duplicate.botInputId!])
  f.host.recordPreparedInput(redacted.id, redacted.id, "The submit Hook removed the reselected attachment.")
  await expect(f.host.acceptedBrowserInputPath(redacted.id, f.picker.botInputId!, signal, historyStorage)).resolves.toBeUndefined()
})

it.each(["completed", "failed", "cancelled", "interrupted", "outcome_unknown", "superseded"] as const)(
  "reuses only the exact approved project attachment after pruning a %s execution",
  async (state) => {
    const f = await projectInput(state === "superseded")
    const storageRoot = await realpath(f.storage)
    f.host.recordPreparedInput(f.source.id, f.source.id, f.body)
    if (state === "superseded") {
      f.host.onSteeringReady(f.source.id)
      const follow = f.host.send({
        botId: f.bot.id, workId: f.work.id, requestId: "direct-correction", message: "Include the original ZIP unchanged."
      })
      expect(follow.state).toBe("queued")
      await vi.waitFor(() => expect(f.finishes.has(follow.id)).toBe(true))
      expect(f.store.getTask(f.source.id).state).toBe("superseded")
      expect(f.store.getTask(follow.id)).toMatchObject({ state: "running", origin: { kind: "user" } })
      const resolve = (reference: string) =>
        f.host.acceptedDeliveryInputFile(follow.id, reference, pickerHistory(storageRoot, f.work.id))
      expect(resolve(f.picker.botInputId!)).toBeUndefined()
      f.host.recordPreparedInput(follow.id, follow.id, follow.message)
      expect(resolve(f.picker.botInputId!)?.file.filePath).toBe(f.snapshot.attachmentPath)
      expect(resolve(f.snapshot.attachmentPath)?.id).toBe(f.picker.botInputId)
      f.finishes.get(follow.id)!("completed")
      await vi.waitFor(() => expect(f.store.getTask(follow.id).state).toBe("completed"))
    } else if (state === "cancelled") f.host.cancel(f.source.id)
    else if (state === "interrupted") {
      await f.host.stop()
      f.store.flushReplies()
    }
    else f.finishes.get(f.source.id)!(state)
    await vi.waitFor(() => expect(f.store.getTask(f.source.id).state).toBe(state))

    const later = new BotStore(f.db, () => Date.now() + 91 * 24 * 60 * 60 * 1_000)
    if (state !== "cancelled" && state !== "superseded") {
      // Keep a newer settlement for this work so its original input execution can expire.
      const revision = later.enqueue({ botId: f.bot.id, workId: f.work.id,
        requestId: "newer-project-result", message: "Record the latest project result." })
      later.transition(revision.id, "running")
      later.recordPreparedInput(revision.id, revision.message)
      later.settle(revision.id, "completed", null)
    }
    const other = later.create({ name: "Other", instructions: "", color: "#123456", modelRef: null })
    // Let the real retention policy move the old input out of its recent task tail.
    for (let index = 0; index < 100; index++) {
      const task = later.enqueue({ botId: other.id, requestId: `recent-${index}`, message: "Independent chat" })
      later.transition(task.id, "running")
      later.settle(task.id, "completed", null)
    }
    later.pruneTaskHistory()
    expect(() => later.getTask(f.source.id)).toThrow()
    expect(f.db.exec("SELECT count(*) FROM bot_task_receipts")[0].values).toEqual([[0]])

    const follow = later.enqueue({
      botId: f.bot.id, workId: f.work.id, requestId: "later-project-turn", message: "Use the original ZIP again."
    })
    later.transition(follow.id, "running")
    const resolve = (reference: string) =>
      later.acceptedDesktopInputFile(follow.id, reference, false, pickerHistory(storageRoot, f.work.id))
    expect(resolve(f.picker.botInputId!)).toBeUndefined()
    later.recordPreparedInput(follow.id, follow.message)
    expect(resolve(f.picker.botInputId!)?.file.filePath).toBe(f.snapshot.attachmentPath)
    expect(resolve(f.snapshot.attachmentPath)?.id).toBe(f.picker.botInputId)
    expect(resolve(f.picker.filename)).toBeUndefined()
    expect(await readFile(f.snapshot.attachmentPath)).toEqual(f.bytes)
  }
)
