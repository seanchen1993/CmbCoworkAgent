import { expect, it } from "vitest"
import { createBotDownloadStartStore } from "./bot-artifact-download-starts"
const source = {
  artifactId: "artifact-1",
  conversationId: "conversation-1",
  sha256: "a".repeat(64),
  size: 20,
  dataEpoch: "epoch-1"
}
const label = { name: "report.txt", mime: "text/plain" }
function fixture() {
  let raw: string | null = null
  const storage = {
    getItem: () => raw,
    setItem: (_key: string, next: string) => {
      raw = next
    },
    removeItem: () => {
      raw = null
    }
  }
  return {
    store: createBotDownloadStartStore(() => storage),
    storage,
    setRaw(value: string) {
      raw = value
    }
  }
}
it("reopens the same exact start nonce and never replaces another immutable version", () => {
  const f = fixture(),
    original = f.store.remember(source, label)
  const reopened = createBotDownloadStartStore(() => f.storage)
  expect(reopened.remember(source, label)).toEqual(original)
  const next = reopened.remember({ ...source, sha256: "b".repeat(64) }, label)
  expect(next.nonce).not.toBe(original.nonce)
  f.store.forget(original)
  expect(reopened.inspect()).toEqual({ kind: "valid", items: [next] })
})
it("blocks before IPC when storage cannot retain intent and never hides corrupt or unreadable records", () => {
  const f = fixture()
  f.setRaw("{broken")
  expect(f.store.inspect().kind).toBe("corrupt")
  expect(() => f.store.remember(source, label)).toThrow()
  const inaccessible = createBotDownloadStartStore(() => {
    throw new Error("unavailable")
  })
  expect(inaccessible.inspect().kind).toBe("unreadable")
  expect(() => inaccessible.remember(source, label)).toThrow()
  const writeFailure = createBotDownloadStartStore(() => ({
    ...f.storage,
    getItem: () => null,
    setItem: () => {
      throw new Error("no space")
    }
  }))
  expect(() => writeFailure.remember(source, label)).toThrow()
})
it("does not delete a changed valid request or a new corrupt record during explicit repair", () => {
  const f = fixture()
  f.setRaw("{broken-one")
  f.setRaw("{broken-two")
  expect(f.store.discardCorrupt("{broken-one")).toBe(false)
  expect(f.store.discardCorrupt("{broken-two")).toBe(true)
  const fresh = f.store.remember(source, label)
  expect(f.store.discardCorrupt("{broken-two")).toBe(false)
  expect(() => f.store.forget({ ...fresh, name: "changed" })).toThrow()
  expect(f.store.inspect()).toEqual({ kind: "valid", items: [fresh] })
})
it("limits the lightweight ledger to sixteen unknown starts and retains every nonce", () => {
  const f = fixture()
  for (let i = 0; i < 16; i++) f.store.remember({ ...source, artifactId: `artifact-${i}` }, label)
  expect(() => f.store.remember({ ...source, artifactId: "overflow" }, label)).toThrow()
  const record = f.store.inspect()
  expect(record.kind === "valid" && record.items.length).toBe(16)
})
