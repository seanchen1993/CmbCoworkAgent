import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  boundedPresence: "empty" as "empty" | "nonempty" | "unknown",
  migrationStatus: null as "migrating" | "complete" | null,
  checkpointPresence: false,
  checkpointPresenceError: null as Error | null,
  readPage: vi.fn()
}))

vi.mock("../db", () => ({
  getBoundedThreadConversationPresence: () => mocks.boundedPresence,
  getLegacyCheckpointMigrationStatus: () => mocks.migrationStatus
}))
vi.mock("../storage", () => ({
  getThreadCheckpointPath: (threadId: string) => `${threadId}.sqlite`
}))
vi.mock("../checkpointer/runtime-projection-client", () => ({
  hasVisibleCheckpointTranscriptInWorker: vi.fn(async () => {
    if (mocks.checkpointPresenceError) throw mocks.checkpointPresenceError
    return mocks.checkpointPresence
  })
}))
vi.mock("../thread-message-hydration/client", () => ({
  readThreadMessagesPageInWorker: mocks.readPage
}))

import {
  readThreadConversationPresenceForMutation,
  resolveThreadConversationPresenceForMutation
} from "./thread-conversation-presence"

beforeEach(() => {
  mocks.boundedPresence = "empty"
  mocks.migrationStatus = null
  mocks.checkpointPresence = false
  mocks.checkpointPresenceError = null
  mocks.readPage.mockReset()
})

describe("thread conversation presence mutation guard", () => {
  it("fails closed for a bounded overflow or interrupted legacy migration", () => {
    expect(
      resolveThreadConversationPresenceForMutation({
        durablePresence: "unknown",
        legacyMigrationStatus: null
      })
    ).toBe("unknown")
    expect(
      resolveThreadConversationPresenceForMutation({
        durablePresence: "empty",
        legacyMigrationStatus: "migrating"
      })
    ).toBe("unknown")
  })

  it("treats a completed migration as authoritative", () => {
    expect(
      resolveThreadConversationPresenceForMutation({
        durablePresence: "empty",
        legacyMigrationStatus: "complete",
        checkpointHasTranscript: true
      })
    ).toBe("empty")
  })

  it("uses the legacy checkpoint whenever no completed migration marker exists", () => {
    const base = {
      durablePresence: "empty" as const,
      legacyMigrationStatus: null
    }
    expect(resolveThreadConversationPresenceForMutation(base)).toBe("unknown")
    expect(
      resolveThreadConversationPresenceForMutation({
        ...base,
        checkpointHasTranscript: true
      })
    ).toBe("nonempty")
    expect(
      resolveThreadConversationPresenceForMutation({
        ...base,
        checkpointHasTranscript: false
      })
    ).toBe("empty")
  })

  it("resolves a bounded overflow with the exact hydration worker", async () => {
    mocks.boundedPresence = "unknown"
    mocks.migrationStatus = "complete"
    mocks.readPage.mockResolvedValue({
      hasVisibleMessages: false,
      legacyCheckpointMigrationStatus: "complete"
    })

    await expect(readThreadConversationPresenceForMutation("long-internal-only")).resolves.toBe(
      "empty"
    )
    expect(mocks.readPage).toHaveBeenCalledWith("long-internal-only", {
      limit: 1,
      byteBudget: 64 * 1024,
      includeVisibleMessagePresence: true
    })
  })

  it("retains exact empty proof while checking a legacy checkpoint", async () => {
    mocks.boundedPresence = "unknown"
    mocks.readPage.mockResolvedValue({
      hasVisibleMessages: false,
      legacyCheckpointMigrationStatus: null
    })

    await expect(readThreadConversationPresenceForMutation("legacy-internal-only")).resolves.toBe(
      "empty"
    )
  })

  it("locks when the exact worker finds a restorable conversation", async () => {
    mocks.boundedPresence = "unknown"
    mocks.readPage.mockResolvedValue({
      hasVisibleMessages: true,
      legacyCheckpointMigrationStatus: null
    })

    await expect(readThreadConversationPresenceForMutation("long-visible")).resolves.toBe(
      "nonempty"
    )
  })

  it("fails closed when checkpoint presence cannot be inspected", async () => {
    const transient = new Error("checkpoint schema is not ready")
    transient.name = "CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY"
    mocks.checkpointPresenceError = transient

    await expect(
      readThreadConversationPresenceForMutation("partial-checkpoint-schema")
    ).rejects.toBe(transient)
  })
})
