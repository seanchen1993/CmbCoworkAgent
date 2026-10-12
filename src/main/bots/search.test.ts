import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { BotSearch } from "./search"
import type { BotSearchInput, BotSearchMatch } from "../../shared/bot-search"

const stores: BotStore[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "支付研发", instructions: "研究资金归集" }),
    b = store.createBot({ nonce: "b", name: "质量检查" })
  return { store, a, b, search: new BotSearch(store) }
}
function all(search: BotSearch, input: BotSearchInput): BotSearchMatch[] {
  const results: BotSearchMatch[] = []
  let cursor: string | undefined
  for (let i = 0; i < 100; i++) {
    const page = search.search({ ...input, ...(cursor ? { cursor } : {}) })
    expect(page.scanned).toBeLessThanOrEqual(32)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(128 * 1024)
    results.push(...page.matches)
    if (!page.cursor) return results
    expect(page.cursor).not.toBe(cursor)
    cursor = page.cursor
  }
  throw new Error("Search cursor did not reach the beginning")
}

it("finds historical reference labels within the requested conversation without importing referenced content", () => {
  const { store, a, b, search } = fixture()
  const sent = store.send({
    nonce: "reference",
    conversationId: b.conversationId,
    text: "请核对这项",
    references: [{ kind: "bot", id: a.bot.id }]
  })
  store.updateBot({ id: a.bot.id, revision: a.bot.revision, name: "已改名" })
  expect(
    all(search, { kind: "message", query: "支付研发", conversationId: b.conversationId })
  ).toMatchObject([{ id: sent.messageId, snippet: expect.stringContaining("@支付研发") }])
  expect(
    all(search, { kind: "message", query: "支付研发", conversationId: a.conversationId })
  ).toEqual([])
  expect(all(search, { kind: "message", query: "资金归集" })).toEqual([])
  expect(all(search, { kind: "message", query: "已改名" })).toEqual([])
  store.deleteBot(b.bot.id, b.bot.revision)
  expect(all(search, { kind: "message", query: "支付研发" })).toEqual([])
})

it("searches the complete transcript in bounded, stable pages, with literal terms and an exact conversation scope", () => {
  const { store, a, b, search } = fixture()
  const expected: string[] = []
  for (let i = 0; i < 130; i++) {
    const hit = i % 9 === 0
    const message = store.send({
      nonce: `m${i}`,
      conversationId: a.conversationId,
      text: hit ? `前文\nNeEdLe 100%_ 项目 ${i}` : `普通文字 ${i}`
    })
    if (hit) expected.unshift(message.messageId)
  }
  const other = store.send({
    nonce: "other",
    conversationId: b.conversationId,
    text: "needle another project"
  })
  expect(
    all(search, { query: "nEeDlE", kind: "message", conversationId: a.conversationId }).map(
      (hit) => hit.id
    )
  ).toEqual(expected)
  expect(all(search, { query: "100%_", kind: "message" }).map((hit) => hit.id)).toEqual(expected)
  expect(all(search, { query: "nEeDlE", kind: "message" })[0].id).toBe(other.messageId)
  expect(all(search, { query: "' OR 1=1", kind: "message" })).toEqual([])
  const first = search.search({
    query: "needle",
    kind: "message",
    conversationId: a.conversationId
  })
  expect(first.cursor).not.toBeNull()
  expect(() => search.search({ query: "other", kind: "message", cursor: first.cursor! })).toThrow(
    "条件已变化"
  )
  expect(() => search.search({ query: "needle", kind: "link", cursor: first.cursor! })).toThrow(
    "条件已变化"
  )
  expect(() =>
    search.search({
      query: "needle",
      kind: "message",
      conversationId: b.conversationId,
      cursor: first.cursor!
    })
  ).toThrow("条件已变化")
  expect(() => search.search({ query: "x", kind: "message", cursor: "broken" })).toThrow(
    "条件已变化"
  )
})

it("does not skip a matching row when the byte budget interrupts a scan, or confuse an empty scan page with exhaustion", () => {
  const { store, a, search } = fixture()
  for (let i = 0; i < 12; i++)
    store.send({
      nonce: `large-${i}`,
      conversationId: a.conversationId,
      text: "字".repeat(60_000) + (i === 2 ? "标记" : "尾部")
    })
  const first = search.search({ query: "标记", kind: "message" })
  expect(first.scanned).toBe(2)
  expect(first.matches).toEqual([])
  expect(first.cursor).not.toBeNull()
  const hits = all(search, { query: "标记", kind: "message" })
  expect(hits).toHaveLength(1)
  expect(hits[0].snippet).toContain("标记")
})

it("searches visible entities and links without indexing hidden credentials or returning a deleted Bot's private history", () => {
  const { store, a, b, search } = fixture()
  const group = store.createGroup({
    nonce: "g",
    name: "支付团队",
    description: "发布评审",
    members: [a.bot.id, b.bot.id]
  })
  const link = store.send({
    nonce: "link",
    conversationId: group.id,
    text: "请看 https://example.invalid/payment/spec?version=2 文档"
  })
  store.send({ nonce: "plain", conversationId: a.conversationId, text: "payment is plain text" })
  const routine = store.saveRoutine({
    botId: a.bot.id,
    name: "支付日检",
    prompt: "检查每日差异",
    schedule: { kind: "cron", expression: "0 9 * * *" },
    timezone: "Asia/Shanghai",
    enabled: false
  })
  store.db.run("INSERT INTO bot_artifacts VALUES(?,?,?,?,?,?,?,?)", [
    "file",
    group.id,
    null,
    "支付说明.pdf",
    "application/pdf",
    0,
    "a".repeat(64),
    Date.now()
  ])
  expect(all(search, { query: "资金归集", kind: "bot" }).map((hit) => hit.id)).toEqual([a.bot.id])
  expect(all(search, { query: "发布评审", kind: "group" }).map((hit) => hit.id)).toEqual([group.id])
  expect(all(search, { query: "支付说明", kind: "file" }).map((hit) => hit.id)).toEqual(["file"])
  expect(all(search, { query: "payment", kind: "link" }).map((hit) => hit.id)).toEqual([
    link.messageId
  ])
  expect(all(search, { query: "每日差异", kind: "routine" }).map((hit) => hit.id)).toEqual([
    routine.id
  ])
  const secretMessage = store.send({
    nonce: "private",
    conversationId: a.conversationId,
    text: "deleted-private-content"
  })
  store.deleteBot(a.bot.id, a.bot.revision)
  expect(all(search, { query: "deleted-private-content", kind: "message" })).toEqual([])
  expect(all(search, { query: "支付日检", kind: "routine" })).toEqual([])
  expect(all(search, { query: "资金归集", kind: "bot" })).toEqual([])
  expect(all(search, { query: "payment", kind: "link" }).map((hit) => hit.id)).toEqual([
    link.messageId
  ])
  expect(() =>
    search.search({
      query: secretMessage.messageId,
      kind: "message",
      conversationId: a.conversationId
    })
  ).toThrow("不可用")
})
