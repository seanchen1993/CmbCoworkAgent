import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AIMessage, AIMessageChunk } from "@langchain/core/messages"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  onLocalThreadRunLeaseReleased,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"
import { FunctionTurnLifecycle, type FunctionTurnLifecycleHost } from "./turn-lifecycle"
import { FunctionTurnRun } from "./turn-run"

const fixture = vi.hoisted(() => ({ manager: undefined as unknown }))
vi.mock("../manager", () => ({ getModsManager: () => fixture.manager }))

const start = vi.fn<FunctionTurnLifecycleHost["start"]>(async () => {})
const complete = vi.fn<FunctionTurnLifecycleHost["complete"]>(async () => {})
const cleanup = vi.fn()
const error = vi.fn()
let lifecycle: FunctionTurnLifecycle
let controller: AbortController

beforeEach(() => {
  vi.clearAllMocks()
  controller = new AbortController()
  lifecycle = new FunctionTurnLifecycle({
    start,
    complete,
    error,
    isBusy: (threadId) => !!getLocalThreadRunLease(threadId),
    onIdle: (listener) => onLocalThreadRunLeaseReleased((lease) => listener(lease.threadId))
  })
  fixture.manager = {
    startFunctionTurn: lifecycle.start.bind(lifecycle),
    functionTurns: lifecycle,
    releaseExpiredRuntimeBindings: cleanup
  }
  claimLocalThreadRunLease({ threadId: "background", owner: "scheduler", runId: "physical" })
})

afterEach(() => {
  lifecycle.close()
  const lease = getLocalThreadRunLease("background")
  if (lease) releaseLocalThreadRunLease(lease.threadId, lease.owner, lease.runId)
  vi.restoreAllMocks()
})

function run(): FunctionTurnRun {
  return new FunctionTurnRun({
    workspace: "/workspace",
    threadId: "background",
    runId: "physical",
    turnId: "actual-user-message",
    text: "request",
    owner: "scheduler",
    signal: controller.signal,
    cancel: () => controller.abort()
  })
}

it("deduplicates retries and publishes real observations only after the physical owner releases", async () => {
  const turn = run()
  await turn.start()
  await turn.start()
  expect(start).toHaveBeenCalledTimes(1)
  lifecycle.observe(
    "background",
    "physical",
    new AIMessage({
      id: "response",
      content: "answer",
      usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      response_metadata: { model_name: "real-model" }
    })
  )
  turn.finish("answer")
  turn.finish("error")
  expect(complete).not.toHaveBeenCalled()
  expect(cleanup).toHaveBeenCalledTimes(1)
  releaseLocalThreadRunLease("background", "scheduler", "physical")
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
  expect(complete.mock.calls[0]?.[1]).toMatchObject({
    turnId: "actual-user-message",
    reason: "answer",
    answer: "answer",
    isAborted: false,
    usage: { input_tokens: 3, output_tokens: 2, model: "real-model" }
  })
  await expect(turn.start()).rejects.toThrow("MODS_TURN_ENDING")
})

it("cancels the exact background controller and retains only main partial output", async () => {
  const turn = run()
  await turn.start()
  const payload = (id: string, content: string, metadata = {}) =>
    JSON.parse(JSON.stringify([new AIMessageChunk({ id, content }), metadata]))
  turn.observeStream("messages", payload("main", "partial"))
  turn.observeStream("messages", payload("child", "private child", { checkpoint_ns: "tools:1" }))
  turn.observeStream(
    "messages",
    payload("summary", "private summary", {
      tags: ["cmb:context-compaction"]
    })
  )
  lifecycle.abort("/workspace", "background", "actual-user-message")
  expect(controller.signal.aborted).toBe(true)
  turn.finish("error")
  releaseLocalThreadRunLease("background", "scheduler", "physical")
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
  expect(complete.mock.calls[0]?.[1]).toMatchObject({
    reason: "aborted",
    isAborted: true,
    answer: "partial"
  })
})

it("refuses stale cancellation after same-owner lease handoff", async () => {
  const turn = run()
  await turn.start()
  claimLocalThreadRunLease({
    threadId: "background",
    owner: "scheduler",
    runId: "replacement",
    handoffFromRunId: "physical"
  })
  expect(() => lifecycle.abort("/workspace", "background", "actual-user-message")).toThrow(
    "run lease mismatch"
  )
  expect(controller.signal.aborted).toBe(false)
  turn.finish("error")
  expect(complete).not.toHaveBeenCalled()
  releaseLocalThreadRunLease("background", "scheduler", "replacement")
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
})

it("keeps optional settlement failures from trapping transport cleanup", async () => {
  const turn = run()
  await turn.start()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(lifecycle, "finish").mockImplementation(() => {
    throw new Error("settlement failed")
  })
  expect(() => turn.finish("error")).not.toThrow()
  expect(cleanup).toHaveBeenCalledWith("background")
})

it("does not create phantom events when no Mods manager is installed", async () => {
  fixture.manager = undefined
  const turn = run()
  await turn.start()
  turn.finish("answer")
  expect(start).not.toHaveBeenCalled()
  expect(complete).not.toHaveBeenCalled()
})
