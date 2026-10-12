import { beforeEach, expect, it, vi } from "vitest"
import { performance } from "node:perf_hooks"
import { LocalBotComputerProvider } from "./computer-provider"

const mocks = vi.hoisted(() => ({ launch: vi.fn(), release: vi.fn(), externalCleanup: vi.fn() }))
vi.mock("playwright", () => ({ chromium: { launchPersistentContext: mocks.launch } }))
vi.mock("./browser-broker", () => ({
  BotBrowserBroker: class {
    readonly lastActivityAt = performance.now()
    contextCloseRequested = false
    constructor(private readonly context: { close(): Promise<void> }) {}
    releaseBot(id: string) {
      return mocks.release(id)
    }
    onContextClosed() {
      return mocks.externalCleanup()
    }
    close() {
      this.contextCloseRequested = true
      return this.context.close()
    }
  }
}))

function context(version = "145.0.1.2") {
  let listener: (() => void) | undefined
  const value = {
    once: vi.fn((_event: string, next: () => void) => {
      listener = next
    }),
    clearPermissions: vi.fn(async () => {}),
    pages: vi.fn(() => [{ close: vi.fn(async () => {}) }]),
    browser: () => ({ version: () => version }),
    close: vi.fn(async () => {
      listener?.()
    }),
    disconnect: () => listener?.()
  }
  return value
}
beforeEach(() => {
  mocks.launch.mockReset()
  mocks.release.mockReset()
  mocks.externalCleanup.mockReset().mockResolvedValue(undefined)
})

it.each(["152.0.7977.75", "153.0.8000.1", "154.0.8037.99"])(
  "blocks known Chromium download-history crashes in %s before publishing pages",
  async (version) => {
    const incompatible = context(version)
    const fixed = context("155.0.8059.39")
    mocks.launch.mockResolvedValueOnce(incompatible).mockResolvedValueOnce(fixed)
    const provider = new LocalBotComputerProvider("/fixture/profile")
    await expect(provider.get()).rejects.toThrow("请更新至 155 或更高版本后重试")
    expect(incompatible.clearPermissions).not.toHaveBeenCalled()
    expect(incompatible.pages).not.toHaveBeenCalled()
    expect(incompatible.close).toHaveBeenCalledTimes(1)
    expect(provider.status()).toMatchObject({ state: "failed", version: null })
    await provider.get()
    expect(provider.status()).toMatchObject({ state: "ready", version: "155.0.8059.39" })
    await provider.close()
  }
)

it("releases a deleted target after an in-flight launch without launching a stopped browser", async () => {
  const provider = new LocalBotComputerProvider("/fixture/profile")
  await provider.releaseBot("deleted")
  expect(mocks.launch).not.toHaveBeenCalled()
  let resolve!: (value: ReturnType<typeof context>) => void
  mocks.launch.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const opening = provider.get()
  const removal = provider.releaseBot("deleted")
  expect(mocks.release).not.toHaveBeenCalled()
  resolve(context())
  await opening
  await removal
  expect(mocks.launch).toHaveBeenCalledTimes(1)
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith("deleted")
  await provider.close()
})

it("reports actual launch/close state and coalesces concurrent callers without launching on inspection", async () => {
  const value = context()
  let resolve!: (value: ReturnType<typeof context>) => void
  mocks.launch.mockReturnValue(
    new Promise((done) => {
      resolve = done
    })
  )
  const provider = new LocalBotComputerProvider("/fixture/profile", "msedge")
  expect(provider.status()).toMatchObject({
    state: "stopped",
    browser: "msedge",
    version: null,
    attemptId: null
  })
  expect(mocks.launch).not.toHaveBeenCalled()
  const first = provider.get()
  expect(provider.get()).toBe(first)
  expect(provider.status().state).toBe("starting")
  const attemptId = provider.status().attemptId
  resolve(value)
  await first
  expect(provider.status()).toMatchObject({ state: "ready", version: "145.0.1.2", attemptId })
  expect(provider.status().startedAt).toBeGreaterThan(0)
  const closing = provider.close()
  expect(provider.status().state).toBe("stopping")
  await closing
  expect(provider.status()).toMatchObject({ state: "stopped", version: null, startedAt: null })
  expect(value.close).toHaveBeenCalledTimes(1)
})

it("closes a launched process when setup fails, and gives retry a new attempt identity", async () => {
  const failed = context()
  failed.clearPermissions.mockRejectedValue(new Error("PRIVATE_PROFILE_PATH"))
  const recovered = context()
  mocks.launch.mockResolvedValueOnce(failed).mockResolvedValueOnce(recovered)
  const provider = new LocalBotComputerProvider("/fixture/profile")
  const first = provider.get()
  const attempt = provider.status().attemptId
  await expect(first).rejects.toThrow("Bot 浏览器无法启动")
  expect(failed.close).toHaveBeenCalledTimes(1)
  expect(provider.status()).toMatchObject({ state: "failed", version: null })
  expect(JSON.stringify(provider.status())).not.toMatch(/PRIVATE|fixture/)
  await provider.get()
  expect(provider.status().attemptId).not.toBe(attempt)
  expect(provider.status().state).toBe("ready")
  recovered.disconnect()
  expect(provider.status().state).toBe("failed")
})

it("never publishes readiness when the process closes during setup or permits an overlapping retry", async () => {
  const value = context()
  let finish!: () => void
  value.clearPermissions.mockImplementation(
    () =>
      new Promise<void>((done) => {
        finish = done
      })
  )
  mocks.launch.mockResolvedValue(value)
  const provider = new LocalBotComputerProvider("/fixture/profile")
  const pending = provider.get()
  // Attach the rejection handler before releasing setup.
  const rejected = expect(pending).rejects.toThrow("Bot 浏览器无法启动")
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
  value.disconnect()
  expect(provider.get()).toBe(pending)
  expect(mocks.launch).toHaveBeenCalledTimes(1)
  finish()
  await rejected
  expect(value.close).toHaveBeenCalledTimes(1)
  expect(provider.status().state).toBe("failed")
})

it("keeps the browser sandbox enabled and never falls back after a sandbox launch failure", async () => {
  mocks.launch.mockRejectedValue(new Error("No usable sandbox"))
  const provider = new LocalBotComputerProvider("/fixture/profile")
  await expect(provider.get()).rejects.toThrow("Bot 浏览器无法启动")
  expect(mocks.launch).toHaveBeenCalledTimes(1)
  expect(mocks.launch.mock.calls[0][1]).toMatchObject({ chromiumSandbox: true })
  expect(provider.status().state).toBe("failed")
})

it("waits for external Broker cleanup before reopening the persistent browser profile", async () => {
  const first = context(),
    second = context()
  let release!: () => void
  const cleanup = new Promise<void>((done) => {
    release = done
  })
  mocks.launch.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
  mocks.externalCleanup.mockReturnValue(cleanup)
  const provider = new LocalBotComputerProvider("/fixture/profile")
  await provider.get()

  first.disconnect()
  let reopened = false
  const next = provider.get().then((broker) => {
    reopened = true
    return broker
  })
  await Promise.resolve()
  expect(reopened).toBe(false)
  expect(mocks.launch).toHaveBeenCalledTimes(1)

  release()
  await next
  expect(mocks.launch).toHaveBeenCalledTimes(2)
  await provider.close()
})

it("fails closed when external Broker cleanup cannot confirm release", async () => {
  const value = context()
  mocks.launch.mockResolvedValue(value)
  mocks.externalCleanup.mockRejectedValue(new Error("external cleanup failed"))
  const provider = new LocalBotComputerProvider("/fixture/profile")
  await provider.get()

  value.disconnect()
  await expect(provider.get()).rejects.toThrow("资源清理未确认")
  expect(mocks.launch).toHaveBeenCalledTimes(1)
  await expect(provider.close()).rejects.toThrow("关闭未确认")
})

it("fences a late wake while close joins external Broker cleanup", async () => {
  const first = context()
  let release!: () => void
  const cleanup = new Promise<void>((done) => {
    release = done
  })
  mocks.launch.mockResolvedValue(first)
  mocks.externalCleanup.mockReturnValue(cleanup)
  const provider = new LocalBotComputerProvider("/fixture/profile")
  await provider.get()

  first.disconnect()
  const closing = provider.close()
  await expect(provider.get()).rejects.toThrow("Bot 浏览器正在关闭")
  expect(mocks.launch).toHaveBeenCalledTimes(1)

  release()
  await closing
  expect(mocks.launch).toHaveBeenCalledTimes(1)
})

it("reports stopped after terminal shutdown joins successful external cleanup", async () => {
  const value = context()
  mocks.launch.mockResolvedValue(value)
  const provider = new LocalBotComputerProvider("/fixture/profile")
  await provider.get()

  value.disconnect()
  await provider.shutdown()

  expect(provider.status().state).toBe("stopped")
  await expect(provider.get()).rejects.toThrow("已关闭")
})
