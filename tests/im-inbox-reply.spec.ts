import assert from "node:assert/strict"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import initSqlJs from "sql.js"
import type { ThreadRow } from "../src/main/db"
import { ImConversationStateStore } from "../src/main/services/im/conversation-state"
import { ImInboxService, IM_MANAGED_INBOX_DIRECTORY } from "../src/main/services/im/inbox-service"
import type { ImPersistenceDependencies } from "../src/main/services/im/persistence"
import {
  imFeatureReplyPrefix,
  imInboxReplyPrefix,
  imThreadReplyPrefix
} from "../src/main/services/im/reply-context"
import {
  IM_REPLY_TRUNCATION_NOTICE,
  buildImEventReplies,
  eventShortCode,
  segmentImReplyText
} from "../src/main/services/im/reply-segmentation"
import { ensureImServiceSchema } from "../src/main/services/im/schema"
import { ImReplyClient } from "../src/main/services/im/reply-client"
import type { ImGatewayClientPort } from "../src/main/services/im/gateway-client"
import type { ImEventStore, ImReplyOutboxRecord } from "../src/main/services/im/event-store"

async function testManagedInboxCreationAndReuse(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cmb-im-inbox-"))
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  ensureImServiceSchema(database)
  const dependencies: ImPersistenceDependencies = {
    getDatabase: () => database,
    markDirty: () => undefined,
    flushStrict: async () => undefined,
    now: () => Date.parse("2026-07-23T08:00:00.000Z")
  }
  const conversations = new ImConversationStateStore(dependencies)
  await conversations.ensureConversation({
    conversationKey: "conversation/private/value",
    principalId: "principal-1"
  })
  const threads = new Map<string, ThreadRow>()
  let id = 0
  const service = new ImInboxService({
    conversationState: conversations,
    openworkDirectory: () => root,
    createId: () => `generated-${++id}`,
    createThread: (threadId, metadata) => {
      const row: ThreadRow = {
        thread_id: threadId,
        created_at: Date.now(),
        updated_at: Date.now(),
        metadata: JSON.stringify(metadata),
        status: "idle",
        thread_values: null,
        title: typeof metadata?.title === "string" ? metadata.title : null
      }
      threads.set(threadId, row)
      return row
    },
    getThread: (threadId) => threads.get(threadId) ?? null,
    ensureDirectory: async () => undefined
  })

  try {
    const first = await service.ensureInbox({
      conversationKey: "conversation/private/value",
      principalId: "principal-1"
    })
    assert.equal(first.kind, "inbox")
    const realRoot = await realpath(root)
    assert(first.workspacePath.startsWith(join(realRoot, IM_MANAGED_INBOX_DIRECTORY)))
    assert(!first.workspacePath.includes("conversation/private/value"))
    const metadata = JSON.parse(threads.get(first.threadId)!.metadata!) as Record<string, unknown>
    assert.equal(metadata.targetKind, "inbox")
    assert.equal(metadata.remoteReadOnly, true)
    assert.equal(metadata.memoryEnabled, false)
    assert.deepEqual(metadata.imDeliveryContext, {
      provider: "zhaohu",
      principalId: "principal-1",
      conversationKey: "conversation/private/value",
      targetId: first.targetId
    })

    const second = await service.ensureInbox({
      conversationKey: "conversation/private/value",
      principalId: "principal-1"
    })
    assert.deepEqual(second, first)
    assert.equal(threads.size, 1)

    threads.delete(first.threadId)
    const repaired = await service.ensureInbox({
      conversationKey: "conversation/private/value",
      principalId: "principal-1"
    })
    assert.notEqual(repaired.targetId, first.targetId)
    assert.notEqual(repaired.threadId, first.threadId)
    assert.equal(threads.size, 1)
    assert.deepEqual(conversations.getActiveTarget("conversation/private/value"), repaired)
    const inboxStates = conversations
      .listTargets("conversation/private/value")
      .filter(({ snapshot }) => snapshot.kind === "inbox")
      .map(({ state, suspendReason }) => ({ state, suspendReason }))
    assert.deepEqual(inboxStates, [
      { state: "suspended", suspendReason: "INBOX_THREAD_MISSING" },
      { state: "active", suspendReason: null }
    ])
  } finally {
    database.close()
    await rm(root, { recursive: true, force: true })
  }
}

function testReplySegmentationAndStableEnvelope(): void {
  const emojiText = "😀".repeat(2_799)
  assert.equal(Array.from(segmentImReplyText(emojiText)[0]).length, 2_799)

  const prefixed = segmentImReplyText("甲".repeat(7_000), { prefix: "【项目 / 功能】" })
  assert(prefixed.length > 1)
  for (const [index, segment] of prefixed.entries()) {
    const expectedStart =
      index === 0
        ? `【项目 / 功能】\n[1/${prefixed.length}] `
        : `[${index + 1}/${prefixed.length}] `
    assert(segment.startsWith(expectedStart))
    if (index > 0) assert(!segment.includes("【项目 / 功能】"))
    assert(Array.from(segment).length <= 2_800)
  }

  const truncated = segmentImReplyText("长".repeat(40_000))
  assert.equal(truncated.length, 8)
  assert(truncated[7].includes(IM_REPLY_TRUNCATION_NOTICE))
  assert(truncated.every((segment) => Array.from(segment).length <= 2_800))

  const event = {
    eventId: "event-stable-id",
    conversationKey: "conversation-1"
  }
  const first = buildImEventReplies({ event, text: "回复".repeat(5_000) })
  const replay = buildImEventReplies({ event, text: "回复".repeat(5_000) })
  assert.deepEqual(replay, first)
  assert.equal(first[0].segment.index, 0)
  assert(first.every((reply) => reply.segment.count === first.length))
  assert.equal(eventShortCode("event-stable-id"), eventShortCode("event-stable-id"))
  assert.match(eventShortCode("event-stable-id"), /^[A-F0-9]{8}$/)

  assert.equal(imInboxReplyPrefix(), "【远程收件箱】")
  assert.equal(imThreadReplyPrefix("  接口   排障  "), "【会话：接口 排障】")
  assert.equal(
    imFeatureReplyPrefix({
      projectName: "支付平台",
      projectId: "project-pay",
      featureTitle: "快捷支付",
      featureSlug: "quick-pay",
      threadTitle: "验收会话",
      switched: true
    }),
    "【Feature：支付平台 / 快捷支付｜会话：验收会话】（切换前任务）"
  )
}

async function testConcurrentOutboxDrainUsesSingleSender(): Promise<void> {
  const record: ImReplyOutboxRecord = {
    outboxId: "outbox-1",
    deliveryId: "delivery-1",
    eventId: "event-1",
    conversationKey: "conversation-1",
    idempotencyKey: "delivery-1:reply:0",
    segmentIndex: 0,
    segmentCount: 1,
    content: "done",
    state: "pending",
    platformReplyId: null,
    attemptCount: 0,
    nextAttemptAt: null,
    reasonCode: null,
    createdAt: 1,
    updatedAt: 1
  }
  let submitCount = 0
  let releaseSubmit: () => void = () => undefined
  const submitGate = new Promise<void>((resolve) => {
    releaseSubmit = resolve
  })
  const gateway = {
    submitReply: async () => {
      submitCount += 1
      await submitGate
      return { state: "accepted" as const, platformReplyId: "platform-1" }
    }
  } as ImGatewayClientPort
  const eventStore = {
    listOutbox: (state?: string) =>
      (!state || state === "pending") && record.state === "pending" ? [record] : [],
    markOutboxSending: async () => {
      record.state = "sending"
      record.attemptCount += 1
      return record
    },
    markOutboxSent: async () => {
      record.state = "sent"
      return record
    }
  } as unknown as ImEventStore
  const firstClient = new ImReplyClient(gateway, eventStore)
  const secondClient = new ImReplyClient(gateway, eventStore)
  const first = firstClient.sendPending()
  const second = secondClient.sendPending()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(submitCount, 1)
  releaseSubmit()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.deepEqual(secondResult, firstResult)
  assert.equal(record.attemptCount, 1)
}

async function testSegmentDeliveryStopsBehindUnconfirmedPredecessor(): Promise<void> {
  const records: ImReplyOutboxRecord[] = [0, 1].map((segmentIndex) => ({
    outboxId: `outbox-${segmentIndex}`,
    deliveryId: "delivery-ordered",
    eventId: "event-ordered",
    conversationKey: "conversation-1",
    idempotencyKey: `delivery-ordered:reply:${segmentIndex}`,
    segmentIndex,
    segmentCount: 2,
    content: `segment-${segmentIndex}`,
    state: "pending",
    platformReplyId: null,
    attemptCount: 0,
    nextAttemptAt: null,
    reasonCode: null,
    createdAt: 1,
    updatedAt: 1
  }))
  let now = 1
  let failFirstAttempt = true
  const submitted: number[] = []
  const gateway = {
    submitReply: async (reply: { segment: { index: number } }) => {
      submitted.push(reply.segment.index)
      if (failFirstAttempt) {
        failFirstAttempt = false
        throw new Error("transient")
      }
      return { state: "accepted" as const, platformReplyId: `platform-${reply.segment.index}` }
    }
  } as ImGatewayClientPort
  const eventStore = {
    listOutbox: () => records,
    markOutboxSending: async (outboxId: string) => {
      const record = records.find((candidate) => candidate.outboxId === outboxId)!
      record.state = "sending"
      record.attemptCount += 1
      return record
    },
    markOutboxSent: async (outboxId: string) => {
      const record = records.find((candidate) => candidate.outboxId === outboxId)!
      record.state = "sent"
      return record
    },
    rescheduleOutbox: async (outboxId: string, nextAttemptAt: number) => {
      const record = records.find((candidate) => candidate.outboxId === outboxId)!
      record.state = "pending"
      record.nextAttemptAt = nextAttemptAt
      return record
    }
  } as unknown as ImEventStore
  const client = new ImReplyClient(gateway, eventStore, () => now)

  assert.deepEqual(await client.sendPending(), {
    sent: 0,
    unknown: 0,
    failed: 0,
    deferred: 1
  })
  assert.deepEqual(submitted, [0], "segment 1 must stay blocked while segment 0 is unconfirmed")

  now = 5_000
  assert.deepEqual(await client.sendPending(), {
    sent: 2,
    unknown: 0,
    failed: 0,
    deferred: 0
  })
  assert.deepEqual(submitted, [0, 0, 1])
}

const tests: Array<[string, () => void | Promise<void>]> = [
  ["testManagedInboxCreationAndReuse", testManagedInboxCreationAndReuse],
  ["testReplySegmentationAndStableEnvelope", testReplySegmentationAndStableEnvelope],
  ["testConcurrentOutboxDrainUsesSingleSender", testConcurrentOutboxDrainUsesSingleSender],
  [
    "testSegmentDeliveryStopsBehindUnconfirmedPredecessor",
    testSegmentDeliveryStopsBehindUnconfirmedPredecessor
  ]
]

async function main(): Promise<void> {
  for (const [name, test] of tests) {
    await test()
    console.log(`PASS ${name}`)
  }
  console.log("im-inbox-reply.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
