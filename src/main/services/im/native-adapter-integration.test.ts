import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it } from "vitest"
import { openNativeSqliteDatabase } from "../../db/native-sqlite-adapter"
import type { RemoteImEventV1, RemoteImReplyV1 } from "../../../shared/im-gateway-contract"
import { ImConversationStateStore } from "./conversation-state"
import { ImEventStore } from "./event-store"
import type { ImPersistenceDependencies } from "./persistence"
import { ImRemoteApprovalAuditStore } from "./remote-approval-audit-store"
import { ImRemoteGrantStore } from "./remote-grant-store"
import { ensureImServiceSchema } from "./schema"
import { ImSelectionContextStore } from "./selection-context"

/**
 * Production wiring regression: the main database is a NativeSqliteAdapter
 * (node:sqlite) with a sql.js-compatible surface, while these stores are typed
 * against sql.js. Any method the adapter does not implement (for example
 * getRowsModified()) fails only at runtime, and the sql.js-based unit tests
 * never expose it. Keep this suite green whenever the adapter or a store
 * changes its database call surface.
 */
const TEMPORARY_DIRECTORIES: string[] = []

function temporaryDatabasePath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "cmb-im-native-"))
  TEMPORARY_DIRECTORIES.push(directory)
  return join(directory, name)
}

afterEach(() => {
  while (TEMPORARY_DIRECTORIES.length > 0) {
    rmSync(TEMPORARY_DIRECTORIES.pop()!, { recursive: true, force: true })
  }
})

function openProductionWiredStore() {
  const database = openNativeSqliteDatabase(
    temporaryDatabasePath("im-native.sqlite"),
    "ImNativeIntegrationTest"
  ).database
  ensureImServiceSchema(database)
  const dependencies: ImPersistenceDependencies = {
    getDatabase: () => database,
    markDirty: () => undefined,
    // Production IM singletons use the shared flushStrict, which checkpoints
    // the WAL; mirror that here so a checkpoint regression is also caught.
    flushStrict: async () => database.flush("FULL"),
    now: Date.now
  }
  return {
    database,
    eventStore: new ImEventStore(dependencies),
    conversations: new ImConversationStateStore(dependencies),
    selection: new ImSelectionContextStore(dependencies),
    grants: new ImRemoteGrantStore(dependencies),
    audit: new ImRemoteApprovalAuditStore(dependencies)
  }
}

function seedInboxEvent(overrides: Partial<RemoteImEventV1> = {}): RemoteImEventV1 {
  const now = Date.now()
  return {
    schemaVersion: 1,
    eventId: `event-${now}-${Math.random()}`,
    platformMessageId: `platform-${now}-${Math.random()}`,
    principalId: "principal-1",
    conversationKey: "conv-1",
    conversationSeq: 1,
    message: { type: "text", text: "hi" },
    occurredAt: new Date(now).toISOString(),
    lease: {
      id: `lease-${now}`,
      expiresAt: new Date(now + 60_000).toISOString()
    },
    ...overrides
  }
}

function seedReply(eventId: string): RemoteImReplyV1 {
  return {
    schemaVersion: 1,
    deliveryId: `delivery-${eventId}`,
    eventId,
    conversationKey: "conv-1",
    idempotencyKey: `idem-${eventId}`,
    segment: { index: 0, count: 1 },
    message: { type: "text", content: "done" }
  }
}

describe("IM stores on the native sqlite adapter", () => {
  it("recovers built-in robot state (recoverAndStart sequence) on the native adapter", async () => {
    const { database, eventStore, selection } = openProductionWiredStore()
    // Seed like the production snapshot: terminal events across conversations.
    database.run(
      `INSERT INTO im_events (
         event_id, platform_message_id, conversation_key, conversation_seq, principal_id,
         lease_id, lease_expires_at, permit_state, message_text, occurred_at, state,
         retryable, created_at, updated_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'revoked', ?, ?, 'completed', 0, ?, ?, ?)`,
      [
        "evt-completed",
        "pm-1",
        "conv-1",
        1,
        "principal-1",
        "lease-1",
        Date.now() + 60_000,
        "hello",
        Date.now(),
        Date.now(),
        Date.now(),
        Date.now()
      ]
    )
    database.run(
      `INSERT INTO im_events (
         event_id, platform_message_id, conversation_key, conversation_seq, principal_id,
         lease_id, lease_expires_at, permit_state, message_text, occurred_at, state,
         retryable, created_at, updated_at, finished_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'revoked', ?, ?, 'cancelled', 0, ?, ?, ?)`,
      [
        "evt-cancelled",
        "pm-2",
        "conv-2",
        1,
        "principal-1",
        "lease-2",
        Date.now() + 60_000,
        "bye",
        Date.now(),
        Date.now(),
        Date.now(),
        Date.now()
      ]
    )

    // Exact production sequence from BuiltinRobotManager.startNow ->
    // ImUnifiedBotService.recoverAndStart.
    await selection.clearAll()
    await eventStore.cleanupExpiredTerminalData()
    await eventStore.recoverInterruptedOutbox()
    await eventStore.recoverInterruptedEvents()

    const summary = eventStore.getStatusSummary()
    expect(summary.eventCounts).toEqual({ completed: 1, cancelled: 1 })
    expect(summary.pendingOutboxCount).toBe(0)
    expect(eventStore.getEvent("evt-completed")?.state).toBe("completed")
    expect(eventStore.getEvent("evt-cancelled")?.state).toBe("cancelled")
  })

  it("runs a full remote event lifecycle on the native adapter", async () => {
    const { eventStore, conversations } = openProductionWiredStore()
    await conversations.ensureConversation({
      conversationKey: "conv-1",
      principalId: "principal-1"
    })
    await conversations.registerTarget(
      "conv-1",
      {
        kind: "inbox",
        targetId: "target-1",
        threadId: "thread-1",
        workspacePath: "/tmp/workspace"
      },
      { activate: true }
    )

    const event = seedInboxEvent()
    const received = await eventStore.receiveEvent(event, {
      kind: "inbox",
      targetId: "target-1",
      threadId: "thread-1",
      workspacePath: "/tmp/workspace"
    })
    expect(received.duplicate).toBe(false)
    expect(received.event.state).toBe("received")

    const queued = await eventStore.queueEvent(event.eventId)
    expect(queued.state).toBe("queued")

    const permit = await eventStore.recordExecutionPermit({
      eventId: event.eventId,
      leaseId: event.lease.id,
      expiresAt: event.lease.expiresAt
    })
    expect(permit.permitState).toBe("acquired")

    const executing = await eventStore.beginExecution(event.eventId, "run-1")
    expect(executing.state).toBe("executing")

    const completed = await eventStore.completeEvent(
      event.eventId,
      [seedReply(event.eventId)],
      "ok"
    )
    expect(completed.state).toBe("completed")
    expect(completed.permitState).toBe("revoked")
    expect(eventStore.getStatusSummary().eventCounts).toEqual({ completed: 1 })
    expect(eventStore.listOutbox("pending")).toHaveLength(1)
  })

  it("writes remote grants and approval audits on the native adapter", async () => {
    const { grants, audit } = openProductionWiredStore()
    const grant = await grants.enableThreadGrant({
      route: { principalId: "principal-1", conversationKey: "conv-1" },
      threadId: "thread-1",
      title: "t"
    })
    expect(grant.threadId).toBe("thread-1")
    expect(grants.getThreadGrant("thread-1")?.state).toBe("active")

    const revoked = await grants.revokeThreadGrant("thread-1")
    expect(revoked?.state).toBe("revoked")

    const entry = await audit.record({
      requestId: "req-1",
      toolCallId: "tool-1",
      threadId: "thread-1",
      principalId: "principal-1",
      conversationKey: "conv-1",
      operation: "bash",
      decision: "approve",
      summary: "ok"
    })
    expect(entry.requestId).toBe("req-1")
    await audit.remove("req-1")
    expect(audit.getByRequestId("req-1")).toBeNull()
  })
})
