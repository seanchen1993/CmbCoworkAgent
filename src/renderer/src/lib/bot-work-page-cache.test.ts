import { expect, it, vi } from "vitest"
import { BotWorkPageCache } from "./bot-work-page-cache"
import { BotTrackedWorkRegistry } from "./bot-tracked-work"
import {
  botWorkScopeKey,
  emptyBotWorkCounts,
  botTrackedWorkKey,
  type BotWorkPageRequest,
  type BotWorkCursor
} from "../../../shared/bot-work-pages"
const owner = {
  hostId: "host",
  dataEpoch: "epoch",
  scope: { kind: "conversation", conversationId: "conversation" }
} as const
const response = (
  input: BotWorkPageRequest,
  items: string[],
  next: BotWorkCursor | null = null
) => ({ ...input, items, counts: { ...emptyBotWorkCounts(), total: 800 }, cursor: 1, next })
const cursor = (index: number): BotWorkCursor => ({
  hostId: owner.hostId,
  dataEpoch: owner.dataEpoch,
  scopeKey: botWorkScopeKey(owner.scope),
  at: index,
  id: String(index)
})
it("keeps one 20-item page and only reads explicit next/previous, including a settled cursor", async () => {
  const cache = new BotWorkPageCache<string>(),
    publish = vi.fn()
  const read = vi.fn(async (input: BotWorkPageRequest) =>
    response(
      input,
      Array.from({ length: 20 }, (_, index) => `${input.before?.id ?? "first"}:${index}`),
      cursor(Number(input.before?.id ?? 0) + 20)
    )
  )
  await cache.refresh(owner, read, publish)
  expect(read).not.toHaveBeenCalled()
  cache.setOpen(true)
  await cache.refresh(owner, read, publish)
  expect(read).toHaveBeenCalledOnce()
  expect(cache.project().items).toHaveLength(20)
  cache.navigate("next")
  await cache.refresh(owner, read, publish)
  expect(read.mock.calls[1][0].before).toEqual(cursor(20))
  expect(cache.project().pageIndex).toBe(1)
  cache.navigate("previous")
  await cache.refresh(owner, read, publish)
  expect(read.mock.calls[2][0].before).toBeUndefined()
  expect(cache.project().items[0]).toBe("first:0")
})
it("bounds cursor history while retaining explicit first-page navigation", async () => {
  const cache = new BotWorkPageCache<string>()
  cache.setOpen(true)
  const read = async (input: BotWorkPageRequest) =>
    response(input, ["row"], cursor(Number(input.before?.id ?? 0) + 1))
  await cache.refresh(owner, read, () => {})
  for (let index = 0; index < 40; index++) {
    cache.navigate("next")
    await cache.refresh(owner, read, () => {})
  }
  expect(cache.project().pageIndex).toBe(40)
  for (let index = 0; index < 40; index++) cache.navigate("previous")
  expect(cache.project().pageIndex).toBe(9)
  expect(cache.project().canPrevious).toBe(false)
  cache.navigate("first")
  await cache.refresh(owner, read, () => {})
  expect(cache.project().pageIndex).toBe(0)
})
it("coalesces current page reads and rejects late old-scope/closed results without corrupting the current pending identity", async () => {
  const cache = new BotWorkPageCache<string>(),
    publish = vi.fn()
  cache.setOpen(true)
  let finishOld!: () => void
  const old = vi.fn(
    (input: BotWorkPageRequest) =>
      new Promise<ReturnType<typeof response>>((resolve) => {
        finishOld = () => resolve(response(input, ["old"]))
      })
  )
  const pending = cache.refresh(owner, old, publish)
  const duplicate = cache.refresh(owner, old, publish)
  expect(pending).toBe(duplicate)
  await Promise.resolve()
  let finishNew!: () => void
  const nextOwner = { ...owner, scope: { ...owner.scope, conversationId: "new" } }
  const next = cache.refresh(
    nextOwner,
    (input) =>
      new Promise((resolve) => {
        finishNew = () => resolve(response(input, ["new"]))
      }),
    publish
  )
  await Promise.resolve()
  finishOld()
  await pending
  expect(cache.project().loading).toBe(true)
  expect(cache.project().items).toEqual([])
  finishNew()
  await next
  expect(cache.project().items).toEqual(["new"])
  cache.setOpen(false)
  expect(cache.project().items).toEqual([])
})
it("rejects wrong Host/branch rows and oversized pages rather than using their actions", async () => {
  const cache = new BotWorkPageCache<string>()
  cache.setOpen(true)
  for (const page of [
    response({ ...owner, hostId: "other" }, ["foreign"]),
    response({ ...owner, scope: { ...owner.scope, threadRootId: "private" } }, ["foreign"]),
    response(owner, Array(21).fill("row"))
  ]) {
    await cache.refresh(
      owner,
      async () => page,
      () => {}
    )
    expect(cache.project().items).toEqual([])
    expect(cache.project().error).toBeTruthy()
  }
})
it("limits distinct tracked addresses to64 and ref-counts identical consumers without false release", () => {
  const registry = new BotTrackedWorkRegistry(),
    target = { kind: "run", botId: "bot", runId: "run" } as const
  const first = registry.register(target),
    second = registry.register(target)
  first()
  first()
  expect(registry.has(botTrackedWorkKey(target))).toBe(true)
  const releases = Array.from({ length: 63 }, (_, index) =>
    registry.register({ kind: "run", botId: "bot", runId: `run${index}` })
  )
  expect(() => registry.register({ kind: "run", botId: "other", runId: "overflow" })).toThrow(
    "任务过多"
  )
  second()
  expect(registry.has(botTrackedWorkKey(target))).toBe(false)
  const extra = registry.register({
    kind: "interaction",
    conversationId: "conv",
    threadRootId: "private",
    runId: "run",
    interactionId: "card"
  })
  releases.forEach((release) => release())
  extra()
  expect(registry.list()).toEqual([])
})
