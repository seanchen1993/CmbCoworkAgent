import { expect, it } from "vitest"
import { prepareLegacyMessageTimeEntries } from "./legacy-message-times"

const message = (
  messageId: string,
  providerSourceId: string | null = null,
  providerOccurrence: number | null = null
) => ({ messageId, providerSourceId, providerOccurrence })
it("keeps the original direct-ID/provider/duplicate-order precedence and timestamp rules", () => {
  const messages = [
    message("direct"),
    message("first", "provider", 1),
    message("second", "provider", 2),
    message("duplicate")
  ]
  const source = JSON.stringify([
    {
      direct: { start_at: "2026-11-09T00:00:00Z", end_at: 0 },
      provider: { start_at: 10, end_at: 20 }
    },
    [
      { id: "duplicate", start_at: 1 },
      { id: "duplicate", start_at: 2 }
    ],
    null,
    null
  ])
  const read = prepareLegacyMessageTimeEntries(source, messages, () => {})
  expect(read(0)).toEqual({
    messageId: "direct",
    startAt: Date.parse("2026-11-09T00:00:00Z"),
    endAt: null
  })
  expect(read(1)).toEqual({ messageId: "first", startAt: 10, endAt: 20 })
  expect(read(2)).toEqual({ messageId: "second", startAt: null, endAt: null })
  expect(read(3)).toEqual({ messageId: "duplicate", startAt: null, endAt: null })
})
it("allows positional times only for a complete order without any identity matches", () => {
  const source = JSON.stringify([{}, [{ start_at: 1 }, { start_at: 2 }], null, null])
  const read = prepareLegacyMessageTimeEntries(source, [message("a"), message("b")], () => {})
  expect(read(0).startAt).toBe(1)
  expect(read(1).startAt).toBe(2)
  const incomplete = prepareLegacyMessageTimeEntries(source, [message("a")], () => {})
  expect(incomplete(0).startAt).toBeNull()
})
it("keeps cancellation observable during the original order traversal", () => {
  let calls = 0
  expect(() =>
    prepareLegacyMessageTimeEntries(
      JSON.stringify([
        {},
        Array.from({ length: 130 }, (_, index) => ({ id: `m${index}`, start_at: index })),
        null,
        null
      ]),
      [message("m0")],
      () => {
        if (++calls === 3) throw Error("actual cancel")
      }
    )
  ).toThrow("actual cancel")
})
