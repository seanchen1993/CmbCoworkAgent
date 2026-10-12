import { afterEach, expect, it } from "vitest"
import { mkdtemp, mkdir, realpath, rm, symlink, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { createBotAPI } from "./rpc"
import { BOT_SCHEMA_VERSION } from "./schema"
import type { CoworkBot } from "../../shared/bot-types"
import type { BotSharedMemoryScope } from "../../shared/bot-memory"

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-memory-scopes-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const project = join(root, "project"),
    other = join(root, "other")
  await Promise.all([mkdir(project), mkdir(other)])
  const path = join(root, "bots.sqlite"),
    store = new BotStore(path)
  cleanup.push(() => store.close())
  const a = store.createBot({ nonce: "a", name: "a", workspacePath: project }).bot
  const b = store.createBot({ nonce: "b", name: "b", workspacePath: project }).bot
  const c = store.createBot({ nonce: "c", name: "c", workspacePath: other }).bot
  const save = (bot: CoworkBot, scope: BotSharedMemoryScope, text: string) =>
    store.sharedMemories.save({
      botId: bot.id,
      botRevision: bot.revision,
      scope,
      text,
      nonce: randomUUID()
    })
  return { root, path, project, other, store, a, b, c, save }
}
const address = (bot: CoworkBot, scope: BotSharedMemoryScope) => ({
  botId: bot.id,
  botRevision: bot.revision,
  scope
})

it("keeps private facts private, shares explicit user facts, and bounds project facts to the same configured root", async () => {
  const f = await fixture()
  f.store.saveMemory({ botId: f.a.id, text: "A 的私聊内容" })
  await f.save(f.a, "user", "所有 Bot 使用中文")
  await f.save(f.a, "project", "当前项目使用 PostgreSQL")
  await f.save(f.c, "project", "另一项目使用 SQLite")
  expect((await f.store.sharedMemories.visible(f.a.id)).map((m) => m.text)).toEqual([
    "A 的私聊内容",
    "所有 Bot 使用中文",
    "当前项目使用 PostgreSQL"
  ])
  expect((await f.store.sharedMemories.visible(f.b.id)).map((m) => m.text)).toEqual([
    "所有 Bot 使用中文",
    "当前项目使用 PostgreSQL"
  ])
  expect((await f.store.sharedMemories.visible(f.c.id)).map((m) => m.text)).toEqual([
    "所有 Bot 使用中文",
    "另一项目使用 SQLite"
  ])
  expect(
    (await f.store.sharedMemories.visible(f.b.id)).every(
      (m) => !m.sourceMessageId && !m.evidence?.length
    )
  ).toBe(true)
  // A nested directory is not automatically authorized for its parent project's memory.
  const sub = join(f.project, "sub")
  await mkdir(sub)
  const child = f.store.createBot({ nonce: "child", name: "child", workspacePath: sub }).bot
  expect((await f.store.sharedMemories.visible(child.id)).map((m) => m.scope)).toEqual(["user"])
})

it("canonicalizes configured directory aliases and re-resolves a retargeted alias", async () => {
  const f = await fixture(),
    alias = join(f.root, "alias")
  await symlink(f.project, alias, process.platform === "win32" ? "junction" : "dir")
  const bot = f.store.createBot({ nonce: "alias", name: "alias", workspacePath: alias }).bot
  await f.save(f.a, "project", "first project")
  await f.save(f.c, "project", "second project")
  expect((await f.store.sharedMemories.list(address(bot, "project")))[0].text).toBe("first project")
  const captured = await f.store.sharedMemories.reader(bot.id, alias)
  await unlink(alias)
  await symlink(f.other, alias, process.platform === "win32" ? "junction" : "dir")
  expect((await f.store.sharedMemories.list(address(bot, "project")))[0].text).toBe(
    "second project"
  )
  await expect(captured()).rejects.toThrow("项目已变化")
})

it("rejects a guessed foreign project ID and concurrent stale edits, preserving the original item", async () => {
  const f = await fixture(),
    saved = await f.save(f.a, "project", "initial")
  await expect(
    f.store.sharedMemories.save({
      ...address(f.c, "project"),
      nonce: "foreign",
      id: saved.id,
      revision: saved.revision,
      text: "foreign edit"
    })
  ).rejects.toThrow("不属于当前范围")
  await expect(
    f.store.sharedMemories.remove({
      ...address(f.c, "project"),
      nonce: "foreign-delete",
      id: saved.id,
      revision: saved.revision
    })
  ).rejects.toThrow("不属于当前范围")
  const requests = [f.a, f.b].map((bot, i) =>
    f.store.sharedMemories.save({
      ...address(bot, "project"),
      nonce: `edit-${i}`,
      id: saved.id,
      revision: 1,
      text: `edit ${i}`
    })
  )
  const results = await Promise.allSettled(requests)
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  expect((await f.store.sharedMemories.list(address(f.a, "project")))[0].revision).toBe(2)
})

it("fences a project/configuration change while a scope lookup is in flight", async () => {
  const f = await fixture()
  await f.save(f.a, "project", "old project")
  const pending = f.store.sharedMemories.save({
    ...address(f.a, "project"),
    text: "must not be saved",
    nonce: "stale"
  })
  const updated = f.store.updateBot({ id: f.a.id, revision: f.a.revision, workspacePath: f.other })
  await expect(pending).rejects.toThrow("项目已变化")
  await expect(f.store.sharedMemories.visible(f.a.id, f.project)).rejects.toThrow("项目已变化")
  expect(await f.store.sharedMemories.list(address(updated, "project"))).toEqual([])
  expect((await f.store.sharedMemories.list(address(f.b, "project"))).map((m) => m.text)).toEqual([
    "old project"
  ])
})

it("replays exact mutation receipts after restart without resurrecting a deleted shared memory", async () => {
  const f = await fixture(),
    input = { ...address(f.a, "user"), nonce: "create-once", text: "shared" }
  const saved = await f.store.sharedMemories.save(input)
  const remove = { ...address(f.a, "user"), nonce: "delete-once", id: saved.id, revision: 1 }
  const receipt = await f.store.sharedMemories.remove(remove)
  f.store.close()
  const reopened = new BotStore(f.path)
  cleanup.push(() => reopened.close())
  expect(await reopened.sharedMemories.save(input)).toEqual(saved)
  expect(await reopened.sharedMemories.remove(remove)).toEqual(receipt)
  expect(await reopened.sharedMemories.list(address(f.a, "user"))).toEqual([])
  await expect(reopened.sharedMemories.save({ ...input, text: "changed" })).rejects.toThrow(
    "同一请求标识"
  )
})

it("revokes old private synthesis evidence after a shared correction, leaving private records and other scopes intact", async () => {
  const f = await fixture(),
    shared = await f.save(f.a, "user", "旧约定")
  f.store.saveMemory({ botId: f.b.id, text: "显式个人偏好" })
  const conversation = f.store
    .snapshot()
    .conversations.find((c) => c.kind === "direct" && c.members.includes(f.b.id))!
  f.store.send({ nonce: "task", conversationId: conversation.id, text: "请按旧约定分析" })
  const claim = f.store.claim("host")!
  f.store.finish(claim.lease, "succeeded", "沿用旧约定")
  expect(f.store.memory.policy(f.b.id).pending).toBe(1)
  await f.store.sharedMemories.save({
    ...address(f.a, "user"),
    nonce: "fix",
    id: shared.id,
    revision: 1,
    text: "新约定"
  })
  expect(f.store.memory.policy(f.b.id).pending).toBe(0)
  expect(f.store.memories(f.b.id)[0].text).toBe("显式个人偏好")
  expect((await f.store.sharedMemories.list(address(f.b, "user")))[0]).toMatchObject({
    text: "新约定",
    origin: "explicit"
  })
})

it("does not delete user/project memories when their creating Bot is deleted", async () => {
  const f = await fixture()
  await f.save(f.a, "user", "user fact")
  await f.save(f.a, "project", "project fact")
  f.store.deleteBot(f.a.id, f.a.revision)
  expect((await f.store.sharedMemories.visible(f.b.id)).map((m) => m.text)).toEqual([
    "user fact",
    "project fact"
  ])
})

it("keeps Host user roots separate and rejects caller-supplied scope identities through the public API", async () => {
  const f = await fixture(),
    api = createBotAPI(new BotHost(f.store))
  await f.save(f.a, "user", "only this user's Host")
  const other = new BotStore(join(f.root, "other-user.sqlite"))
  cleanup.push(() => other.close())
  const bot = other.createBot({ nonce: "other", name: "other", workspacePath: f.project }).bot
  expect(await other.sharedMemories.visible(bot.id)).toEqual([])
  await expect(other.sharedMemories.list(address(f.a, "user"))).rejects.toThrow()
  for (const extra of [
    { userId: "other" },
    { projectPath: f.other },
    { sourceMessageId: "private" }
  ]) {
    await expect(
      api.saveSharedMemory({ ...address(f.a, "user"), nonce: "injected", text: "bad", ...extra })
    ).rejects.toThrow()
  }
  await expect(
    api.sharedMemories({ ...address(f.a, "user"), scope: "team" } as never)
  ).rejects.toThrow()
})

it("upgrades a v15 database additively and preserves protected private memories", async () => {
  const f = await fixture()
  f.store.saveMemory({ botId: f.a.id, text: "private" })
  f.store.close()
  const db = new DatabaseSync(f.path)
  db.exec("DROP TABLE bot_shared_memories; UPDATE bot_schema SET version=15")
  db.close()
  const migrated = new BotStore(f.path)
  cleanup.push(() => migrated.close())
  expect(migrated.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(
    BOT_SCHEMA_VERSION
  )
  expect(migrated.memories(f.a.id)[0]).toMatchObject({ text: "private", origin: "explicit" })
  expect(await migrated.sharedMemories.list(address(f.a, "project"))).toEqual([])
})
