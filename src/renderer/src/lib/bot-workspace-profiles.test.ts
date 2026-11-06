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
  first()
  second()
  expect(stop).toHaveBeenCalledTimes(1)
})
