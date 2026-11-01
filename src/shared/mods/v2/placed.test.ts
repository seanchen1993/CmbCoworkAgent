import { expect, it } from "vitest"
import { placeFunctionRows, type FunctionPlacedEntry } from "./placed"

const row = (anchor: FunctionPlacedEntry["anchor"], sequence = 1): FunctionPlacedEntry => ({
  requestId: "row-" + sequence,
  id: "same",
  plugin: "source",
  anchor,
  sequence
})
it("keeps cards after their exact native message when new messages arrive", () => {
  const messages = [
    { id: "a", role: "assistant" },
    { id: "b", role: "user" }
  ]
  const entries = [
    row({ kind: "after-message", id: "a", role: "assistant" }, 2),
    row({ kind: "start" })
  ]
  const actual = placeFunctionRows(messages, [0, 1], entries, true)
  expect(actual.after.get(0)?.[0].requestId).toBe("row-2")
  expect(actual.after.has(1)).toBe(false)
  expect(actual.start).toHaveLength(1)
})
it("does not guess missing/released/hidden/ambiguous native anchors or expose a start row in a history gap", () => {
  const entry = row({
    kind: "after-message",
    id: "old",
    role: "assistant",
    providerSourceId: "provider",
    providerOccurrence: 2
  })
  expect(
    placeFunctionRows([{ id: "new", role: "assistant" }], [0], [entry], false).after.size
  ).toBe(0)
  expect(placeFunctionRows([{ id: "old", role: "assistant" }], [], [entry], true).after.size).toBe(
    0
  )
  const ambiguous = [0, 1].map((i) => ({
    id: "alias" + i,
    role: "assistant",
    provider_source_id: "provider",
    provider_occurrence: 2
  }))
  expect(placeFunctionRows(ambiguous, [0, 1], [entry], true).after.size).toBe(0)
  expect(placeFunctionRows([], [], [row({ kind: "start" })], false).start).toEqual([])
})
