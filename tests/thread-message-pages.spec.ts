import assert from "node:assert/strict"
import {
  mergeLatestThreadMessagePage,
  prependThreadMessagePage
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

console.log("thread message page merge contracts passed")
