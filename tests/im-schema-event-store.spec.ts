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
    principalId: "principal-1"
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
    context.conversationStore.assertConversationOwner("conversation-1", "principal-1")
    assert.throws(
      () => context.conversationStore.assertConversationOwner("conversation-1", "principal-2"),
      { message: "Conversation principal differs" }
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
    assert.equal(database.exec("SELECT COUNT(*) FROM im_selection_contexts")[0]?.values[0]?.[0], 2)
  } finally {
    database.close()
  }
}

async function testFeatureGrantPrincipalScopeMigration(): Promise<void> {
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  try {
    database.run(`
      CREATE TABLE im_feature_grants (
        grant_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        project_id TEXT NOT NULL,
        feature_slug TEXT NOT NULL,
        project_name_snapshot TEXT NOT NULL,
        feature_title_snapshot TEXT NOT NULL,
        state TEXT NOT NULL,
        grant_version INTEGER NOT NULL,
        suspend_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revoked_at INTEGER,
        UNIQUE(project_id, feature_slug)
      )
    `)
    database.run(
      "CREATE INDEX idx_im_feature_grants_route ON im_feature_grants(conversation_key, state)"
    )
    database.run(
      `INSERT INTO im_feature_grants VALUES (
        'feature-grant-current', 'principal-1', 'conversation-1', 'project-1', 'feature-1',
        '项目一', '功能一', 'active', 3, NULL, 10, 11, NULL
      )`
    )

    ensureImServiceSchema(database)
    ensureImServiceSchema(database)

    const columns = database
      .exec("PRAGMA table_info(im_feature_grants)")
      .flatMap((result) => result.values.map((row) => String(row[1])))
    assert(!columns.includes("conversation_key"))
    assert.deepEqual(
      database.exec(
        "SELECT grant_id, principal_id, project_id, feature_slug, state, grant_version FROM im_feature_grants"
      )[0]?.values[0],
      ["feature-grant-current", "principal-1", "project-1", "feature-1", "active", 3]
    )
    const indexes = database
      .exec("PRAGMA index_list(im_feature_grants)")
      .flatMap((result) => result.values.map((row) => String(row[1])))
    assert(indexes.includes("idx_im_feature_grants_principal"))
    assert(!indexes.includes("idx_im_feature_grants_route"))
  } finally {
    database.close()
  }
}

async function testSingleDesktopSchemaMigrationPreservesLegacyRows(): Promise<void> {
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  try {
    database.run(`
      CREATE TABLE im_conversations (
        conversation_key TEXT, principal_id TEXT, device_epoch INTEGER,
        active_target_id TEXT, state TEXT, last_received_seq INTEGER,
        created_at INTEGER, updated_at INTEGER
      )
    `)
    database.run(
      "INSERT INTO im_conversations VALUES ('conversation-legacy', 'principal-1', 7, NULL, 'active', 1, 10, 11)"
    )
    database.run(`
      CREATE TABLE im_events (
        event_id TEXT, platform_message_id TEXT, conversation_key TEXT,
        conversation_seq INTEGER, principal_id TEXT, device_epoch INTEGER,
        lease_id TEXT, lease_expires_at INTEGER, permit_state TEXT,
        permit_expires_at INTEGER, message_text TEXT, occurred_at INTEGER,
        target_snapshot_json TEXT, state TEXT, run_id TEXT, retry_of_event_id TEXT,
        result_text TEXT, reason_code TEXT, retryable INTEGER, created_at INTEGER,
        updated_at INTEGER, accepted_at INTEGER, execution_started_at INTEGER,
        finished_at INTEGER
      )
    `)
    database.run(
      `INSERT INTO im_events VALUES (
         'event-legacy', 'platform-legacy', 'conversation-legacy', 1, 'principal-1', 7,
         'lease-legacy', 1000, 'unacquired', NULL, 'hello', 1, NULL, 'queued',
         NULL, NULL, NULL, NULL, NULL, 10, 11, 11, NULL, NULL
       )`
    )
    database.run(`
      CREATE TABLE im_reply_outbox (
        outbox_id TEXT, delivery_id TEXT, event_id TEXT, conversation_key TEXT,
        expected_device_epoch INTEGER, idempotency_key TEXT, segment_index INTEGER,
        segment_count INTEGER, content TEXT, state TEXT, platform_reply_id TEXT,
        attempt_count INTEGER, next_attempt_at INTEGER, reason_code TEXT,
        created_at INTEGER, updated_at INTEGER
      )
    `)
    database.run(
      `INSERT INTO im_reply_outbox VALUES (
         'outbox-legacy', 'delivery-legacy', 'event-legacy', 'conversation-legacy', 7,
         'delivery-legacy:reply:0', 0, 1, 'done', 'pending', NULL, 0, NULL, NULL, 10, 11
       )`
    )
    database.run(`
      CREATE TABLE im_thread_grants (
        grant_id TEXT, principal_id TEXT, conversation_key TEXT, device_epoch INTEGER,
        thread_id TEXT, title_snapshot TEXT, state TEXT, grant_version INTEGER,
        suspend_reason TEXT, created_at INTEGER, updated_at INTEGER, revoked_at INTEGER
      )
    `)
    database.run(
      "INSERT INTO im_thread_grants VALUES ('thread-grant-legacy', 'principal-1', 'conversation-legacy', 7, 'thread-legacy', '旧会话', 'active', 1, NULL, 10, 11, NULL)"
    )
    database.run(`
      CREATE TABLE im_feature_grants (
        grant_id TEXT, principal_id TEXT, conversation_key TEXT, device_epoch INTEGER,
        project_id TEXT, feature_slug TEXT, project_name_snapshot TEXT,
        feature_title_snapshot TEXT, state TEXT, grant_version INTEGER,
        suspend_reason TEXT, created_at INTEGER, updated_at INTEGER, revoked_at INTEGER
      )
    `)
    database.run(
      "INSERT INTO im_feature_grants VALUES ('feature-grant-legacy', 'principal-1', 'conversation-legacy', 7, 'project-1', 'feature-1', '旧项目', '旧功能', 'active', 1, NULL, 10, 11, NULL)"
    )
    database.run(`
      CREATE TABLE im_remote_approval_audit (
        audit_id TEXT, request_id TEXT, tool_call_id TEXT, thread_id TEXT,
        principal_id TEXT, conversation_key TEXT, device_epoch INTEGER,
        operation TEXT, decision TEXT, summary TEXT, created_at INTEGER
      )
    `)
    database.run(
      "INSERT INTO im_remote_approval_audit VALUES ('audit-legacy', 'request-legacy', 'tool-legacy', 'thread-legacy', 'principal-1', 'conversation-legacy', 7, 'write_file', 'approve', '旧审批', 10)"
    )

    ensureImServiceSchema(database)
    ensureImServiceSchema(database)

    const columns = (table: string): string[] =>
      database
        .exec(`PRAGMA table_info(${table})`)
        .flatMap((result) => result.values.map((row) => String(row[1])))
    for (const [table, legacyColumn] of [
      ["im_conversations", "device_epoch"],
      ["im_events", "device_epoch"],
      ["im_reply_outbox", "expected_device_epoch"],
      ["im_thread_grants", "device_epoch"],
      ["im_feature_grants", "device_epoch"],
      ["im_remote_approval_audit", "device_epoch"]
    ] as const) {
      assert(!columns(table).includes(legacyColumn), `${table} must drop ${legacyColumn}`)
      assert.equal(
        database.exec(`SELECT COUNT(*) FROM ${table}`)[0]?.values[0]?.[0],
        1,
        `${table} must preserve its legacy row`
      )
    }
    assert.deepEqual(
      database.exec(
        "SELECT principal_id, state, last_received_seq FROM im_conversations WHERE conversation_key = 'conversation-legacy'"
      )[0]?.values[0],
      ["principal-1", "active", 1]
    )
    assert(
      !columns("im_feature_grants").includes("conversation_key"),
      "Feature grants must migrate from conversation scope to principal scope"
    )
    assert.deepEqual(
      database.exec(
        "SELECT principal_id, project_id, feature_slug, state FROM im_feature_grants WHERE grant_id = 'feature-grant-legacy'"
      )[0]?.values[0],
      ["principal-1", "project-1", "feature-1", "active"]
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
      leaseId: third.lease.id,
      expiresAt: third.lease.expiresAt
    })
    await context.eventStore.beginExecution(third.eventId, "run-before-crash")
    const [replyBeforeCrash] = await context.eventStore.enqueueProactiveReplies([
      {
        schemaVersion: 1,
        deliveryId: "reply-before-client-crash",
        conversationKey: "conversation-1",
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

async function testConversationQueueRunsDifferentThreadsInParallel(): Promise<void> {
  const context = await createContext()
  try {
    await seedConversation(context)
    await context.conversationStore.registerTarget("conversation-1", featureTarget)
    const first = eventFixture(1)
    const second = eventFixture(2)
    await context.eventStore.receiveEvent(first, inboxTarget)
    await context.eventStore.queueEvent(first.eventId)
    await context.eventStore.receiveEvent(second, featureTarget)
    await context.eventStore.queueEvent(second.eventId)

    let releaseInbox: () => void = () => undefined
    let releaseFeature: () => void = () => undefined
    const inboxGate = new Promise<void>((resolve) => {
      releaseInbox = resolve
    })
    const featureGate = new Promise<void>((resolve) => {
      releaseFeature = resolve
    })
    const started: string[] = []
    const queue = new ImConversationTurnQueue(async (event) => {
      started.push(event.eventId)
      await (event.targetSnapshot?.threadId === inboxTarget.threadId ? inboxGate : featureGate)
      await context.eventStore.cancelEvent(event.eventId, "TEST_TERMINAL")
    }, context.eventStore)

    const draining = queue.notify("conversation-1")
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(
      new Set(started),
      new Set([first.eventId, second.eventId]),
      "different Thread lanes should begin without waiting for each other"
    )

    releaseFeature()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    assert.equal(context.eventStore.getEvent(second.eventId)?.state, "cancelled")
    assert.notEqual(context.eventStore.getEvent(first.eventId)?.state, "cancelled")

    releaseInbox()
    await draining
    assert.equal(context.eventStore.getEvent(first.eventId)?.state, "cancelled")
    await queue.stop()
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
  assert.equal(waiting.status, "waiting_session")
  gateway.connectSession({ sessionId: "session-a", principalId: "principal-1" })
  const [event] = gateway.takeDeliveries("session-a")
  assert(event, "waiting event is delivered after the desktop connects")

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
    gateway.takeDeliveries("session-a"),
    [],
    "later first delivery waits for received ACK"
  )
  gateway.acknowledge("session-a", {
    type: "received",
    eventId: event.eventId,
    leaseId: event.lease.id
  })
  const [second] = gateway.takeDeliveries("session-a")
  assert.equal(second.conversationSeq, 2)
  gateway.acknowledge("session-a", {
    type: "received",
    eventId: second.eventId,
    leaseId: second.lease.id
  })
  const [third] = gateway.takeDeliveries("session-a")
  assert.equal(third.conversationSeq, 3)

  const redelivered = gateway.redeliver(event.eventId)
  assert.notEqual(redelivered.lease.id, event.lease.id)
  const lateRedelivery = gateway.takeDeliveries("session-a")[0]
  assert.equal(lateRedelivery.redelivered, true)
  assert.equal(
    lateRedelivery.conversationSeq,
    1,
    "old redelivery may arrive after later first delivery"
  )
  gateway.disconnectSession("session-a")
  assert.equal(
    gateway.acquirePermit({
      eventId: event.eventId,
      sessionId: "session-a",
      leaseId: redelivered.lease.id
    }).reasonCode,
    "DESKTOP_OFFLINE"
  )
  gateway.connectSession({ sessionId: "session-a", principalId: "principal-1" })
  gateway.takeDeliveries("session-a")
  const replacement = gateway.connectSession({
    sessionId: "session-b",
    principalId: "principal-1"
  })
  assert.equal(replacement.supersededSessionId, "session-a")
  const replacementDelivery = gateway
    .takeDeliveries("session-b")
    .find((candidate) => candidate.eventId === event.eventId)
  assert(replacementDelivery, "an unpermitted event receives a new lease on the active session")
  assert.notEqual(replacementDelivery.lease.id, redelivered.lease.id)
  assert.throws(
    () => gateway.takeDeliveries("session-a"),
    (error) => error instanceof MockGatewayError && error.reasonCode === "SESSION_SUPERSEDED"
  )
  const permit = gateway.acquirePermit({
    eventId: event.eventId,
    sessionId: "session-b",
    leaseId: replacementDelivery.lease.id
  })
  assert.equal(permit.status, "granted")
  gateway.revokeLease(event.eventId)
  assert.equal(
    gateway.renewPermit({
      eventId: event.eventId,
      sessionId: "session-b",
      leaseId: replacementDelivery.lease.id
    }).reasonCode,
    "LEASE_REVOKED"
  )

  const reply: RemoteImReplyV1 = {
    schemaVersion: 1,
    deliveryId: "scheduled-reply",
    conversationKey: event.conversationKey,
    idempotencyKey: "scheduled-reply:reply:0",
    segment: { index: 0, count: 1 },
    message: { type: "text", content: "done" }
  }
  gateway.setNextReplyFault("timeout_after_persist")
  assert.throws(
    () => gateway.submitReply("session-b", reply),
    (error) => error instanceof MockGatewaySendTimeout && error.persisted
  )
  assert.equal(gateway.submitReply("session-b", reply).duplicate, true)
  const unknownReply = {
    ...reply,
    deliveryId: "unknown-delivery",
    idempotencyKey: "unknown-delivery:reply:0"
  }
  gateway.setNextReplyFault("platform_unknown")
  assert.equal(gateway.submitReply("session-b", unknownReply).state, "platform_unknown")
  const beforePersistReply = {
    ...reply,
    deliveryId: "before-persist-delivery",
    idempotencyKey: "before-persist-delivery:reply:0"
  }
  gateway.setNextReplyFault("timeout_before_persist")
  assert.throws(
    () => gateway.submitReply("session-b", beforePersistReply),
    (error) => error instanceof MockGatewaySendTimeout && !error.persisted
  )
  assert.equal(gateway.submitReply("session-b", beforePersistReply).duplicate, false)
  assert.throws(
    () => gateway.submitReply("session-a", reply),
    (error) => error instanceof MockGatewayError && error.reasonCode === "SESSION_SUPERSEDED"
  )

  now += 100_000
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
    testFeatureGrantPrincipalScopeMigration,
    testSingleDesktopSchemaMigrationPreservesLegacyRows,
    testDurableDedupAndImmutableSnapshot,
    testPermitStateMachineAndAtomicOutbox,
    testFlushFailureIsNeverAcknowledgedAsDurable,
    testIngressAckBoundariesAndReplay,
    testRestartRecoveryAndConversationQueue,
    testConversationQueueRunsDifferentThreadsInParallel,
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
