import { expect, it } from "vitest"
import {
  BOT_VIEWPORT_POSITION_LIMIT,
  createBotViewportPositionCache,
  type BotViewportPosition
} from "./bot-viewport-position"

const position = (id: string): BotViewportPosition => ({
  messageId: `message-${id}`,
  offset: -24,
  followTail: false
})

it.each([BOT_VIEWPORT_POSITION_LIMIT, 128])(
  "bounds 200 visited views and their leases at %s without retaining message bodies",
  (limit) => {
    const cache = createBotViewportPositionCache(limit)
    const first = cache.open("view-0")
    cache.save(first.lease, position("0"))
    for (let index = 1; index < 200; index++) {
      const opened = cache.open(`view-${index}`)
      expect(opened.position).toBeNull()
      cache.save(opened.lease, position(String(index)))
      expect(cache.size()).toBeLessThanOrEqual(limit)
    }
    expect(cache.size()).toBe(limit)
    expect(cache.isCurrent(first.lease)).toBe(false)
    expect(cache.save(first.lease, position("late"))).toBe(false)
    expect(cache.open("view-0").position).toBeNull()
    expect(cache.open("view-199").position).toEqual(position("199"))
  }
)

it("protects a newly opened viewport from a previous component's late cleanup or restore callback", () => {
  const cache = createBotViewportPositionCache()
  const old = cache.open("bot")
  cache.save(old.lease, position("old"))
  const current = cache.open("bot")
  expect(current.position).toEqual(position("old"))
  expect(cache.isCurrent(old.lease)).toBe(false)
  cache.save(current.lease, position("new"))
  expect(cache.save(old.lease, position("stale"))).toBe(false)
  expect(cache.open("bot").position).toEqual(position("new"))
})

it("stores only lightweight identity and copies positions at both save and open boundaries", () => {
  const cache = createBotViewportPositionCache()
  const opened = cache.open("bot")
  const input = Object.assign(position("row"), {
    text: "DO_NOT_KEEP_BODY".repeat(10000),
    node: { liveDOM: true },
    attachments: ["private-content"]
  })
  cache.save(opened.lease, input)
  input.messageId = "caller-mutated"
  const returned = cache.open("bot")
  expect(returned.position).toEqual(position("row"))
  expect(Object.keys(returned.position!)).toEqual(["messageId", "offset", "followTail"])
  returned.position!.messageId = "snapshot-mutated"
  expect(cache.open("bot").position).toEqual(position("row"))
})

it("cleans a deleted conversation and all its branches while preserving other views", () => {
  const cache = createBotViewportPositionCache()
  const main = cache.open("removed"),
    branch = cache.open("removed/thread/root"),
    other = cache.open("remaining")
  cache.save(main.lease, position("main"))
  cache.save(branch.lease, position("branch"))
  cache.save(other.lease, position("other"))
  cache.prune(new Set(["remaining"]))
  expect(cache.size()).toBe(1)
  expect(cache.isCurrent(main.lease)).toBe(false)
  expect(cache.isCurrent(branch.lease)).toBe(false)
  expect(cache.save(branch.lease, position("stale"))).toBe(false)
  expect(cache.open("remaining").position).toEqual(position("other"))
  expect(cache.open("removed").position).toBeNull()
})

it("does not revive deleted or restored-workspace positions from old leases", () => {
  const cache = createBotViewportPositionCache()
  const deleted = cache.open("bot")
  cache.save(deleted.lease, position("deleted"))
  cache.delete("bot")
  const replacement = cache.open("bot")
  expect(replacement.position).toBeNull()
  expect(cache.save(deleted.lease, position("late-delete"))).toBe(false)
  cache.save(replacement.lease, position("replacement"))
  cache.clear()
  const restored = cache.open("bot")
  expect(restored.position).toBeNull()
  expect(restored.lease.generation).toBeGreaterThan(replacement.lease.generation)
  expect(cache.save(replacement.lease, position("old-workspace"))).toBe(false)
})

it("records an explicit return to latest without carrying an old reading anchor", () => {
  const cache = createBotViewportPositionCache()
  const opened = cache.open("bot")
  cache.save(opened.lease, position("old"))
  cache.save(opened.lease, { ...position("old"), followTail: true })
  expect(cache.open("bot").position).toEqual({ messageId: null, offset: 0, followTail: true })
})

it("rejects nonfinite offsets and bounds invalid or excessive capacity settings", () => {
  const cache = createBotViewportPositionCache(Infinity)
  const opened = cache.open("bot")
  expect(cache.save(opened.lease, { ...position("bad"), offset: NaN })).toBe(false)
  expect(cache.open("bot").position).toBeNull()
  const excessive = createBotViewportPositionCache(10000)
  for (let index = 0; index < 200; index++) excessive.open(String(index))
  expect(excessive.size()).toBe(128)
})
