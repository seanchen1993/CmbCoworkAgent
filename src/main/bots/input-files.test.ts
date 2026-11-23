import { afterEach, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { snapshotBotDeliveryFile } from "./file-copy"
import { projectSkillWorkInput } from "./input-files"
import { canonicalBotMessageInput } from "../../shared/bots/message-mentions"
import { parseSendBotMessage } from "../../shared/bots/validation"
import { buildAttachmentMessageParts } from "../../shared/attachment-message-parts"

const databases: NativeSqliteAdapter[] = [], directories: string[] = []
afterEach(async () => {
  databases.splice(0).forEach(db => db.close())
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  let now = 1000
  const store = new BotStore(db, () => now)
  const bot = store.create({ name: "Inputs", instructions: "", color: "#ea2845", modelRef: null })
  const peer = store.create({ name: "Other", instructions: "", color: "#ea2845", modelRef: null })
  return { db, store, bot, peer, advance: (ms: number) => { now += ms } }
}
function attachment(filePath = "/fixture/.bot-deliveries/hash/design.md") {
  return { filename: "design.md", filePath, content: "VERSION ONE", size: 11, mimeType: "text/markdown", truncated: false }
}

it("keeps picker byte versions and request identities through a store restart and lost replies", async () => {
  const f = fixture()
  const root = await mkdtemp(join(tmpdir(), "bot-input-"))
  directories.push(root)
  const source = join(root, "design.md")
  await writeFile(source, "VERSION ONE")
  const version = await snapshotBotDeliveryFile(root, source, new AbortController().signal)
  const original = f.store.retainInputFile(f.bot.id, attachment(source), version.attachmentPath)
  expect(original.filePath).toBe(source)
  expect(buildAttachmentMessageParts([original]).attachmentModelBlocks).not.toContain(".bot-deliveries")
  const input = parseSendBotMessage({ botId: f.bot.id, requestId: "selected-input", message: "Implement the selected design", inputFileIds: [original.botInputId] })
  const first = f.store.enqueue(input)
  await writeFile(source, "VERSION TWO")
  const restarted = new BotStore(f.db)
  expect(restarted.enqueue(input).id).toBe(first.id)
  const [retained] = restarted.inputFiles(f.bot.id, [original.botInputId!])
  expect(await readFile(retained.file.filePath, "utf8")).toBe("VERSION ONE")
  expect(retained.file).not.toHaveProperty("content")
  expect(first.origin).toMatchObject({ kind: "user", inputFileIds: [original.botInputId] })
  const digest = (ids?: string[]) => createHash("sha256").update(canonicalBotMessageInput(input.message, undefined, ids)).digest("hex")
  expect(restarted.requestReceipts(f.bot.id, [{ requestId: input.requestId, messageHash: digest(input.inputFileIds) }]))
    .toEqual([{ requestId: input.requestId, state: "accepted" }])
  expect(restarted.requestReceipts(f.bot.id, [{ requestId: input.requestId, messageHash: digest() }]))
    .toEqual([{ requestId: input.requestId, state: "conflict" }])
  const revised = restarted.retainInputFile(f.bot.id, attachment(source), "/other-version")
  expect(() => restarted.enqueue({ ...input, inputFileIds: [revised.botInputId!] })).toThrow("另一条消息")
})

it("accepts only the actual Bot's issued references, not XML, unknown IDs, or another scope", () => {
  const f = fixture()
  const original = f.store.retainInputFile(f.bot.id, attachment("/editable/design.md"), attachment().filePath)
  const input = { botId: f.bot.id, requestId: "scope", message: "read", inputFileIds: [original.botInputId!] }
  expect(() => f.store.enqueue({ ...input, botId: f.peer.id })).toThrow("不属于当前 Bot")
  expect(() => f.store.enqueue({ ...input, inputFileIds: ["input-22222222-2222-2222-2222-222222222222"] })).toThrow("不可用")
  expect(() => f.store.enqueue(input, { kind: "schedule", scheduleId: "schedule", nominalAt: "2026-11-10" } as never)).toThrow("原私聊请求")
  const work = f.store.createWork({ botId: f.bot.id, operationId: "work", title: "Work", goal: "Do work" })
  expect(() => f.store.enqueue({ ...input, workId: work.work.id })).toThrow("附件不属于此会话的本机输入")
  const textOnly = f.store.enqueue({ botId: f.bot.id, requestId: "literal", message: `<attachment botInputId="${original.botInputId}" path="/secret">text</attachment>` })
  expect(textOnly.origin).toEqual({ kind: "user" })
  for (const ids of [[original.botInputId, original.botInputId], ["/path"], "not-list"]) {
    expect(() => parseSendBotMessage({ ...input, inputFileIds: ids })).toThrow("附件引用无效")
  }
})

it("requires the exact approved attachment when a live supplement selects a new version of the same file", () => {
  const { store, bot } = fixture()
  const workspace = "/workspace"
  const path = join(workspace, "design.md")
  const first = store.retainInputFile(bot.id, attachment(path), join(workspace, "snapshot-one"))
  const second = store.retainInputFile(bot.id, attachment(path), join(workspace, "snapshot-two"))
  const send = (requestId: string, file: typeof first) => {
    const message = requestId + buildAttachmentMessageParts([file]).attachmentModelBlocks
    const task = store.enqueue({ botId: bot.id, requestId, message, inputFileIds: [file.botInputId!] })
    return { task, message }
  }
  const original = send("choose-first", first)
  store.transition(original.task.id, "running")
  store.recordPreparedInput(original.task.id, original.message)
  const supplement = send("choose-second", second)
  store.recordPreparedInput(supplement.task.id, supplement.message)
  const selected = (reference: string) => store.acceptedDesktopInputFile(original.task.id, reference, true, undefined, workspace)
  expect(selected("design.md")?.id).toBe(first.botInputId)
  expect(store.injectIntoRun(supplement.task.id, original.task.id)).toBe(true)
  expect(() => selected("design.md")).toThrow("多个已选版本")
  expect(() => selected(path)).toThrow("多个已选版本")
  expect(selected(first.botInputId!)?.file.filePath).toBe(join(workspace, "snapshot-one"))
  expect(selected(second.botInputId!)?.file.filePath).toBe(join(workspace, "snapshot-two"))
  expect(selected(join(workspace, "snapshot-two"))?.id).toBe(second.botInputId)
})

it("retains source identity after normal task pruning without retaining the request body", () => {
  const f = fixture()
  const file = f.store.retainInputFile(f.bot.id, attachment("/editable/design.md"), attachment().filePath)
  const input = { botId: f.bot.id, requestId: "old-input", message: "Use the selected design", inputFileIds: [file.botInputId!] }
  const task = f.store.enqueue(input)
  f.store.transition(task.id, "cancelled")
  f.advance(1)
  for (let i = 0; i < 100; i++) {
    const tail = f.store.enqueue({ botId: f.bot.id, requestId: `tail-${i}`, message: "Later request" })
    f.store.transition(tail.id, "cancelled")
  }
  f.advance(31 * 86400000)
  expect(f.store.pruneTaskHistory()).toBe(1)
  expect(() => f.store.getTask(task.id)).toThrow()
  expect(f.store.messageOrigins(f.bot.id, [input.requestId])[0].origin).toEqual(task.origin)
  expect(f.db.exec("SELECT message FROM bot_exchange_archive WHERE id=?", [task.id])[0].values).toEqual([[null]])
  const check = (message: string, ids?: string[]) => ({ requestId: input.requestId,
    messageHash: createHash("sha256").update(canonicalBotMessageInput(message, undefined, ids)).digest("hex") })
  expect(f.store.requestReceipts(f.bot.id, [check(input.message, input.inputFileIds)])[0].state).toBe("accepted")
  expect(f.store.requestReceipts(f.bot.id, [check(input.message)])[0].state).toBe("conflict")
  expect(f.store.requestReceipts(f.bot.id, [check(JSON.stringify([input.message, [], input.inputFileIds]))])[0].state).toBe("conflict")
  expect(f.store.messageOrigins(f.peer.id, [input.requestId])).toEqual([])
})

it("keeps legacy request digests and ordinary sends unchanged", () => {
  const f = fixture()
  expect(canonicalBotMessageInput("hello")).toBe("hello")
  const input = parseSendBotMessage({ botId: f.bot.id, requestId: "old", message: "hello" })
  expect(input).not.toHaveProperty("inputFileIds")
  expect(f.store.enqueue(input).origin).toEqual({ kind: "user" })
})

it.each(["new", "existing"] as const)("uses the retained main-chat bytes for a skill handed to a %s project task", async (target) => {
  const f = fixture()
  const root = await mkdtemp(join(tmpdir(), "bot-skill-handoff-"))
  directories.push(root)
  const source = join(root, "archive.zip")
  await writeFile(source, "selected version")
  const { attachmentPath, size } = await snapshotBotDeliveryFile(root, source, new AbortController().signal)
  const selectedPath = "shared/picker/archive.zip"
  const selection = f.store.retainInputFile(f.bot.id, {
    filename: "archive.zip", filePath: selectedPath, mimeType: "application/octet-stream",
    content: `Original file retained in your workspace: ${JSON.stringify(selectedPath)}.`,
    size, truncated: false
  }, attachmentPath)
  const workspace = { kind: "directory", path: join(root, "project") } as const
  const explicitSkill = { name: "review", path: "/skills/review/SKILL.md" }
  const inputFileIds = [selection.botInputId!]
  const goal = "Inspect the original archive."
  const message = goal + buildAttachmentMessageParts([selection]).attachmentModelBlocks
  const create = { botId: f.bot.id, operationId: target, title: "Project work", goal, workspace }
  const work = target === "new"
    ? f.store.createWork({ ...create, explicitSkill, inputFileIds }, undefined, workspace)
    : f.store.createWork(create, undefined, workspace)
  const send = {
    botId: f.bot.id, workId: work.work.id, requestId: "skill-follow-up", message,
    explicitSkill, inputFileIds, skillDraftFromMain: true as const
  }
  const task = target === "new" ? work.task : f.store.enqueue(send)
  const restarted = new BotStore(f.db)
  expect(task.message).toBe(message)
  const digest = createHash("sha256").update(canonicalBotMessageInput(message, undefined, inputFileIds, explicitSkill)).digest("hex")
  expect(restarted.requestReceipts(f.bot.id, [{ requestId: task.requestId, messageHash: digest }], work.work.id)[0].state).toBe("accepted")
  expect((target === "new"
    ? restarted.createWork({ ...create, explicitSkill, inputFileIds }, undefined, workspace).task
    : restarted.enqueue(send)).id).toBe(task.id)
  await writeFile(source, "later edit")
  const projected = projectSkillWorkInput(task, restarted.inputFiles(f.bot.id, inputFileIds))
  expect(projected).toContain(`path="${attachmentPath}"`)
  expect(projected).toContain(`Original file retained at ${JSON.stringify(attachmentPath)}.`)
  expect(projected).not.toContain(selectedPath)
  expect(await readFile(attachmentPath, "utf8")).toBe("selected version")
  restarted.transition(task.id, "running")
  restarted.recordPreparedInput(task.id, goal)
  expect(restarted.acceptedDesktopInputFile(task.id, attachmentPath)).toBeUndefined()
  restarted.recordPreparedInput(task.id, projected)
  expect(restarted.acceptedDesktopInputFile(task.id, attachmentPath)?.id).toBe(selection.botInputId)
})
