import { afterEach, expect, it, vi } from "vitest"
import { createModCompilerService } from "./compiler-service"

afterEach(() => { vi.useRealTimers() })

function fixture() {
  const build = vi.fn(async () => ({ errors: [], warnings: [] }))
  const transform = vi.fn(async () => ({ code: "export {}", map: "", warnings: [] }))
  const stop = vi.fn(async () => {})
  const load = vi.fn(() => ({ version: "fixture", build, transform, stop }))
  const service = createModCompilerService(
    load as unknown as Parameters<typeof createModCompilerService>[0], 100
  )
  return { service, build, transform, stop, load }
}

it("does not initialize or schedule a child when unused or only reading the version", async () => {
  vi.useFakeTimers()
  const f = fixture()
  expect(f.load).not.toHaveBeenCalled()
  expect(f.service.version).toBe("fixture")
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.build).not.toHaveBeenCalled()
  expect(f.transform).not.toHaveBeenCalled()
  expect(f.stop).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it("keeps concurrent builds alive and releases the service after the last operation settles", async () => {
  vi.useFakeTimers()
  const f = fixture()
  const first = Promise.withResolvers<Awaited<ReturnType<typeof f.build>>>()
  const second = Promise.withResolvers<Awaited<ReturnType<typeof f.transform>>>()
  f.build.mockReturnValueOnce(first.promise)
  f.transform.mockReturnValueOnce(second.promise)
  const a = f.service.build({})
  const b = f.service.transform("source").catch(error => error)
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.stop).not.toHaveBeenCalled()
  first.resolve({ errors: [], warnings: [] })
  await a
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.stop).not.toHaveBeenCalled()
  const failure = Error("syntax error")
  second.reject(failure)
  expect(await b).toBe(failure)
  await vi.advanceTimersByTimeAsync(99)
  expect(f.stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.stop).toHaveBeenCalledTimes(1)
})

it("cancels an idle shutdown on reuse and waits for an already started shutdown", async () => {
  vi.useFakeTimers()
  const f = fixture()
  await f.service.transform("first")
  await vi.advanceTimersByTimeAsync(99)
  await f.service.transform("second")
  await vi.advanceTimersByTimeAsync(99)
  expect(f.stop).not.toHaveBeenCalled()
  const stopped = Promise.withResolvers<void>()
  f.stop.mockReturnValueOnce(stopped.promise)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.stop).toHaveBeenCalledTimes(1)
  const resumed = f.service.transform("third")
  expect(f.transform).toHaveBeenCalledTimes(2)
  stopped.resolve()
  await resumed
  expect(f.transform).toHaveBeenCalledTimes(3)
  expect(f.load).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(100)
  expect(f.stop).toHaveBeenCalledTimes(2)
})
