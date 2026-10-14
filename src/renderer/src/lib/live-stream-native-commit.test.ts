import { describe, expect, it } from "vitest"
import type { Message } from "../types"
import { mergeLiveStreamCommitMessagesDetailed, resolveCommittedLiveStreamMessages }
  from "./live-stream-messages"

const raw = (occurrence = 1): Message => ({
  id: "P", role: "assistant", content: "partial", created_at: new Date(1),
  provider_source_id: "P", provider_occurrence: occurrence
})
const native = (id = "U", occurrence = 1): Message => ({
  ...raw(occurrence), id, content: "kept",
  function_row: { conversationId: "conversation", branchId: "branch", uuid: id,
    sequence: occurrence, door: "response", messageType: "assistant",
    origin: { kind: "model", model: "test" } }
})

describe("native commit identity", () => {
  it("replaces the temporary occurrence and ignores its later raw content", () => {
    const kept = native()
    const first = mergeLiveStreamCommitMessagesDetailed([raw()], [kept])
    expect(first.messages).toEqual([kept])
    const late = mergeLiveStreamCommitMessagesDetailed(first.messages, [raw()])
    expect(late.messages).toEqual([kept])
    expect(late.resolvedIncoming).toEqual([kept])
    expect(mergeLiveStreamCommitMessagesDetailed([kept], [{ ...kept, content: "forged" }])
      .messages).toEqual([kept])
  })
  it("does not merge a different role, occurrence, or native UUID", () => {
    for (const earlier of [raw(2), { ...raw(), role: "user" as const }, native("V")]) {
      const result = mergeLiveStreamCommitMessagesDetailed([earlier], [native()])
      expect(result.messages).toHaveLength(2)
      expect(result.messages).toContainEqual(earlier)
      expect(result.messages).toContainEqual(native())
    }
  })
  it("does not select one of multiple provider occurrence candidates", () => {
    const result = mergeLiveStreamCommitMessagesDetailed([raw(), { ...raw(), id: "Q" }], [native()])
    expect(result.messages.map(message => message.id)).toEqual(["P", "Q", "U"])
  })
  it.each([
    { ...native(), id: "wrong" },
    { ...native(), provider_source_id: "foreign" },
    { ...native(), provider_occurrence: 2 },
    { ...native(), function_row_invalid: true as const },
    { ...native(), function_row: { ...native().function_row!, branchId: "foreign" } }
  ])("never resolves a rejected native input to the good row (%#)", incoming => {
    const result = mergeLiveStreamCommitMessagesDetailed([native()], [incoming])
    expect(result.messages).toEqual([native()])
    const resolved = resolveCommittedLiveStreamMessages(result.messages, result.resolvedIncoming)
    expect(resolved.resolved).toEqual([])
    expect(resolved.unresolved).toHaveLength(1)
  })
  it("preserves ordinary user/assistant batch anchoring after a native prefix", () => {
    const prefix = { ...native(), provider_source_id: "native-provider" }
    const user: Message = { id: "user", role: "user", content: "question", created_at: new Date(1) }
    const before = [user, raw()]
    const batch = [{ ...user, content: "question" }, { ...raw(), content: "complete" }]
    const ordinary = mergeLiveStreamCommitMessagesDetailed(before, batch)
    const prefixed = mergeLiveStreamCommitMessagesDetailed([prefix, ...before], batch)
    expect(prefixed.messages).toEqual([prefix, ...ordinary.messages])
    expect(prefixed.resolvedIncoming).toEqual(ordinary.resolvedIncoming)
  })
  it("replaces a temporary row from the same incoming batch", () => {
    expect(mergeLiveStreamCommitMessagesDetailed([], [raw(), native()]).messages)
      .toEqual([native()])
  })
  it.each([
    { ...raw(), id: "U", provider_occurrence: 2 },
    { ...raw(), id: "U", provider_source_id: "foreign" },
    { ...raw(), id: "U", role: "user" as const }
  ])("rejects an unmarked collision with a kept UUID (%#)", incoming => {
    const result = mergeLiveStreamCommitMessagesDetailed([native()], [incoming])
    expect(result.messages).toEqual([native()])
    expect(resolveCommittedLiveStreamMessages(result.messages, result.resolvedIncoming).resolved)
      .toEqual([])
  })
})
