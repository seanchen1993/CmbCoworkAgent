import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CursorQueue } from "../src/renderer/src/lib/cursor-queue"

const burstQueue = new CursorQueue<number>()
for (let index = 0; index < 100_000; index += 1) burstQueue.push(index)
for (let index = 0; index < 100_000; index += 1) {
  assert.equal(burstQueue.dequeue(), index)
}
assert.equal(burstQueue.length, 0)
assert.equal(burstQueue.backingLength, 0)

const interleavedQueue = new CursorQueue<string>()
interleavedQueue.push("a")
interleavedQueue.push("b")
assert.equal(interleavedQueue.dequeue(), "a")
interleavedQueue.push("c")
assert.deepEqual(interleavedQueue.toArray(), ["b", "c"])
assert.equal(interleavedQueue.dequeue(), "b")
assert.equal(interleavedQueue.dequeue(), "c")

const filteredQueue = new CursorQueue<number>()
filteredQueue.push(1)
filteredQueue.push(2)
filteredQueue.push(3)
assert.equal(filteredQueue.dequeue(), 1)
filteredQueue.replace(filteredQueue.toArray().filter((value) => value !== 2))
assert.deepEqual(filteredQueue.toArray(), [3])

const transportSource = readFileSync(
  join(process.cwd(), "src/renderer/src/lib/electron-transport.ts"),
  "utf8"
)
assert.match(transportSource, /new CursorQueue<QueuedStreamEvent>\(\)/)
assert.doesNotMatch(transportSource, /eventQueue\.shift\(\)/)
assert.match(transportSource, /eventQueue\.toArray\(\)\.filter/)

console.log("cursor queue tests passed")
