import assert from "node:assert/strict"
import {
  createTargetedThreadMessageWindow,
  mergeLatestThreadMessagePage,
  prependBoundedThreadMessagePage,
  prependThreadMessagePage,
  restoreLatestThreadMessageWindow
} from "../src/renderer/src/lib/thread-message-pages"
import type { Message } from "../src/renderer/src/types"

const createdAt = new Date("2026-08-21T00:00:00.000Z")
const message = (id: string): Message => ({
  id,
  role: "assistant",
  content: id,
  created_at: createdAt
})

const retained = [message("m-3"), message("m-4")]
const next = prependThreadMessagePage(retained, [message("m-1"), message("m-2"), message("m-3")])
assert.deepEqual(next.map((item) => item.id), ["m-1", "m-2", "m-3", "m-4"])
assert.equal(next[2], retained[0], "dedupe must retain the existing boundary object")
assert.equal(next[3], retained[1], "pagination must preserve stable message references")
assert.equal(prependThreadMessagePage(retained, [message("m-3")]), retained)

const poisonedPrefix = Array.from({ length: 9_500 }, (_, index) =>
  new Proxy(message(`poison-${index}`), {
    get() {
      throw new Error("stable historical prefix was inspected")
    }
  })
)
const durableTail = Array.from({ length: 500 }, (_, index) => message(`m-${9_500 + index}`))
const longTranscript = [...poisonedPrefix, ...durableTail]
const shiftedLatestPage = Array.from({ length: 500 }, (_, index) =>
  message(`m-${9_501 + index}`)
)
shiftedLatestPage[shiftedLatestPage.length - 1] = {
  ...shiftedLatestPage[shiftedLatestPage.length - 1],
  content: "durable completion"
}
const latestMerge = mergeLatestThreadMessagePage(longTranscript, shiftedLatestPage)
assert.equal(latestMerge.retainedPrefixLength, 9_501)
assert.equal(latestMerge.addedDurableMessageCount, 1)
assert.equal(latestMerge.messages.length, 10_001)
assert.equal(latestMerge.messages[0], poisonedPrefix[0])
assert.equal(latestMerge.messages.at(-1)?.id, "m-10000")
assert.equal(latestMerge.messages.at(-1)?.content, "durable completion")

const residentTail = Array.from({ length: 300 }, (_, index) => message(`tail-${index}`))
const firstOlderPage = Array.from({ length: 500 }, (_, index) => message(`older-${index}`))
const bounded = prependBoundedThreadMessagePage(residentTail, firstOlderPage, {
  maximumResidentMessages: 600,
  protectedTailMessages: 100
})
assert.equal(bounded.messages.length, 600, "history pagination must have a hard resident cap")
assert.deepEqual(
  bounded.messages.slice(0, 3).map((item) => item.id),
  ["older-0", "older-1", "older-2"]
)
assert.deepEqual(
  bounded.messages.slice(-3).map((item) => item.id),
  ["tail-297", "tail-298", "tail-299"],
  "the latest tail must remain resident for streaming reconciliation"
)
assert.deepEqual(bounded.gap, {
  afterMessageId: "older-499",
  beforeMessageId: "tail-200",
  evictedMessageCount: 200,
  reloadBeforeOrdinal: null,
  reloadBeforeMessageId: null,
  reloadAnchorMessageId: null,
  reloadTargetMessageId: null
})

const secondOlderPage = Array.from({ length: 500 }, (_, index) => message(`ancient-${index}`))
const shifted = prependBoundedThreadMessagePage(bounded.messages, secondOlderPage, {
  maximumResidentMessages: 600,
  protectedTailMessages: 100,
  existingGap: bounded.gap
})
assert.equal(shifted.messages.length, 600)
assert.equal(shifted.messages[0].id, "ancient-0")
assert.equal(shifted.messages[499].id, "ancient-499")
assert.equal(shifted.messages[500].id, "tail-200")
assert.equal(
  shifted.gap?.evictedMessageCount,
  700,
  "subsequent pages must accumulate, rather than forget, the released middle"
)

const targetPage = Array.from({ length: 240 }, (_, index) => message(`target-${index}`))
const targeted = createTargetedThreadMessageWindow(shifted.messages, targetPage, {
  targetMessageId: "target-200",
  protectedTailMessages: 100,
  maximumResidentMessages: 600
})
assert(targeted.messages.some((item) => item.id === "target-200"))
assert.deepEqual(
  targeted.messages.slice(-3).map((item) => item.id),
  ["tail-297", "tail-298", "tail-299"],
  "search hydration must not discard the active tail"
)
assert(targeted.gap, "a non-contiguous targeted search page needs an explicit gap marker")

const latestPage = Array.from({ length: 500 }, (_, index) => message(`latest-${index}`))
const restoredLatest = restoreLatestThreadMessageWindow(targeted.messages, latestPage, {
  maximumResidentMessages: 600,
  protectedLocalTailMessages: 100,
  existingGap: targeted.gap
})
assert.equal(restoredLatest.gap, null)
assert(restoredLatest.messages.length <= 600)
assert.equal(restoredLatest.messages.at(-1)?.id, "tail-299")
assert(
  restoredLatest.messages.some((item) => item.id === "latest-499"),
  "return-to-bottom hydration must restore the newest durable page"
)

console.log("thread message page merge contracts passed")
