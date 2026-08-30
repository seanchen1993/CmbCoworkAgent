import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  config: {
    enabled: true,
    intervalMinutes: 30,
    lastRunAt: null
  }
}))

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("../storage", () => ({
  getHeartbeatConfig: () => mocks.config,
  getHeartbeatContent: vi.fn(),
  saveHeartbeatConfig: vi.fn(),
  getGlobalRoutingMode: vi.fn()
}))
vi.mock("../routing", () => ({ resolveModel: vi.fn() }))
vi.mock("../agent/runtime", () => ({
  createAgentRuntime: vi.fn(),
  getCheckpointer: vi.fn(),
  closeCheckpointer: vi.fn(),
  pinCheckpointer: vi.fn(),
  reviveRetiredThread: vi.fn()
}))
vi.mock("../agent/workflow/run-store", () => ({ reviveWorkflowThread: vi.fn() }))
vi.mock("../db", () => ({
  createThread: vi.fn(),
  getThread: vi.fn(),
  updateThread: vi.fn()
}))
vi.mock("../agent/stream-converter", () => ({ StreamConverter: class {} }))
vi.mock("./notify", () => ({ notifyIfBackground: vi.fn() }))
vi.mock("../app-attention-events", () => ({ emitAppAttention: vi.fn() }))
vi.mock("./event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("./heartbeat-session", () => ({ HEARTBEAT_THREAD_ID: "heartbeat" }))

import {
  beginHeartbeatWorkspaceReset,
  isHeartbeatRunning,
  startHeartbeat,
  stopHeartbeat
} from "./heartbeat"

describe("heartbeat timer invalidation", () => {
  afterEach(() => {
    stopHeartbeat()
    vi.restoreAllMocks()
  })

  it("ignores a timeout callback that was queued before a workspace reset", () => {
    const queuedCallbacks: Array<() => void> = []
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      queuedCallbacks.push(callback)
      return 1 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
    // Model the Node edge case under review: clearing the handle cannot remove
    // a callback that has already reached the event-loop queue.
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {})

    startHeartbeat()
    expect(queuedCallbacks).toHaveLength(1)

    const staleCallback = queuedCallbacks[0]
    const releaseWorkspaceReset = beginHeartbeatWorkspaceReset()
    releaseWorkspaceReset()
    staleCallback()

    expect(isHeartbeatRunning()).toBe(false)
  })
})
