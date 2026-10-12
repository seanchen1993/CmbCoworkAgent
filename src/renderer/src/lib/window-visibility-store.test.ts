import { expect, it, vi } from "vitest"
import type { WindowVisibilitySnapshot } from "../../../shared/window-visibility"
import { createWindowVisibilityStore } from "./window-visibility-store"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(withNative = true) {
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" })
  const add = vi.spyOn(document, "addEventListener")
  const remove = vi.spyOn(document, "removeEventListener")
  const reads: ReturnType<typeof deferred<WindowVisibilitySnapshot>>[] = []
  const callbacks: ((value: WindowVisibilitySnapshot) => void)[] = []
  const unsubscribe = vi.fn()
  const native = {
    read: vi.fn(() => {
      const request = deferred<WindowVisibilitySnapshot>()
      reads.push(request)
      return request.promise
    }),
    onChanged: vi.fn((callback: (value: WindowVisibilitySnapshot) => void) => {
      callbacks.push(callback)
      return unsubscribe
    })
  }
  const store = createWindowVisibilityStore(
    document as unknown as Document,
    withNative ? native : undefined
  )
  const documentVisible = (visible: boolean) => {
    document.visibilityState = visible ? "visible" : "hidden"
    document.dispatchEvent(new Event("visibilitychange"))
  }
  return { document, documentVisible, add, remove, reads, callbacks, unsubscribe, native, store }
}

it("requires both native and document visibility even when browser focus is emulated", async () => {
  const f = fixture()
  const stop = f.store.subscribe(vi.fn())
  expect(f.store.getSnapshot()).toBe(false)
  f.reads[0].resolve({ revision: 0, visible: true })
  await Promise.resolve()
  expect(f.store.getSnapshot()).toBe(true)
  f.callbacks[0]({ revision: 1, visible: false })
  expect(f.document.visibilityState).toBe("visible")
  expect(f.store.getSnapshot()).toBe(false)
  f.documentVisible(false)
  f.callbacks[0]({ revision: 2, visible: true })
  expect(f.store.getSnapshot()).toBe(false)
  f.documentVisible(true)
  expect(f.store.getSnapshot()).toBe(true)
  stop()
})

it("does not let a stale initial read or malformed event undo a newer hide", async () => {
  const f = fixture()
  const changed = vi.fn()
  const stop = f.store.subscribe(changed)
  f.callbacks[0]({ revision: 3, visible: false })
  f.reads[0].resolve({ revision: 2, visible: true })
  await Promise.resolve()
  for (const value of [
    null,
    {},
    { revision: -1, visible: true },
    { revision: 4, visible: 1 },
    { revision: 3, visible: true },
    { revision: Infinity, visible: true }
  ]) {
    f.callbacks[0](value as WindowVisibilitySnapshot)
  }
  expect(f.store.getSnapshot()).toBe(false)
  expect(changed).toHaveBeenCalledTimes(1)
  stop()
})

it("shares one listener, cleans up the last subscription, and ignores retired reads/events", async () => {
  const f = fixture()
  const changed = vi.fn()
  const stopFirst = f.store.subscribe(changed)
  const stopSecond = f.store.subscribe(changed)
  expect(f.native.read).toHaveBeenCalledTimes(1)
  expect(f.add).toHaveBeenCalledTimes(1)
  stopFirst()
  stopFirst()
  f.callbacks[0]({ revision: 1, visible: true })
  expect(changed).toHaveBeenCalledTimes(1)
  expect(f.unsubscribe).not.toHaveBeenCalled()
  stopSecond()
  expect(f.unsubscribe).toHaveBeenCalledTimes(1)
  expect(f.remove).toHaveBeenCalledTimes(1)
  const stopNew = f.store.subscribe(changed)
  expect(f.native.read).toHaveBeenCalledTimes(2)
  f.reads[0].resolve({ revision: 99, visible: true })
  f.callbacks[0]({ revision: 100, visible: true })
  await Promise.resolve()
  expect(f.store.getSnapshot()).toBe(false)
  f.reads[1].resolve({ revision: 2, visible: true })
  await Promise.resolve()
  expect(f.store.getSnapshot()).toBe(true)
  stopNew()
  expect(f.unsubscribe).toHaveBeenCalledTimes(2)
  expect(f.remove).toHaveBeenCalledTimes(2)
})

it("stays suspended after a failed initial read and recovers on a native event without retry polling", async () => {
  const f = fixture()
  const stop = f.store.subscribe(vi.fn())
  f.reads[0].reject(new Error("Window unavailable"))
  await Promise.resolve()
  expect(f.store.getSnapshot()).toBe(false)
  f.callbacks[0]({ revision: 1, visible: true })
  expect(f.store.getSnapshot()).toBe(true)
  expect(f.native.read).toHaveBeenCalledTimes(1)
  stop()
})

it("supports the browser-only surface using document visibility", () => {
  const f = fixture(false)
  const changed = vi.fn()
  const stop = f.store.subscribe(changed)
  expect(f.store.getSnapshot()).toBe(true)
  f.documentVisible(false)
  expect(f.store.getSnapshot()).toBe(false)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(f.native.read).not.toHaveBeenCalled()
  stop()
})
