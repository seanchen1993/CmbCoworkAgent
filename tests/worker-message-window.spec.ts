/**
 * Run: npx tsx tests/worker-message-window.spec.ts
 */

import assert from "assert"
import { readFileSync } from "fs"
import { join } from "path"
import {
  buildWorkerMessageWindow,
  WORKER_MESSAGE_WINDOW_SIZE
} from "../src/renderer/src/lib/worker-message-window"

const history = Array.from({ length: 2_500 }, (_, index) => ({ id: `message-${index}` }))
let stablePrefixReads = 0
const guardedHistory = new Proxy(history, {
  get(target, property, receiver) {
    const index = typeof property === "string" && /^\d+$/.test(property) ? Number(property) : -1
    if (index >= 0 && index < target.length - WORKER_MESSAGE_WINDOW_SIZE) {
      stablePrefixReads += 1
      throw new Error(`window read stable prefix index ${index}`)
    }
    return Reflect.get(target, property, receiver)
  }
})

const latest = buildWorkerMessageWindow(guardedHistory, null)
assert.equal(latest.messages.length, WORKER_MESSAGE_WINDOW_SIZE)
assert.equal(latest.messages[0].id, "message-2260")
assert.equal(latest.messages.at(-1)?.id, "message-2499")
assert.equal(stablePrefixReads, 0, "the newest render window must not read detached history")

const older = buildWorkerMessageWindow(history, latest.start)
assert.equal(older.start, 2_020)
assert.equal(older.end, 2_260)
assert.equal(older.messages.length, WORKER_MESSAGE_WINDOW_SIZE)

const panelSource = readFileSync(
  join(process.cwd(), "src/renderer/src/components/chat/WorkerStreamPanel.tsx"),
  "utf8"
)
assert.match(panelSource, /windowMessages\.map\(\(message, index\) =>/)
assert.doesNotMatch(
  panelSource,
  /\{messages\.map\(\(message, index\) =>/,
  "WorkerStreamPanel must never remount the full merged transcript"
)

console.log("worker message window tests passed")
