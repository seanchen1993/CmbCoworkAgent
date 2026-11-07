import { afterEach, expect, it, vi } from "vitest"
import { getModCards, subscribeModCards } from "./mod-cards-store"
import type { ModCard, ModUiChangeEvent } from "../../../shared/mods/types"

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const stops: (() => void)[] = []
afterEach(async () => {
  stops.splice(0).forEach((stop) => stop())
  await settle()
  vi.unstubAllGlobals()
})
function fixture() {
  const events = new Set<(event: ModUiChangeEvent) => void>()
  const configs = new Set<() => void>()
  const cards = vi.fn<() => Promise<ModCard[]>>()
  vi.stubGlobal(
    "window",
    Object.assign(new EventTarget(), {
      api: {
        mods: {
          cards,
          onCardsChanged: (fn: (event: ModUiChangeEvent) => void) => {
            events.add(fn)
            return () => events.delete(fn)
          },
          onConfigurationChanged: (fn: () => void) => {
            configs.add(fn)
            return () => configs.delete(fn)
          }
        }
      }
    })
  )
  return { cards, events, configs }
}
const rows = (text: string): ModCard[] => [
  {
    id: text,
    agentId: "test",
    modId: "test",
    name: text,
    threadId: "live",
    callId: "",
    nodes: []
  }
]

it("shares one reader across rows and keeps publishing while notifications continue", async () => {
  const f = fixture()
  let pending = Promise.withResolvers<ModCard[]>()
  f.cards.mockImplementation(() => pending.promise)
  for (let i = 0; i < 100; i++) stops.push(subscribeModCards("live", vi.fn()))
  await settle()
  expect(f.events.size).toBe(1)
  for (let i = 0; i < 100; i++) {
    for (let j = 0; j < 20; j++) f.events.forEach((fn) => fn({ threadId: "live", scope: "cards" }))
    expect(f.cards).toHaveBeenCalledTimes(i + 1)
    const completing = pending
    pending = Promise.withResolvers<ModCard[]>()
    completing.resolve(rows(String(i)))
    await settle()
    expect(getModCards("live")).toEqual(rows(String(i)))
  }
  stops.splice(0).forEach((stop) => stop())
  await settle()
  pending.resolve(rows("closed"))
  await settle()
  expect(f.events.size).toBe(0)
  expect(f.configs.size).toBe(0)
  expect(getModCards("live")).toEqual([])
  expect(f.cards).toHaveBeenCalledTimes(101)
})

it("never restores a pending card reply after configuration revokes the source", async () => {
  const f = fixture()
  const pending = Promise.withResolvers<ModCard[]>()
  f.cards.mockReturnValueOnce(pending.promise).mockResolvedValue([])
  const seen: ModCard[][] = []
  stops.push(subscribeModCards("revoke", () => seen.push(getModCards("revoke"))))
  await settle()
  f.configs.forEach((fn) => fn())
  pending.resolve(rows("revoked"))
  await settle()
  expect(f.cards).toHaveBeenCalledTimes(2)
  expect(seen.flat()).toEqual([])
})
