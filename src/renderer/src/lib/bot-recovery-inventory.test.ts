import { expect, it } from "vitest"
import { pendingBotRecoveryIdentities } from "./bot-recovery-inventory"

const index = (names: string[]) => ({
  length: names.length,
  key: (at: number) => names[at] ?? null
})
const key = (id: string) => `cmb:bot-recovery:pending:${id}`

it("enumerates original identities without reading payloads or requiring a current task", () => {
  expect(pendingBotRecoveryIdentities(index(["other", key("run-b"), key("run-a")]))).toEqual({
    ids: ["run-a", "run-b"],
    hasMore: false
  })
})
it("bounds the visible inventory without losing remaining original keys", () => {
  const names = Array.from({ length: 70 }, (_, i) => key(`run-${String(i).padStart(2, "0")}`))
  expect(pendingBotRecoveryIdentities(index(names))).toEqual({
    ids: names.slice(0, 64).map((name) => name.slice("cmb:bot-recovery:pending:".length)),
    hasMore: true
  })
  expect(pendingBotRecoveryIdentities(index(names.slice(64)))).toEqual({
    ids: names.slice(64).map((name) => name.slice("cmb:bot-recovery:pending:".length)),
    hasMore: false
  })
})
it.each(["", "invalid/identity", "x".repeat(161)])("retains an invalid original index %s", (id) => {
  expect(() => pendingBotRecoveryIdentities(index([key(id)]))).toThrow("索引")
})
it("refuses oversized and unavailable storage without trying to repair it", () => {
  let reads = 0
  expect(() =>
    pendingBotRecoveryIdentities({
      length: 4097,
      key: () => {
        reads++
        return null
      }
    })
  ).toThrow("过多")
  expect(reads).toBe(0)
  expect(() =>
    pendingBotRecoveryIdentities({
      get length(): number {
        throw Error("unavailable")
      },
      key: () => null
    })
  ).toThrow("unavailable")
})
