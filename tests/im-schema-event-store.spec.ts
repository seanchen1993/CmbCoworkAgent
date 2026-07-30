import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js"
import { parse as parseYaml } from "yaml"
import {
  ImGatewayContractError,
  assertRemoteImAckV1,
  assertRemoteImEventV1,
  assertRemoteImReplyV1,
  type RemoteImEventV1,
  type RemoteImReplyV1
} from "../src/shared/im-gateway-contract"
import {
  ImConversationStateStore,
  type ImTargetSnapshot
} from "../src/main/services/im/conversation-state"
import { ImConversationTurnQueue } from "../src/main/services/im/conversation-turn-queue"
import { ImEventStore, ImEventStoreError } from "../src/main/services/im/event-store"
import { ImIngressSequencer } from "../src/main/services/im/ingress-sequencer"
import type { ImPersistenceDependencies } from "../src/main/services/im/persistence"
import { ensureImServiceSchema } from "../src/main/services/im/schema"
import {
  MockGatewayError,
  MockGatewaySendTimeout,
  MockImGateway
} from "../src/main/services/im/mock-gateway"

const PROJECT_ROOT = resolve(__dirname, "..")

interface TestStoreContext {
  database: SqlJsDatabase
  conversationStore: ImConversationStateStore
  eventStore: ImEventStore
  clock: { now: number }
  persistence: {
    flushCount: number
    dirtyCount: number
    failNextFlush: boolean
  }
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, "contracts/fixtures/v1", name), "utf8"))
}

function eventFixture(index: number, overrides: Partial<RemoteImEventV1> = {}): RemoteImEventV1 {
  return {
    schemaVersion: 1,
    eventId: `event-${index}`,
    platformMessageId: `platform-${index}`,
    principalId: "principal-1",
    conversationKey: "conversation-1",
    conversationSeq: index,
    deviceEpoch: 1,
    message: { type: "text", text: `message-${index}` },
    occurredAt: `2026-07-23T08:00:${String(index).padStart(2, "0")}.000Z`,
    lease: { id: `lease-${index}`, expiresAt: "2026-07-23T09:00:00.000Z" },
    ...overrides
  }
}

function repliesFor(event: RemoteImEventV1, contents: string[]): RemoteImReplyV1[] {
  const deliveryId = `${event.eventId}-reply`
  return contents.map((content, index) => ({
    schemaVersion: 1,
    deliveryId,
    eventId: event.eventId,
    conversationKey: event.conversationKey,
    expectedDeviceEpoch: event.deviceEpoch,
    idempotencyKey: `${deliveryId}:reply:${index}`,
    segment: { index, count: contents.length },
    message: { type: "text", content }
  }))
}

async function createContext(): Promise<TestStoreContext> {
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  ensureImServiceSchema(database)
  const clock = { now: Date.parse("2026-07-23T08:00:00.000Z") }
  const persistence = { flushCount: 0, dirtyCount: 0, failNextFlush: false }
  const dependencies: ImPersistenceDependencies = {
    getDatabase: () => database,
    markDirty: () => {
      persistence.dirtyCount += 1
    },
    flushStrict: async () => {
      persistence.flushCount += 1
      if (persistence.failNextFlush) {
        persistence.failNextFlush = false
        throw new Error("injected flush failure")
      }
    },
    now: () => clock.now
  }
  return {
    database,
    conversationStore: new ImConversationStateStore(dependencies),
    eventStore: new ImEventStore(dependencies),
    clock,
    persistence
  }
}

const inboxTarget: ImTargetSnapshot = {
  kind: "inbox",
  targetId: "target-inbox",
  threadId: "thread-inbox",
  workspacePath: "/managed/inbox"
}

const featureTarget: ImTargetSnapshot = {
  kind: "feature",
  targetId: "target-feature",
  bindingId: "binding-feature",
  projectId: "project-1",
  featureSlug: "feature-a",
  threadId: "thread-feature",
  workspacePath: "/project/workspace"
}

async function seedConversation(context: TestStoreContext): Promise<void> {
  await context.conversationStore.ensureConversation({
    conversationKey: "conversation-1",
    principalId: "principal-1",
    deviceEpoch: 1
  })
  await context.conversationStore.registerTarget("conversation-1", inboxTarget, {
    activate: true
  })
}

function expectContractError(operation: () => void, code: ImGatewayContractError["code"]): void {
  assert.throws(
    operation,
    (error) => error instanceof ImGatewayContractError && error.code === code
  )
}

async function testFrozenContractFixtures(): Promise<void> {
  assertRemoteImEventV1(fixture("remote-event.valid.json"))
  assertRemoteImAckV1(fixture("remote-ack-received.valid.json"))
  assertRemoteImAckV1(fixture("remote-ack-failed.valid.json"))
  assertRemoteImReplyV1(fixture("remote-reply.valid.json"))

  expectContractError(
    () => assertRemoteImEventV1(fixture("remote-event.invalid-extra-field.json")),
    "INVALID_PAYLOAD"
  )
  expectContractError(
    () => assertRemoteImEventV1(fixture("remote-event.invalid-schema-version.json")),
    "SCHEMA_VERSION_UNSUPPORTED"
  )
  expectContractError(
    () => assertRemoteImAckV1(fixture("remote-ack-failed.invalid-missing-retryable.json")),
    "INVALID_PAYLOAD"
  )
  expectContractError(
    () => assertRemoteImReplyV1(fixture("remote-reply.invalid-segment-relation.json")),
    "INVALID_PAYLOAD"
  )

  for (const schemaName of [
    "desktop-gateway-ws-v1.schema.json",
    "remote-im-event-v1.schema.json",
    "remote-im-ack-v1.schema.json",
    "remote-im-reply-v1.schema.json"
  ]) {
    const schema = JSON.parse(
      readFileSync(join(PROJECT_ROOT, "contracts/schema", schemaName), "utf8")
    ) as Record<string, unknown>
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema")
  }
  const asyncApi = parseYaml(
    readFileSync(join(PROJECT_ROOT, "contracts/asyncapi/desktop-gateway-ws-v1.yaml"), "utf8")
  ) as Record<string, unknown>
  assert.equal(asyncApi.asyncapi, "3.0.0")
  assert.equal(
    (
      ((asyncApi.components as Record<string, unknown>).messages as Record<string, unknown>)
        .envelope as Record<string, unknown>
    ).name,
    "DesktopGatewayWsEnvelopeV1"
  )
}

async function testImArchitectureBoundaries(): Promise<void> {
  const imDirectory = join(PROJECT_ROOT, "src/main/services/im")
  const sourceFiles = readdirSync(imDirectory, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts"))
  for (const relativePath of sourceFiles) {
    const source = readFileSync(join(imDirectory, relativePath), "utf8")
    assert(
      !source.includes("createAgentRuntime("),
      `${relativePath} must use the shared standard-turn Runtime factory`
    )
    assert(!source.includes('from "electron"'), `${relativePath} must remain headless`)
  }

  const productionSources = readdirSync(join(PROJECT_ROOT, "src/main"), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts") && !name.endsWith("services/im/mock-gateway.ts"))
  for (const relativePath of productionSources) {
    const source = readFileSync(join(PROJECT_ROOT, "src/main", relativePath), "utf8")
    assert(
      !source.includes("services/im/mock-gateway") && !source.includes("./mock-gateway"),
      `${relativePath} must not wire the fault-injection Mock Gateway into production`
    )
  }
}

async function testSchemaAndTargetLifecycle(): Promise<void> {
  const context = await createContext()
  try {
    const tables = context.database
      .exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'im_%' ORDER BY name")
      .flatMap((result) => result.values.map((row) => String(row[0])))
    assert.deepEqual(tables, [
      "im_conversations",
      "im_events",
      "im_feature_bindings",
      "im_feature_grants",
      "im_remote_approval_audit",
      "im_reply_outbox",
      "im_selection_contexts",
      "im_targets",
      "im_thread_grants"
    ])

    await seedConversation(context)
    assert.deepEqual(context.conversationStore.getActiveTarget("conversation-1"), inboxTarget)
    await context.conversationStore.registerTarget("conversation-1", featureTarget)
    await context.conversationStore.setActiveTarget("conversation-1", featureTarget.targetId)
    assert.deepEqual(context.conversationStore.getActiveTarget("conversation-1"), featureTarget)

    await context.conversationStore.updateTargetState(
      featureTarget.targetId,
      "suspended",
      "missing"
    )
    assert.throws(() => context.conversationStore.getActiveTarget("conversation-1"), {
      message: "Active target is unavailable"
    })
    assert.deepEqual(context.conversationStore.getSelectedTarget("conversation-1"), {
      snapshot: featureTarget,
      state: "suspended",
      suspendReason: "missing"
    })
    await context.conversationStore.updateTargetState(featureTarget.targetId, "active")
    await context.conversationStore.resetForDeviceTakeover("conversation-1", 1, 2)
    assert.equal(context.conversationStore.getActiveTarget("conversation-1"), null)
    assert(
      context.conversationStore
        .listTargets("conversation-1")
        .every((target) => target.state === "revoked")
    )
  } finally {
    context.database.close()
  }
}

async function testRemoteControlSchemaMigrationPreservesV1Rows(): Promise<void> {
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  try {
    database.run(`
      CREATE TABLE im_targets (
        target_id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('inbox', 'feature')),
        thread_id TEXT NOT NULL,
        binding_id TEXT,
        project_id TEXT,
        feature_slug TEXT,
        project_name TEXT,
        feature_title TEXT,
        workspace_path TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'suspended', 'revoked')),
        suspend_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(conversation_key, thread_id),
        UNIQUE(binding_id)
      )
    `)
    database.run(
      `INSERT INTO im_targets (
         target_id, conversation_key, kind, thread_id, binding_id, project_id, feature_slug,
         project_name, feature_title, workspace_path, state, suspend_reason, created_at, updated_at
       ) VALUES (?, ?, 'feature', ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, 1)`,
      [
        "legacy-target",
        "legacy-conversation",
        "legacy-thread",
        "legacy-binding",
        "legacy-project",
        "legacy-feature",
        "旧项目",
        "旧 Feature",
        "/legacy/workspace"
      ]
    )
    database.run(`
      CREATE TABLE im_selection_contexts (
        token TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('project', 'feature')),
        candidates_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
    database.run(
      "INSERT INTO im_selection_contexts VALUES ('legacy-selection', 'legacy-conversation', 'project', '[]', 2, 1)"
    )

    ensureImServiceSchema(database)

    const target = database.exec(
      "SELECT kind, thread_id, grant_id, grant_version FROM im_targets WHERE target_id = 'legacy-target'"
    )[0]?.values[0]
    assert.deepEqual(target, ["feature", "legacy-thread", null, null])
    database.run(
      `INSERT INTO im_targets (
         target_id, conversation_key, kind, thread_id, binding_id, grant_id, grant_version,
         project_id, feature_slug, project_name, feature_title, thread_title, workspace_path,
         state, suspend_reason, created_at, updated_at
       ) VALUES ('thread-target', 'legacy-conversation', 'thread', 'desktop-thread', NULL,
                 'grant-1', 1, NULL, NULL, NULL, NULL, '桌面会话', '/workspace',
                 'active', NULL, 2, 2)`
    )
    database.run(
      "INSERT INTO im_selection_contexts VALUES ('remote-selection', 'legacy-conversation', 'remote_target', '[]', 3, 2)"
    )
    assert.equal(
      database.exec("SELECT COUNT(*) FROM im_selection_contexts")[0]?.values[0]?.[0],
      2
    )
  } finally {
    database.close()
  }
}

async function testDurableDedupAndImmutableSnapshot(): Promise<void> {
  const context = await createContext()
  try {
    await seedConversation(context)
    const remoteEvent = eventFixture(1)
    const received = await context.eventStore.receiveEvent(remoteEvent, inboxTarget)
    assert.equal(received.duplicate, false)
    assert.equal(received.event.state, "received")
    assert.equal(context.persistence.flushCount, 3, "conversation, target, and received each flush")
    await context.eventStore.queueEvent(remoteEvent.eventId)

    await context.conversationStore.registerTarget("conversation-1", featureTarget, {
      activate: true
    })
    const redelivery = {
      ...remoteEvent,
      lease: { id: "lease-redelivery", expiresAt: "2026-07-23T09:05:00.000Z" },
      redelivered: true
    }
    const duplicate = await context.eventStore.receiveEvent(redelivery, featureTarget)
    assert.equal(duplicate.duplicate, true)
    assert.deepEqual(duplicate.event.targetSnapshot, inboxTarget, "redelivery keeps first snapshot")
    assert.equal(
      duplicate.event.leaseId,
      "lease-redelivery",
      "pre-permit redelivery may refresh lease"
    )
    assert.equal(context.eventStore.listConversationEvents("conversation-1").length, 1)

    await assert.rejects(
      () =>
        context.eventStore.receiveEvent(
          { ...eventFixture(2), platformMessageId: remoteEvent.platformMessageId },
          featureTarget
        ),
      (error) => error instanceof ImEventStoreError && error.code === "EVENT_IDENTITY_CONFLICT"
    )
  } finally {
    context.database.close()
  }
}

async function testPermitStateMachineAndAtomicOutbox(): Promise<void> {
  const context = await createContext()
  try {
    await seedConversation(context)
    const remoteEvent = eventFixture(1)
    await context.eventStore.receiveEvent(remoteEvent, inboxTarget)
    await context.eventStore.queueEvent(remoteEvent.eventId)
    await assert.rejects(
      () => context.eventStore.beginExecution(remoteEvent.eventId, "run-1"),
      (error) => error instanceof ImEventStoreError && error.code === "PERMIT_REQUIRED"
    )
    await context.eventStore.recordExecutionPermit({
      eventId: remoteEvent.eventId,
      deviceEpoch: 1,
      leaseId: "permit-lease-1",
      previousLeaseId: remoteEvent.lease.id,
      expiresAt: "2026-07-23T08:02:00.000Z"
    })
    await context.eventStore.beginExecution(remoteEvent.eventId, "run-1")
    const replies = repliesFor(remoteEvent, ["first", "second"])
    const completed = await context.eventStore.completeEvent(remoteEvent.eventId, replies, "result")
    assert.equal(completed.state, "completed")
    assert.equal(context.eventStore.listOutbox().length, 2)
    await context.eventStore.completeEvent(remoteEvent.eventId, replies, "result")
    assert.equal(
      context.eventStore.listOutbox().length,
      2,
      "completion replay does not duplicate outbox"
    )

    const first = context.eventStore.listOutbox()[0]
    const sending = await context.eventStore.markOutboxSending(first.outboxId)
    assert.equal(sending.attemptCount, 1)
    await context.eventStore.markOutboxUnknown(first.outboxId, "PLATFORM_RESULT_UNKNOWN")
    assert.equal(context.eventStore.listOutbox("unknown").length, 1)

    const SQL = await initSqlJs()
    const reopenedDatabase = new SQL.Database(context.database.export())
    const reopenedDependencies: ImPersistenceDependencies = {
      getDatabase: () => reopenedDatabase,
      markDirty: () => undefined,
      flushStrict: async () => undefined,
      now: () => context.clock.now
    }
    const reopenedStore = new ImEventStore(reopenedDependencies)
    assert.equal(reopenedStore.getEvent(remoteEvent.eventId)?.state, "completed")
    assert.equal(reopenedStore.listOutbox().length, 2, "completed outbox survives a DB reopen")
    reopenedDatabase.close()
  } finally {
    context.database.close()
  }
}

async function testIngressAckBoundariesAndReplay(): Promise<void> {
  const context = await createContext()
  try {
    await seedConversation(context)
    const remoteEvent = eventFixture(1)
    let failReceivedAck = true
    const attempted: Array<{ type: string; flushCount: number }> = []
    const interruptedIngress = new ImIngressSequencer({
      conversationState: context.conversationStore,
      eventStore: context.eventStore,
      emitAcknowledgement: async (ack) => {
        attempted.push({ type: ack.type, flushCount: context.persistence.flushCount })
        if (ack.type === "received" && failReceivedAck) {
          failReceivedAck = false
          throw new Error("injected ACK transport failure")
        }
      }
    })
    await assert.rejects(
      () => interruptedIngress.receiveOrdinaryEvent(remoteEvent),
      /injected ACK transport failure/
    )
    assert.equal(context.eventStore.getEvent(remoteEvent.eventId)?.state, "received")

    const emitted: Array<{ type: string; flushCount: number }> = []
    const resumedIngress = new ImIngressSequencer({
      conversationState: context.conversationStore,
      eventStore: context.eventStore,
      emitAcknowledgement: async (ack) => {
        emitted.push({ type: ack.type, flushCount: context.persistence.flushCount })
      }
    })
    const resumed = await resumedIngress.receiveOrdinaryEvent(remoteEvent)
    assert.equal(resumed.duplicate, true)
    assert.deepEqual(
      emitted.map((entry) => entry.type),
      ["received", "accepted"]
    )
    assert(
      emitted[0].flushCount < emitted[1].flushCount,
      "queue acceptance has its own strict flush"
    )
    assert.equal(context.eventStore.getEvent(remoteEvent.eventId)?.state, "queued")

    emitted.length = 0
    const queuedReplay = await resumedIngress.receiveOrdinaryEvent(remoteEvent)
    assert.equal(queuedReplay.duplicate, true)
    assert.deepEqual(
      emitted.map((entry) => entry.type),
      ["accepted"]
    )
  } finally {
    context.database.close()
  }
}

async function testFlushFailureIsNeverAcknowledgedAsDurable(): Promise<void> {
  const context = await createContext()
  try {
    await seedConversation(context)
    const remoteEvent = eventFixture(1)
    context.persistence.failNextFlush = true
    await assert.rejects(
      () => context.eventStore.receiveEvent(remoteEvent, inboxTarget),
      /injected flush failure/
    )
    assert.equal(context.eventStore.listConversationEvents("conversation-1").length, 1)
    const replay = await context.eventStore.receiveEvent(remoteEvent, featureTarget)
    assert.equal(replay.duplicate, true)
    assert.deepEqual(replay.event.targetSnapshot, inboxTarget)

    await context.eventStore.queueEvent(remoteEvent.eventId)
    await context.eventStore.recordExecutionPermit({
      eventId: remoteEvent.eventId,
      deviceEpoch: 1,
      leaseId: remoteEvent.lease.id,
      expiresAt: remoteEvent.lease.expiresAt
    })
    context.persistence.failNextFlush = true
    await assert.rejects(
      () => context.eventStore.beginExecution(remoteEvent.eventId, "stable-run"),
      /injected flush failure/
    )
    const retried = await context.eventStore.beginExecution(remoteEvent.eventId, "stable-run")
    assert.equal(retried.state, "executing", "same run retries only the strict flush")
  } finally {
    context.database.close()
  }
}

async function testRestartRecoveryAndConversationQueue(): Promise<void> {
  const context = await createContext()
  try {
    await seedConversation(context)
    for (const index of [1, 2]) {
      const remoteEvent = eventFixture(index)
      await context.eventStore.receiveEvent(remoteEvent, inboxTarget)
      await context.eventStore.queueEvent(remoteEvent.eventId)
    }

    let releaseFirst: () => void = () => undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: string[] = []
    const queue = new ImConversationTurnQueue(async (event) => {
      started.push(event.eventId)
      if (event.eventId === "event-1") await firstGate
      await context.eventStore.cancelEvent(event.eventId, "TEST_TERMINAL")
    }, context.eventStore)
    const draining = queue.notify("conversation-1")
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(started, ["event-1"], "one conversation executes only one event at a time")
    releaseFirst()
    await draining
    assert.deepEqual(started, ["event-1", "event-2"])

    const third = eventFixture(3)
    await context.eventStore.receiveEvent(third, inboxTarget)
    await context.eventStore.queueEvent(third.eventId)
    await context.eventStore.recordExecutionPermit({
      eventId: third.eventId,
      deviceEpoch: 1,
      leaseId: third.lease.id,
      expiresAt: third.lease.expiresAt
    })
    await context.eventStore.beginExecution(third.eventId, "run-before-crash")
    const [replyBeforeCrash] = await context.eventStore.enqueueProactiveReplies([
      {
        schemaVersion: 1,
        deliveryId: "reply-before-client-crash",
        conversationKey: "conversation-1",
        expectedDeviceEpoch: 1,
        idempotencyKey: "reply-before-client-crash:reply:0",
        segment: { index: 0, count: 1 },
        message: { type: "text", content: "durable reply" }
      }
    ])
    await context.eventStore.markOutboxSending(replyBeforeCrash.outboxId)
    const recovered = await context.eventStore.recoverInterruptedEvents()
    assert.deepEqual(recovered, [third.eventId])
    assert.equal(context.eventStore.getEvent(third.eventId)?.state, "outcome_unknown")
    assert.deepEqual(await context.eventStore.recoverInterruptedOutbox(), [
      replyBeforeCrash.outboxId
    ])
    const recoveredReply = context.eventStore
      .listOutbox()
      .find((record) => record.outboxId === replyBeforeCrash.outboxId)
    assert.equal(recoveredReply?.state, "pending")
    assert.equal(recoveredReply?.idempotencyKey, replyBeforeCrash.idempotencyKey)
    assert.equal(recoveredReply?.attemptCount, 1)
  } finally {
    context.database.close()
  }
}

async function testMockGatewayFaultMatrix(): Promise<void> {
  let now = Date.parse("2026-07-23T08:00:00.000Z")
  const gateway = new MockImGateway({ now: () => now })
  const waiting = gateway.ingestText({
    platformMessageId: "platform-waiting",
    principalId: "principal-1",
    conversationKey: "conversation-1",
    text: "offline"
  })
  assert.equal(waiting.status, "waiting_device")
  gateway.connectDevice({ deviceId: "device-a", principalId: "principal-1", preferred: true })
  const [event] = gateway.takeDeliveries("device-a")
  assert(event, "waiting event is delivered after a device connects")

  gateway.ingestText({
    platformMessageId: "platform-order-2",
    principalId: "principal-1",
    conversationKey: "conversation-1",
    text: "second"
  })
  gateway.ingestText({
    platformMessageId: "platform-order-3",
    principalId: "principal-1",
    conversationKey: "conversation-1",
    text: "third"
  })
  assert.deepEqual(
    gateway.takeDeliveries("device-a"),
    [],
    "later first delivery waits for received ACK"
  )
  gateway.acknowledge("device-a", 1, {
    type: "received",
    eventId: event.eventId,
    leaseId: event.lease.id
  })
  const [second] = gateway.takeDeliveries("device-a")
  assert.equal(second.conversationSeq, 2)
  gateway.acknowledge("device-a", 1, {
    type: "received",
    eventId: second.eventId,
    leaseId: second.lease.id
  })
  const [third] = gateway.takeDeliveries("device-a")
  assert.equal(third.conversationSeq, 3)

  const redelivered = gateway.redeliver(event.eventId)
  assert.notEqual(redelivered.lease.id, event.lease.id)
  const lateRedelivery = gateway.takeDeliveries("device-a")[0]
  assert.equal(lateRedelivery.redelivered, true)
  assert.equal(
    lateRedelivery.conversationSeq,
    1,
    "old redelivery may arrive after later first delivery"
  )
  gateway.disconnectDevice("device-a")
  assert.equal(
    gateway.acquirePermit({
      eventId: event.eventId,
      deviceId: "device-a",
      deviceEpoch: 1,
      leaseId: redelivered.lease.id
    }).reasonCode,
    "DEVICE_OFFLINE"
  )
  gateway.reconnectDevice("device-a")
  const permit = gateway.acquirePermit({
    eventId: event.eventId,
    deviceId: "device-a",
    deviceEpoch: 1,
    leaseId: redelivered.lease.id
  })
  assert.equal(permit.status, "granted")
  gateway.revokeLease(event.eventId)
  assert.equal(
    gateway.renewPermit({
      eventId: event.eventId,
      deviceId: "device-a",
      deviceEpoch: 1,
      leaseId: redelivered.lease.id
    }).reasonCode,
    "LEASE_REVOKED"
  )

  gateway.connectDevice({ deviceId: "device-b", principalId: "principal-1" })
  const route = gateway.takeover({
    conversationKey: "conversation-1",
    expectedEpoch: 1,
    newDeviceId: "device-b"
  })
  assert.equal(route.deviceEpoch, 2)
  const reply: RemoteImReplyV1 = {
    schemaVersion: 1,
    deliveryId: "scheduled-reply",
    conversationKey: event.conversationKey,
    expectedDeviceEpoch: 2,
    idempotencyKey: "scheduled-reply:reply:0",
    segment: { index: 0, count: 1 },
    message: { type: "text", content: "done" }
  }
  gateway.setNextReplyFault("timeout_after_persist")
  assert.throws(
    () => gateway.submitReply("device-b", reply),
    (error) => error instanceof MockGatewaySendTimeout && error.persisted
  )
  assert.equal(gateway.submitReply("device-b", reply).duplicate, true)
  const unknownReply = {
    ...reply,
    deliveryId: "unknown-delivery",
    idempotencyKey: "unknown-delivery:reply:0"
  }
  gateway.setNextReplyFault("platform_unknown")
  assert.equal(gateway.submitReply("device-b", unknownReply).state, "platform_unknown")
  const beforePersistReply = {
    ...reply,
    deliveryId: "before-persist-delivery",
    idempotencyKey: "before-persist-delivery:reply:0"
  }
  gateway.setNextReplyFault("timeout_before_persist")
  assert.throws(
    () => gateway.submitReply("device-b", beforePersistReply),
    (error) => error instanceof MockGatewaySendTimeout && !error.persisted
  )
  assert.equal(gateway.submitReply("device-b", beforePersistReply).duplicate, false)
  assert.throws(
    () => gateway.submitReply("device-a", { ...reply, expectedDeviceEpoch: 1 }),
    (error) => error instanceof MockGatewayError && error.reasonCode === "ROUTE_EPOCH_CONFLICT"
  )

  now += 100_000
}

async function testDeviceTakeoverTerminalizesOldEpoch(): Promise<void> {
  const context = await createContext()
  try {
    await seedConversation(context)
    const queuedEvent = eventFixture(1)
    const runningEvent = eventFixture(2)
    await context.eventStore.receiveEvent(queuedEvent, inboxTarget)
    await context.eventStore.queueEvent(queuedEvent.eventId)
    await context.eventStore.receiveEvent(runningEvent, inboxTarget)
    await context.eventStore.queueEvent(runningEvent.eventId)
    await context.eventStore.recordExecutionPermit({
      eventId: runningEvent.eventId,
      deviceEpoch: 1,
      leaseId: runningEvent.lease.id,
      expiresAt: runningEvent.lease.expiresAt
    })
    await context.eventStore.beginExecution(runningEvent.eventId, "running-before-takeover")
    const proactive = (deliveryId: string): RemoteImReplyV1 => ({
      schemaVersion: 1,
      deliveryId,
      conversationKey: "conversation-1",
      expectedDeviceEpoch: 1,
      idempotencyKey: `${deliveryId}:reply:0`,
      segment: { index: 0, count: 1 },
      message: { type: "text", content: deliveryId }
    })
    const [pending] = await context.eventStore.enqueueProactiveReplies([proactive("pending-old")])
    const [sending] = await context.eventStore.enqueueProactiveReplies([proactive("sending-old")])
    await context.eventStore.markOutboxSending(sending.outboxId)

    const changed = await context.eventStore.applyDeviceTakeover("conversation-1", 1)
    assert.deepEqual(changed.cancelledEventIds, [queuedEvent.eventId])
    assert.deepEqual(changed.outcomeUnknownEventIds, [runningEvent.eventId])
    assert.equal(context.eventStore.getEvent(queuedEvent.eventId)?.state, "cancelled")
    assert.equal(context.eventStore.getEvent(runningEvent.eventId)?.state, "outcome_unknown")
    assert.equal(
      context.eventStore.listOutbox().find((item) => item.outboxId === pending.outboxId)?.state,
      "failed"
    )
    assert.equal(
      context.eventStore.listOutbox().find((item) => item.outboxId === sending.outboxId)?.state,
      "unknown"
    )
    await context.conversationStore.resetForDeviceTakeover("conversation-1", 1, 2)
    assert.equal(context.conversationStore.getConversation("conversation-1")?.deviceEpoch, 2)
    assert(
      context.conversationStore
        .listTargets("conversation-1")
        .every((item) => item.state === "revoked")
    )
  } finally {
    context.database.close()
  }
}

async function testRetentionKeepsLiveAndUncertainDeliveryState(): Promise<void> {
  const context = await createContext()
  try {
    await seedConversation(context)
    const deliveredEvent = eventFixture(1)
    const uncertainEvent = eventFixture(2)
    const queuedEvent = eventFixture(3)
    for (const event of [deliveredEvent, uncertainEvent]) {
      await context.eventStore.receiveEvent(event, inboxTarget)
      await context.eventStore.queueEvent(event.eventId)
      await context.eventStore.recordExecutionPermit({
        eventId: event.eventId,
        deviceEpoch: 1,
        leaseId: event.lease.id,
        expiresAt: event.lease.expiresAt
      })
      await context.eventStore.beginExecution(event.eventId, `run:${event.eventId}`)
      await context.eventStore.completeEvent(
        event.eventId,
        repliesFor(event, [event.eventId]),
        "done"
      )
    }
    for (const segment of context.eventStore
      .listOutbox()
      .filter((item) => item.eventId === deliveredEvent.eventId)) {
      await context.eventStore.markOutboxSending(segment.outboxId)
      await context.eventStore.markOutboxSent(segment.outboxId, `platform:${segment.outboxId}`)
    }
    const uncertainSegment = context.eventStore
      .listOutbox()
      .find((item) => item.eventId === uncertainEvent.eventId)!
    await context.eventStore.markOutboxSending(uncertainSegment.outboxId)
    await context.eventStore.markOutboxUnknown(uncertainSegment.outboxId, "PLATFORM_RESULT_UNKNOWN")
    await context.eventStore.receiveEvent(queuedEvent, inboxTarget)
    await context.eventStore.queueEvent(queuedEvent.eventId)

    context.clock.now += 8 * 24 * 60 * 60 * 1_000
    const removed = await context.eventStore.cleanupExpiredTerminalData()
    assert.equal(removed.deletedEvents, 1)
    assert.equal(context.eventStore.getEvent(deliveredEvent.eventId), null)
    assert.equal(context.eventStore.getEvent(uncertainEvent.eventId)?.state, "completed")
    assert.equal(context.eventStore.getEvent(queuedEvent.eventId)?.state, "queued")
    assert.equal(context.eventStore.listOutbox("unknown").length, 1)
  } finally {
    context.database.close()
  }
}

async function main(): Promise<void> {
  for (const test of [
    testFrozenContractFixtures,
    testImArchitectureBoundaries,
    testSchemaAndTargetLifecycle,
    testRemoteControlSchemaMigrationPreservesV1Rows,
    testDurableDedupAndImmutableSnapshot,
    testPermitStateMachineAndAtomicOutbox,
    testFlushFailureIsNeverAcknowledgedAsDurable,
    testIngressAckBoundariesAndReplay,
    testRestartRecoveryAndConversationQueue,
    testDeviceTakeoverTerminalizesOldEpoch,
    testRetentionKeepsLiveAndUncertainDeliveryState,
    testMockGatewayFaultMatrix
  ]) {
    await test()
    console.log(`PASS ${test.name}`)
  }
  console.log("im-schema-event-store.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
