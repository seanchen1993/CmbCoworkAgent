import { afterEach, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"

const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
)
function fixture(path = ":memory:") {
  let time = Date.now()
  const store = new BotStore(path, () => time++)
  cleanup.push(() => store.close())
  const bots = ["A", "B", "C", "D"].map((name) => store.createBot({ nonce: name, name }).bot)
  for (const bot of bots.slice(0, 3)) store.updateBot({ id: bot.id, revision: 1, pinned: true })
  return { store, ids: bots.map((bot) => bot.id) }
}

it("persists Grok before/after moves, protects concurrent order and acknowledges a lost reply without applying it again", () => {
  const f = fixture(),
    [a, b, c, d] = f.ids
  const initial = f.store.pinnedOrder()
  expect(initial.ids).toEqual([a, b, c])
  const input = {
    nonce: "move",
    revision: initial.revision,
    movedId: c,
    targetId: a,
    position: "before" as const
  }
  const first = f.store.reorderPinned(input)
  expect(first.ids).toEqual([c, a, b])
  const second = f.store.reorderPinned({
    nonce: "other-window",
    revision: first.revision,
    movedId: a,
    targetId: b,
    position: "after"
  })
  expect(second.ids).toEqual([c, b, a])
  expect(f.store.reorderPinned(input)).toEqual(first)
  expect(f.store.pinnedOrder()).toEqual(second)
  expect(() => f.store.reorderPinned({ ...input, nonce: "stale" })).toThrow("已变化")
  expect(() =>
    f.store.reorderPinned({ ...input, nonce: "not-pinned", revision: second.revision, movedId: d })
  ).toThrow("仍在置顶")
  expect(() => f.store.reorderPinned({ ...input, position: "after" })).toThrow("不同操作")
  const hidden = f.store.updateBot({ id: b, revision: 2, hidden: true })
  expect(f.store.pinnedOrder()).toEqual(second)
  f.store.updateBot({ id: b, revision: hidden.revision, pinned: false })
  expect(f.store.pinnedOrder().ids).toEqual([c, a])
  f.store.updateBot({ id: b, revision: hidden.revision + 1, pinned: true })
  expect(f.store.pinnedOrder().ids).toEqual([c, a, b])
  f.store.deleteBot(c, f.store.getBot(c).revision)
  expect(f.store.pinnedOrder().ids).toEqual([a, b])
})

it("migrates v10 pinned Bots without losing them and preserves manual ordering across Host reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-pin-migrate-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite")
  const f = fixture(path),
    [a, b, c] = f.ids
  f.store.close()
  const previous = new DatabaseSync(path)
  previous.exec("DROP TABLE bot_pinned_order; UPDATE bot_schema SET version=10")
  previous.close()
  const upgraded = new BotStore(path)
  cleanup.push(() => upgraded.close())
  expect(upgraded.snapshot().pinnedOrder).toEqual({ revision: 0, ids: [a, b, c] })
  const input = {
    nonce: "persist",
    revision: 0,
    movedId: c,
    targetId: a,
    position: "before" as const
  }
  const result = upgraded.reorderPinned(input)
  upgraded.close()
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  expect(reopened.pinnedOrder()).toEqual(result)
  expect(reopened.reorderPinned(input)).toEqual(result)
  expect(readdirSync(join(root, "backups"))).toHaveLength(1)
})
