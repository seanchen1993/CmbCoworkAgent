import { expect, it, vi } from "vitest"
import type { BrowserContext } from "playwright"
import { BotBrowserBroker } from "./browser-broker"

it("releases broker-owned resources when Chromium closes its context externally", async () => {
  const closeListeners: (() => void)[] = []
  const context = {
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "close") closeListeners.push(listener)
    }),
    close: vi.fn(async () => {})
  } as unknown as BrowserContext
  const broker = new BotBrowserBroker(context)
  const downloads = Reflect.get(broker, "downloads") as { close(): Promise<void> }
  const closeDownloads = vi.spyOn(downloads, "close")

  for (const listener of closeListeners) listener()
  await broker.close()

  expect(broker.isClosed).toBe(true)
  expect(context.close).not.toHaveBeenCalled()
  expect(closeDownloads).toHaveBeenCalledOnce()
})

it("publishes normal close intent before asking Chromium to close", async () => {
  const listeners: (() => void)[] = []
  const current: { broker?: BotBrowserBroker } = {}
  const context = {
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "close") listeners.push(listener)
    }),
    close: vi.fn(async () => {
      expect(current.broker?.contextCloseRequested).toBe(true)
      for (const listener of listeners) listener()
    })
  } as unknown as BrowserContext
  const broker = new BotBrowserBroker(context)
  current.broker = broker

  expect(broker.contextCloseRequested).toBe(false)
  await broker.close()
  expect(broker.contextCloseRequested).toBe(true)
})
