import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { LocalBotComputerProvider } from "./computer-provider"

const fixtures = vi.hoisted(() => ({
  launch: vi.fn(),
  idleClose: vi.fn(),
  close: vi.fn(),
  externalCleanup: vi.fn()
}))
vi.mock("node:perf_hooks", () => ({ performance: { now: () => Date.now() } }))
vi.mock("playwright", () => ({
  chromium: { launchPersistentContext: fixtures.launch }
}))
vi.mock("./browser-broker", () => ({
  BotBrowserBroker: class {
    constructor(private context: { close(): Promise<void> }) {}
    lastActivityAt = 0
    idleBlockedReason: string | null = null
    isClosed = false
    contextCloseRequested = false
    tryIdleClose() {
      if (this.idleBlockedReason) return null
      fixtures.idleClose()
      return this.close().then(() => ({ closed: true, sessionCookies: [] }))
    }
    close() {
      this.contextCloseRequested = true
      this.isClosed = true
      fixtures.close()
      return this.context.close()
    }
    onContextClosed() {
      this.isClosed = true
      return fixtures.externalCleanup()
    }
  }
}))
const providers: LocalBotComputerProvider[] = []
const expectedClosureFailures = new Set<LocalBotComputerProvider>()
function provider(idleAfterMs = 500) {
  const value = new LocalBotComputerProvider("/fixture/profile", "chrome", {
    idleAfterMs
  })
  providers.push(value)
  return value
}
function context() {
  const closeListeners = new Set<() => void>()
  const emitClose = () => {
    const listeners = [...closeListeners]
    closeListeners.clear()
    for (const listener of listeners) listener()
  }
  return {
    once: (_event: string, handler: () => void) => {
      closeListeners.add(handler)
    },
    clearPermissions: async () => {},
    pages: () => [],
    browser: () => ({ version: () => "154" }),
    close: async () => emitClose(),
    disconnect: emitClose
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  fixtures.launch.mockReset().mockImplementation(async () => context())
  fixtures.idleClose.mockReset()
  fixtures.close.mockReset()
  fixtures.externalCleanup.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  for (const value of providers.splice(0))
    if (expectedClosureFailures.delete(value))
      await expect(value.close()).rejects.toThrow("关闭未确认")
    else await value.close()
  vi.useRealTimers()
})
it("closes an idle owned browser and coalesces lazy wake with a new attempt identity", async () => {
  const value = provider(),
    first = await value.get(),
    attempt = value.status().attemptId
  await vi.advanceTimersByTimeAsync(501)
  expect(value.status().state).toBe("stopped")
  expect(fixtures.idleClose).toHaveBeenCalledOnce()
  const next = value.get()
  expect(value.get()).toBe(next)
  expect(await next).not.toBe(first)
  expect(value.status().attemptId).not.toBe(attempt)
  expect(fixtures.launch).toHaveBeenCalledTimes(2)
})
it("keeps a pending Host task live and starts the idle interval after it releases", async () => {
  const value = provider()
  let busy = true
  value.bindIdleGuard(() => !busy)
  await value.get()
  await vi.advanceTimersByTimeAsync(501)
  expect(value.status().state).toBe("ready")
  expect(fixtures.idleClose).not.toHaveBeenCalled()
  busy = false
  await vi.advanceTimersByTimeAsync(501)
  expect(value.status().state).toBe("stopped")
})
it("does not close during browser busy holds and retries after release without a hot loop", async () => {
  const value = provider(),
    broker = await value.get()
  Object.assign(broker, { idleBlockedReason: "download" })
  await vi.advanceTimersByTimeAsync(2000)
  expect(value.status().state).toBe("ready")
  expect(fixtures.idleClose).not.toHaveBeenCalled()
  Object.assign(broker, { idleBlockedReason: null })
  await vi.advanceTimersByTimeAsync(501)
  expect(value.status().state).toBe("stopped")
})
it("keeps the original browser if durable session saving fails before idle commit", async () => {
  const value = provider(),
    broker = await value.get()
  vi.spyOn(broker, "tryIdleClose").mockImplementationOnce(() => {
    throw Error("storage failed")
  })
  await vi.advanceTimersByTimeAsync(501)
  expect(value.status().state).toBe("ready")
  expect(fixtures.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(501)
  expect(value.status().state).toBe("stopped")
})
it("does not launch or retain idle timers before first use or after shutdown", async () => {
  const value = provider()
  await vi.advanceTimersByTimeAsync(6000)
  expect(fixtures.launch).not.toHaveBeenCalled()
  await value.get()
  await value.close()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(6000)
  expect(fixtures.launch).toHaveBeenCalledOnce()
})

it("joins a concurrent lazy wake behind idle publication without returning the old broker", async () => {
  const value = provider(),
    old = await value.get()
  let finish!: () => void
  const gate = new Promise<void>((done) => {
    finish = done
  })
  vi.spyOn(old, "tryIdleClose").mockImplementationOnce(() =>
    gate.then(async () => {
      await old.close()
      return { closed: true, sessionCookies: [] }
    })
  )
  await vi.advanceTimersByTimeAsync(501)
  expect(value.status().state).toBe("stopping")
  let resolved = false
  const wake = value.get().then((broker) => {
    resolved = true
    return broker
  })
  await Promise.resolve()
  expect(resolved).toBe(false)
  finish()
  expect(await wake).not.toBe(old)
})
it("waits for external cleanup when Chromium closes during idle cookie escrow", async () => {
  const value = provider(),
    native = context()
  fixtures.launch.mockResolvedValueOnce(native)
  const old = await value.get()
  let finishIdle!: (value: { closed: false }) => void
  const idle = new Promise<{ closed: false }>((done) => {
    finishIdle = done
  })
  let finishCleanup!: () => void
  const cleanup = new Promise<void>((done) => {
    finishCleanup = done
  })
  fixtures.externalCleanup.mockReturnValueOnce(cleanup)
  vi.spyOn(old, "tryIdleClose").mockImplementationOnce(() => idle)

  await vi.advanceTimersByTimeAsync(501)
  expect(value.status().state).toBe("stopping")
  native.disconnect()
  finishIdle({ closed: false })
  await vi.advanceTimersByTimeAsync(0)

  let reopened = false
  const wake = value.get().then((broker) => {
    reopened = true
    return broker
  })
  await Promise.resolve()
  expect(reopened).toBe(false)
  expect(fixtures.launch).toHaveBeenCalledOnce()

  finishCleanup()
  expect(await wake).not.toBe(old)
  expect(fixtures.launch).toHaveBeenCalledTimes(2)
})
it("forces shutdown through a pending idle preparation and awaits that same transition", async () => {
  const value = provider(),
    old = await value.get()
  let finish!: () => void
  const gate = new Promise<void>((done) => {
    finish = done
  })
  vi.spyOn(old, "tryIdleClose").mockImplementationOnce(() => gate.then(() => ({ closed: false })))
  await vi.advanceTimersByTimeAsync(501)
  let stopped = false
  const stopping = value.close().then(() => {
    stopped = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(fixtures.close).toHaveBeenCalledOnce()
  expect(stopped).toBe(false)
  finish()
  await stopping
  expect(value.status().state).toBe("stopped")
  expect(vi.getTimerCount()).toBe(0)
})

it("fails closed after an unconfirmed physical idle close without launching a second browser", async () => {
  const value = provider(),
    old = await value.get()
  vi.spyOn(old, "tryIdleClose").mockImplementationOnce(() => {
    Object.defineProperty(old, "isClosed", { value: true })
    return Promise.reject(Error("physical close unconfirmed"))
  })
  await vi.advanceTimersByTimeAsync(501)
  expect(value.status().state).toBe("failed")
  await expect(value.get()).rejects.toThrow("关闭未确认")
  expect(fixtures.launch).toHaveBeenCalledOnce()
  expectedClosureFailures.add(value)
  expect(vi.getTimerCount()).toBe(0)
})
it("does not reopen a profile after an explicit shutdown failed to close its native process", async () => {
  const value = provider(),
    old = await value.get()
  const failure = vi.spyOn(old, "close").mockRejectedValueOnce(Error("native close unconfirmed"))
  await expect(value.close()).rejects.toThrow("native close unconfirmed")
  expect(value.status().state).toBe("failed")
  await expect(value.get()).rejects.toThrow("关闭未确认")
  expect(fixtures.launch).toHaveBeenCalledOnce()
  failure.mockRestore()
  expectedClosureFailures.add(value)
})

it("retains the bounded session escrow after a failed cookie restore and publishes only after a successful retry", async () => {
  const value = provider(),
    old = await value.get()
  const cookies = [
    {
      name: "session",
      value: "audit-only",
      domain: "fixture.invalid",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Strict" as const
    }
  ]
  vi.spyOn(old, "tryIdleClose").mockImplementationOnce(async () => {
    await old.close()
    return { closed: true, sessionCookies: cookies }
  })
  await vi.advanceTimersByTimeAsync(501)
  expect(value.status().state).toBe("stopped")
  const failed = context(),
    closeFailed = vi.spyOn(failed, "close"),
    rejectedCookies = vi.fn(async () => {
      throw Error("cookie restore failed")
    }),
    acceptedCookies = vi.fn(async () => {})
  fixtures.launch.mockImplementationOnce(async () => ({ ...failed, addCookies: rejectedCookies }))
  await expect(value.get()).rejects.toThrow("无法启动")
  expect(closeFailed).toHaveBeenCalledOnce()
  expect(value.status().state).toBe("failed")
  expect(rejectedCookies).toHaveBeenCalledWith(cookies)
  fixtures.launch.mockImplementationOnce(async () => ({
    ...context(),
    addCookies: acceptedCookies
  }))
  await value.get()
  expect(acceptedCookies).toHaveBeenCalledWith(cookies)
  expect(value.status().state).toBe("ready")
})

it("revokes queued idle wake and new browser admission when the provider lifetime closes", async () => {
  const value = provider(),
    old = await value.get()
  let finish!: () => void
  const gate = new Promise<void>((done) => {
    finish = done
  })
  vi.spyOn(old, "tryIdleClose").mockImplementationOnce(() => gate.then(() => ({ closed: false })))
  await vi.advanceTimersByTimeAsync(501)
  expect(value.status().state).toBe("stopping")
  const waiting = value.get()
  const rejected = expect(waiting).rejects.toThrow("已关闭")
  const shutdown = value.shutdown()
  finish()
  await shutdown
  await rejected
  await expect(value.get()).rejects.toThrow("已关闭")
  expect(fixtures.launch).toHaveBeenCalledOnce()
  expect(value.status().state).toBe("stopped")
  expect(vi.getTimerCount()).toBe(0)
})

it("cancels an old idle waiter across manual close but allows a fresh explicit reopen afterward", async () => {
  const value = provider(),
    old = await value.get()
  let finish!: () => void
  const gate = new Promise<void>((done) => {
    finish = done
  })
  vi.spyOn(old, "tryIdleClose").mockImplementationOnce(() => gate.then(() => ({ closed: false })))
  await vi.advanceTimersByTimeAsync(501)
  const previous = value.get(),
    rejected = expect(previous).rejects.toThrow("已关闭")
  const close = value.close()
  await expect(value.get()).rejects.toThrow("正在关闭")
  finish()
  await close
  await rejected
  expect(await value.get()).not.toBe(old)
  expect(fixtures.launch).toHaveBeenCalledTimes(2)
})
it.each([false, true])(
  "awaits terminal shutdown during opening and preserves failed physical cleanup=%s",
  async (failsClose) => {
    const value = provider(),
      native = context()
    let finish!: () => void
    const gate = new Promise<void>((done) => {
      finish = done
    })
    native.clearPermissions = () => gate
    const close = vi.spyOn(native, "close")
    if (failsClose) close.mockRejectedValueOnce(Error("native shutdown unconfirmed"))
    fixtures.launch.mockResolvedValueOnce(native)
    const opening = value.get(),
      rejectedOpening = expect(opening).rejects.toThrow("无法启动")
    await Promise.resolve()
    const shuttingDown = value.shutdown()
    const settledShutdown = failsClose
      ? expect(shuttingDown).rejects.toThrow("关闭未确认")
      : expect(shuttingDown).resolves.toBeUndefined()
    finish()
    await rejectedOpening
    await settledShutdown
    expect(close).toHaveBeenCalledOnce()
    await expect(value.get()).rejects.toThrow(failsClose ? "关闭未确认" : "已关闭")
    expect(fixtures.launch).toHaveBeenCalledOnce()
    expect(value.status().state).toBe(failsClose ? "failed" : "stopped")
    if (failsClose) expectedClosureFailures.add(value)
    expect(vi.getTimerCount()).toBe(0)
  }
)
it("keeps unconfirmed failed setup closure sticky instead of admitting a retry", async () => {
  const value = provider(),
    native = context()
  native.clearPermissions = async () => {
    throw Error("setup failed")
  }
  const close = vi.spyOn(native, "close").mockRejectedValueOnce(Error("native still present"))
  fixtures.launch.mockResolvedValueOnce(native)
  await expect(value.get()).rejects.toThrow("无法启动")
  expect(close).toHaveBeenCalledOnce()
  await expect(value.get()).rejects.toThrow("关闭未确认")
  expect(fixtures.launch).toHaveBeenCalledOnce()
  expect(value.status().state).toBe("failed")
  await expect(value.shutdown()).rejects.toThrow("关闭未确认")
  expectedClosureFailures.add(value)
})
