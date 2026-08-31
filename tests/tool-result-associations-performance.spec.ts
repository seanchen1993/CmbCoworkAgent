/**
 * Run: npx tsx tests/tool-result-associations-performance.spec.ts
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { buildToolResultAssociations } from "../src/renderer/src/lib/worker-tool-result-key"
import type { Message } from "../src/renderer/src/types"

const callCount = 2_000
const calls: Message[] = Array.from({ length: callCount }, (_, index) => ({
  id: `worker-turn-test-${index + 1}::assistant-${index}`,
  role: "assistant" as const,
  content: "",
  tool_calls: [{ id: "shared-call", name: "lookup", args: { index } }],
  created_at: new Date(index)
}))
const results: Message[] = Array.from({ length: callCount }, (_, index) => ({
  id: `tool-result-${index}`,
  role: "tool" as const,
  content: `result-${index}`,
  tool_call_id: "shared-call",
  created_at: new Date(callCount + index)
}))

const associations = buildToolResultAssociations([...calls, ...results])
assert.equal(associations.size, callCount)
assert.equal(
  associations.get(
    `worker-turn-test-${callCount}::assistant-${callCount - 1}` +
      `::cmb-tool-call:0:worker-turn-test-${callCount}::shared-call`
  )?.content,
  "result-0",
  "unscoped results must continue to consume the latest pending turn first"
)

const source = readFileSync(
  resolve(__dirname, "../src/renderer/src/lib/worker-tool-result-key.ts"),
  "utf8"
)
assert.doesNotMatch(source, /pendingCalls\.filter|pendingCalls\.indexOf|pendingCalls\.splice/)
assert.match(source, /pendingCallsByRawId/)
assert.match(source, /activeCountByTurn/)

console.log("tool result association performance tests passed")
