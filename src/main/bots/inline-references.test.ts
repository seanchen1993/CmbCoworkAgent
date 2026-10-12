import { afterEach, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BOT_SCHEMA_VERSION } from "./schema"
import { botUserMessageContent } from "./prompt-preparation"
import type {
  BotInlineReferenceAddress,
  BotInlineReferenceSpan
} from "../../shared/bot-inline-references"
import type { BotSendInput } from "../../shared/bot-types"

const stores: BotStore[] = [],
  roots: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function close(store: BotStore) {
  store.close()
  stores.splice(stores.indexOf(store), 1)
}
function fixture(path = ":memory:") {
  const store = new BotStore(path)
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "助手" })
  const b = store.createBot({ nonce: "b", name: "助手" })
  const group = store.createGroup({ nonce: "group", name: "项目组", members: [a.bot.id, b.bot.id] })
  const skill = store.saveSkill({
    botId: a.bot.id,
    name: "评审",
    instructions: "PRIVATE_SKILL",
    enabled: true
  })
  const routine = store.saveRoutine({
    botId: b.bot.id,
    name: "日检",
    prompt: "PRIVATE_ROUTINE",
    timezone: "UTC",
    enabled: false,
    schedule: { kind: "event", topic: "daily" }
  })
  const connectors = [{ id: "plugin:test/docs", name: "文档库", source: "connector" as const }]
  const references = [
    { kind: "bot" as const, id: b.bot.id },
    { kind: "group" as const, id: group.id },
    { kind: "routine" as const, id: routine.id },
    { kind: "connector" as const, id: connectors[0].id }
  ]
  const skills = [{ botId: a.bot.id, id: skill.id, version: skill.version }]
  let text = "🙂 请 "
  const inlineReferences: BotInlineReferenceSpan[] = []
  const append = (reference: BotInlineReferenceAddress, label: string) => {
    const from = text.length
    text += label
    inlineReferences.push({ from, to: text.length, reference })
    text += " 核对\n"
  }
  append({ kind: "recipient", id: a.bot.id }, "@助手")
  for (const [index, label] of ["@助手", "@项目组", "@日检", "@文档库"].entries())
    append(references[index], label)
  append({ ...skills[0], kind: "skill" }, "/评审")
  const input: BotSendInput = {
    nonce: "send",
    conversationId: group.id,
    text,
    recipients: [a.bot.id],
    references,
    skills,
    inlineReferences
  }
  return { store, a, b, group, skill, routine, connectors, input }
}

it("retains every inline identity and position without dispatching referenced objects", () => {
  const f = fixture(),
    sent = f.store.send(f.input, undefined, f.connectors)
  const message = f.store.message({ conversationId: f.group.id, id: sent.messageId })
  expect(message.inlineReferences).toEqual(f.input.inlineReferences)
  expect(message.text).toBe(f.input.text)
  expect(message.recipientReferences).toEqual([{ botId: f.a.bot.id, name: "助手" }])
  expect(sent.runIds.map((id) => f.store.getRun(id).botId)).toEqual([f.a.bot.id])
  expect(f.store.routineHistory({ botId: f.b.bot.id, routineId: f.routine.id }).items).toEqual([])
  expect(f.store.getBot(f.a.bot.id).connectorIds).toEqual([])
  expect(botUserMessageContent(message)).toContain(f.input.text)
  expect(botUserMessageContent(message)).not.toContain("PRIVATE_ROUTINE")
})

it("replays an accepted receipt after rename and restart without consulting a live catalog", () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-inline-references-"))
  roots.push(root)
  const path = join(root, "bots.sqlite"),
    f = fixture(path)
  const sent = f.store.send(f.input, undefined, f.connectors)
  f.store.updateBot({ id: f.a.bot.id, revision: f.a.bot.revision, name: "已改名" })
  f.store.saveSkill({ ...f.skill, name: "已改技能名", enabled: false })
  close(f.store)
  const next = new BotStore(path)
  stores.push(next)
  expect(next.send(f.input)).toEqual(sent)
  expect(next.messages(f.group.id)[0]).toMatchObject({
    text: f.input.text,
    inlineReferences: f.input.inlineReferences,
    recipientReferences: [{ botId: f.a.bot.id, name: "助手" }]
  })
  expect(next.messages(f.group.id)).toHaveLength(1)
  expect(() =>
    next.send({ ...f.input, inlineReferences: f.input.inlineReferences!.slice(1) })
  ).toThrow("不同")
})

it("rejects forged labels, unselected identities and malformed positions before any work is committed", () => {
  const f = fixture(),
    input = f.input,
    spans = input.inlineReferences!
  const bad: BotSendInput[] = [
    {
      ...input,
      inlineReferences: [{ ...spans[0], reference: { kind: "recipient", id: f.b.bot.id } }]
    },
    { ...input, references: input.references!.slice(1) },
    { ...input, skills: [] },
    { ...input, text: input.text.replace("@助手", "@伪造") },
    { ...input, inlineReferences: [spans[1], spans[0]] },
    { ...input, inlineReferences: [spans[0], spans[0]] },
    { ...input, inlineReferences: [{ ...spans[0], to: input.text.length + 1 }] },
    { ...input, inlineReferences: [{ ...spans[0], from: 1 }] },
    { ...input, inlineReferences: [{ ...spans[0], from: -1 }] },
    { ...input, inlineReferences: Array.from({ length: 65 }, () => spans[0]) },
    {
      ...input,
      inlineReferences: [{ ...spans[0], reference: { ...spans[0].reference, name: "助手" } }]
    } as never
  ]
  for (const request of bad) expect(() => f.store.send(request, undefined, f.connectors)).toThrow()
  expect(f.store.messages(f.group.id)).toEqual([])
  expect(f.store.snapshot().runs).toEqual([])
  f.store.updateBot({ id: f.a.bot.id, revision: f.a.bot.revision, name: "新名称" })
  expect(() => f.store.send(input, undefined, f.connectors)).toThrow("名称已变化")
})

it("allows everyone only when the group is actually addressed to everyone", () => {
  const f = fixture(),
    input: BotSendInput = {
      nonce: "everyone",
      conversationId: f.group.id,
      text: "请@全体 Bot 核对",
      inlineReferences: [{ from: 1, to: 8, reference: { kind: "everyone", id: "everyone" } }]
    }
  expect(() => f.store.send({ ...input, recipients: [f.a.bot.id] })).toThrow("重新选择")
  expect(() => f.store.send({ ...input, conversationId: f.a.conversationId })).toThrow("重新选择")
  const result = f.store.send(input)
  expect(
    f.store.message({ conversationId: f.group.id, id: result.messageId }).inlineReferences
  ).toEqual(input.inlineReferences)
})

it("preserves reference positions for a branch and a current-task instruction", () => {
  const f = fixture(),
    root = f.store.send({ nonce: "root", conversationId: f.a.conversationId, text: "开始" })
  const active = f.store.claim("host")!
  const input: BotSendInput = {
    nonce: "steer",
    conversationId: f.a.conversationId,
    text: "核对@日检",
    references: [f.input.references![2]],
    inlineReferences: [{ from: 2, to: 5, reference: f.input.references![2] }]
  }
  const steer = f.store.send({ ...input, steerRunId: active.run.id })
  expect(steer.runIds).toEqual(root.runIds)
  expect(
    f.store.message({ conversationId: f.a.conversationId, id: steer.messageId }).inlineReferences
  ).toEqual(input.inlineReferences)
  const branch = f.store.send({ ...input, nonce: "branch", threadRootId: root.messageId })
  expect(
    f.store
      .messages(f.a.conversationId, undefined, undefined, undefined, root.messageId)
      .find((message) => message.id === branch.messageId)?.inlineReferences
  ).toEqual(input.inlineReferences)
})

it("backs up and upgrades v41 without fabricating inline positions in old messages", () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-inline-migration-"))
  roots.push(root)
  const path = join(root, "bots.sqlite"),
    f = fixture(path)
  f.store.send({ nonce: "old", conversationId: f.a.conversationId, text: "旧的@助手文本" })
  close(f.store)
  const db = new DatabaseSync(path)
  db.exec("DROP TABLE bot_message_inline_references; UPDATE bot_schema SET version=41")
  db.close()
  const next = new BotStore(path)
  stores.push(next)
  expect(next.messages(f.a.conversationId)[0].inlineReferences).toBeUndefined()
  expect(next.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
  const backup = readdirSync(join(root, "backups")).find((name) => name.startsWith("bots-v41-"))!
  const saved = new DatabaseSync(join(root, "backups", backup), { readOnly: true })
  try {
    expect(saved.prepare("SELECT version FROM bot_schema").get()?.version).toBe(41)
  } finally {
    saved.close()
  }
})
