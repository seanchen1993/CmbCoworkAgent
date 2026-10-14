import { describe, expect, it } from "vitest"
import { normalizeMessageRoleCollisionIds } from "./message-role-collision"
import {
  functionConversationTranscriptFields,
  type FunctionConversationTranscriptStamp
} from "./mods/v2/conversation-transcript"

const stamp = (uuid: string, sequence = 1): FunctionConversationTranscriptStamp => ({
  conversationId: "conversation", branchId: "branch", uuid, sequence,
  door: "response", messageType: "assistant", origin: { kind: "model", model: "test" }
})
const sealed = (id = "native-U", occurrence = 1) => ({
  id, role: "assistant", provider_source_id: "provider-P", provider_occurrence: occurrence,
  content: "answer", function_row: stamp(id, occurrence)
})

describe("role collision normalization preserves sealed native identity", () => {
  it("does not rewrite a native UUID to the earlier provider stream ID", () => {
    const incoming = sealed()
    const [result] = normalizeMessageRoleCollisionIds([
      { id: "provider-P", role: "assistant", provider_source_id: "provider-P", content: "ans" }
    ], [incoming])
    expect(result).toEqual(incoming)
    expect(functionConversationTranscriptFields(result, result.id, result.role))
      .toEqual({ function_row: incoming.function_row })
  })

  it("does not borrow a sealed baseline UUID for an unmarked provider echo", () => {
    const incoming = { id: "provider-P", role: "assistant", provider_source_id: "provider-P" }
    expect(normalizeMessageRoleCollisionIds([sealed()], [incoming])).toEqual([incoming])
  })

  it("keeps different sealed occurrences and their roles separate", () => {
    const first = sealed(), second = sealed("native-V", 2)
    const otherRole = { id: "provider-P", role: "user", content: "question" }
    expect(normalizeMessageRoleCollisionIds([first], [second, otherRole]))
      .toEqual([second, otherRole])
    expect(normalizeMessageRoleCollisionIds([], [first, second])).toEqual([first, second])
  })

  it.each([
    { ...sealed(), id: "wrong-id" },
    { ...sealed(), function_row: { ...stamp("native-U"), sequence: 0 } },
    { ...sealed(), function_row_invalid: true }
  ])("does not repair an invalid native marker by remapping an ID (%#)", (incoming) => {
    const [result] = normalizeMessageRoleCollisionIds([sealed()], [incoming])
    expect(result.id).toBe(incoming.id)
    expect(functionConversationTranscriptFields(result, result.id, result.role))
      .toEqual({ function_row_invalid: true })
  })

  it("flags a conflicting stamp or role at the same UUID without inventing another UUID", () => {
    for (const incoming of [
      { ...sealed(), function_row: { ...stamp("native-U"), branchId: "other-branch" } },
      sealed()
    ]) {
      const baseline = incoming.function_row.branchId === "other-branch"
        ? sealed() : { id: "native-U", role: "user" }
      const [result] = normalizeMessageRoleCollisionIds([baseline], [incoming])
      expect(result.id).toBe("native-U")
      expect(functionConversationTranscriptFields(result, result.id, result.role))
        .toEqual({ function_row_invalid: true })
    }
  })

  it("preserves ordinary cross-role normalization", () => {
    const baseline = [{ id: "provider-P", role: "user" }]
    const first = normalizeMessageRoleCollisionIds(baseline, [{ id: "provider-P", role: "assistant" }])
    expect(first[0].id).not.toBe("provider-P")
    expect(normalizeMessageRoleCollisionIds([...baseline, ...first], [
      { id: "provider-P", role: "assistant", content: "updated" }
    ])[0].id).toBe(first[0].id)
  })
})
