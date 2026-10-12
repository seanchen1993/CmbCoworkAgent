import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import type { BotSaveSkillInput } from "../../shared/bot-skill-save"

const stores: BotStore[] = [],
  directories: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function open(path = ":memory:") {
  const store = new BotStore(path)
  stores.push(store)
  return store
}
function setup(store: BotStore) {
  const { bot } = store.createBot({ nonce: "owner", name: "Skill owner" })
  const input: BotSaveSkillInput = {
    nonce: "create-skill",
    expectedDataEpoch: store.dataEpoch(),
    botId: bot.id,
    name: "核对",
    instructions: "读取证据并核对",
    enabled: true
  }
  return { bot, input }
}
it("replays lost create/update acknowledgements after reopening real SQLite before a stale CAS", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-skill-save-"))
  directories.push(directory)
  const path = join(directory, "bots.sqlite"),
    store = open(path),
    { input } = setup(store)
  const created = store.saveSkill(input)
  // The client lost this response. A different control operation then advances the version.
  const edit = {
    ...input,
    nonce: "edit-skill",
    id: created.id,
    version: 1,
    instructions: "新的核对方式"
  }
  const edited = store.saveSkill(edit)
  store.close()
  stores.splice(stores.indexOf(store), 1)
  const reopened = open(path)
  expect(reopened.saveSkill(input)).toEqual(created)
  expect(reopened.saveSkill(edit)).toEqual(edited)
  expect(reopened.skills(input.botId)).toEqual([edited])
  expect(reopened.events().filter((event) => event.kind === "skill.saved")).toHaveLength(2)
})
it("rejects a reused nonce with changed content/owner/version and does not create another skill", () => {
  const store = open(),
    { input } = setup(store),
    skill = store.saveSkill(input)
  const other = store.createBot({ nonce: "other-owner", name: "Other" }).bot
  for (const mutation of [
    { name: "Changed" },
    { instructions: "Changed" },
    { enabled: false },
    { botId: other.id },
    { id: skill.id, version: 1 }
  ])
    expect(() => store.saveSkill({ ...input, ...mutation })).toThrow("同一请求标识")
  expect(store.skills(input.botId)).toEqual([skill])
  expect(store.skills(other.id)).toEqual([])
})
it("historical receipts never restore current enabled authority or a soft-deleted skill", () => {
  const store = open(),
    { input } = setup(store),
    created = store.saveSkill(input)
  const disable = {
    ...input,
    nonce: "disable",
    id: created.id,
    version: 1,
    enabled: false
  }
  const disabled = store.saveSkill(disable)
  expect(store.saveSkill(input)).toEqual(created)
  expect(store.skills(input.botId)).toEqual([disabled])
  store.deleteSkill({
    nonce: "delete",
    botId: input.botId,
    skillId: created.id,
    version: 2
  })
  expect(store.saveSkill(disable)).toEqual(disabled)
  expect(store.skills(input.botId)).toEqual([])
  expect(store.skillVersion(input.botId, created.id, 1).enabled).toBe(false)
  expect(() =>
    store.saveSkill({
      ...disable,
      nonce: "new-enable",
      version: 2,
      enabled: true
    })
  ).toThrow("已删除")
})
it("replays accepted skill receipts read-only after replacement but rejects new stale saves", () => {
  const store = open(),
    { input } = setup(store),
    created = store.saveSkill(input)
  const originalEvents = store.events().filter((event) => event.kind === "skill.saved").length
  store.db.run("INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)", [
    "workspace.restored",
    "replacement",
    "{}",
    1
  ])
  const restoredCursor = store.snapshot().cursor
  expect(store.saveSkill(input)).toEqual(created)
  expect(store.snapshot().cursor).toBe(restoredCursor)
  expect(store.events().filter((event) => event.kind === "skill.saved")).toHaveLength(
    originalEvents
  )
  const next = { ...input, nonce: "unaccepted" }
  expect(() => store.saveSkill(next)).toThrow("工作区数据已恢复")
  const valid = store.saveSkill({ ...next, expectedDataEpoch: "replacement" })
  expect(valid.id).not.toBe(created.id)
  expect(store.events().filter((event) => event.kind === "skill.saved")).toHaveLength(
    originalEvents + 1
  )
})
it("leaves trusted legacy Teach/tool writes compatible and rejects malformed bounded inputs atomically", () => {
  const store = open(),
    { input, bot } = setup(store)
  const legacy = {
    botId: input.botId,
    name: input.name,
    instructions: input.instructions,
    enabled: input.enabled
  }
  const created = store.saveSkill(legacy)
  const edited = store.saveSkill({
    ...created,
    instructions: "Trusted internal new version"
  })
  expect(edited.version).toBe(2)
  const before = store.events().length
  for (const mutation of [
    { name: "" },
    { name: "a".repeat(101) },
    { instructions: "a".repeat(64001) },
    { instructions: "\0" },
    { id: created.id },
    { version: 1 },
    { enabled: "yes" },
    { expectedDataEpoch: "x", nonce: undefined }
  ])
    expect(() => store.saveSkill({ ...legacy, ...mutation } as BotSaveSkillInput)).toThrow()
  expect(store.events()).toHaveLength(before)
  store.deleteBot(bot.id, bot.revision)
  expect(() => store.saveSkill({ ...input, nonce: "after-delete" })).toThrow("Bot 不存在")
})
