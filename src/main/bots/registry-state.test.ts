import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"

const roots: string[] = [],
  stores: BotStore[] = []
const now = 1_900_000_000_000
function open(path = ":memory:") {
  const store = new BotStore(path, () => now)
  stores.push(store)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function reply(store: BotStore, conversationId: string, nonce: string) {
  store.send({ nonce, conversationId, text: nonce })
  store.finish(store.claim("host")!.lease, "succeeded", `result ${nonce}`)
  return store.messages(conversationId).at(-1)!
}

it("clones the authorized configuration and enabled skills, without live work or private history", () => {
  const store = open()
  const original = store.createBot({
    nonce: "source",
    name: "Builder",
    instructions: "Build",
    modelRef: "configured-model",
    workspacePath: "/project",
    connectorIds: ["notes"],
    avatarColor: "blue",
    avatarShape: "cloud"
  })
  const bot = store.updateBot({ id: original.bot.id, revision: 1, hidden: true, pinned: true })
  store.saveMemory({ botId: bot.id, text: "Private context" })
  const skill = store.saveSkill({
    botId: bot.id,
    name: "Review",
    instructions: "Review files",
    enabled: true
  })
  store.saveSkill({
    botId: bot.id,
    id: skill.id,
    version: 1,
    name: "Review",
    instructions: "Latest instructions",
    enabled: true
  })
  store.saveSkill({ botId: bot.id, name: "Disabled", instructions: "Not copied", enabled: false })
  reply(store, original.conversationId, "old-message")
  const scheduled = store.saveRoutine({
    botId: bot.id,
    name: "Daily",
    prompt: "Review",
    schedule: { kind: "interval", anchor: now - 60_000, everyMs: 60_000 },
    timezone: "Asia/Shanghai",
    enabled: true
  })
  store.saveRoutine({
    botId: bot.id,
    name: "Event",
    prompt: "Review",
    schedule: { kind: "event", topic: "changed" },
    timezone: "UTC",
    enabled: false
  })
  const input = { id: bot.id, revision: bot.revision, nonce: "copy" }
  store.memory.setPolicy({ botId: input.id, revision: 0, enabled: false })
  const copy = store.cloneBot(input)
  expect(store.cloneBot(input)).toEqual(copy)
  expect(store.memory.policy(copy.bot.id)).toMatchObject({
    enabled: false,
    pending: 0,
    revision: 0
  })
  expect(copy.bot).toMatchObject({
    name: "Builder copy",
    instructions: "Build",
    modelRef: "configured-model",
    workspacePath: "/project",
    connectorIds: ["notes"],
    avatarShape: "cloud",
    hidden: false,
    pinned: false
  })
  expect(copy.bot.id).not.toBe(bot.id)
  expect(store.messages(copy.conversationId)).toEqual([])
  expect(store.memories(copy.bot.id)).toEqual([])
  expect(store.artifacts(copy.conversationId)).toEqual([])
  expect(store.loadBrowserSession(copy.bot.id)).toBeNull()
  expect(store.skills(copy.bot.id)).toMatchObject([
    { name: "Review", instructions: "Latest instructions", version: 1, verified: false }
  ])
  expect(store.skills(copy.bot.id)[0].id).not.toBe(skill.id)
  const routines = store.routines(copy.bot.id)
  expect(routines.find((item) => item.name === "Daily")).toMatchObject({
    enabled: true,
    nextAt: now + 60_000
  })
  expect(routines.find((item) => item.name === "Daily")?.id).not.toBe(scheduled.id)
  expect(routines.find((item) => item.name === "Event")).toMatchObject({
    enabled: false,
    nextAt: null
  })
  const due = store.dispatchDueRoutines()
  expect(due.map((id) => store.getRun(id).botId)).toEqual([bot.id])
  expect(store.snapshot().runs.some((run) => run.botId === copy.bot.id)).toBe(false)
})

it("rolls back every clone write on failure and rejects stale or reused requests", () => {
  const store = open(),
    source = store.createBot({ nonce: "source", name: "Source" })
  const input = { nonce: "copy", id: source.bot.id, revision: 1 }
  store.saveSkill({ botId: source.bot.id, name: "Skill", instructions: "x", enabled: true })
  store.db.run(
    `CREATE TRIGGER fail_clone BEFORE INSERT ON bot_skills WHEN NEW.bot_id!='${source.bot.id}' BEGIN SELECT RAISE(ABORT,'disk fault'); END`
  )
  expect(() => store.cloneBot(input)).toThrow("disk fault")
  expect(store.snapshot().bots).toHaveLength(1)
  store.db.run("DROP TRIGGER fail_clone")
  store.cloneBot(input)
  expect(() => store.cloneBot({ ...input, revision: 2 })).toThrow("同一请求标识")
  store.updateBot({ id: source.bot.id, revision: 1, name: "Changed" })
  expect(() => store.cloneBot({ ...input, nonce: "stale" })).toThrow("已变化")
  expect(store.snapshot().bots).toHaveLength(2)
})

it("keeps manual unread separate from the read position and rejects a late automatic acknowledgement", () => {
  const store = open(),
    created = store.createBot({ nonce: "source", name: "Inbox" })
  const first = reply(store, created.conversationId, "first")
  const read = store.setReadState({
    conversationId: created.conversationId,
    revision: 0,
    throughSequence: first.sequence,
    unread: false
  })
  const manual = store.setReadState({
    conversationId: created.conversationId,
    revision: read.revision,
    throughSequence: first.sequence,
    unread: true
  })
  expect(manual).toMatchObject({
    manuallyUnread: true,
    lastReadSequence: first.sequence,
    unreadCount: 1,
    firstUnreadSequence: first.sequence
  })
  expect(() =>
    store.setReadState({
      conversationId: created.conversationId,
      revision: read.revision,
      throughSequence: first.sequence,
      unread: false
    })
  ).toThrow("读取位置已变化")
  const second = reply(store, created.conversationId, "second")
  const partial = store.setReadState({
    conversationId: created.conversationId,
    revision: manual.revision,
    throughSequence: first.sequence,
    unread: false
  })
  expect(partial).toMatchObject({
    unreadCount: 1,
    firstUnreadSequence: second.sequence,
    manuallyUnread: false
  })
  const other = store.createBot({ nonce: "other", name: "Other" })
  const foreign = reply(store, other.conversationId, "foreign")
  reply(store, created.conversationId, "third")
  expect(() =>
    store.setReadState({
      conversationId: created.conversationId,
      revision: partial.revision,
      throughSequence: foreign.sequence,
      unread: false
    })
  ).toThrow("不属于当前对话")
  expect(store.getConversation(created.conversationId).readState?.unreadCount).toBe(2)
})

describe("persisted unread pagination", () => {
  let fixture: { path: string; conversationId: string; firstSequence: number }
  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), "bot-read-"))
    roots.push(root)
    const path = join(root, "bots.sqlite"),
      store = open(path)
    const created = store.createBot({ nonce: "inbox", name: "Inbox" })
    const first = reply(store, created.conversationId, "first")
    store.setReadState({
      conversationId: created.conversationId,
      throughSequence: first.sequence,
      revision: 0,
      unread: false
    })
    for (let index = 0; index < 115; index++)
      reply(store, created.conversationId, `message-${index}`)

    fixture = { path, conversationId: created.conversationId, firstSequence: first.sequence }
  }, 30_000)

  // Seed 115 durable tasks before timing pagination and reopen assertions.
  it("persists unread positions and pages forward from an old unread boundary without skipping a gap", () => {
    const { path, conversationId, firstSequence } = fixture
    const reopened = open(path)
    const unread = reopened.getConversation(conversationId).readState!
    expect(unread).toMatchObject({ lastReadSequence: firstSequence, unreadCount: 115 })
    const firstPage = reopened.messages(
      conversationId,
      undefined,
      100,
      unread.firstUnreadSequence! - 1
    )
    expect(firstPage[0].sequence).toBe(unread.firstUnreadSequence)
    const secondPage = reopened.messages(conversationId, undefined, 100, firstPage.at(-1)!.sequence)
    expect(secondPage[0].sequence).toBe(firstPage.at(-1)!.sequence + 1)
    expect(() => reopened.messages(conversationId, 20, 100, 10)).toThrow("同时")
  })
})
