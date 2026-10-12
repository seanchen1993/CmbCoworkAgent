import { expect, it } from "vitest"
import { createPendingIntroductionQuestionStore } from "./bot-introduction-question-pending"

function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, raw: string) => {
      values.set(key, raw)
    },
    removeItem: (key: string) => {
      values.delete(key)
    }
  }
  const store = createPendingIntroductionQuestionStore(() => storage)
  const input = {
    runId: "opening",
    messageId: "hello",
    revision: 1,
    nonce: "answer",
    dataEpoch: "before",
    answer: '{"status":"cancelled","answers":{}}'
  }
  return { values, storage, store, input, key: "bot-introduction-question-pending:opening" }
}
it("retains the exact first answer across reconstruction and blocks a different answer before confirmation", () => {
  const f = fixture()
  f.store.remember(f.input)
  const reopened = createPendingIntroductionQuestionStore(() => f.storage)
  expect(reopened.inspect("opening", "before")).toMatchObject({ kind: "valid", input: f.input })
  expect(() => reopened.remember({ ...f.input, nonce: "other", answer: "different" })).toThrow(
    "尚未确认"
  )
  expect(reopened.acknowledge({ ...f.input, nonce: "other" })).toBe(false)
  expect(reopened.acknowledge(f.input)).toBe(true)
  expect(reopened.inspect("opening", "before")).toEqual({ kind: "empty" })
})
it("does not overwrite an old workspace, corrupted or unreadable answer record", () => {
  const f = fixture()
  f.store.remember(f.input)
  const raw = f.values.get(f.key)!
  expect(f.store.inspect("opening", "after")).toMatchObject({ kind: "obsolete", raw })
  expect(() => f.store.remember({ ...f.input, dataEpoch: "after" })).toThrow("恢复前")
  f.values.set(f.key, "corrupt")
  expect(() => f.store.remember(f.input)).toThrow("无法核对")
  expect(f.store.discard("opening", "before", "different")).toBe(false)
  expect(f.store.discard("opening", "before", "corrupt")).toBe(true)
  f.storage.getItem = () => {
    throw Error("denied")
  }
  expect(f.store.inspect("opening", "before")).toEqual({ kind: "unreadable" })
  expect(() => f.store.remember(f.input)).toThrow("无法核对")
})
it("preserves a confirmed answer if local cleanup fails instead of inventing a new nonce", () => {
  const f = fixture()
  f.store.remember(f.input)
  f.storage.removeItem = () => {
    throw Error("denied")
  }
  expect(f.store.acknowledge(f.input)).toBe(false)
  expect(f.store.inspect("opening", "before")).toMatchObject({ kind: "valid", input: f.input })
})
