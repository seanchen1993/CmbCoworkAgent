/**
 * Executable inventory of direct createAgentRuntime call sites.
 *
 * Later unified-bot PRs must deliberately update this inventory when a call is
 * moved behind the shared Runtime factory or receives a local run-lease guard.
 */

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const PROJECT_ROOT = resolve(__dirname, "..")

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n")
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1
}

function sliceBetween(source: string, start: string, end: string, label: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert(startIndex >= 0, `${label}: missing ${JSON.stringify(start)}`)
  assert(endIndex > startIndex, `${label}: missing ${JSON.stringify(end)}`)
  return source.slice(startIndex, endIndex)
}

const sources = {
  desktop: read("src/main/ipc/agent.ts"),
  standardTurn: read("src/main/agent/standard-thread-turn.ts"),
  scheduler: read("src/main/services/scheduler.ts"),
  heartbeat: read("src/main/services/heartbeat.ts"),
  legacyChatx: read("src/main/services/chatx.ts"),
  runtime: read("src/main/agent/runtime.ts")
}

const expectedDirectCalls: Record<keyof typeof sources, number> = {
  desktop: 0,
  standardTurn: 0,
  scheduler: 1,
  heartbeat: 1,
  legacyChatx: 1,
  runtime: 4
}

for (const [owner, source] of Object.entries(sources) as [keyof typeof sources, string][]) {
  const actual = count(source, "createAgentRuntime({")
  assert(
    actual === expectedDirectCalls[owner],
    `${owner}: expected ${expectedDirectCalls[owner]} direct Runtime calls, got ${actual}; ` +
      "classify the new/removed entry in docs/chatx-desktop-runtime-entrypoint-inventory.md"
  )
}

assert(
  count(sources.standardTurn, "createAgentRuntime(optionsForModel(modelId))") === 1,
  "the controlled standard-turn factory must be the only shared top-level Runtime constructor"
)

const invoke = sliceBetween(
  sources.desktop,
  "// Handle agent invocation with streaming",
  "// Handle agent resume (after interrupt approval/rejection via useStream)",
  "invoke"
)
const resume = sliceBetween(
  sources.desktop,
  "// Handle agent resume (after interrupt approval/rejection via useStream)",
  "// Handle HITL interrupt response",
  "resume"
)
const interrupt = sliceBetween(
  sources.desktop,
  "// Handle HITL interrupt response",
  "// Handle cancellation",
  "interrupt"
)

assert(
  count(invoke, "invokeRuntimeFactory.create(") === 3,
  "desktop invoke must retain three controlled factory failover sites"
)
assert(
  count(resume, "resumeRuntimeFactory.create(") === 2,
  "desktop resume must retain two controlled factory failover sites"
)
assert(
  count(interrupt, "interruptRuntimeFactory.create(") === 2,
  "desktop interrupt must retain two controlled factory failover sites"
)

assert(
  sources.scheduler.includes("const threadId = uuid()") &&
    sources.scheduler.includes("const releaseCheckpointerPin = pinCheckpointer(threadId)"),
  "scheduler Runtime must use a fresh, pinned thread"
)
assert(
  sources.heartbeat.includes('const HEARTBEAT_THREAD_ID = "heartbeat"') &&
    sources.heartbeat.includes("releaseCheckpointerPin = pinCheckpointer(threadId)"),
  "heartbeat Runtime must use its fixed, pinned service thread"
)
assert(
  sources.legacyChatx.includes("findChatXThread(msg.chatId, msg.fromId)") &&
    sources.legacyChatx.includes("const releaseCheckpointerPin = pinCheckpointer(threadId)"),
  "legacy ChatX Runtime must remain classified until clean-cut deletion"
)
assert(
  count(sources.runtime, "threadId: workerInput.workerThreadId") >= 3 &&
    sources.runtime.includes("threadId: subagentOptions.threadId"),
  "runtime-internal calls must remain isolated on child Runtime thread ids"
)
assert(
  sources.runtime.includes("const checkpointer = await getCheckpointer(threadId)"),
  "every Runtime creation reaches a thread-keyed checkpointer"
)

console.log("desktop-agent-runtime-entrypoints.spec.ts passed")
