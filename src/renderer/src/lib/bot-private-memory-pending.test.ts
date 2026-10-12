import { expect, it } from "vitest"
import {
  createPendingPrivateMemoryStore,
  pendingPrivateMemorySchema,
  type PendingPrivateMemoryMutation
} from "./bot-private-memory-pending"
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
    store = createPendingPrivateMemoryStore(() => storage),
    input: PendingPrivateMemoryMutation = {
      dataEpoch: "initial",
      nonce: "create-once",
      operation: "save",
      request: { botId: "bot", expectedDataEpoch: "initial", nonce: "create-once", text: "fact" }
    }
  return { values, storage, store, input, key: "bot-private-memory-pending:bot" }
}
it("keeps one private editor intent across creation, edit and deletion after reconstruction", () => {
  const f = fixture()
  f.store.remember(f.input)
  const reloaded = createPendingPrivateMemoryStore(() => f.storage)
  expect(reloaded.inspect("bot", "initial")).toMatchObject({ kind: "valid", input: f.input })
  for (const input of [
    {
      ...f.input,
      nonce: "other",
      request: { ...f.input.request, nonce: "other", id: "existing", revision: 1 }
    },
    {
      operation: "delete" as const,
      dataEpoch: "initial",
      nonce: "remove",
      request: {
        botId: "bot",
        expectedDataEpoch: "initial",
        nonce: "remove",
        id: "existing",
        revision: 1
      }
    }
  ])
    expect(() => reloaded.remember(input)).toThrow("尚未确认")
  expect(f.values.size).toBe(1)
})
it("preserves retired bytes until exact archive and refuses a new epoch intent", () => {
  const f = fixture()
  f.store.remember(f.input)
  const old = f.store.inspect("bot", "replacement")
  expect(old.kind).toBe("obsolete")
  expect(() =>
    f.store.remember({
      ...f.input,
      dataEpoch: "replacement",
      request: { ...f.input.request, expectedDataEpoch: "replacement" }
    })
  ).toThrow("恢复前")
  if (old.kind !== "obsolete") throw new Error("missing retired record")
  expect(f.store.discard("bot", "replacement", old.raw + " ")).toBe(false)
  expect(f.store.discard("bot", "replacement", old.raw)).toBe(true)
})
it("clears only the full original request and retains a known ACK when local cleanup fails", () => {
  const f = fixture()
  f.store.remember(f.input)
  expect(
    f.store.acknowledge({ ...f.input, request: { ...f.input.request, text: "changed" } })
  ).toBe(false)
  f.storage.removeItem = () => {
    throw new Error("blocked")
  }
  expect(f.store.acknowledge(f.input)).toBe(false)
  expect(f.store.inspect("bot", "initial").kind).toBe("valid")
})
it("blocks corrupt or unreadable records without overwriting and validates wrapper authority", () => {
  const f = fixture()
  expect(() => f.store.remember({ ...f.input, nonce: "mismatch" })).toThrow()
  expect(() =>
    f.store.remember({ ...f.input, request: { ...f.input.request, expectedDataEpoch: "other" } })
  ).toThrow()
  f.values.set(f.key, '{"broken":true}')
  expect(f.store.inspect("bot", "initial").kind).toBe("corrupt")
  expect(() => f.store.remember(f.input)).toThrow("无法核对")
  f.storage.getItem = () => {
    throw new Error("unreadable")
  }
  expect(f.store.inspect("bot", "initial").kind).toBe("unreadable")
})
it("normalizes draft text before first dispatch and permits the maximum escaped private text within the bounded record", () => {
  const f = fixture(),
    input = pendingPrivateMemorySchema.parse({
      ...f.input,
      request: { ...f.input.request, text: "  fact  " }
    })
  expect(input.request).toMatchObject({ text: "fact" })
  f.store.remember({ ...f.input, request: { ...f.input.request, text: "\u0001".repeat(16000) } })
  expect(f.store.inspect("bot", "initial").kind).toBe("valid")
  expect(f.values.get(f.key)!.length).toBeLessThan(128000)
})
it("keeps different Bot private memory operations isolated without touching existing retry keys", () => {
  const f = fixture()
  f.values.set("bot-memory-retry-pending:bot", "unrelated")
  f.store.remember(f.input)
  expect(f.store.inspect("other", "initial").kind).toBe("empty")
  expect(f.values.get("bot-memory-retry-pending:bot")).toBe("unrelated")
})
