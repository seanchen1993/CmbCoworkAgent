import { describe, expect, it } from "vitest"

import {
  CONTEXT_COMPACTION_MODEL_TAG,
  isContextCompactionStreamPayload,
  parseContextCompactionLifecycleEvent
} from "./context-compaction-events"

describe("context compaction events", () => {
  it("parses lifecycle events and rejects incomplete terminal events", () => {
    expect(
      parseContextCompactionLifecycleEvent({
        id: " run-1 ",
        phase: "completed",
        startedAt: 100,
        finishedAt: 250
      })
    ).toEqual({ id: "run-1", phase: "completed", startedAt: 100, finishedAt: 250 })

    expect(
      parseContextCompactionLifecycleEvent({
        id: "run-1",
        phase: "failed",
        startedAt: 100
      })
    ).toBeNull()
    expect(parseContextCompactionLifecycleEvent({ phase: "started", startedAt: 100 })).toBeNull()
  })

  it("recognizes only explicitly tagged compaction message chunks", () => {
    expect(
      isContextCompactionStreamPayload("messages", [
        { kwargs: { content: "private summary" } },
        { tags: [CONTEXT_COMPACTION_MODEL_TAG] }
      ])
    ).toBe(true)
    expect(
      isContextCompactionStreamPayload("messages", [
        { kwargs: { content: "ordinary response" } },
        { tags: [] }
      ])
    ).toBe(false)
    expect(isContextCompactionStreamPayload("values", { messages: [] })).toBe(false)
  })
})
