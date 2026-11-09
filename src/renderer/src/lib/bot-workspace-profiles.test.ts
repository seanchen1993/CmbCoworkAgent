import { afterEach, expect, it, vi } from "vitest"
import type { BotClient, BotChangeEvent, BotSnapshot } from "../../../shared/bots/contracts"
import { createBotWorkspaceProfiles } from "../components/bots/use-bot-workspace-profiles"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it("shares catalog reads and coalesces changes without concurrent requests or per-thread lookups", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("window", new EventTarget())
  let changed: (event: BotChangeEvent) => void = () => {}
  let resolve: (value: BotSnapshot) => void = () => {}
  const snapshot = vi.fn(
    () =>
      new Promise<BotSnapshot>((done) => {
        resolve = done
      })
  )
  const stop = vi.fn()
  const client = {
    snapshot,
    subscribe: (handler: typeof changed) => {
      changed = handler
      return stop
    }
  } as unknown as BotClient
  const catalog = createBotWorkspaceProfiles(client)
  const notify = vi.fn()
  const first = catalog.subscribe(notify),
    second = catalog.subscribe(() => {})
  expect(snapshot).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 100; i++) changed({} as BotChangeEvent)
  await vi.advanceTimersByTimeAsync(200)
  expect(snapshot).toHaveBeenCalledTimes(1)
  const result = {
    bots: [{ id: "b", name: "小 A", color: "red", instructions: "not part of UI cache" }]
  } as BotSnapshot
  resolve(result)
  await vi.advanceTimersByTimeAsync(0)
  expect(snapshot).toHaveBeenCalledTimes(2)
  resolve(result)
  await vi.advanceTimersByTimeAsync(0)
  expect(notify).toHaveBeenCalledTimes(1)
  expect(catalog.getSnapshot()).toEqual([{ id: "b", name: "小 A", color: "red", shape: undefined }])
  changed({} as BotChangeEvent)
  await vi.advanceTimersByTimeAsync(200)
  resolve({
    ...result,
    imConversations: [
      { id: "group-a", botId: "b", title: "产品协作群" },
      { id: "group-b", botId: "b", title: "研发群" }
    ]
  } as BotSnapshot)
  await vi.advanceTimersByTimeAsync(0)
  expect(catalog.getSnapshot()[0].imGroups).toEqual([
    { id: "group-a", title: "产品协作群" },
    { id: "group-b", title: "研发群" }
  ])
  const beforeRename = catalog.getSnapshot()
  changed({} as BotChangeEvent)
  await vi.advanceTimersByTimeAsync(200)
  resolve({
    ...result,
    imConversations: [
      { id: "group-b", botId: "b", title: "研发群" },
      { id: "group-a", botId: "b", title: "产品协作群" }
    ]
  } as BotSnapshot)
  await vi.advanceTimersByTimeAsync(0)
  expect(catalog.getSnapshot()).toBe(beforeRename) // activity sorting does not redraw labels
  changed({} as BotChangeEvent)
  await vi.advanceTimersByTimeAsync(200)
  resolve({
    ...result,
    imConversations: [{ id: "group-a", botId: "b", title: "产品组新名字" }]
  } as BotSnapshot)
  await vi.advanceTimersByTimeAsync(0)
  expect(catalog.getSnapshot()[0].imGroups?.[0].title).toBe("产品组新名字")
  first()
  second()
  expect(stop).toHaveBeenCalledTimes(1)
})
