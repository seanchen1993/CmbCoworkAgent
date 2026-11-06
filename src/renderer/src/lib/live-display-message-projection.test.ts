import { describe, expect, it, vi } from "vitest"
import { createLiveDisplayMessageProjector } from "./live-display-message-projection"
import type { LiveStreamMessage } from "./live-stream-messages"
import type { Message } from "../types"
import { functionConversationTranscriptFields } from "../../../shared/mods/v2/conversation-transcript"

describe("live display native identity", () => {
  const message = (): LiveStreamMessage => ({
    id: "native-U", type: "ai", content: "answer", provider_source_id: "provider-P",
    provider_occurrence: 2,
    function_row: { conversationId: "conversation", branchId: "branch", uuid: "native-U",
      sequence: 2, door: "response", messageType: "assistant",
      origin: { kind: "model", model: "test" } }
  })

  it("preserves provider occurrence and the native stamp on initial and content-only frames", () => {
    const project = createLiveDisplayMessageProjector()
    const original = message()
    for (const input of [original, { ...original, content: "answer extended" }]) {
      const result = project([], [input]).messages[0]
      expect(result.id).toBe("native-U")
      expect(result.provider_source_id).toBe("provider-P")
      expect(result.provider_occurrence).toBe(2)
      expect(result.function_row).toEqual(original.function_row)
    }
  })

  it("retains an invalid marker so a later display merge cannot treat it as legacy", () => {
    const incoming = { ...message(), function_row_invalid: true as const }
    const result = createLiveDisplayMessageProjector()([], [incoming]).messages[0]
    expect(functionConversationTranscriptFields(result, result.id, result.role))
      .toEqual({ function_row_invalid: true })
  })

  it.each(["provider", "occurrence", "stamp", "invalid"])(
    "invalidates display structure when only %s identity metadata changes", field => {
      const project = createLiveDisplayMessageProjector()
      const original = message()
      const baseline: Message[] = []
      const initial = project(baseline, [original])
      const before = initial.structureVersion
      const changed: LiveStreamMessage = {
        ...original,
        ...(field === "provider" ? { provider_source_id: "other-provider" } : {}),
        ...(field === "occurrence" ? { provider_occurrence: 3 } : {}),
        ...(field === "stamp" ? {
          function_row: { ...original.function_row!, branchId: "other-branch" }
        } : {}),
        ...(field === "invalid" ? { function_row_invalid: true as const } : {})
      }
      expect(project(baseline, [changed]).structureVersion).toBeGreaterThan(before)
    }
  )

  it("keeps display structure stable for a content-only update", () => {
    const project = createLiveDisplayMessageProjector()
    const original = message()
    const baseline: Message[] = []
    const first = project(baseline, [original])
    const next = project(baseline, [{ ...original, content: "answer extended" }])
    expect(next.structureVersion).toBe(first.structureVersion)
    expect(next.contentVersion).toBeGreaterThan(first.contentVersion)
  })

  it("retains fallback dates while their rows remain live or in resident history", () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1000)
      const project = createLiveDisplayMessageProjector()
      const live: LiveStreamMessage = { id: "retained", type: "ai", content: "answer" }
      const baseline: Message[] = []
      const first = project(baseline, [live]).messages[0]
      vi.setSystemTime(2000)
      const next = project(baseline, [{ ...live, content: "answer extended" },
        { id: "next", type: "ai", content: "next answer" }])
      expect(next.messages[0].created_at).toBe(first.created_at)
      const history = [first]
      project(history, [])
      vi.setSystemTime(3000)
      expect(project(history, [live]).messages[0].created_at).toBe(first.created_at)
    } finally { vi.useRealTimers() }
  })

  it("releases fallback dates after their rows leave both live output and resident history", () => {
    vi.useFakeTimers()
    try {
      const project = createLiveDisplayMessageProjector()
      const baseline: Message[] = []
      for (let turn = 0; turn < 64; turn++) {
        vi.setSystemTime(1000 + turn)
        project(baseline, [{ id: `turn-${turn}`, type: "ai", content: "answer" }])
      }
      const last = project(baseline, [{ id: "last", type: "ai", content: "answer" }]).messages[0]
      project([last], [])
      project(baseline, [])
      vi.setSystemTime(5000)
      for (const id of ["turn-0", "turn-63", "last"]) {
        expect(project(baseline, [{ id, type: "ai", content: "answer" }]).messages[0]
          .created_at.getTime()).toBe(5000)
      }
      const authoritative = new Date(900)
      expect(project(baseline, [{ id: "last", type: "ai", content: "answer",
        start_at: authoritative }]).messages[0].created_at).toBe(authoritative)
    } finally { vi.useRealTimers() }
  })

  it("invalidates structure when provenance is added or removed at the same ID", () => {
    const project = createLiveDisplayMessageProjector()
    const baseline: Message[] = []
    const original = message()
    const raw = { ...original, function_row: undefined }
    const first = project(baseline, [raw])
    const kept = project(baseline, [original])
    expect(kept.structureVersion).toBeGreaterThan(first.structureVersion)
    const removed = project(baseline, [raw])
    expect(removed.structureVersion).toBeGreaterThan(kept.structureVersion)
  })
})
