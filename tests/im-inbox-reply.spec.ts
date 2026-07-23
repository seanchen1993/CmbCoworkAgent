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
  IM_REPLY_TRUNCATION_NOTICE,
  buildImEventReplies,
  eventShortCode,
  segmentImReplyText
} from "../src/main/services/im/reply-segmentation"
import { ensureImServiceSchema } from "../src/main/services/im/schema"

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
    principalId: "principal-1",
    deviceEpoch: 1
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
      principalId: "principal-1",
      deviceEpoch: 1
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
      conversationKey: "conversation/private/value",
      deviceEpoch: 1,
      targetId: first.targetId
    })

    const second = await service.ensureInbox({
      conversationKey: "conversation/private/value",
      principalId: "principal-1",
      deviceEpoch: 1
    })
    assert.deepEqual(second, first)
    assert.equal(threads.size, 1)
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
    assert(segment.startsWith(`【项目 / 功能】\n[${index + 1}/${prefixed.length}] `))
    assert(Array.from(segment).length <= 2_800)
  }

  const truncated = segmentImReplyText("长".repeat(40_000))
  assert.equal(truncated.length, 8)
  assert(truncated[7].includes(IM_REPLY_TRUNCATION_NOTICE))
  assert(truncated.every((segment) => Array.from(segment).length <= 2_800))

  const event = {
    eventId: "event-stable-id",
    conversationKey: "conversation-1",
    deviceEpoch: 3
  }
  const first = buildImEventReplies({ event, text: "回复".repeat(5_000) })
  const replay = buildImEventReplies({ event, text: "回复".repeat(5_000) })
  assert.deepEqual(replay, first)
  assert.equal(first[0].segment.index, 0)
  assert(first.every((reply) => reply.segment.count === first.length))
  assert.equal(eventShortCode("event-stable-id"), eventShortCode("event-stable-id"))
  assert.match(eventShortCode("event-stable-id"), /^[A-F0-9]{8}$/)
}

const tests: Array<[string, () => void | Promise<void>]> = [
  ["testManagedInboxCreationAndReuse", testManagedInboxCreationAndReuse],
  ["testReplySegmentationAndStableEnvelope", testReplySegmentationAndStableEnvelope]
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
