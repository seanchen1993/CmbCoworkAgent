import { expect, it, vi } from "vitest"
import type { BrowserContext } from "playwright"
import { BotBrowserBroker } from "./browser-broker"
const cookie = (name: string, value = "audit") => ({
  name,
  value,
  domain: "fixture.invalid",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Strict" as const
})
it.each(["count", "bytes"] as const)(
  "refuses session-cookie %s overflow before closing the live context and permits later normal work",
  async (kind) => {
    const close = vi.fn(async () => {}),
      cookies = vi.fn(async () =>
        kind === "count"
          ? Array.from({ length: 2049 }, (_, i) => cookie(String(i)))
          : [cookie("large", "x".repeat(2 * 1024 * 1024))]
      )
    const context = { cookies, close, once: vi.fn() } as unknown as BrowserContext
    const broker = new BotBrowserBroker(context)
    await expect(broker.tryIdleClose()).rejects.toThrow("超出休眠预算")
    expect(close).not.toHaveBeenCalled()
    expect(broker.isClosed).toBe(false)
    expect(broker.idleBlockedReason).toBeNull()
    cookies.mockResolvedValue([])
    await expect(broker.tryIdleClose()).resolves.toEqual({ closed: true, sessionCookies: [] })
    expect(close).toHaveBeenCalledOnce()
  }
)
it("cancels idle preparation when a real observer appears during cookie capture without releasing its hold", async () => {
  let release!: (value: ReturnType<typeof cookie>[]) => void
  const close = vi.fn(async () => {}),
    cookies = () =>
      new Promise<ReturnType<typeof cookie>[]>((done) => {
        release = done
      })
  const broker = new BotBrowserBroker({
    cookies,
    close,
    once: vi.fn()
  } as unknown as BrowserContext)
  const sleep = broker.tryIdleClose(),
    client = new AbortController()
  // Internal clientTarget renews the authoritative connection lease before admission
  // is rejected; a get()-routed caller normally waits behind this same transition.
  expect(() => broker.clientTarget("unprepared", client.signal)).toThrow("浏览器")
  await Promise.resolve()
  await Promise.resolve()
  release([])
  await expect(sleep).resolves.toEqual({ closed: false })
  expect(close).not.toHaveBeenCalled()
  expect(broker.idleBlockedReason).toContain("查看")
  client.abort()
  expect(broker.idleBlockedReason).toBeNull()
})

it("checks the same trusted Host ownership/activity guard again after the awaited cookie capture", async () => {
  let release!: (value: ReturnType<typeof cookie>[]) => void
  const close = vi.fn(async () => {}),
    cookies = () =>
      new Promise<ReturnType<typeof cookie>[]>((done) => {
        release = done
      })
  const broker = new BotBrowserBroker({
    cookies,
    close,
    once: vi.fn()
  } as unknown as BrowserContext)
  let canClose = true
  const pending = broker.tryIdleClose(() => canClose)
  await Promise.resolve()
  await Promise.resolve()
  canClose = false
  release([])
  await expect(pending).resolves.toEqual({ closed: false })
  expect(close).not.toHaveBeenCalled()
  expect(broker.isClosed).toBe(false)
})
