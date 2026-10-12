import { afterEach, describe, expect, it, vi } from "vitest"
import type { Browser, Page } from "playwright"
import { LocalBotComputerProvider } from "./computer-provider"
import type { BotBrowserBroker } from "./browser-broker"
import { pressGrokBrowserKey } from "./upstream/grok-browser-actions.js"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
function fixture() {
  const events: string[] = []
  const primary = new Error("original press failure")
  const keyboard = {
    press: vi.fn(async (key: string): Promise<void> => {
      events.push(`press:${key}`)
      throw primary
    }),
    up: vi.fn(async (key: string) => {
      events.push(`up:${key}`)
    }),
    down: vi.fn()
  }
  const browser = { close: vi.fn(async () => {}) } as unknown as Browser
  const page = { keyboard, context: () => ({ browser: () => browser }) } as unknown as Page
  return { page, keyboard, browser, primary, events }
}
afterEach(() => vi.useRealTimers())

describe("failed browser keyboard chord recovery", () => {
  it("keeps one successful delegated press without additional keyup or down", async () => {
    const f = fixture()
    f.keyboard.press.mockResolvedValueOnce(undefined)
    await pressGrokBrowserKey(f.page, "Control++")
    expect(f.keyboard.press).toHaveBeenCalledExactlyOnceWith("Control++")
    expect(f.keyboard.up).not.toHaveBeenCalled()
    expect(f.keyboard.down).not.toHaveBeenCalled()
    expect(f.browser.close).not.toHaveBeenCalled()
  })

  it.each([
    ["Control+Shift+Invalid", ["Invalid", "Shift", "Control"]],
    ["Control++", ["+", "Control"]],
    ["+", ["+"]],
    ["ControlOrMeta+KeyA", ["KeyA", "ControlOrMeta"]]
  ] satisfies [string, string[]][])(
    "releases only original potentially pressed tokens in reverse for %s",
    async (key, tokens) => {
      const f = fixture()
      await expect(pressGrokBrowserKey(f.page, key)).rejects.toBe(f.primary)
      expect(f.keyboard.press).toHaveBeenCalledOnce()
      expect(f.keyboard.up.mock.calls.map(([token]) => token)).toEqual(tokens)
      expect(f.keyboard.down).not.toHaveBeenCalled()
    }
  )

  it("continues after each release failure and retains the primary error", async () => {
    const f = fixture()
    f.keyboard.up.mockRejectedValue(new Error("release failure"))
    await expect(pressGrokBrowserKey(f.page, "Control+Shift+Invalid")).rejects.toBe(f.primary)
    expect(f.events).toEqual(["press:Control+Shift+Invalid"])
    expect(f.keyboard.up.mock.calls.map(([token]) => token)).toEqual([
      "Invalid",
      "Shift",
      "Control"
    ])
    expect(f.keyboard.press).toHaveBeenCalledOnce()
    expect(f.keyboard.down).not.toHaveBeenCalled()
  })

  it("keeps the original Keyboard and Browser when the page references change during failure", async () => {
    const f = fixture(),
      other = fixture()
    f.keyboard.press.mockImplementationOnce(async () => {
      Object.assign(f.page, { keyboard: other.keyboard, context: other.page.context })
      throw f.primary
    })
    await expect(pressGrokBrowserKey(f.page, "Control+Invalid")).rejects.toBe(f.primary)
    expect(f.keyboard.up.mock.calls.map(([token]) => token)).toEqual(["Invalid", "Control"])
    expect(other.keyboard.up).not.toHaveBeenCalled()
    expect(other.keyboard.press).not.toHaveBeenCalled()
    expect(other.browser.close).not.toHaveBeenCalled()
  })

  it("joins the original pending up and one captured shutdown before returning the main failure", async () => {
    vi.useFakeTimers()
    const f = fixture(),
      up = deferred(),
      close = deferred()
    const stop = vi.fn((browser: Browser | null | undefined) => {
      expect(browser).toBe(f.browser)
      return close.promise
    })
    f.keyboard.up.mockImplementationOnce(() => up.promise)
    let settled = false
    const failed = pressGrokBrowserKey(f.page, "Control+Invalid", stop)
    const rejected = expect(failed).rejects.toBe(f.primary)
    void failed.catch(() => (settled = true))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stop).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    up.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    expect(f.keyboard.up.mock.calls.map(([key]) => key)).toEqual(["Invalid"])
    close.resolve()
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it("preserves the primary error if shutdown rejects and does not release another token", async () => {
    vi.useFakeTimers()
    const f = fixture(),
      up = deferred()
    f.keyboard.up.mockImplementationOnce(() => up.promise)
    const stop = vi.fn(async () => {
      throw new Error("shutdown unconfirmed")
    })
    const rejected = expect(pressGrokBrowserKey(f.page, "Control+Invalid", stop)).rejects.toBe(
      f.primary
    )
    await vi.advanceTimersByTimeAsync(5_000)
    up.resolve()
    await rejected
    expect(f.keyboard.up).toHaveBeenCalledOnce()
    expect(f.keyboard.down).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["reject", "resolve"] as const)(
    "stops a pending delegated press and joins its %s completion with the captured shutdown",
    async (outcome) => {
      vi.useFakeTimers()
      const f = fixture(),
        press = deferred(),
        close = deferred()
      f.keyboard.press.mockImplementationOnce(async () => {
        await press.promise
        if (outcome === "reject") throw f.primary
      })
      const stop = vi.fn((browser: Browser | null | undefined) => {
        expect(browser).toBe(f.browser)
        return close.promise
      })
      let settled = false
      const result = pressGrokBrowserKey(f.page, "Control+Invalid", stop).then(
        () => ({ success: true, error: undefined }),
        (error: unknown) => ({ success: false, error })
      )
      void result.then(() => (settled = true))
      try {
        await vi.advanceTimersByTimeAsync(9_999)
        expect(stop).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(stop).toHaveBeenCalledOnce()
        expect(settled).toBe(false)
        close.resolve()
        await vi.advanceTimersByTimeAsync(0)
        expect(settled).toBe(false)
        press.resolve()
        const actual = await result
        expect(actual.success).toBe(false)
        if (outcome === "reject") expect(actual.error).toBe(f.primary)
        else
          expect(actual.error).toHaveProperty(
            "message",
            "Browser key input timed out; outcome is unconfirmed"
          )
        expect(f.keyboard.press).toHaveBeenCalledExactlyOnceWith("Control+Invalid")
        expect(f.keyboard.up).not.toHaveBeenCalled()
        expect(f.keyboard.down).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        press.resolve()
        close.resolve()
        await result
      }
    }
  )

  it("does not accept a late press success when the captured shutdown is unconfirmed", async () => {
    vi.useFakeTimers()
    const f = fixture(),
      press = deferred()
    f.keyboard.press.mockImplementationOnce(() => press.promise)
    const stop = vi.fn(async () => {
      throw new Error("shutdown unconfirmed")
    })
    const result = pressGrokBrowserKey(f.page, "Control+a", stop).then(
      () => undefined,
      (error: unknown) => error
    )
    try {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(stop).toHaveBeenCalledOnce()
      press.resolve()
      expect(await result).toHaveProperty(
        "message",
        "Browser key input timed out; outcome is unconfirmed"
      )
      expect(f.keyboard.up).not.toHaveBeenCalled()
      expect(f.keyboard.down).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      press.resolve()
      await result
    }
  })

  it("bounds a direct caller before any key operation", async () => {
    const f = fixture()
    await expect(pressGrokBrowserKey(f.page, "x".repeat(101))).rejects.toThrow("100")
    expect(f.keyboard.press).not.toHaveBeenCalled()
    expect(f.keyboard.up).not.toHaveBeenCalled()
    expect(f.keyboard.down).not.toHaveBeenCalled()
  })
})

// This private trusted port is not an RPC or a model-supplied permission. The
// actual Chromium case separately exercises the public Provider and Broker.
describe("Provider keyboard shutdown ordering", () => {
  it("joins an existing shutdown without waiting for its own input tail, and closes once", async () => {
    const provider = new LocalBotComputerProvider("unused-test-profile")
    const tail = deferred()
    const broker = { close: vi.fn(() => tail.promise) } as unknown as BotBrowserBroker
    const browser = { close: vi.fn(async () => {}), isConnected: () => false } as unknown as Browser
    Reflect.set(provider, "broker", broker)
    Reflect.set(provider, "opening", Promise.resolve(broker))
    const closing = provider.close()
    const stop = Reflect.get(provider, "stopKeyboardCleanup").bind(provider) as (
      browser: Browser,
      broker: BotBrowserBroker
    ) => Promise<void>
    const first = stop(browser, broker)
    expect(stop(browser, broker)).toBe(first)
    await first
    Reflect.set(provider, "opening", undefined)
    Reflect.set(provider, "broker", undefined)
    await expect(provider.get()).rejects.toThrow("正在关闭")
    expect(browser.close).toHaveBeenCalledOnce()
    tail.resolve()
    await closing
    expect(broker.close).toHaveBeenCalledOnce()
  })

  it("keeps failed physical shutdown unavailable without replacing its error or restarting", async () => {
    const provider = new LocalBotComputerProvider("unused-test-profile")
    const primary = new Error("close unconfirmed")
    const broker = { close: vi.fn(async () => {}) } as unknown as BotBrowserBroker
    const browser = {
      close: vi.fn(async () => {
        throw primary
      }),
      isConnected: () => true
    } as unknown as Browser
    Reflect.set(provider, "broker", broker)
    Reflect.set(provider, "opening", Promise.resolve(broker))
    const stop = Reflect.get(provider, "stopKeyboardCleanup").bind(provider) as (
      browser: Browser,
      broker: BotBrowserBroker
    ) => Promise<void>
    const stopped = expect(stop(browser, broker)).rejects.toBe(primary)
    const drained = expect(Reflect.get(provider, "forceClosing") as Promise<void>).rejects.toBe(
      primary
    )
    await stopped
    await drained
    await expect(provider.close()).rejects.toThrow("关闭未确认")
    await expect(provider.get()).rejects.toThrow("关闭未确认")
    expect(provider.status().state).toBe("failed")
    expect(browser.close).toHaveBeenCalledOnce()
    expect(broker.close).not.toHaveBeenCalled()
  })
})
