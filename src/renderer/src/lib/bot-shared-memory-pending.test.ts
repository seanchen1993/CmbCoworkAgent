import { expect, it } from "vitest"
import {
  createPendingSharedMemoryStore,
  type PendingSharedMemoryMutation
} from "./bot-shared-memory-pending"
function fixture() {
  const values = new Map<string, string>(),
    storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
      removeItem: (key: string) => {
        values.delete(key)
      }
    },
    store = createPendingSharedMemoryStore(() => storage),
    input: PendingSharedMemoryMutation = {
      dataEpoch: "initial",
      nonce: "once",
      operation: "save",
      request: {
        botId: "bot",
        botRevision: 1,
        scope: "user",
        nonce: "once",
        expectedDataEpoch: "initial",
        text: "fact"
      }
    }
  return { values, storage, store, input }
}
it("preserves a single exact shared intent across create/edit/delete and reconstruction", () => {
  const f = fixture()
  f.store.remember(f.input)
  const same = createPendingSharedMemoryStore(() => f.storage)
  expect(same.inspect("bot", "user", "initial")).toMatchObject({ kind: "valid", input: f.input })
  expect(() =>
    same.remember({
      ...f.input,
      nonce: "other",
      request: { ...f.input.request, nonce: "other", text: "changed" }
    })
  ).toThrow("尚未确认")
  expect(() =>
    same.remember({
      dataEpoch: "initial",
      nonce: "delete",
      operation: "delete",
      request: {
        botId: "bot",
        botRevision: 1,
        scope: "user",
        expectedDataEpoch: "initial",
        nonce: "delete",
        id: "existing",
        revision: 1
      }
    })
  ).toThrow("尚未确认")
})
it("retains obsolete raw bytes and refuses replacement intent until exact review/archive", () => {
  const f = fixture()
  f.store.remember(f.input)
  const old = f.store.inspect("bot", "user", "replacement")
  expect(old.kind).toBe("obsolete")
  expect(() =>
    f.store.remember({
      ...f.input,
      dataEpoch: "replacement",
      request: { ...f.input.request, expectedDataEpoch: "replacement" }
    })
  ).toThrow("恢复前")
  if (old.kind !== "obsolete") throw new Error("missing original")
  expect(f.store.discard("bot", "user", "replacement", `${old.raw} `)).toBe(false)
  expect(f.store.discard("bot", "user", "replacement", old.raw)).toBe(true)
})
it("acknowledges only the full matching input; cleanup failure retains original request", () => {
  const f = fixture()
  f.store.remember(f.input)
  expect(
    f.store.acknowledge({ ...f.input, request: { ...f.input.request, text: "different" } })
  ).toBe(false)
  f.storage.removeItem = () => {
    throw new Error("storage unavailable")
  }
  expect(f.store.acknowledge(f.input)).toBe(false)
  expect(f.store.inspect("bot", "user", "initial").kind).toBe("valid")
})
it("does not trust malformed/mismatched epoch nonce payloads or overwrite unreadable storage", () => {
  const f = fixture()
  expect(() => f.store.remember({ ...f.input, nonce: "mismatch" })).toThrow()
  const key = "bot-shared-memory-pending:bot:user"
  f.values.set(key, '{"broken":true}')
  expect(f.store.inspect("bot", "user", "initial").kind).toBe("corrupt")
  expect(() => f.store.remember(f.input)).toThrow("无法核对")
  f.storage.getItem = () => {
    throw new Error("unreadable")
  }
  expect(f.store.inspect("bot", "user", "initial").kind).toBe("unreadable")
})
it("keeps project and user authority separate and preserves the original operation key", () => {
  const f = fixture()
  f.store.remember(f.input)
  expect(f.store.inspect("bot", "project", "initial").kind).toBe("empty")
  expect(f.values.size).toBe(1)
  expect(f.values.keys().next().value).toBe("bot-shared-memory-pending:bot:user")
})
