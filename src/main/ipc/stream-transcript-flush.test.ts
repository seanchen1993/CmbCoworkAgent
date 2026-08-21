import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "fs"
import type { Message } from "../types"
import {
  resolveStreamTranscriptFlush,
  type QueuedStreamTranscriptMessage,
  type StreamTranscriptAssistantIdentity
} from "./stream-transcript-flush"
import { buildMessageSameRoleDuplicateId } from "../../shared/message-role-collision"

function queuedMessage(
  input: Partial<QueuedStreamTranscriptMessage> &
    Pick<QueuedStreamTranscriptMessage, "id" | "role" | "content">
): QueuedStreamTranscriptMessage {
  return {
    created_at: new Date("2026-08-21T00:00:00.000Z"),
    streamContentMode: "delta",
    streamToolCallChunks: [],
    ...input
  }
}

function longTranscript(): Message[] {
  const messages: Message[] = []
  for (let index = 0; index < 2_000; index += 1) {
    messages.push(
      {
        id: `history-user-${index}`,
        role: "user",
        content: `question ${index}`,
        created_at: new Date(index * 2)
      },
      {
        id: `history-assistant-${index}`,
        role: "assistant",
        content: `answer ${index}`,
        created_at: new Date(index * 2 + 1)
      }
    )
  }
  messages.push(
    {
      id: "reused-provider-id",
      role: "assistant",
      content: "calling tool",
      tool_calls: [{ id: "call-before-fast-path", name: "lookup", args: {} }],
      created_at: new Date(5_000)
    },
    {
      id: "tool-before-fast-path",
      role: "tool",
      content: "tool result",
      tool_call_id: "call-before-fast-path",
      created_at: new Date(5_001)
    }
  )
  return messages
}

describe("stream transcript flush identity cache", () => {
  it("never falls through from a rejected suffix append to full upsert", () => {
    const source = readFileSync(new URL("./agent.ts", import.meta.url), "utf8")
    const start = source.indexOf("if (resolved.appendTextDelta")
    const end = source.indexOf("if (persistedCount !== messages.length)", start)
    const appendBranch = source.slice(start, end)
    expect(appendBranch).toMatch(/if \(!appendThreadMessageTextDelta[\s\S]*throw new Error/)
    expect(appendBranch).toMatch(/else \{[\s\S]*upsertThreadMessages/)
    expect(appendBranch).not.toMatch(/appendThreadMessageTextDelta[\s\S]*\?\s*1\s*:\s*upsert/)
    expect(source).toMatch(
      /streamTranscriptAssistantIdentities\.delete\(pendingKey\)[\s\S]*requiredSnapshotProviderSourceId/
    )
    expect(source).toMatch(/Stream suffix is waiting for an authoritative assistant snapshot/)
  })
  it("loads a long transcript once, then keeps ordinary chunks on the incremental path", () => {
    const baseline = longTranscript()
    const loadBaselineMessages = vi.fn(() => baseline)
    const first = resolveStreamTranscriptFlush({
      queuedMessages: [
        queuedMessage({ id: "reused-provider-id", role: "assistant", content: "Hel" })
      ],
      loadBaselineMessages
    })

    expect(loadBaselineMessages).toHaveBeenCalledTimes(1)
    expect(first.preserveExistingOrder).toBe(true)
    expect(first.appendTextDelta).toBeUndefined()
    expect(first.messages).toHaveLength(1)
    expect(first.messages[0]).toMatchObject({
      id: buildMessageSameRoleDuplicateId("reused-provider-id", "assistant", 2),
      provider_source_id: "reused-provider-id",
      provider_occurrence: 2
    })
    expect(first.nextAssistantIdentity).toBeDefined()

    const rejectTranscriptRead = vi.fn((): readonly Message[] => {
      throw new Error("second ordinary chunk attempted to read the full transcript")
    })
    const second = resolveStreamTranscriptFlush({
      queuedMessages: [
        queuedMessage({ id: "reused-provider-id", role: "assistant", content: "lo" })
      ],
      currentAssistantIdentity: first.nextAssistantIdentity,
      loadBaselineMessages: rejectTranscriptRead
    })

    expect(rejectTranscriptRead).not.toHaveBeenCalled()
    expect(second.preserveExistingOrder).toBe(true)
    expect(second.appendTextDelta).toBe(true)
    expect(second.messages[0]).toMatchObject({
      id: buildMessageSameRoleDuplicateId("reused-provider-id", "assistant", 2),
      provider_source_id: "reused-provider-id",
      provider_occurrence: 2,
      content: "lo"
    })
    expect(second.nextAssistantIdentity?.observedTextPrefix).toBe("Hello")
  })

  it("drops the cached identity at tool boundaries and re-normalizes a reused raw id", () => {
    const baseline = longTranscript()
    const first = resolveStreamTranscriptFlush({
      queuedMessages: [
        queuedMessage({ id: "reused-provider-id", role: "assistant", content: "answer" })
      ],
      loadBaselineMessages: () => baseline
    })
    const boundaryLoader = vi.fn((): readonly Message[] => {
      throw new Error("a targeted tool result should not read the full transcript")
    })
    const toolBoundary = resolveStreamTranscriptFlush({
      queuedMessages: [
        queuedMessage({
          id: "reused-provider-id",
          role: "tool",
          content: "second tool result",
          tool_call_id: "call-after-fast-path"
        })
      ],
      currentAssistantIdentity: first.nextAssistantIdentity,
      loadBaselineMessages: boundaryLoader
    })

    expect(boundaryLoader).not.toHaveBeenCalled()
    expect(toolBoundary.preserveExistingOrder).toBe(true)
    expect(toolBoundary.appendTextDelta).toBeUndefined()
    expect(toolBoundary.nextAssistantIdentity).toBeUndefined()

    const durableAfterTool = [...baseline, ...first.messages, ...toolBoundary.messages]
    const postToolLoader = vi.fn(() => durableAfterTool)
    const postToolAssistant = resolveStreamTranscriptFlush({
      queuedMessages: [
        queuedMessage({ id: "reused-provider-id", role: "assistant", content: "new answer" })
      ],
      currentAssistantIdentity: toolBoundary.nextAssistantIdentity,
      loadBaselineMessages: postToolLoader
    })

    expect(postToolLoader).toHaveBeenCalledTimes(1)
    expect(postToolAssistant.preserveExistingOrder).toBe(true)
    expect(postToolAssistant.messages[0]).toMatchObject({
      id: buildMessageSameRoleDuplicateId("reused-provider-id", "assistant", 3),
      provider_source_id: "reused-provider-id",
      provider_occurrence: 3
    })
  })

  it("falls back on resume, raw identity changes, and incompatible snapshots", () => {
    const baseline = longTranscript()
    const initial = resolveStreamTranscriptFlush({
      queuedMessages: [
        queuedMessage({ id: "reused-provider-id", role: "assistant", content: "prefix" })
      ],
      loadBaselineMessages: () => baseline
    })
    const identity = initial.nextAssistantIdentity as StreamTranscriptAssistantIdentity

    const resumeLoader = vi.fn(() => [...baseline, ...initial.messages])
    const resumed = resolveStreamTranscriptFlush({
      queuedMessages: [
        queuedMessage({ id: "reused-provider-id", role: "assistant", content: " resumed" })
      ],
      loadBaselineMessages: resumeLoader
    })
    expect(resumeLoader).toHaveBeenCalledTimes(1)
    expect(resumed.preserveExistingOrder).toBe(true)

    const changedIdentityLoader = vi.fn(() => [...baseline, ...initial.messages])
    const changedIdentity = resolveStreamTranscriptFlush({
      queuedMessages: [
        queuedMessage({ id: "different-provider-id", role: "assistant", content: "new" })
      ],
      currentAssistantIdentity: identity,
      loadBaselineMessages: changedIdentityLoader
    })
    expect(changedIdentityLoader).toHaveBeenCalledTimes(1)
    expect(changedIdentity.preserveExistingOrder).toBe(true)
    expect(changedIdentity.nextAssistantIdentity?.providerSourceId).toBe("different-provider-id")

    const changedStableIdLoader = vi.fn(() => [...baseline, ...initial.messages])
    const changedStableId = resolveStreamTranscriptFlush({
      queuedMessages: [
        queuedMessage({
          id: "unexpected-stable-id",
          provider_source_id: identity.providerSourceId,
          provider_occurrence: identity.providerOccurrence,
          role: "assistant",
          content: " explicit identity change"
        })
      ],
      currentAssistantIdentity: identity,
      loadBaselineMessages: changedStableIdLoader
    })
    expect(changedStableIdLoader).toHaveBeenCalledTimes(1)
    expect(changedStableId.preserveExistingOrder).toBe(true)

    const snapshotLoader = vi.fn(() => [...baseline, ...initial.messages])
    const incompatibleSnapshot = resolveStreamTranscriptFlush({
      queuedMessages: [
        queuedMessage({
          id: "reused-provider-id",
          role: "assistant",
          content: "unrelated replacement",
          streamContentMode: "snapshot"
        })
      ],
      currentAssistantIdentity: identity,
      loadBaselineMessages: snapshotLoader
    })
    expect(snapshotLoader).toHaveBeenCalledTimes(1)
    expect(incompatibleSnapshot.preserveExistingOrder).toBe(true)
    expect(incompatibleSnapshot.appendTextDelta).toBeUndefined()
  })

  it("seeds an explicit provider tuple once, then marks only pure deltas for append", () => {
    const providerSourceId = "explicit-provider-id"
    const stableId = buildMessageSameRoleDuplicateId(providerSourceId, "assistant", 4)
    const rejectBaselineRead = vi.fn((): readonly Message[] => {
      throw new Error("an explicit provider tuple must not read durable history")
    })
    let resolved = resolveStreamTranscriptFlush({
      queuedMessages: [
        queuedMessage({
          id: stableId,
          provider_source_id: providerSourceId,
          provider_occurrence: 4,
          role: "assistant",
          content: "seed"
        })
      ],
      loadBaselineMessages: rejectBaselineRead
    })

    expect(rejectBaselineRead).not.toHaveBeenCalled()
    expect(resolved.appendTextDelta).toBeUndefined()
    expect(resolved.nextAssistantIdentity).toMatchObject({
      stableId,
      providerSourceId,
      providerOccurrence: 4,
      observedTextPrefix: "seed"
    })

    let completeText = "seed"
    for (let index = 0; index < 2_000; index += 1) {
      const delta = `:${index}`
      completeText += delta
      resolved = resolveStreamTranscriptFlush({
        queuedMessages: [
          queuedMessage({
            id: stableId,
            provider_source_id: providerSourceId,
            provider_occurrence: 4,
            role: "assistant",
            content: delta
          })
        ],
        currentAssistantIdentity: resolved.nextAssistantIdentity,
        loadBaselineMessages: rejectBaselineRead
      })
      expect(resolved.appendTextDelta).toBe(true)
    }

    const terminalSnapshot = resolveStreamTranscriptFlush({
      queuedMessages: [
        queuedMessage({
          id: stableId,
          provider_source_id: providerSourceId,
          provider_occurrence: 4,
          role: "assistant",
          content: completeText,
          streamContentMode: "snapshot"
        })
      ],
      currentAssistantIdentity: resolved.nextAssistantIdentity,
      loadBaselineMessages: rejectBaselineRead
    })
    expect(terminalSnapshot.appendTextDelta).toBeUndefined()
    expect(terminalSnapshot.messages[0].content).toBe(completeText)
  })
})
