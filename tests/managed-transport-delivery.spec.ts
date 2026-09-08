/**
 * Delivery contract for runs no desktop window owns.
 *
 * Two things are load-bearing here. The window shim, because agent.ts reaches
 * into `delivery.window` and the cast silences the compiler. And the channel
 * translation: the run body publishes raw LangGraph frames on
 * `agent:stream:<threadId>`, which only a renderer that invoked the run
 * subscribes to, while the standing subscription for background runs is
 * `scheduler:stream:<threadId>` and expects converted events. Without the
 * translation an IM turn reaches Feishu and the database but never repaints an
 * open desktop session.
 *
 * Run:
 *   npx tsx tests/managed-transport-delivery.spec.ts
 */

import assert from "node:assert/strict"
import {
  createManagedTransportAgentRunDelivery,
  MANAGED_TRANSPORT_WINDOW_ID
} from "../src/main/agent/managed-transport-delivery"
import type { SchedulerRendererEvent } from "../src/main/agent/stream-converter"
import { ImGoalRunBridge } from "../src/main/services/im/goal-runner"
import { registerAgentRunImplementation, startAgentRun } from "../src/main/agent/agent-run-service"

interface Mirrored {
  threadId: string
  event: SchedulerRendererEvent
}
interface Broadcast {
  channel: string
  payload: unknown
}

function recorder(): {
  mirrored: Mirrored[]
  broadcasts: Broadcast[]
  deps: Parameters<typeof createManagedTransportAgentRunDelivery>[0]
} {
  const mirrored: Mirrored[] = []
  const broadcasts: Broadcast[] = []
  return {
    mirrored,
    broadcasts,
    deps: {
      mirror: (threadId, event) => mirrored.push({ threadId, event }),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload })
    }
  }
}

function testRunIsNeverGatedOnAWindow(): void {
  const delivery = createManagedTransportAgentRunDelivery(recorder().deps)
  assert.equal(
    delivery.isAvailable(),
    true,
    "a managed run must proceed whether or not anyone is watching"
  )
}

function testStreamFramesReachTheChannelTheRendererListensOn(): void {
  const { mirrored, broadcasts, deps } = recorder()
  const delivery = createManagedTransportAgentRunDelivery(deps)

  delivery.send("agent:stream:t1", { type: "done" })

  assert.equal(broadcasts.length, 0, "a thread stream must not go out on the raw agent channel")
  assert.deepEqual(
    mirrored.map((entry) => ({ threadId: entry.threadId, type: entry.event.type })),
    [
      { threadId: "t1", type: "started" },
      { threadId: "t1", type: "done" }
    ],
    "the first frame opens the renderer's loading state, as the transport used to do itself"
  )
}

function testLifecycleAndCustomEventsSurviveTranslation(): void {
  const { mirrored, deps } = recorder()
  const delivery = createManagedTransportAgentRunDelivery(deps)

  delivery.send("agent:stream:t1", { type: "custom", data: { type: "token_usage", total: 12 } })
  delivery.send("agent:stream:t1", { type: "error", error: "boom" })

  const events = mirrored.map((entry) => entry.event)
  assert.deepEqual(events[1], { type: "custom", data: { type: "token_usage", total: 12 } })
  assert.deepEqual(events[2], { type: "error", error: "boom" })
}

function testOnlyTheThreadWideChannelIsTranslated(): void {
  const { mirrored, broadcasts, deps } = recorder()
  const delivery = createManagedTransportAgentRunDelivery(deps)

  // Request-scoped and coordinator-internal sub-channels belong to a specific
  // renderer subscription; rewriting them onto the thread stream would deliver
  // one run's frames to every listener of that thread.
  delivery.send("agent:stream:t1:req-7", { type: "done" })
  delivery.send("agent:stream:t1:coordinator-internal", { type: "done" })
  delivery.send("threads:changed", undefined)

  assert.equal(mirrored.length, 0, "sub-channels must not be rewritten onto the thread stream")
  assert.deepEqual(
    broadcasts.map((entry) => entry.channel),
    ["agent:stream:t1:req-7", "agent:stream:t1:coordinator-internal", "threads:changed"],
    "everything else is forwarded untouched"
  )
}

function testWindowShimRoutesThroughTheSameTranslation(): void {
  const { mirrored, deps } = recorder()
  // The run body sends through safeSendToWindow(window, ...), i.e. the shim's
  // webContents — not delivery.send. Both must land in the same place.
  const shim = createManagedTransportAgentRunDelivery(deps).window as unknown as {
    id: number
    isDestroyed(): boolean
    webContents: { send(channel: string, payload: unknown): void; isDestroyed(): boolean }
  }

  assert.equal(shim.isDestroyed(), false)
  assert.equal(shim.webContents.isDestroyed(), false)
  shim.webContents.send("agent:stream:t1", { type: "done" })
  assert.deepEqual(
    mirrored.map((entry) => entry.event.type),
    ["started", "done"]
  )
}

function testSyntheticIdCannotCollideWithARealWindow(): void {
  // agent.ts keys coordinator-worker maps by window.id; Electron allocates
  // positive ids, so a colliding id would let a managed run read or clobber a
  // real window's worker state.
  assert.ok(
    MANAGED_TRANSPORT_WINDOW_ID < 0,
    `managed window id must be negative, got ${MANAGED_TRANSPORT_WINDOW_ID}`
  )
  const shim = createManagedTransportAgentRunDelivery(recorder().deps).window as unknown as {
    id: number
  }
  assert.equal(shim.id, MANAGED_TRANSPORT_WINDOW_ID)
}

function testAnUnsupportedWindowMemberExplainsItself(): void {
  // The source guard reads agent.ts for `window.<member>`, so an aliased access
  // slips past it. This is what the run would hit instead of a bare
  // "x is not a function" with nothing pointing at why this window differs.
  const shim = createManagedTransportAgentRunDelivery(recorder().deps).window as unknown as Record<
    string,
    unknown
  >
  assert.throws(
    () => shim.focus,
    /BrowserWindow\.focus.*does not implement.*managed-transport-delivery\.ts/s,
    "an unsupported member must name itself and say where to fix it"
  )
  assert.throws(
    () => (shim.webContents as Record<string, unknown>).executeJavaScript,
    /executeJavaScript/
  )
}

function testProbingTheShimStaysSafe(): void {
  // Node inspects objects while logging and awaiting; throwing on those probes
  // would break diagnostics instead of revealing a real mistake.
  const delivery = createManagedTransportAgentRunDelivery(recorder().deps)
  const shim = delivery.window as unknown as Record<string | symbol, unknown>
  assert.doesNotThrow(() => shim.then, "a thenable probe must not throw when awaited")
  assert.doesNotThrow(() => shim[Symbol.toPrimitive])
  assert.doesNotThrow(() => JSON.stringify({ id: (shim as { id: number }).id }))
  assert.doesNotThrow(() => String(delivery.isAvailable()))
}

async function testGoalRunSurvivesWithNoDesktopWindow(): Promise<void> {
  // The regression this delivery fixes: ImGoalRunBridge.requireDelivery() threw
  // "主窗口尚未就绪" whenever mainWindow was null, so an IM Goal turn failed
  // outright if nobody had the desktop open.
  let started = false
  const bridge = new ImGoalRunBridge({
    getDelivery: () => createManagedTransportAgentRunDelivery(recorder().deps),
    hasActiveGoal: () => false,
    startRun: async (request, delivery, context) => {
      started = true
      assert.equal(delivery.isAvailable(), true)
      assert.equal(context.source, "im")
      return {
        threadId: request.threadId,
        completion: (async () => {
          await context.onFinalAssistant?.({ messageId: "m1", finalText: "done" })
        })()
      }
    }
  })

  const reply = await bridge.run({
    threadId: "t1",
    userMessageId: "u1",
    runId: "run-1",
    agentMode: "normal",
    signal: new AbortController().signal,
    prepared: { visibleText: "跑一下目标" }
  } as Parameters<ImGoalRunBridge["run"]>[0])

  assert.equal(started, true, "the goal run must reach startAgentRun without a window")
  assert.equal(reply, "done")
}

async function main(): Promise<void> {
  for (const test of [
    testRunIsNeverGatedOnAWindow,
    testStreamFramesReachTheChannelTheRendererListensOn,
    testLifecycleAndCustomEventsSurviveTranslation,
    testOnlyTheThreadWideChannelIsTranslated,
    testWindowShimRoutesThroughTheSameTranslation,
    testSyntheticIdCannotCollideWithARealWindow,
    testAnUnsupportedWindowMemberExplainsItself,
    testProbingTheShimStaysSafe
  ]) {
    test()
    console.log(`PASS ${test.name}`)
  }
  await testGoalRunSurvivesWithNoDesktopWindow()
  await testEverySettledRunClosesItsRendererStream()
  console.log("PASS testGoalRunSurvivesWithNoDesktopWindow")
  console.log("managed-transport-delivery.spec.ts passed")
}

async function testEverySettledRunClosesItsRendererStream(): Promise<void> {
  for (const outcome of ["abort", "error", "early-return", "success"] as const) {
    const recording = recorder()
    const delivery = createManagedTransportAgentRunDelivery(recording.deps)
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    registerAgentRunImplementation(async (_request, runDelivery) => {
      runDelivery.send("agent:stream:t1", { type: "custom", data: { type: "hook_notice" } })
      if (outcome === "success") runDelivery.send("agent:stream:t1", { type: "done" })
      await cleanup
      // Cleanup can publish after an earlier terminal, reopening loading.
      runDelivery.send("agent:stream:t1", { type: "custom", data: { type: "hook_notice" } })
      if (outcome === "abort") throw new DOMException("stopped", "AbortError")
      if (outcome === "error") throw new Error("failed")
    })
    const handle = await startAgentRun({ threadId: "t1", message: "hello" }, delivery, {
      source: "im"
    })
    if (outcome !== "success") assert.notEqual(recording.mirrored.at(-1)?.event.type, "done")
    releaseCleanup()
    if (outcome === "abort" || outcome === "error") {
      await assert.rejects(handle.completion)
    } else {
      await handle.completion
    }
    assert.equal(recording.mirrored.at(-1)?.event.type, "done", outcome)
    assert.equal(recording.mirrored.at(-1)?.threadId, "t1")
  }
  console.log("PASS testEverySettledRunClosesItsRendererStream")
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
