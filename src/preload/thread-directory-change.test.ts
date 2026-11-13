import { EventEmitter } from "node:events"
import { expect, it, vi } from "vitest"
import { subscribeThreadDirectoryChanges } from "./thread-directory-change"

const hint = {
  threadId: "thread",
  kind: "transcript",
  workspacePath: "/workspace",
  incarnation: { token: "native-incarnation", legacyCreatedAt: 1 }
}

it("forwards a copied complete scope and unsubscribes the same event listener", () => {
  const ipc = new EventEmitter(),
    callback = vi.fn()
  const stop = subscribeThreadDirectoryChanges(ipc, callback)
  ipc.emit("threads:changed", {}, hint)
  expect(callback).toHaveBeenCalledExactlyOnceWith(hint)
  const value = callback.mock.calls[0][0]
  expect(value).not.toBe(hint)
  expect(Object.isFrozen(value)).toBe(true)
  expect(Object.isFrozen(value.incarnation)).toBe(true)
  stop()
  ipc.emit("threads:changed", {}, hint)
  expect(callback).toHaveBeenCalledTimes(1)
  expect(ipc.listenerCount("threads:changed")).toBe(0)
})

it.each([
  undefined,
  null,
  {},
  { threadId: "thread" },
  { ...hint, kind: "unknown" },
  { ...hint, incarnation: undefined }
])("preserves zero-argument legacy fallback for %j", (value) => {
  const ipc = new EventEmitter(),
    callback = vi.fn()
  subscribeThreadDirectoryChanges(ipc, callback)
  ipc.emit("threads:changed", {}, value)
  expect(callback.mock.calls).toEqual([[]])
})

it("does not invoke accessors or interpret the scope as authority", () => {
  const ipc = new EventEmitter(),
    callback = vi.fn(),
    read = vi.fn(() => "scope")
  const malformed = { ...hint }
  Object.defineProperty(malformed, "workspacePath", { enumerable: true, get: read })
  subscribeThreadDirectoryChanges(ipc, callback)
  ipc.emit("threads:changed", {}, malformed)
  expect(callback.mock.calls).toEqual([[]])
  expect(read).not.toHaveBeenCalled()
})

it("forwards own undefined workspace while preserving the missing-field fallback", () => {
  const ipc = new EventEmitter(), callback = vi.fn()
  const stop = subscribeThreadDirectoryChanges(ipc, callback)
  const ordinary = { ...hint, workspacePath: undefined }
  ipc.emit("threads:changed", {}, ordinary)
  expect(callback).toHaveBeenCalledExactlyOnceWith(ordinary)
  expect(Object.hasOwn(callback.mock.calls[0][0], "workspacePath")).toBe(true)
  const { workspacePath: _workspace, ...missing } = ordinary
  ipc.emit("threads:changed", {}, missing)
  expect(callback.mock.calls[1]).toEqual([])
  stop()
})
