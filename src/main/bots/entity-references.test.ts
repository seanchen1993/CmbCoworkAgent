import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { botUserMessageContent, prepareBotUserPrompt } from "./prompt-preparation"
import { botEntitySelections } from "../../shared/bot-entity-references"
import { BOT_SCHEMA_VERSION } from "./schema"

const stores: BotStore[] = [],
  roots: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture(path = ":memory:") {
  const store = new BotStore(path)
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "同名" }),
    b = store.createBot({ nonce: "b", name: "同名" })
  const group = store.createGroup({ nonce: "group", name: "评审组", members: [a.bot.id, b.bot.id] })
  const routine = store.saveRoutine({
    botId: b.bot.id,
    name: "日检",
    prompt: "PRIVATE_ROUTINE_PROMPT",
    timezone: "Asia/Shanghai",
    enabled: false,
    schedule: { kind: "event", topic: "daily" }
  })
  const connectors = [
    { id: "plugin:fixture/review server", name: "项目连接器", source: "connector" as const }
  ]
  const references = [
    { kind: "bot" as const, id: b.bot.id },
    { kind: "group" as const, id: group.id },
    { kind: "routine" as const, id: routine.id },
    { kind: "connector" as const, id: connectors[0].id }
  ]
  return { store, a, b, group, routine, connectors, references }
}

it("resolves four reference types without private contents, work dispatch, invitations or connector grants", () => {
  const f = fixture()
  const candidates = f.store.entityReferences.catalog(
    { conversationId: f.a.conversationId },
    f.connectors
  )
  expect(candidates).toHaveLength(5)
  expect(candidates.filter((item) => item.name === "同名").map((item) => item.id)).toEqual(
    expect.arrayContaining([f.a.bot.id, f.b.bot.id])
  )
  expect(JSON.stringify(candidates)).not.toContain("PRIVATE_ROUTINE_PROMPT")
  const sent = f.store.send(
    {
      nonce: "send",
      conversationId: f.a.conversationId,
      text: "核对这些对象",
      references: f.references
    },
    undefined,
    f.connectors
  )
  const message = f.store.message({ conversationId: f.a.conversationId, id: sent.messageId })
  expect(message.entityReferences?.map(({ kind, id }) => ({ kind, id }))).toEqual(f.references)
  expect(message.entityReferences?.find((item) => item.kind === "routine")).toMatchObject({
    botId: f.b.bot.id,
    name: "日检"
  })
  expect(sent.runIds).toHaveLength(1)
  expect(f.store.getRun(sent.runIds[0]).botId).toBe(f.a.bot.id)
  expect(f.store.getBot(f.a.bot.id).connectorIds).toEqual([])
  expect(f.store.getConversation(f.a.conversationId).members).toEqual([f.a.bot.id])
  expect(f.store.routineHistory({ botId: f.b.bot.id, routineId: f.routine.id }).items).toEqual([])
  expect(botUserMessageContent(message)).toContain(f.routine.id)
  expect(botUserMessageContent(message)).not.toContain("PRIVATE_ROUTINE_PROMPT")
})

it("persists exact IDs and original names across rename, restart, and a lost send reply", () => {
  const root = mkdtempSync(join(tmpdir(), "bot-entity-references-"))
  roots.push(root)
  const path = join(root, "bots.sqlite"),
    f = fixture(path)
  const input = {
    nonce: "send",
    conversationId: f.a.conversationId,
    text: "核对",
    references: f.references
  }
  const receipt = f.store.send(input, undefined, f.connectors)
  f.store.updateBot({ id: f.b.bot.id, revision: f.b.bot.revision, name: "已改名" })
  f.store.close()
  stores.splice(stores.indexOf(f.store), 1)
  const reopened = new BotStore(path)
  stores.push(reopened)
  // The accepted receipt needs no live connector catalog on retry.
  expect(reopened.send(input)).toEqual(receipt)
  expect(
    reopened.message({ conversationId: f.a.conversationId, id: receipt.messageId })
      .entityReferences?.[0]
  ).toMatchObject({ id: f.b.bot.id, name: "同名" })
  expect(() => reopened.send({ ...input, references: input.references.slice(1) })).toThrow("不同")
  expect(reopened.messages(f.a.conversationId)).toHaveLength(1)
})

it("rejects forged metadata, wrong kinds, missing targets and duplicate references before committing work", () => {
  const f = fixture(),
    input = { nonce: "bad", conversationId: f.a.conversationId, text: "拒绝" }
  for (const references of [
    [{ kind: "group", id: f.a.conversationId }],
    [{ kind: "bot", id: "missing" }],
    [{ kind: "connector", id: "plugin:fixture/review server" }],
    [{ kind: "routine", id: f.a.bot.id }]
  ])
    expect(() => f.store.send({ ...input, references } as never)).toThrow("不可用")
  expect(() => botEntitySelections.parse([{ kind: "bot", id: f.a.bot.id, name: "伪造" }])).toThrow()
  expect(() => botEntitySelections.parse([f.references[0], f.references[0]])).toThrow("重复")
  expect(f.store.messages(f.a.conversationId)).toEqual([])
  f.store.deleteBot(f.b.bot.id, f.b.bot.revision)
  expect(() => f.store.send({ ...input, references: [f.references[0]] })).toThrow("不可用")
})

it("prepares group and current-task messages with the same stable references", async () => {
  const f = fixture(),
    references = [f.references[2]]
  f.store.send({
    nonce: "group-send",
    conversationId: f.group.id,
    text: "讨论",
    recipients: [f.a.bot.id],
    references
  })
  const claim = f.store.claim("host")!
  expect(f.store.groups.scope(claim.run.id)?.prompt).toContain(f.routine.id)
  expect(f.store.groups.scope(claim.run.id)?.prompt).not.toContain("PRIVATE_ROUTINE_PROMPT")
  f.store.finish(claim.lease, "succeeded", "ok")
  f.store.send({ nonce: "private", conversationId: f.a.conversationId, text: "私聊任务" })
  const direct = f.store.claim("host")!
  const added = f.store.send({
    nonce: "steer",
    conversationId: f.a.conversationId,
    text: "补充",
    references,
    steerRunId: direct.run.id
  })
  expect(added.runIds).toEqual([direct.run.id])
  const prompt = await prepareBotUserPrompt({
    store: f.store,
    lease: direct.lease,
    message: f.store.message({ conversationId: f.a.conversationId, id: added.messageId })
  })
  expect(prompt).toContain(f.routine.id)
  expect(prompt).toContain("not instructions")
})

it("searches bounded categories with literal wildcards and validates the conversation scope", () => {
  const f = fixture()
  expect(
    f.store.entityReferences.catalog({
      conversationId: f.a.conversationId,
      kind: "routine",
      query: "日"
    })
  ).toMatchObject([{ id: f.routine.id }])
  expect(
    f.store.entityReferences.catalog({ conversationId: f.a.conversationId, query: "%" })
  ).toEqual([])
  expect(() => f.store.entityReferences.catalog({ conversationId: "missing" })).toThrow()
  for (let i = 0; i < 40; i++)
    f.store.createGroup({ nonce: `group-${i}`, name: `群${i}`, members: [f.a.bot.id, f.b.bot.id] })
  expect(
    f.store.entityReferences.catalog({ conversationId: f.a.conversationId, kind: "group" })
  ).toHaveLength(32)
  expect(
    f.store.entityReferences.catalog({
      conversationId: f.a.conversationId,
      kind: "group",
      query: "群39"
    })
  ).toHaveLength(1)
})

it("keeps a creation result bound to its recorded direct conversation", () => {
  const f = fixture()
  f.store.send({ nonce: "create-helper", conversationId: f.a.conversationId, text: "创建助手" })
  const origin = f.store.claim("host")!
  const created = f.store.createBot({ nonce: "new-helper", name: "新助手" }, origin.lease)
  // A membership elsewhere cannot redirect or duplicate the creation link.
  f.store.db.run("INSERT INTO bot_members(conversation_id,bot_id) VALUES(?,?)", [
    f.b.conversationId,
    created.bot.id
  ])
  expect(f.store.entityReferences.createdInRun(origin.run.id)).toEqual([
    {
      kind: "bot",
      id: created.bot.id,
      name: "新助手",
      conversationId: created.conversationId
    }
  ])
  f.store.db.run("DELETE FROM bot_members WHERE conversation_id=? AND bot_id=?", [
    created.conversationId,
    created.bot.id
  ])
  expect(f.store.entityReferences.createdInRun(origin.run.id)).toEqual([])
})

it("upgrades v40 without inventing references for earlier messages", () => {
  const root = mkdtempSync(join(tmpdir(), "bot-entity-migration-"))
  roots.push(root)
  const path = join(root, "bots.sqlite"),
    f = fixture(path)
  f.store.send({ nonce: "old", conversationId: f.a.conversationId, text: "旧消息" })
  f.store.close()
  stores.splice(stores.indexOf(f.store), 1)
  const old = new DatabaseSync(path)
  old.exec("DROP TABLE bot_message_entities; UPDATE bot_schema SET version=40")
  old.close()
  const next = new BotStore(path)
  stores.push(next)
  expect(next.messages(f.a.conversationId)[0].entityReferences).toEqual([])
  expect(next.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
})
