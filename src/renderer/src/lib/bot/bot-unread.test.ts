import { afterEach, expect, it, vi } from "vitest"
import type { BotChangeEvent } from "../../../../shared/bots/contracts"
import { useLocalBotsUnread } from "@/components/bots/use-bots"

const hooks = vi.hoisted(() => ({
  useEffect: vi.fn<(effect: () => void | (() => void)) => void>(),
  setUnread: vi.fn<(unread: boolean) => void>()
}))

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: hooks.useEffect,
  useState: (initial: boolean) => [initial, hooks.setUnread]
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function mountUnread() {
  const hasUnread = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
  const listeners = new Set<(event: BotChangeEvent) => void>()
  const unsubscribe = vi.fn((listener: (event: BotChangeEvent) => void) => {
    listeners.delete(listener)
  })
  const client = {
    hostId: "local",
    hasUnread,
    snapshot: vi.fn(),
    markRead: vi.fn(),
    subscribe: vi.fn((listener: (event: BotChangeEvent) => void) => {
      listeners.add(listener)
      return () => unsubscribe(listener)
    })
  }
  const window = Object.assign(new EventTarget(), { api: { bots: client } })
  vi.stubGlobal("window", window)
  useLocalBotsUnread()
  const unmount = hooks.useEffect.mock.lastCall![0]() as () => void
  const emit = (revision: number, fields: Partial<BotChangeEvent> = {}) =>
    listeners.forEach(listener => listener({ hostId: "local", revision, ...fields }))
  return { client, emit, unmount, unsubscribe, window }
}

it("refreshes only the local unread indicator at mount, on Bot changes and on focus", async () => {
  const { client, emit, unmount, unsubscribe, window } = mountUnread()
  await vi.waitFor(() => expect(hooks.setUnread).toHaveBeenLastCalledWith(false))
  expect(client.subscribe).toHaveBeenCalledOnce()
  expect(client.hasUnread).toHaveBeenCalledOnce()

  emit(2, { memoryBotId: "bot" })
  emit(3, { hostId: "other" })
  expect(client.hasUnread).toHaveBeenCalledOnce()

  client.hasUnread.mockResolvedValueOnce(true)
  emit(4)
  await vi.waitFor(() => expect(hooks.setUnread).toHaveBeenLastCalledWith(true))

  client.hasUnread.mockRejectedValueOnce(new Error("unavailable"))
  emit(5)
  await Promise.resolve()
  expect(hooks.setUnread).toHaveBeenLastCalledWith(true)

  window.dispatchEvent(new Event("focus"))
  await vi.waitFor(() => expect(hooks.setUnread).toHaveBeenLastCalledWith(false))
  expect(client.hasUnread).toHaveBeenCalledTimes(4)
  expect(client.snapshot).not.toHaveBeenCalled()
  expect(client.markRead).not.toHaveBeenCalled()

  unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
  emit(6)
  window.dispatchEvent(new Event("focus"))
  expect(client.hasUnread).toHaveBeenCalledTimes(4)
})

it("coalesces invalidations during a read and ignores obsolete or unmounted replies", async () => {
  const { client, emit, unmount } = mountUnread()
  await vi.waitFor(() => expect(hooks.setUnread).toHaveBeenCalledOnce())

  let resolveOld!: (unread: boolean) => void
  let resolveCurrent!: (unread: boolean) => void
  client.hasUnread
    .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
    .mockReturnValueOnce(new Promise(resolve => { resolveCurrent = resolve }))
  emit(2)
  emit(3)
  emit(4)
  expect(client.hasUnread).toHaveBeenCalledTimes(2)
  resolveOld(false)
  await vi.waitFor(() => expect(client.hasUnread).toHaveBeenCalledTimes(3))
  expect(hooks.setUnread).toHaveBeenCalledOnce()
  resolveCurrent(true)
  await vi.waitFor(() => expect(hooks.setUnread).toHaveBeenLastCalledWith(true))

  let resolveUnmounted!: (unread: boolean) => void
  client.hasUnread.mockReturnValueOnce(new Promise(resolve => { resolveUnmounted = resolve }))
  emit(5)
  unmount()
  resolveUnmounted(false)
  await Promise.resolve()
  expect(hooks.setUnread).toHaveBeenCalledTimes(2)
  expect(hooks.setUnread).toHaveBeenLastCalledWith(true)
})
