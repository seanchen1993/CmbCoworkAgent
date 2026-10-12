import { afterEach, expect, it } from "vitest"
import {
  pendingLocalToolPolicy,
  localToolAnswerPending,
  pendingLocalToolAnswers,
  localToolRecoveryRecord,
  discardRetiredLocalToolRecord
} from "./bot-local-tool-permission-pending"
const records = new Map<string, string>()
afterEach(() => {
  records.clear()
  Reflect.deleteProperty(globalThis, "localStorage")
})
const input = {
  botId: null,
  targetId: "a".repeat(64),
  dataEpoch: "initial",
  revision: 1,
  nonce: "once",
  choice: "ask" as const
}
function storage() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return records.size
      },
      key: (index: number) => [...records.keys()][index] ?? null,
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, raw: string) => {
        records.set(key, raw)
      },
      removeItem: (key: string) => {
        records.delete(key)
      }
    }
  })
}
it("reopening retains the exact policy target/revision/nonce; restore cannot overwrite or acknowledge it", () => {
  storage()
  pendingLocalToolPolicy.remember(input)
  expect(pendingLocalToolPolicy.read(null, "initial")).toEqual(input)
  expect(pendingLocalToolPolicy.inspect(null, "replacement").kind).toBe("obsolete")
  expect(() =>
    pendingLocalToolPolicy.remember({ ...input, dataEpoch: "replacement", nonce: "new" })
  ).toThrow()
  expect(pendingLocalToolPolicy.acknowledge({ ...input, nonce: "new" })).toBe(false)
  expect(pendingLocalToolPolicy.acknowledge(input)).toBe(true)
})
it("four-choice answers keep original card authority and cannot contaminate another card", () => {
  storage()
  const pending = localToolAnswerPending("card-one"),
    answer = {
      botId: null,
      targetId: input.targetId,
      dataEpoch: input.dataEpoch,
      id: "card-one",
      revision: 1,
      nonce: "answer",
      resolution: "never" as const
    }
  pending.remember(answer)
  expect(localToolAnswerPending("card-one").read(null, "initial")).toEqual(answer)
  expect(localToolAnswerPending("card-two").read(null, "initial")).toBeNull()
  expect(() => pending.remember({ ...answer, id: "card-two" })).toThrow()
  expect(pending.discard(null, "initial", "different raw")).toBe(false)
})
it("a corrupt original request blocks new policy changes and requires exact recovery bytes", () => {
  storage()
  records.set("cmb:bot-local-tool-policy:pending", "{broken")
  const present = pendingLocalToolPolicy.inspect(null, "initial")
  expect(present.kind).toBe("corrupt")
  expect(() => pendingLocalToolPolicy.remember(input)).toThrow()
  expect(pendingLocalToolPolicy.discard(null, "initial", "{broken")).toBe(true)
  pendingLocalToolPolicy.remember(input)
})

it("only keeps bounded lightweight pending identities and never auto-retries during inventory", () => {
  storage()
  localToolAnswerPending("one").remember({
    botId: null,
    targetId: input.targetId,
    dataEpoch: input.dataEpoch,
    id: "one",
    revision: 1,
    nonce: "original",
    resolution: "allow-once"
  })
  expect(pendingLocalToolAnswers()).toEqual(["one"])
  for (let i = 1; i <= 64; i++) records.set(`cmb:bot-local-tool-answer:more-${i}`, "corrupt")
  expect(() => pendingLocalToolAnswers()).toThrow("过多")
})

it("physical target retirement allows only user-confirmed exact archive, never a current or changed request", () => {
  storage()
  pendingLocalToolPolicy.remember(input)
  const record = pendingLocalToolPolicy.inspect(null, "initial")
  expect(localToolRecoveryRecord(record, "c".repeat(64)).kind).toBe("obsolete")
  if (record.kind !== "valid") throw new Error("fixture missing record")
  expect(
    discardRetiredLocalToolRecord(pendingLocalToolPolicy, "initial", input.targetId, record.raw)
  ).toBe(false)
  expect(
    discardRetiredLocalToolRecord(pendingLocalToolPolicy, "initial", "c".repeat(64), "changed")
  ).toBe(false)
  expect(
    discardRetiredLocalToolRecord(pendingLocalToolPolicy, "initial", "c".repeat(64), record.raw)
  ).toBe(true)
})
