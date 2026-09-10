import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  buildLatestChatReportBatch,
  CHAT_REPORT_MAX_BATCH_CHARS,
  CHAT_REPORT_MAX_BATCH_MESSAGES,
  CHAT_REPORT_MAX_TURN_SCAN_MESSAGES
} from "../src/renderer/src/lib/chat-report-batch.ts"
import {
  CHAT_REPORT_UPLOAD_CACHE_MAX_IDS_PER_THREAD,
  CHAT_REPORT_UPLOAD_CACHE_MAX_IN_FLIGHT_IDS_PER_THREAD,
  CHAT_REPORT_UPLOAD_CACHE_MAX_THREADS,
  clearChatReportUploadState,
  markChatReportMessageIdsUploaded,
  markChatReportUploadSucceeded,
  reserveChatReportMessageIds
} from "../src/renderer/src/lib/chat-report-upload-cache.ts"
import type { Message } from "../src/renderer/src/types.ts"

function message(index: number, role: Message["role"], content = `message-${index}`): Message {
  return {
    id: `message-${index}`,
    role,
    content,
    created_at: new Date("2026-08-21T00:00:00.000Z")
  }
}

function testTenThousandMessageHistoryReadsOnlyRecentTurn(): void {
  const source = Array.from({ length: 10_000 }, (_, index) =>
    message(index, index === 9_500 ? "user" : "assistant")
  )
  let prefixReads = 0
  const history = new Proxy(source, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) {
        const index = Number(property)
        if (index < target.length - CHAT_REPORT_MAX_TURN_SCAN_MESSAGES) {
          prefixReads += 1
          throw new Error(`chat report touched durable prefix index ${index}`)
        }
      }
      return Reflect.get(target, property, receiver)
    }
  })

  const batch = buildLatestChatReportBatch(history)
  assert(batch, "the latest turn should produce a report batch")
  assert.equal(prefixReads, 0, "report projection must not read the 10k durable prefix")
  assert.equal(
    batch.messageIds[0],
    "message-9500",
    "the initiating user prompt should remain first"
  )
  assert.equal(
    batch.messageIds.at(-1),
    "message-9999",
    "the newest completion should remain in the bounded tail"
  )
  assert.equal(
    batch.messageIds.length,
    CHAT_REPORT_MAX_BATCH_MESSAGES,
    "a tool-heavy turn should be capped by message count"
  )
}

function testChatReportContentBudgetIsBounded(): void {
  const messages = [
    message(0, "user", "u".repeat(100_000)),
    ...Array.from({ length: 12 }, (_, index) =>
      message(index + 1, "assistant", "a".repeat(100_000))
    )
  ]
  const batch = buildLatestChatReportBatch(messages)
  assert(batch)
  const contentChars = batch.payload.reduce((total, item) => total + item.content.length, 0)
  assert(
    contentChars <= CHAT_REPORT_MAX_BATCH_CHARS,
    "one report batch must retain a bounded amount of text"
  )
}

function testChatReportCacheBoundsThreadsAndIds(): void {
  const threadIds = Array.from(
    { length: CHAT_REPORT_UPLOAD_CACHE_MAX_THREADS + 1 },
    (_, index) => `report-lru-${index}`
  )
  for (const [index, threadId] of threadIds.entries()) {
    clearChatReportUploadState(threadId)
    const ids = [`uploaded-${index}`]
    assert.equal(reserveChatReportMessageIds(threadId, ids).length, 1)
    markChatReportUploadSucceeded(threadId, ids)
  }

  assert.deepEqual(
    reserveChatReportMessageIds(threadIds[0], ["uploaded-0"]),
    ["uploaded-0"],
    "the oldest idle thread cache should be evicted"
  )
  assert.equal(
    reserveChatReportMessageIds(
      threadIds[threadIds.length - 1],
      [`uploaded-${threadIds.length - 1}`]
    ).length,
    0,
    "the newest thread should retain its dedupe state"
  )

  const inFlightThreadId = "report-in-flight-ring"
  clearChatReportUploadState(inFlightThreadId)
  assert.equal(
    reserveChatReportMessageIds(
      inFlightThreadId,
      Array.from(
        { length: CHAT_REPORT_UPLOAD_CACHE_MAX_IN_FLIGHT_IDS_PER_THREAD + 100 },
        (_, index) => `in-flight-${index}`
      )
    ).length,
    CHAT_REPORT_UPLOAD_CACHE_MAX_IN_FLIGHT_IDS_PER_THREAD,
    "a stalled request must not retain an unbounded id set"
  )

  const boundedThreadId = "report-id-ring"
  clearChatReportUploadState(boundedThreadId)
  const uploadedIds = Array.from(
    { length: CHAT_REPORT_UPLOAD_CACHE_MAX_IDS_PER_THREAD + 1 },
    (_, index) => `ring-${index}`
  )
  markChatReportMessageIdsUploaded(boundedThreadId, uploadedIds)
  assert.deepEqual(
    reserveChatReportMessageIds(boundedThreadId, [uploadedIds[0]]),
    [uploadedIds[0]],
    "the per-thread ring should release its oldest uploaded id"
  )
  assert.equal(
    reserveChatReportMessageIds(boundedThreadId, [uploadedIds.at(-1)!]).length,
    0,
    "the per-thread ring should retain its newest uploaded id"
  )

  for (const threadId of [...threadIds, boundedThreadId, inFlightThreadId]) {
    clearChatReportUploadState(threadId)
  }
}

async function testChatContainerCancelsComponentOwnedWork(): Promise<void> {
  const source = (
    await readFile(
      resolve(__dirname, "../src/renderer/src/components/chat/ChatContainer.tsx"),
      "utf8"
    )
  ).replace(/\r\n/g, "\n")

  assert.match(
    source,
    /const batch = buildLatestChatReportBatch\(msgs\)/,
    "the debounce should capture only the bounded latest-turn batch"
  )
  assert.doesNotMatch(
    source,
    /const messagesForUpload = msgs\.slice\(\)/,
    "the debounce must not clone the complete loaded history"
  )
  assert.match(
    source,
    /chatReportDisposedRef\.current = true[\s\S]*Object\.values\(chatReportUploadTimersRef\.current\)[\s\S]*Object\.values\(chatReportRetryTimersRef\.current\)[\s\S]*Object\.values\(chatReportAbortControllersRef\.current\)[\s\S]*controller\?\.abort[\s\S]*chatReportPendingBatchesRef\.current = \{\}/,
    "unmount must abort uploads, cancel timers and release the bounded pending batch"
  )
}

async function main(): Promise<void> {
  testTenThousandMessageHistoryReadsOnlyRecentTurn()
  testChatReportContentBudgetIsBounded()
  testChatReportCacheBoundsThreadsAndIds()
  await testChatContainerCancelsComponentOwnedWork()
  console.log("chat report performance contracts passed")
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
