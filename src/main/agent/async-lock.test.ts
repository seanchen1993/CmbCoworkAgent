import { describe, expect, it, vi } from "vitest"
import { AsyncRWLock, AsyncSemaphore } from "./async-lock"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe("AsyncRWLock", () => {
  it("unblocks waiting readers when the last queued writer is canceled", async () => {
    const lock = new AsyncRWLock()
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const first = lock.read(async () => {
      firstStarted.resolve()
      await releaseFirst.promise
    })
    await firstStarted.promise

    const controller = new AbortController()
    const writerHandler = vi.fn(async () => "must not run")
    const writer = lock.write(writerHandler, controller.signal)
    const canceled = expect(writer).rejects.toMatchObject({ name: "AbortError" })
    const secondStarted = deferred()
    const second = lock.read(async () => {
      secondStarted.resolve()
      return "parallel read"
    })
    controller.abort()
    await canceled
    await secondStarted.promise
    await expect(second).resolves.toBe("parallel read")
    expect(writerHandler).not.toHaveBeenCalled()
    releaseFirst.resolve()
    await first
  })

  it("preserves writer preference while removing a canceled writer", async () => {
    const lock = new AsyncRWLock()
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const first = lock.read(async () => {
      firstStarted.resolve()
      await releaseFirst.promise
    })
    await firstStarted.promise

    const controller = new AbortController()
    const canceledWriter = lock.write(async () => "canceled", controller.signal)
    const canceled = expect(canceledWriter).rejects.toMatchObject({ name: "AbortError" })
    const order: string[] = []
    const writerStarted = deferred()
    const releaseWriter = deferred()
    const nextWriter = lock.write(async () => {
      order.push("writer")
      writerStarted.resolve()
      await releaseWriter.promise
    })
    const reader = lock.read(async () => {
      order.push("reader")
    })
    controller.abort()
    await canceled
    expect(order).toEqual([])
    releaseFirst.resolve()
    await first
    await writerStarted.promise
    expect(order).toEqual(["writer"])
    releaseWriter.resolve()
    await Promise.all([nextWriter, reader])
    expect(order).toEqual(["writer", "reader"])
  })

  it.each(["read", "write"] as const)(
    "releases an immediately granted %s lock if canceled before its handler starts",
    async (kind) => {
      const lock = new AsyncRWLock()
      const controller = new AbortController()
      const handler = vi.fn(async () => "must not run")
      const pending = lock[kind](handler, controller.signal)
      const canceled = expect(pending).rejects.toMatchObject({ name: "AbortError" })
      controller.abort()
      await canceled
      expect(handler).not.toHaveBeenCalled()
      await expect(lock.write(async () => "released")).resolves.toBe("released")
    }
  )

  it("releases a queued write granted just before its continuation is canceled", async () => {
    const lock = new AsyncRWLock()
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const first = lock.write(async () => {
      firstStarted.resolve()
      await releaseFirst.promise
    })
    await firstStarted.promise

    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, "removeEventListener")
    const handler = vi.fn(async () => "must not dispatch")
    const queued = lock.write(handler, controller.signal)
    const canceled = expect(queued).rejects.toMatchObject({ name: "AbortError" })
    // The first microtask completes the holder; its continuation grants the
    // waiter before this nested microtask aborts the waiter's continuation.
    const abortInGrantWindow = releaseFirst.promise.then(() =>
      Promise.resolve().then(() => {
        expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
        controller.abort()
      })
    )
    releaseFirst.resolve()
    await Promise.all([first, abortInGrantWindow, canceled])
    expect(handler).not.toHaveBeenCalled()
    await expect(lock.read(async () => "read after race")).resolves.toBe("read after race")
  })

  it.each(["read", "write"] as const)("releases a %s lock on handler failure", async (kind) => {
    const lock = new AsyncRWLock()
    await expect(
      lock[kind](async () => {
        throw new Error("tool failed")
      })
    ).rejects.toThrow("tool failed")
    await expect(lock.write(async () => "released")).resolves.toBe("released")
  })

  it("detaches abort listeners when queued readers and writers acquire their locks", async () => {
    const lock = new AsyncRWLock()
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const first = lock.write(async () => {
      firstStarted.resolve()
      await releaseFirst.promise
    })
    await firstStarted.promise

    const readerController = new AbortController()
    const writerController = new AbortController()
    const readerRemove = vi.spyOn(readerController.signal, "removeEventListener")
    const writerRemove = vi.spyOn(writerController.signal, "removeEventListener")
    const reader = lock.read(async () => "read", readerController.signal)
    const writer = lock.write(async () => "write", writerController.signal)
    releaseFirst.resolve()
    await Promise.all([first, reader, writer])
    expect(readerRemove).toHaveBeenCalledWith("abort", expect.any(Function))
    expect(writerRemove).toHaveBeenCalledWith("abort", expect.any(Function))
  })
})

describe("AsyncSemaphore", () => {
  it("removes a canceled waiter and immediately settles its promise", async () => {
    const semaphore = new AsyncSemaphore(1)
    const started = deferred()
    const release = deferred()
    const first = semaphore.run(async () => {
      started.resolve()
      await release.promise
    })
    await started.promise

    const controller = new AbortController()
    const handler = vi.fn(async () => "must not launch")
    const pending = semaphore.run(handler, controller.signal)
    const canceled = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    controller.abort()
    await canceled
    expect(handler).not.toHaveBeenCalled()
    release.resolve()
    await first
    await expect(semaphore.run(async () => "slot available")).resolves.toBe("slot available")
  })

  it("releases a granted slot when cancellation wins before dispatch", async () => {
    const semaphore = new AsyncSemaphore(1)
    const controller = new AbortController()
    const handler = vi.fn(async () => "must not launch")
    const pending = semaphore.run(handler, controller.signal)
    const canceled = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    controller.abort()
    await canceled
    expect(handler).not.toHaveBeenCalled()
    await expect(semaphore.run(async () => "slot available")).resolves.toBe("slot available")
  })

  it("releases a queued slot granted just before cancellation", async () => {
    const semaphore = new AsyncSemaphore(1)
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const first = semaphore.run(async () => {
      firstStarted.resolve()
      await releaseFirst.promise
    })
    await firstStarted.promise

    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, "removeEventListener")
    const handler = vi.fn(async () => "must not launch")
    const queued = semaphore.run(handler, controller.signal)
    const canceled = expect(queued).rejects.toMatchObject({ name: "AbortError" })
    const abortInGrantWindow = releaseFirst.promise.then(() =>
      Promise.resolve().then(() => {
        expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function))
        controller.abort()
      })
    )
    releaseFirst.resolve()
    await Promise.all([first, abortInGrantWindow, canceled])
    expect(handler).not.toHaveBeenCalled()
    await expect(semaphore.run(async () => "slot available")).resolves.toBe("slot available")
  })

  it("releases its slot when the handler fails", async () => {
    const semaphore = new AsyncSemaphore(1)
    await expect(
      semaphore.run(async () => {
        throw new Error("subagent failed")
      })
    ).rejects.toThrow("subagent failed")
    await expect(semaphore.run(async () => "slot available")).resolves.toBe("slot available")
  })
})
