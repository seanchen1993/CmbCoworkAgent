/**
 * Behavioural contract for the headless AgentRunDelivery.
 *
 * This delivery exists so a run can execute with no desktop window owning it.
 * It is Electron-free by construction, which is exactly why — unlike the
 * desktop run body it feeds — it can be exercised directly here.
 *
 * Run:
 *   npx tsx tests/headless-agent-run-delivery.spec.ts
 */

import assert from "node:assert/strict"
import {
  createHeadlessAgentRunDelivery,
  HEADLESS_AGENT_RUN_WINDOW_ID
} from "../src/main/agent/headless-delivery"
import { ImGoalRunBridge } from "../src/main/services/im/goal-runner"

interface Sent {
  channel: string
  payload: unknown
}

function recordingBroadcast(): { sent: Sent[]; broadcast: (c: string, p: unknown) => void } {
  const sent: Sent[] = []
  return { sent, broadcast: (channel, payload) => sent.push({ channel, payload }) }
}

function testRunIsNeverGatedOnAWindow(): void {
  const delivery = createHeadlessAgentRunDelivery(() => undefined)
  assert.equal(
    delivery.isAvailable(),
    true,
    "a headless run must proceed whether or not anyone is watching"
  )
}

function testSendReachesEveryOpenRenderer(): void {
  const { sent, broadcast } = recordingBroadcast()
  const delivery = createHeadlessAgentRunDelivery(broadcast)

  delivery.send("scheduler:stream:t1", { type: "started" })
  assert.deepEqual(sent, [{ channel: "scheduler:stream:t1", payload: { type: "started" } }])
}

function testWindowShimCoversTheSurfaceAgentUses(): void {
  const { sent, broadcast } = recordingBroadcast()
  // The run body reaches these four members through `delivery.window`; the cast
  // in headless-delivery.ts means only this test and the source-shape guard in
  // agent-window-surface.spec.ts prove they exist.
  const shim = createHeadlessAgentRunDelivery(broadcast).window as unknown as {
    id: number
    isDestroyed(): boolean
    webContents: { send(channel: string, payload: unknown): void; isDestroyed(): boolean }
  }

  assert.equal(shim.isDestroyed(), false, "a headless window is never destroyed")
  assert.equal(shim.webContents.isDestroyed(), false, "headless webContents is never destroyed")

  shim.webContents.send("agent:stream:t1", { type: "token" })
  assert.deepEqual(
    sent,
    [{ channel: "agent:stream:t1", payload: { type: "token" } }],
    "window.webContents.send must go out over the same broadcast as delivery.send"
  )
}

function testSyntheticIdCannotCollideWithARealWindow(): void {
  // Electron allocates BrowserWindow ids as positive integers. agent.ts keys
  // coordinator-worker maps by window.id, so a colliding id would let a headless
  // run read or clobber a real window's worker state.
  assert.ok(
    HEADLESS_AGENT_RUN_WINDOW_ID < 0,
    `headless window id must be negative, got ${HEADLESS_AGENT_RUN_WINDOW_ID}`
  )
  const first = createHeadlessAgentRunDelivery(() => undefined).window as unknown as { id: number }
  const second = createHeadlessAgentRunDelivery(() => undefined).window as unknown as { id: number }
  assert.equal(first.id, HEADLESS_AGENT_RUN_WINDOW_ID)
  assert.equal(second.id, first.id, "all headless runs share one id; none owns worker focus state")
}

async function testGoalRunSurvivesWithNoDesktopWindow(): Promise<void> {
  // The regression this delivery fixes: ImGoalRunBridge.requireDelivery() threw
  // "主窗口尚未就绪" whenever mainWindow was null, so an IM Goal turn failed
  // outright if nobody had the desktop open.
  let started = false
  const bridge = new ImGoalRunBridge({
    getDelivery: () => createHeadlessAgentRunDelivery(() => undefined),
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
  const sync = [
    testRunIsNeverGatedOnAWindow,
    testSendReachesEveryOpenRenderer,
    testWindowShimCoversTheSurfaceAgentUses,
    testSyntheticIdCannotCollideWithARealWindow
  ]
  for (const test of sync) {
    test()
    console.log(`PASS ${test.name}`)
  }
  await testGoalRunSurvivesWithNoDesktopWindow()
  console.log("PASS testGoalRunSurvivesWithNoDesktopWindow")
  console.log("headless-agent-run-delivery.spec.ts passed")
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
