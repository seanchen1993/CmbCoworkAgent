import { afterEach, expect, it, vi } from "vitest"
import {
  acknowledgePendingWorkflowControl,
  discardPendingWorkflowControl,
  readPendingWorkflowControl,
  rememberPendingWorkflowControl
} from "./bot-workflow-pending"
import { createStableAsyncTasksClock } from "../components/bots/upstream/grok-async-clock"

afterEach(() => vi.unstubAllGlobals())
it("recovers one exact child command and fences different branches, restores and newer requests", () => {
  const items = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  })
  const input = {
    nonce: "original",
    conversationId: "conversation",
    runId: "child",
    threadRootId: "branch",
    revision: 3,
    operation: "message" as const,
    text: "verify record 42"
  }
  rememberPendingWorkflowControl(input, "epoch")
  expect(readPendingWorkflowControl(input, "epoch")).toEqual(input)
  expect(readPendingWorkflowControl({ ...input, runId: "other" }, "epoch")).toBeNull()
  expect(readPendingWorkflowControl({ ...input, threadRootId: undefined }, "epoch")).toBeNull()
  expect(readPendingWorkflowControl(input, "restored")).toBeNull()
  const newer = { ...input, nonce: "later", revision: 4 }
  expect(() => rememberPendingWorkflowControl(newer, "epoch")).toThrow()
  const key = [...items.keys()][0]
  items.set(key, JSON.stringify({ dataEpoch: "epoch", input: newer }))
  expect(acknowledgePendingWorkflowControl(input, "epoch")).toBe(false)
  expect(readPendingWorkflowControl(input, "epoch")).toEqual(newer)
  items.set(key, JSON.stringify({ dataEpoch: "epoch", input: { ...input, runId: "foreign" } }))
  expect(readPendingWorkflowControl(input, "epoch")).toBeNull()
  items.set(key, "{".repeat(220_001))
  expect(readPendingWorkflowControl(input, "epoch")).toBeNull()
  expect(() => rememberPendingWorkflowControl(newer, "epoch")).toThrow()
  const damaged = items.get(key)!
  expect(discardPendingWorkflowControl(input, "epoch", "changed")).toBe(false)
  expect(discardPendingWorkflowControl(input, "epoch", damaged)).toBe(true)
  rememberPendingWorkflowControl(newer, "epoch")
  expect(acknowledgePendingWorkflowControl(newer, "epoch")).toBe(true)
  expect(items.size).toBe(0)
})
it("does not dispatch when the command identity cannot be saved", () => {
  vi.stubGlobal("localStorage", {
    setItem: () => {
      throw new Error("quota")
    }
  })
  expect(() =>
    rememberPendingWorkflowControl(
      {
        nonce: "stop",
        conversationId: "conversation",
        runId: "child",
        revision: 2,
        operation: "cancel"
      },
      "epoch"
    )
  ).toThrow("尚未提交")
})
it("refreshes the copied stable clock when a task panel is reopened after idle", () => {
  let now = 1000
  const dispose = vi.fn()
  const clock = createStableAsyncTasksClock({ now: () => now }, { start: () => ({ dispose }) })
  const unsubscribe = clock.subscribe(() => {})
  expect(clock.now()).toBe(1000)
  unsubscribe()
  now = 3_600_000
  const second = clock.subscribe(() => {})
  expect(clock.now()).toBe(now)
  expect(clock.now()).toBe(clock.now())
  second()
  expect(dispose).toHaveBeenCalledTimes(2)
})
