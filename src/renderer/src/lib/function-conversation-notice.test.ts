import { describe, expect, it } from "vitest"
import type { Thread } from "@/types"
import type { FunctionConversationNoticeEvent } from
  "../../../shared/mods/v2/conversation-notice"
import { functionConversationNoticeForThread as admit } from "./function-conversation-notice"

function fixture() {
  const thread: Thread = { thread_id: "actual-thread", created_at: new Date(10),
    updated_at: new Date(10), status: "busy", metadata: { cmb_thread_incarnation: "actual-token" } }
  const event: FunctionConversationNoticeEvent = { threadId: thread.thread_id,
    incarnation: { token: "actual-token", legacyCreatedAt: 10 },
    message: { id: "actual-notice", role: "system", content: "Literal /goal @file notice",
      created_at: new Date(12), function_row: { conversationId: "actual-conversation",
        branchId: "actual-branch", uuid: "actual-notice", sequence: 1, door: "note",
        messageType: "system", origin: { kind: "plugin", name: "actual-component" } } } }
  return { thread, event }
}

describe("actual committed notice display admission", () => {
  it("accepts the original native row without changing message identity or starting a user turn", () => {
    const { thread, event } = fixture()
    expect(admit(event, thread)).toBe(event.message)
    expect(admit(event, thread)?.role).toBe("system")
    expect(admit(event, thread)?.content).toBe("Literal /goal @file notice")
  })

  it("rejects an old same-ID thread event even after recreation in the same millisecond", () => {
    const { thread, event } = fixture()
    expect(admit(event, { ...thread, metadata: { cmb_thread_incarnation: "replacement" } }))
      .toBeUndefined()
    expect(admit(event, { ...thread, thread_id: "another-live-thread" })).toBeUndefined()
    expect(admit(event, undefined)).toBeUndefined()
  })

  it("uses the exact persisted creation date only for genuinely legacy rows", () => {
    const { thread, event } = fixture()
    const legacy = { ...thread, metadata: {} }
    const old = { ...event, incarnation: { token: null, legacyCreatedAt: 10 } }
    expect(admit(old, legacy)).toBe(event.message)
    expect(admit({ ...old, incarnation: { ...old.incarnation, legacyCreatedAt: 11 } }, legacy))
      .toBeUndefined()
    expect(admit(old, thread)).toBeUndefined()
    expect(admit(event, legacy)).toBeUndefined()
  })

  it("rejects unverified markers, copied UUIDs, user notes and ordinary old notices", () => {
    const { thread, event } = fixture()
    const stamp = event.message.function_row!
    for (const message of [
      { ...event.message, function_row_invalid: true as const },
      { ...event.message, id: "another-native-uuid" },
      { ...event.message, role: "user" as const, function_row: { ...stamp,
        messageType: "user" as const, isMeta: true as const } },
      { ...event.message, function_row: undefined }
    ]) expect(admit({ ...event, message }, thread)).toBeUndefined()
  })
})
