import { afterEach, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BOT_SCHEMA_VERSION } from "./schema"
import { canonicalJson } from "./validation"
const stores: BotStore[] = [],
  directories: string[] = []
const open = (path = ":memory:") => {
  const store = new BotStore(path)
  stores.push(store)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
it("creates without a model and replays the same receipt after restart, retaining the legacy hash", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-fast-create-"))
  directories.push(directory)
  const path = join(directory, "bots.sqlite"),
    store = open(path)
  const input = { nonce: "old-create", name: "New Bot" }
  const created = store.createBot(input)
  expect(created.bot.modelRef).toBeNull()
  expect(store.snapshot().runs).toHaveLength(0)
  const expected = createHash("sha256")
    .update(
      canonicalJson({
        op: "create",
        name: input.name,
        instructions: "",
        modelRef: null,
        workspacePath: null,
        avatarShape: null,
        avatarColor: null
      })
    )
    .digest("hex")
  expect(
    store.db.exec("SELECT request_hash FROM bot_receipts WHERE nonce='old-create'")[0].values[0][0]
  ).toBe(expected)
  store.close()
  const reopened = open(path)
  expect(reopened.createBot(input)).toEqual(created)
  expect(reopened.listBots()).toHaveLength(1)
  expect(() => reopened.createBot({ ...input, title: "label" })).toThrow("同一请求标识")
})
it("replays accepted creation read-only and checks workspace identity before spending a new nonce", () => {
  const store = open(),
    input = {
      nonce: "scoped",
      name: "新 Bot",
      expectedDataEpoch: store.dataEpoch()
    }
  const created = store.createBot(input)
  expect(store.createBot(input)).toEqual(created)
  store.db.run("INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)", [
    "workspace.restored",
    "new-epoch",
    "{}",
    1
  ])
  const restoredCursor = store.snapshot().cursor
  expect(store.createBot(input)).toEqual(created)
  expect(store.snapshot().cursor).toBe(restoredCursor)
  expect(store.listBots()).toHaveLength(1)
  const next = {
    ...input,
    nonce: "rejected-before",
    expectedDataEpoch: "initial"
  }
  expect(() => store.createBot(next)).toThrow("工作区数据已恢复")
  expect(store.createBot({ ...next, expectedDataEpoch: "new-epoch" }).bot.id).not.toBe(
    created.bot.id
  )
  expect(() =>
    store.createBot({
      ...next,
      expectedDataEpoch: "new-epoch",
      name: "changed"
    })
  ).toThrow("同一请求标识")
  expect(store.listBots()).toHaveLength(2)
})
it("retains title independently from instructions, including clone, busy cosmetic edits and clearing", () => {
  const store = open()
  const { bot, conversationId } = store.createBot({
    nonce: "profile",
    name: "Review",
    title: "  项目评审助手  ",
    instructions: "检查代码"
  })
  expect(bot.title).toBe("项目评审助手")
  expect(store.listBots()[0].title).toBe(bot.title)
  store.send({ nonce: "work", conversationId, text: "开始" })
  store.claim("host")
  const changed = store.updateBot({
    id: bot.id,
    revision: bot.revision,
    nonce: "label",
    title: "质量助手"
  })
  expect(changed).toMatchObject({
    title: "质量助手",
    instructions: "检查代码"
  })
  expect(() =>
    store.updateBot({
      id: bot.id,
      revision: changed.revision,
      instructions: "不同执行职责"
    })
  ).toThrow("请先停止")
  const copy = store.cloneBot({
    nonce: "clone",
    id: bot.id,
    revision: changed.revision
  })
  expect(copy.bot.title).toBe(changed.title)
  const cleared = store.updateBot({
    nonce: "clear-title",
    id: bot.id,
    revision: changed.revision,
    title: " "
  })
  expect(cleared.title).toBeUndefined()
  expect(
    store.updateBot({
      nonce: "label",
      id: bot.id,
      revision: bot.revision,
      title: "质量助手"
    })
  ).toEqual(changed)
  expect(() =>
    store.updateBot({
      id: bot.id,
      revision: cleared.revision,
      title: "x".repeat(201)
    })
  ).toThrow("标签格式")
})
it("upgrades a real v49 database additively, preserves old receipt/message and backs up its original schema", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-v49-label-"))
  directories.push(directory)
  const path = join(directory, "bots.sqlite")
  let store = open(path)
  const input = { nonce: "legacy", name: "Original", instructions: "旧职责" },
    created = store.createBot(input)
  store.send({
    nonce: "message",
    conversationId: created.conversationId,
    text: "原记录"
  })
  const before = store.snapshot(),
    messages = store.messages(created.conversationId)
  store.close()
  const old = new DatabaseSync(path)
  old.exec("DROP TABLE bot_profile_labels; UPDATE bot_schema SET version=49")
  old.close()
  store = open(path)
  expect(store.snapshot()).toEqual(before)
  expect(store.messages(created.conversationId)).toEqual(messages)
  expect(store.createBot(input)).toEqual(created)
  expect(store.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(BOT_SCHEMA_VERSION)
  const backupName = readdirSync(join(directory, "backups")).find((name) =>
    name.startsWith("bots-v49-")
  )!
  expect(backupName).toBeTruthy()
  const backup = new DatabaseSync(join(directory, "backups", backupName), {
    readOnly: true
  })
  try {
    expect(backup.prepare("SELECT version FROM bot_schema").get()?.version).toBe(49)
    expect(
      backup.prepare("SELECT name FROM sqlite_master WHERE name='bot_profile_labels'").get()
    ).toBeUndefined()
  } finally {
    backup.close()
  }
  const saved = store.updateBot({
    id: created.bot.id,
    revision: created.bot.revision,
    title: "新标签"
  })
  expect(saved.instructions).toBe("旧职责")
})

it("rejects raw multiline titles before any create/update receipt or profile side effect", () => {
  const store = open()
  const { bot } = store.createBot({ nonce: "single-line", name: "Original", title: "original" })
  for (const [index, separator] of ["\n", "\r", "\u2028", "\u2029"].entries()) {
    const before = store.snapshot()
    const count = store.db.exec("SELECT count(*) FROM bot_receipts")[0].values[0][0]
    const rejectedNonce = `multiline-create-${index}`
    expect(() =>
      store.createBot({ nonce: rejectedNonce, name: "Must not exist", title: `one${separator}` })
    ).toThrow("单行")
    expect(() =>
      store.updateBot({
        nonce: `multiline-update-${index}`,
        id: bot.id,
        revision: bot.revision,
        name: "Must not rename",
        title: `${separator}two`
      })
    ).toThrow("单行")
    expect(store.snapshot()).toEqual(before)
    expect(store.db.exec("SELECT count(*) FROM bot_receipts")[0].values[0][0]).toBe(count)
    // Definitive rejection did not spend the identity; a corrected request may use it.
    const corrected = store.createBot({ nonce: rejectedNonce, name: "Correct", title: "one" })
    expect(corrected.bot.title).toBe("one")
  }
})

it("keeps the omitted-title update receipt hash and replay identity unchanged", () => {
  const store = open()
  const { bot } = store.createBot({ nonce: "legacy-update-create", name: "Original" })
  const input = { nonce: "legacy-update", id: bot.id, revision: bot.revision, name: "Renamed" }
  const saved = store.updateBot(input)
  const expected = createHash("sha256")
    .update(
      canonicalJson({
        op: "updateBot",
        input: { id: bot.id, revision: bot.revision, name: "Renamed" }
      })
    )
    .digest("hex")
  expect(
    store.db.exec("SELECT request_hash FROM bot_receipts WHERE nonce='legacy-update'")[0]
      .values[0][0]
  ).toBe(expected)
  store.updateBot({ id: bot.id, revision: saved.revision, title: "later" })
  expect(store.updateBot(input)).toEqual(saved)
})
