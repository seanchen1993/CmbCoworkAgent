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
  imRunner: read("src/main/services/im/remote-runner.ts"),
  scheduler: read("src/main/services/scheduler.ts"),
  heartbeat: read("src/main/services/heartbeat.ts"),
  runtime: read("src/main/agent/runtime.ts"),
  managedAction: read("src/main/harness-board/auto-mode-action-executor.ts"),
  managedController: read("src/main/harness-board/auto-mode-controller.ts")
}

const expectedDirectCalls: Record<keyof typeof sources, number> = {
  desktop: 0,
  standardTurn: 0,
  imRunner: 0,
  scheduler: 1,
  heartbeat: 1,
  runtime: 4,
  managedAction: 0,
  managedController: 0
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
  count(sources.standardTurn, "return createAgentRuntime(options)") === 1,
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
  sources.managedAction.includes("managedExecution: true") &&
    invoke.includes("managedExecution,") &&
    invoke.includes("managedExecution === true || isActiveManagedRunSession(threadId)"),
  "managed launches must preserve one-run execution semantics through the shared invoke path"
)
assert(
  invoke.includes("onWorkflowLaunched") &&
    resume.includes("onWorkflowLaunched: onResumeWorkflowLaunched") &&
    interrupt.includes("onWorkflowLaunched: onInterruptWorkflowLaunched"),
  "all desktop physical run entry points must report detached workflow launch facts"
)
assert(
  count(invoke, "queueAutoModeAgentTurnEnd({") === 1 &&
    count(resume, "queueAutoModeAgentTurnEnd({") === 1 &&
    count(interrupt, "queueAutoModeAgentTurnEnd({") === 1 &&
    sources.desktop.includes("handleAutoModeAgentTurnEnd({") &&
    sources.managedController.includes("input.executionFacts?.workflowLaunchedRunIds"),
  "managed runs must report terminal events and defer evaluation after detached workflow launches"
)

assert(
  sources.scheduler.includes("const threadId = uuid()") &&
    sources.scheduler.includes("releaseCheckpointerPin = pinCheckpointer(threadId)"),
  "scheduler Runtime must use a fresh, pinned thread"
)
assert(
  sources.heartbeat.includes('import { HEARTBEAT_THREAD_ID } from "./heartbeat-session"') &&
    sources.heartbeat.includes("const threadId = HEARTBEAT_THREAD_ID") &&
    sources.heartbeat.includes("pinCheckpointer(threadId)"),
  "heartbeat Runtime must use its fixed, pinned service thread"
)
assert(
  sources.imRunner.includes("prepareStandardThreadRuntimeFactory({") &&
    sources.imRunner.includes("executePreparedRemoteStandardTurn"),
  "the IM runner must use the controlled standard-turn factory"
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
