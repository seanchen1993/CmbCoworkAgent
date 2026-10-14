import { describe, expect, it } from "vitest"
import type { Message } from "../types"
import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  hasIndependentProviderRenderId,
  normalizeAppendedMessageIds,
  normalizeCompleteMessageIds,
  normalizeCompleteSnapshotMessageIds
} from "../../../shared/message-role-collision"
import type { FunctionConversationTranscriptStamp } from
  "../../../shared/mods/v2/conversation-transcript"
import {
  mergeLiveStreamCommitMessagesDetailed,
  normalizeAppendedLiveStreamMessageIds,
  resolveCommittedLiveStreamMessages,
  type LiveStreamMessage
} from "./live-stream-messages"
import { liveStreamMessageToStoreMessage } from "./live-stream-transcript"

const provider = "reused-display-provider"
function assistant(occurrence: number, id = `supplied-display-${occurrence}`): Message {
  return { id, role: "assistant", provider_source_id: provider,
    provider_occurrence: occurrence, content: `reply ${occurrence}`,
    created_at: new Date("2026-10-06T00:00:00Z") }
}
function live(message: Message): LiveStreamMessage & { id: string } {
  return { ...message, type: message.role === "user" ? "human" : "ai" }
}
function stamp(uuid: string, conversationId = "actual-display-conversation"):
  FunctionConversationTranscriptStamp {
  return { conversationId, branchId: "main", uuid, sequence: 1, door: "response",
    messageType: "assistant", origin: { kind: "model", model: "display-model" } }
}

describe("independent supplied provider render IDs", () => {
  it.each([1, 2, 3])("preserves supplied ID for a new occurrence %s", occurrence => {
    const baseline = Array.from({ length: occurrence - 1 }, (_, index) => assistant(index + 1))
    const incoming = assistant(occurrence)
    expect(normalizeAppendedMessageIds(baseline, [incoming])[0]).toEqual(incoming)
    expect(normalizeAppendedLiveStreamMessageIds(baseline.map(live), [live(incoming)])[0])
      .toEqual(live(incoming))
    expect(normalizeCompleteMessageIds([...baseline, incoming]).map(message => message.id))
      .toEqual([...baseline, incoming].map(message => message.id))
  })

  it("keeps six unmarked supplied IDs through live conversion, commit, resolution and snapshots", () => {
    let committed: Message[] = []
    for (let occurrence = 1; occurrence <= 6; occurrence++) {
      const user: Message = { id: `display-user-${occurrence}`, role: "user",
        content: "next request", created_at: new Date("2026-10-06T00:00:00Z") }
      const incoming = assistant(occurrence)
      const normalized = normalizeAppendedLiveStreamMessageIds(committed.map(live),
        [live(user), live(incoming)])
      const pending = normalized.map(message => {
        if (!message.id) throw Error("SUPPLIED_DISPLAY_ID_REQUIRED")
        return liveStreamMessageToStoreMessage({ ...message, id: message.id })
      })
      const merged = mergeLiveStreamCommitMessagesDetailed(committed, pending)
      const resolved = resolveCommittedLiveStreamMessages(merged.messages, merged.resolvedIncoming)
      expect(resolved.unresolved).toEqual([])
      expect(resolved.resolved.map(message => message.id)).toEqual([user.id, incoming.id])
      expect(resolved.resolved[1].function_row).toBeUndefined()
      expect(resolved.resolved[1].provider_source_id).toBe(provider)
      expect(resolved.resolved[1].provider_occurrence).toBe(occurrence)
      committed = merged.messages
      const firstReplayExpected = committed.map(message => {
        const complete = { ...message }
        if (!pending.some(incomingMessage => incomingMessage.id === message.id)) return complete
        return { ...complete, provider_source_id: message.provider_source_id ?? message.id,
          provider_occurrence: message.provider_occurrence ?? 1,
          content_priority: 0, reasoning: undefined, tool_call_id: undefined, name: undefined,
          status: undefined, is_error: undefined }
      })
      const replayed = mergeLiveStreamCommitMessagesDetailed(committed, pending).messages
      expect(replayed).toStrictEqual(firstReplayExpected)
      expect(mergeLiveStreamCommitMessagesDetailed(replayed, pending).messages).toStrictEqual(replayed)
      committed = replayed
      expect(normalizeCompleteSnapshotMessageIds(committed, committed)).toEqual(committed)
    }
    expect(committed.filter(message => message.role === "assistant").map(message => message.id))
      .toEqual(Array.from({ length: 6 }, (_, index) => assistant(index + 1).id))
  })

  it("replays an existing tuple onto its established nonnative display ID", () => {
    const baseline = [assistant(1), assistant(2)]
    const replay = assistant(2, "another-observed-display-id")
    expect(normalizeAppendedMessageIds(baseline, [replay])[0].id).toBe(baseline[1].id)
    expect(normalizeAppendedLiveStreamMessageIds(baseline.map(live), [live(replay)])[0].id)
      .toBe(baseline[1].id)
  })

  it("retains collision handling when the supplied ID is occupied by another tuple", () => {
    const occupied = { ...assistant(1), provider_source_id: "other-display-provider" }
    const incoming = assistant(2, occupied.id)
    for (const normalized of [normalizeAppendedMessageIds([occupied], [incoming])[0],
      normalizeAppendedLiveStreamMessageIds([live(occupied)], [live(incoming)])[0]]) {
      expect(normalized.id).not.toBe(occupied.id)
      expect(normalized.provider_source_id).toBe(provider)
      expect(normalized.provider_occurrence).toBe(2)
    }
  })

  it("keeps bare provider ID reuse on the existing duplicate algorithm", () => {
    const baseline = [assistant(1, provider)]
    const incoming = assistant(2, provider)
    const expected = buildMessageSameRoleDuplicateId(provider, "assistant", 2)
    expect(normalizeAppendedMessageIds(baseline, [incoming])[0].id).toBe(expected)
    expect(normalizeAppendedLiveStreamMessageIds(baseline.map(live), [live(incoming)])[0].id)
      .toBe(expected)
  })

  it.each([buildMessageRoleCollisionId(provider, "assistant"),
    buildMessageSameRoleDuplicateId(provider, "assistant", 2)])(
    "does not treat an encoded ID as an independently supplied ID: %s", id => {
      expect(hasIndependentProviderRenderId(assistant(2, id))).toBe(false)
      const normalized = normalizeAppendedMessageIds([assistant(1)], [assistant(2, id)])[0]
      expect(normalized.id).toBe(buildMessageSameRoleDuplicateId(provider, "assistant", 2))
    })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not recognize an invalid occurrence %s", occurrence => {
      expect(hasIndependentProviderRenderId(assistant(occurrence))).toBe(false)
    })

  it("requires own data tuple fields and does not read their accessors", () => {
    const inherited = Object.create({ provider_source_id: provider, provider_occurrence: 2 },
      { id: { value: "inherited-display-id", enumerable: true } }) as Message
    expect(hasIndependentProviderRenderId(inherited)).toBe(false)
    let reads = 0
    const accessor = assistant(2)
    Object.defineProperty(accessor, "provider_source_id", {
      get() { reads++; throw Error("DISPLAY_SOURCE_GETTER_MUST_NOT_RUN") }
    })
    expect(hasIndependentProviderRenderId(accessor)).toBe(false)
    expect(reads).toBe(0)
    expect(hasIndependentProviderRenderId({ ...assistant(2), provider_source_id: " " })).toBe(false)
  })

  it("does not merge incompatible native stamps merely because a provider tuple matches", () => {
    const baseline = { ...assistant(2), function_row: stamp(assistant(2).id) }
    const incoming = { ...assistant(2), function_row: stamp(assistant(2).id, "foreign-conversation") }
    const shared = normalizeAppendedMessageIds([baseline], [incoming])[0]
    const normalized = normalizeAppendedLiveStreamMessageIds([live(baseline)], [live(incoming)])[0]
    expect(shared.id).not.toBe(baseline.id)
    expect(normalized.id).not.toBe(baseline.id)
    if (!normalized.id) throw Error("REJECTED_DISPLAY_ID_REQUIRED")
    expect(liveStreamMessageToStoreMessage({ ...normalized, id: normalized.id }).function_row_invalid)
      .toBe(true)
  })

  it("rejects an invalid native marker as a candidate and preserves a compatible exact replay", () => {
    const baseline = { ...assistant(2), function_row: stamp(assistant(2).id) }
    const compatible = normalizeAppendedLiveStreamMessageIds([live(baseline)], [live(baseline)])[0]
    expect(compatible.id).toBe(baseline.id)
    const invalid = { ...assistant(2), function_row_invalid: true as const }
    const rejected = normalizeAppendedLiveStreamMessageIds([live(baseline)], [live(invalid)])[0]
    expect(rejected.id).not.toBe(baseline.id)
    expect(rejected.function_row_invalid).toBe(true)
  })
})
