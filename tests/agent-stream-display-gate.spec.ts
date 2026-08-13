import { AgentStreamDisplayGate } from "../src/main/ipc/agent-stream-display-gate"

interface FakeWindow {
  id: number
  once: (event: "closed", callback: () => void) => void
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function makeWindow(id: number): FakeWindow {
  let onClosed: (() => void) | null = null
  return {
    id,
    once: (_event, callback) => {
      onClosed = callback
    },
    close: () => onClosed?.()
  } as FakeWindow
}

function testBackgroundThreadsKeepOnlyTheLatestDisplaySnapshot(): void {
  const activeRuns = new Set(["thread-a"])
  const sent: Array<{ channel: string; payload: unknown }> = []
  const gate = new AgentStreamDisplayGate({
    isThreadRunActive: (threadId) => activeRuns.has(threadId),
    send: (_window, channel, payload) => sent.push({ channel, payload })
  })
  const window = makeWindow(1)

  gate.trackWindow(window as never)
  gate.setInterest(window as never, "thread-a", "background")
  gate.remember(window as never, "thread-a", "run-a", "agent:stream:thread-a", "messages", {
    delta: "old"
  })
  gate.remember(window as never, "thread-a", "run-a", "agent:stream:thread-a", "values", {
    messages: [{ content: "latest" }]
  })

  assert(
    !gate.shouldSendImmediately(window as never, "thread-a"),
    "background thread chunks are not sent immediately"
  )
  assert(
    gate.setInterest(window as never, "thread-a", "foreground"),
    "foregrounding an active thread restores one display snapshot"
  )
  assert(sent.length === 1, "a values snapshot replaces stale incremental replay")
  assert(
    JSON.stringify(sent[0].payload).includes("latest"),
    "the restored snapshot contains the latest complete state"
  )
}

function testCompletedRunsDoNotReplayStaleSnapshots(): void {
  const activeRuns = new Set(["thread-a"])
  const sent: Array<{ channel: string; payload: unknown }> = []
  const gate = new AgentStreamDisplayGate({
    isThreadRunActive: (threadId) => activeRuns.has(threadId),
    send: (_window, channel, payload) => sent.push({ channel, payload })
  })
  const window = makeWindow(2)

  gate.setInterest(window as never, "thread-a", "background")
  gate.remember(window as never, "thread-a", "run-a", "agent:stream:thread-a", "values", {
    messages: [{ content: "stale" }]
  })
  activeRuns.delete("thread-a")

  assert(
    !gate.setInterest(window as never, "thread-a", "foreground"),
    "completed threads do not replay a stale live snapshot"
  )
  assert(sent.length === 0, "no stale snapshot is delivered after completion")
}

function main(): void {
  const tests = [
    testBackgroundThreadsKeepOnlyTheLatestDisplaySnapshot,
    testCompletedRunsDoNotReplayStaleSnapshots
  ]
  for (const test of tests) {
    test()
    console.log(`✓ ${test.name}`)
  }
  console.log(`\n${tests.length} passed`)
}

main()
