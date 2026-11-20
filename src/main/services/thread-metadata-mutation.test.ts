import { beforeEach, describe, expect, it, vi } from "vitest"

const dbMock = vi.hoisted(() => {
  let metadata = "{}"
  return {
    getThreadCore: vi.fn(() => ({ thread_id: "thread-race", metadata })),
    updateThread: vi.fn((_threadId: string, updates: { metadata?: string }) => {
      if (typeof updates.metadata === "string") metadata = updates.metadata
      return { thread_id: "thread-race", metadata }
    }),
    setMetadata: (value: Record<string, unknown>) => {
      metadata = JSON.stringify(value)
    },
    getMetadata: (): Record<string, unknown> => JSON.parse(metadata) as Record<string, unknown>
  }
})

vi.mock("../db", () => ({
  getThreadCore: dbMock.getThreadCore,
  updateThread: dbMock.updateThread
}))

import { patchLatestThreadMetadata } from "./thread-metadata"

describe("latest thread metadata mutation", () => {
  beforeEach(() => {
    dbMock.setMetadata({ workspacePath: "A", agentMode: "normal", llmModifiedFiles: ["a"] })
  })

  it("preserves a newer workspace and main-only fields when an old mode request commits", () => {
    // The request captured workspace A, then workspace:set committed B while its guard awaited.
    dbMock.setMetadata({ workspacePath: "B", agentMode: "normal", llmModifiedFiles: ["b"] })
    patchLatestThreadMetadata("thread-race", { set: { agentMode: "coordinator" } })

    expect(dbMock.getMetadata()).toEqual({
      workspacePath: "B",
      agentMode: "coordinator",
      llmModifiedFiles: ["b"]
    })
  })

  it("merges two independently completed owned-field patches", () => {
    patchLatestThreadMetadata("thread-race", { set: { memoryEnabled: true } })
    patchLatestThreadMetadata("thread-race", { set: { model: "provider/model" } })
    expect(dbMock.getMetadata()).toMatchObject({
      workspacePath: "A",
      memoryEnabled: true,
      model: "provider/model"
    })
  })
})
