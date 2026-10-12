import { expect, test, vi } from "vitest"
import { lazyBotNativeShellFactory } from "./native-shell-factory-lazy"
import type { BotShellOwnedFactory } from "./shell-process"
const request = {} as Parameters<BotShellOwnedFactory>[0]
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const controller = () => new AbortController()
test("creating an unavailable native factory never initializes or blocks ordinary Host startup", () => {
  const initialize = vi.fn(async () => {
    throw new Error("no native capability")
  })
  expect(typeof lazyBotNativeShellFactory(initialize, async () => {})).toBe("function")
  expect(initialize).not.toHaveBeenCalled()
})
test("concurrent admissions coalesce preparation and each rechecks ownership before effects", async () => {
  const d = deferred<BotShellOwnedFactory>(),
    owner = vi.fn(async () => {}),
    effect = vi.fn(async () => {
      throw new Error("admitted fixture")
    })
  const init = vi.fn(() => d.promise),
    factory = lazyBotNativeShellFactory(init, owner)
  const a = factory(request, controller().signal),
    b = factory(request, controller().signal)
  const rejected = Promise.allSettled([a, b])
  await Promise.resolve()
  await Promise.resolve()
  expect(init).toHaveBeenCalledTimes(1)
  d.resolve(effect)
  await rejected
  expect(effect).toHaveBeenCalledTimes(2)
  expect(owner).toHaveBeenCalledTimes(4)
})
test("failed preparation is retried only on a fresh admission and never produces an effect", async () => {
  const init = vi.fn(async () => {
      throw new Error("probe unavailable")
    }),
    factory = lazyBotNativeShellFactory(init, async () => {})
  await expect(factory(request, controller().signal)).rejects.toThrow("unavailable")
  await expect(factory(request, controller().signal)).rejects.toThrow("unavailable")
  expect(init).toHaveBeenCalledTimes(2)
})
test("cancelling a second caller detaches without cancelling the first caller's native preparation", async () => {
  const d = deferred<BotShellOwnedFactory>(),
    effect = vi.fn(async () => {
      throw new Error("first admitted")
    }),
    first = controller(),
    second = controller()
  const init = vi.fn((signal: AbortSignal) => {
    expect(signal).toBe(first.signal)
    return d.promise
  })
  const factory = lazyBotNativeShellFactory(init, async () => {})
  const a = factory(request, first.signal),
    b = factory(request, second.signal)
  const pa = expect(a).rejects.toThrow("first admitted"),
    pb = expect(b).rejects.toThrow("second cancelled")
  await Promise.resolve()
  await Promise.resolve()
  second.abort(new Error("second cancelled"))
  await pb
  expect(first.signal.aborted).toBe(false)
  d.resolve(effect)
  await pa
  expect(effect).toHaveBeenCalledTimes(1)
})
test("ownership loss during native initialization prevents first effect", async () => {
  const d = deferred<BotShellOwnedFactory>(),
    effect = vi.fn(async () => {
      throw new Error("unexpected effect")
    })
  let current = true
  const factory = lazyBotNativeShellFactory(
    () => d.promise,
    async () => {
      if (!current) throw new Error("owner lost")
    }
  )
  const result = expect(factory(request, controller().signal)).rejects.toThrow("owner lost")
  await Promise.resolve()
  await Promise.resolve()
  current = false
  d.resolve(effect)
  await result
  expect(effect).not.toHaveBeenCalled()
})
test("first caller cancellation reaches native initializer, rejects it, and permits a fresh retry", async () => {
  const first = controller(),
    init = vi.fn(
      (signal: AbortSignal) =>
        new Promise<BotShellOwnedFactory>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true
          })
        )
    )
  const factory = lazyBotNativeShellFactory(init, async () => {}),
    a = expect(factory(request, first.signal)).rejects.toThrow("first cancelled")
  await Promise.resolve()
  await Promise.resolve()
  first.abort(new Error("first cancelled"))
  await a
  const second = controller(),
    b = expect(factory(request, second.signal)).rejects.toThrow("retry cancelled")
  await Promise.resolve()
  await Promise.resolve()
  second.abort(new Error("retry cancelled"))
  await b
  expect(init).toHaveBeenCalledTimes(2)
})
