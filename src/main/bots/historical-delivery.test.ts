import { DatabaseSync } from "node:sqlite"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ToolMessage } from "@langchain/core/messages"
import { expect, it, vi } from "vitest"
import { parseBotFileDelivery } from "../../shared/bots/file-delivery"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { captureThreadIncarnation } from "../services/thread-incarnation"
import * as transcript from "../db"
import { botAttachmentReceiptKey, workAttachmentStorage } from "./attachment-storage"
import type { BotHistoricalDeliveryReference } from "./delivery-receipt"
import { snapshotBotDeliveryFile } from "./file-copy"
import { LocalBotHost, type BotRunLease } from "./host"
import { BotStore } from "./store"
import { createBotDeliveryTools } from "./tools"
import { createBotWorkTools } from "./work-tools"
import { resolveBotWorkspaceFile } from "./workspace-file"

const fixture = vi.hoisted(() => ({ root: "" }))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => join(fixture.root, "app") }))
vi.mock("../storage", () => ({
  getDbPath: () => join(fixture.root, "transcript.sqlite"),
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))

it.each(["create", "follow_up"] as const)("uses only persisted, injected continuations to reuse a delivery during %s", async dispatch => {
  fixture.root = await realpath(await mkdtemp(join(tmpdir(), "bot-injected-delivery-")))
  const database = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(database)
  const injections = new Map<string, () => boolean>()
  const steer: NonNullable<BotRunLease["steer"]> = async (input, inject) => {
    const owner = [...store.recentTasks()].find(task => task.workId === input.workId && task.state === "running" && !task.injectedInto)!
    host.beginInputPreparation(owner.id, input.id)
    host.recordPreparedInput(owner.id, input.id, input.message)
    injections.set(input.id, inject)
    return true
  }
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => ({
      release() {}, steer,
      execute: signal => {
        host.onSteeringReady(task.id)
        return new Promise(resolve => signal.addEventListener("abort", () => resolve({ state: "completed" }), { once: true }))
      }
    })
  }, 2)
  try {
    await transcript.initializeDatabase()
    const workspace = join(fixture.root, "project")
    await mkdir(workspace)
    const bot = store.create({ name: "Reports", instructions: "", color: "#123456", modelRef: null })
    const { work, task: creation } = store.createWork({ botId: bot.id, operationId: "create", title: "Report", goal: "Prepare a report" },
      undefined, { kind: "directory", path: workspace })
    if (dispatch === "follow_up") store.transition(creation.id, "cancelled")
    const row = transcript.createThread(work.threadId, { botId: bot.id, botWorkId: work.id,
      botHostId: "local", botAudienceKey: "desktop", workspacePath: workspace })
    store.initializeWorkThread(bot.id, work.id)
    const parent = host.send({ botId: bot.id, requestId: "main", message: "Continue the report" })
    await vi.waitFor(() => expect(store.getTask(parent.id).state).toBe("running"))
    host.recordPreparedInput(parent.id, parent.id, parent.message)
    const source = (key: string) => ({ taskId: parent.id, callId: key, key })
    const physical = dispatch === "create" ? creation : host.sendWork(source("start"), work.id, "Continue the report")
    await vi.waitFor(() => expect(store.getTask(physical.id).state).toBe("running"))
    host.recordPreparedInput(physical.id, physical.id, physical.message)
    const persistInput = (input: typeof physical) => transcript.upsertThreadMessages(work.threadId,
      [{ id: input.requestId, role: "user", content: input.message, created_at: new Date() }])
    persistInput(physical)
    const storage = workAttachmentStorage(workspace, work)!
    const signal = new AbortController().signal
    const resolve = (reference: BotHistoricalDeliveryReference) => host.acceptedHistoricalWorkDelivery(physical.id, reference, storage, signal)
    const [tool] = createBotDeliveryTools(workspace, signal, undefined, undefined, false, storage, work.id,
      undefined, botAttachmentReceiptKey(work.threadId, row), resolve)
    const path = join(workspace, "report.md")
    const deliver = async (id: string, body: string) => {
      await writeFile(path, body)
      const content = String(await tool.invoke({ files: ["report.md"] }))
      const [file] = parseBotFileDelivery(content)!
      transcript.upsertThreadMessages(work.threadId, [
        { id: `assistant-${id}`, role: "assistant", content: "", created_at: new Date(), tool_calls: [{ id, name: tool.name, args: {} }] },
        { id: `result-${id}`, role: "tool", content, created_at: new Date(), name: tool.name, tool_call_id: id }
      ])
      return { attachmentPath: file.attachmentPath!, filePath: file.filePath }
    }
    const exact = (file: Awaited<ReturnType<typeof deliver>>, id: string) => ({
      ...file,
      source: { threadId: work.threadId, assistantMessageId: `assistant-${id}`, callId: id, fileIndex: 0 }
    })
    const original = await deliver("v1", "SENT V1")
    await writeFile(path, "UNDELIVERED V2")
    await expect(resolve(original)).resolves.toBeUndefined()

    const supplement = host.sendWork(source("resend"), work.id, "Re-send the original delivered version")
    await vi.waitFor(() => expect(injections.has(supplement.id)).toBe(true))
    // Prepared but still queued input cannot authorize an earlier attachment.
    await expect(resolve(original)).resolves.toBeUndefined()
    expect(injections.get(supplement.id)!()).toBe(true)
    // Host admission alone is insufficient until the actual user row is stored.
    await expect(resolve(original)).resolves.toBeUndefined()
    persistInput(supplement)
    const saved = await resolve(original)
    expect(saved?.resultId).toBe("result-v1")
    await expect(resolve(exact(original, "v1"))).resolves.toMatchObject({ resultId: "result-v1" })
    expect(await readFile(saved!.path, "utf8")).toBe("SENT V1")
    expect(await readFile(path, "utf8")).toBe("UNDELIVERED V2")
    const redelivered = parseBotFileDelivery(String(await tool.invoke({ files: [original] })))
    expect(redelivered?.[0].attachmentPath).toBe(original.attachmentPath)

    const later = await deliver("v3", "SENT AFTER SUPPLEMENT")
    // Neither a later tool result nor an unrelated persisted user row expands the grant.
    await expect(resolve(later)).resolves.toBeUndefined()
    await expect(resolve(exact(later, "v3"))).rejects.toThrow("原交付附件已不可用")
    transcript.upsertThreadMessages(work.threadId, [{ id: "unowned", role: "user", content: "Unrelated", created_at: new Date() }])
    await expect(resolve(later)).resolves.toBeUndefined()
    const next = host.send({ botId: bot.id, workId: work.id, requestId: "direct-continuation", message: "Use the newer formal version" })
    await vi.waitFor(() => expect(injections.has(next.id)).toBe(true))
    expect(injections.get(next.id)!()).toBe(true)
    persistInput(next)
    await expect(resolve(later)).resolves.toMatchObject({ resultId: "result-v3" })
    await expect(resolve(exact(later, "v3"))).resolves.toMatchObject({ resultId: "result-v3" })
    host.cancel(physical.id)
    await expect(resolve(original)).rejects.toThrow("当前执行已停止")
    await expect(resolve(exact(original, "v1"))).rejects.toThrow("当前执行已停止")
  } finally {
    await host.stop()
    database.close()
    await transcript.closeDatabase()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

it.each([
  { source: "desktop", managed: true },
  { source: "desktop", managed: false },
  { source: "owner IM", managed: true }
])("reuses exact old versions and logical entries in its own desktop work ($source, managed=$managed)", async ({ source, managed }) => {
  fixture.root = await realpath(await mkdtemp(join(tmpdir(), "bot-historical-delivery-")))
  const database = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(database)
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    acquire: (_bot, task) => task.requestId !== "later" && task.mockSource?.transport !== "im" ? null : {
      release() {},
      execute: signal => new Promise(resolve => {
        signal.addEventListener("abort", () => resolve({ state: "completed" }), { once: true })
      })
    }
  }, 2)
  try {
    await transcript.initializeDatabase()
    const workspace = join(fixture.root, "project")
    await mkdir(workspace)
    const bot = store.create({ name: "Reports", instructions: "", color: "#123456", modelRef: null })
    const createWork = (operationId: string) => {
      const { work, task } = store.createWork({ botId: bot.id, operationId, title: "Report", goal: "Deliver a report" },
        undefined, managed ? { kind: "directory", path: workspace } : undefined)
      store.transition(task.id, "cancelled")
      const row = transcript.createThread(work.threadId, { botId: bot.id, botWorkId: work.id,
        botHostId: "local", botAudienceKey: "desktop", workspacePath: workspace })
      store.initializeWorkThread(bot.id, work.id)
      const storage = workAttachmentStorage(workspace, work)
      return { work, row, storage, root: storage ?? workspace }
    }
    const original = createWork("original"), other = createWork("other")
    const name = 'report".md', path = join(workspace, name)
    const signal = new AbortController().signal
    const deliver = async (target: typeof original, id: string, files = [name], legacy = false) => {
      const [tool] = createBotDeliveryTools(workspace, signal, undefined, undefined, false,
        target.storage, legacy ? undefined : target.work.id, undefined,
        legacy ? undefined : botAttachmentReceiptKey(target.work.threadId, target.row))
      const content = String(await tool.invoke({ files }))
      transcript.upsertThreadMessages(target.work.threadId, [
        { id: `assistant-${id}`, role: "assistant", content: "", created_at: new Date(),
          tool_calls: [{ name: tool.name, id, args: {} }] },
        { id: `result-${id}`, role: "tool", content, created_at: new Date(), name: tool.name, tool_call_id: id }
      ])
      return parseBotFileDelivery(content)!
    }
    await writeFile(path, "V1")
    const [v1] = await deliver(original, "v1")
    // More than one lookup batch of newer versions must not hide this exact old receipt.
    for (let index = 0; index < 9; index++) {
      await writeFile(path, `Revision ${index}`)
      await deliver(original, `revision-${index}`)
    }
    await writeFile(path, "Unpublished")
    const unpublished = await snapshotBotDeliveryFile(original.root, path, signal, workspace)
    const legacy = managed ? undefined : (await deliver(original, "legacy", [name], true))[0]
    await writeFile(path, "Never delivered")
    const unrecorded = await snapshotBotDeliveryFile(original.root, path, signal, workspace)
    await writeFile(path, "V2")
    const alternateFiles = [join("a", name), join("b", name)]
    const deliverPair = async (target: typeof original, id: string, contents: [string, string]) => {
      for (const [index, file] of alternateFiles.entries()) {
        const fullPath = join(workspace, file)
        await mkdir(dirname(fullPath), { recursive: true })
        await writeFile(fullPath, contents[index])
      }
      return deliver(target, id, alternateFiles)
    }
    const sharedV1 = await deliverPair(original, "shared-v1", ["V1", "V1"])
    expect(sharedV1.map(file => file.attachmentPath)).toEqual([v1.attachmentPath, v1.attachmentPath])
    expect(sharedV1.map(file => file.filePath)).toEqual(alternateFiles.map(file => join(workspace, file)))
    const sharedBody = "![Chart](chart.png)"
    const [shared, sharedAlias] = await deliverPair(original, "shared-only", [sharedBody, sharedBody])
    expect(shared.attachmentPath).toBe(sharedAlias.attachmentPath)
    for (let index = 0; index < 9; index++)
      await deliver(original, `shared-repeat-${index}`, [alternateFiles[0]])
    const [distinctA, distinctB] = await deliverPair(original, "distinct", ["Different A", "Different B"])
    expect(distinctA.attachmentPath).not.toBe(distinctB.attachmentPath)
    const [foreign, foreignAlias] = await deliverPair(other, "foreign", ["Foreign bytes", "Foreign bytes"])
    expect(foreign.attachmentPath).toBe(foreignAlias.attachmentPath)
    expect(foreign.attachmentPath).not.toBe(shared.attachmentPath)
    const { work, row, storage, root } = original
    const message = "Upload and deliver the exact first version"
    const acceptOwnerContinuation = async () => {
      const expiresAt = new Date(Date.now() + 900_000).toISOString()
      const binding = host.registerImBinding("realm", "owner", {
        id: "personal", botId: bot.id, kind: "dm", label: "Owner IM", state: "active", version: 1,
        conversationKey: "owner-chat", createdAt: new Date().toISOString(), expiresAt
      })
      store.im.importImBinding({ id: binding.id, botId: bot.id, kind: "dm", label: "Owner IM", channelKey: "owner-chat", version: 1 })
      host.setImOnline(bot.id, binding.id, true)
      const event = store.imGateway.receive("realm", "owner", {
        route: { bindingId: "personal", botId: bot.id, kind: "dm", label: "Owner IM", version: 1, senderId: "owner" },
        event: { schemaVersion: 1, eventId: "follow-up", platformMessageId: "owner-request", principalId: "owner",
          conversationKey: "owner-chat", conversationSeq: 1, message: { type: "text", text: message },
          occurredAt: new Date().toISOString(), redelivered: false, lease: { id: "owner-lease", expiresAt } }
      })
      store.imGateway.settle(event.id, "active", undefined, Date.parse(expiresAt))
      const inbound = host.acceptImEvent({
        bindingId: binding.id, eventId: event.id, messageId: "owner-request", senderId: "owner", text: message, mentionsBotIds: [bot.id]
      })
      expect(inbound.status).toBe("accepted")
      store.imGateway.settle(event.id, "active", inbound.taskId!)
      const parent = store.getTask(inbound.taskId!)
      await vi.waitFor(() => expect(store.getTask(parent.id).state).toBe("running"))
      const send = createBotWorkTools(parent, () => host, signal).find(tool => tool.name === "bot_work_send")!
      const reply = await send.invoke({
        type: "tool_call", id: "continue-report", name: send.name, args: { workId: work.id, requestKey: "continue-report", message }
      }) as ToolMessage
      expect(reply).toBeInstanceOf(ToolMessage)
      const receipt = JSON.parse(String(reply.content))
      expect(receipt).toMatchObject({ kind: "bot-work-receipt", receipt: {
        threadId: work.threadId, workId: work.id, origin: { kind: "work", dispatch: "follow_up", sourceTaskId: parent.id },
        mockSource: { transport: "im", personal: true, audienceKey: "desktop" }
      } })
      return store.getTask(receipt.receipt.id)
    }
    const task = source === "owner IM" ? await acceptOwnerContinuation()
      : host.send({ botId: bot.id, workId: work.id, requestId: "later", message })
    await vi.waitFor(() => expect(store.getTask(task.id).state).toBe("running"))
    const resolve = (reference: BotHistoricalDeliveryReference) => host.acceptedHistoricalWorkDelivery(task.id, reference, root, signal)
    const upload = (reference: string) => host.acceptedHistoricalWorkDelivery(task.id, reference, root, signal, "upload")
    const exact = ({ attachmentPath, filePath }: typeof v1) => ({ attachmentPath: attachmentPath!, filePath })
    host.beginInputPreparation(task.id, task.id)
    await expect(resolve(v1.attachmentPath!)).resolves.toBeUndefined()
    host.recordPreparedInput(task.id, task.id, message)
    await expect(resolve(exact(v1))).resolves.toBeUndefined()
    transcript.upsertThreadMessages(work.threadId, [{ id: task.requestId, role: "user", content: message, created_at: new Date() }])
    await expect(resolve(foreign.attachmentPath!)).resolves.toBeUndefined()
    await expect(resolve({ ...exact(v1), source: {
      threadId: other.work.threadId, assistantMessageId: "assistant-foreign", callId: "foreign", fileIndex: 0
    } })).rejects.toThrow("原交付附件已不可用")
    if (legacy) await expect(resolve(unpublished.attachmentPath)).resolves.toMatchObject({ file: legacy })
    else await expect(resolve(unpublished.attachmentPath)).resolves.toBeUndefined()
    await expect(resolve(unrecorded.attachmentPath)).resolves.toBeUndefined()
    await expect(resolve(path)).resolves.toBeUndefined()
    await expect(resolve(v1.attachmentPath!)).rejects.toThrow("对应多条交付记录")
    await expect(resolve(shared.attachmentPath!)).rejects.toThrow("对应多条交付记录")
    await expect(resolve({ attachmentPath: shared.attachmentPath!, filePath: path })).resolves.toBeUndefined()
    const saved = await resolve(exact(v1))
    expect(saved?.file).toEqual(v1)
    expect(saved?.resultId).toBe("result-v1")
    expect(await readFile(saved!.path, "utf8")).toBe("V1")
    expect(await readFile(await resolveBotWorkspaceFile(workspace, name), "utf8")).toBe("V2")
    const originalUpload = await upload(v1.attachmentPath!)
    expect(originalUpload?.path).toBe(v1.attachmentPath)
    expect(await readFile(originalUpload!.path, "utf8")).toBe("V1")
    const savedShared = await resolve(exact(sharedAlias))
    expect(savedShared?.file).toEqual(sharedAlias)
    expect(savedShared?.markdownWorkspace).toBe(workspace)
    expect(await readFile(savedShared!.path, "utf8")).toBe(sharedBody)
    await expect(upload(shared.attachmentPath!)).resolves.toMatchObject({ path: shared.attachmentPath })
    await expect(upload(foreign.attachmentPath!)).resolves.toBeUndefined()
    for (const [file, bytes] of [[distinctA, "Different A"], [distinctB, "Different B"]] as const) {
      const savedDistinct = await resolve(file.attachmentPath!)
      expect(savedDistinct?.file).toEqual(file)
      expect(await readFile(savedDistinct!.path, "utf8")).toBe(bytes)
    }

    const [redeliver] = createBotDeliveryTools(workspace, signal, undefined, undefined, false,
      storage, work.id, undefined, botAttachmentReceiptKey(work.threadId, row), resolve)
    const redelivery = String(await redeliver.invoke({ files: [exact(v1)] }))
    expect(parseBotFileDelivery(redelivery)).toEqual([v1])
    const sharedRedelivery = String(await redeliver.invoke({ files: [exact(sharedAlias), exact(shared)] }))
    expect(parseBotFileDelivery(sharedRedelivery)).toEqual([sharedAlias, shared])
    expect(parseBotFileDelivery(String(await redeliver.invoke({ files: [distinctB.attachmentPath!] })))).toEqual([distinctB])
    expect(JSON.parse(String(await redeliver.invoke({ files: [shared.attachmentPath!] })))).toMatchObject({
      ok: false, error: expect.stringContaining("对应多条交付记录")
    })
    expect(JSON.parse(String(await redeliver.invoke({ files: [exact(foreign)] })))).toMatchObject({ ok: false })
    expect(JSON.parse(String(await redeliver.invoke({ files: [foreign.attachmentPath!] })))).toMatchObject({ ok: false })

    await writeFile(shared.attachmentPath!, sharedBody.toUpperCase())
    await expect(resolve(exact(shared))).rejects.toThrow("成果版本发生变化")
    await expect(upload(shared.attachmentPath!)).rejects.toThrow("成果版本发生变化")

    const receiptPath = v1.attachmentPath!
    await writeFile(receiptPath, "V3")
    await expect(resolve(exact(v1))).rejects.toThrow("成果版本发生变化")
    await rm(receiptPath)
    const redirected = join(dirname(receiptPath), "redirected.txt")
    await writeFile(redirected, "V1")
    await symlink(redirected, receiptPath)
    await expect(resolve(exact(v1))).rejects.toThrow("成果版本发生变化")
    await rm(receiptPath)
    await writeFile(receiptPath, "V1")

    if (task.mockSource) {
      await expect(resolve(exact(v1))).resolves.toMatchObject({ resultId: "result-v1" })
      host.revokeImBinding(bot.id, task.mockSource.bindingId, task.mockSource.grantVersion)
      await expect(resolve(exact(v1))).rejects.toThrow("当前执行已停止")
      await expect(upload(receiptPath)).rejects.toThrow("当前执行已停止")
      return
    }
    const ref = { kind: "local_thread" as const, threadId: work.threadId, incarnation: captureThreadIncarnation(row) }
    store.conversations.prepareCreated(bot.id, work.id, ref)
    store.conversations.bound(bot.id, work.id, ref)
    database.run("UPDATE bot_work_items SET detached=1,conversation_json=json_set(conversation_json,'$.state','detached') WHERE id=?", [work.id])
    await expect(resolve(receiptPath)).rejects.toThrow("原任务关联已变化")
    database.run("UPDATE bot_work_items SET detached=0,conversation_json=NULL WHERE id=?", [work.id])
    const priorMessages = transcript.getThreadMessages(work.threadId)
    transcript.deleteThread(work.threadId)
    const replacement = transcript.createThread(work.threadId, JSON.parse(row.metadata || "{}"))
    expect(captureThreadIncarnation(replacement)).not.toEqual(ref.incarnation)
    transcript.upsertThreadMessages(work.threadId, priorMessages)
    await expect(resolve(receiptPath)).resolves.toBeUndefined()
    host.cancel(task.id)
    await expect(resolve(receiptPath)).rejects.toThrow("当前执行已停止")
  } finally {
    await host.stop()
    database.close()
    await transcript.closeDatabase()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
