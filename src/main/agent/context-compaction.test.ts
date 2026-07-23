import type { RunnableConfig } from "@langchain/core/runnables"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CONTEXT_COMPACTION_MODEL_TAG,
  CONTEXT_COMPACTION_NO_STREAM_TAG,
  type ContextCompactionLifecycleEvent
} from "../../shared/context-compaction-events"
import {
  configureContextCompactionModel,
  ContextCompactionCallbackHandler
} from "./context-compaction"

class FakeConfigurableModel {
  withConfig(config: RunnableConfig): { config: RunnableConfig } {
    return { config }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("context compaction model binding", () => {
  it("hides summary output and emits a complete lifecycle", () => {
    const events: ContextCompactionLifecycleEvent[] = []
    const configured = configureContextCompactionModel(new FakeConfigurableModel(), (event) =>
      events.push(event)
    ) as { config: RunnableConfig }

    expect(configured.config.tags).toEqual([
      CONTEXT_COMPACTION_NO_STREAM_TAG,
      CONTEXT_COMPACTION_MODEL_TAG
    ])
    const callbacks = configured.config.callbacks
    expect(Array.isArray(callbacks)).toBe(true)
    const handler = (callbacks as ContextCompactionCallbackHandler[])[0]

    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(240)
    handler.handleChatModelStart({}, [], "summary-run")
    handler.handleLLMEnd({}, "summary-run")

    expect(events).toEqual([
      { id: "summary-run", phase: "started", startedAt: 100 },
      {
        id: "summary-run",
        phase: "completed",
        startedAt: 100,
        finishedAt: 240
      }
    ])
  })

  it("emits a failed terminal event and ignores duplicate finishes", () => {
    const events: ContextCompactionLifecycleEvent[] = []
    const handler = new ContextCompactionCallbackHandler((event) => events.push(event))
    vi.spyOn(Date, "now").mockReturnValueOnce(10).mockReturnValueOnce(20)

    handler.handleChatModelStart({}, [], "failed-run")
    handler.handleLLMError(new Error("summary failed"), "failed-run")
    handler.handleLLMEnd({}, "failed-run")

    expect(events).toEqual([
      { id: "failed-run", phase: "started", startedAt: 10 },
      { id: "failed-run", phase: "failed", startedAt: 10, finishedAt: 20 }
    ])
  })

  it("keeps background summarization silent without adding a UI callback", () => {
    const configured = configureContextCompactionModel(new FakeConfigurableModel()) as {
      config: RunnableConfig
    }
    expect(configured.config.tags).toContain(CONTEXT_COMPACTION_NO_STREAM_TAG)
    expect(configured.config.callbacks).toBeUndefined()
  })
})
