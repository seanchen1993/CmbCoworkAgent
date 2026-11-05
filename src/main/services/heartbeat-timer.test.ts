import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  config: {
    enabled: true,
    intervalMinutes: 30,
    prompt: "heartbeat",
    modelId: "model",
    workDir: "/workspace",
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null
  },
  getHeartbeatContent: vi.fn(),
  resolveModel: vi.fn(),
  getCheckpointer: vi.fn(),
  closeCheckpointer: vi.fn(),
  pinCheckpointer: vi.fn(),
  reviveRetiredThread: vi.fn(),
  reviveWorkflowThread: vi.fn(),
  createThread: vi.fn(),
  getThreadCore: vi.fn(),
  updateThread: vi.fn()
}))

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("../storage", () => ({
  getHeartbeatConfig: () => mocks.config,
  getHeartbeatContent: mocks.getHeartbeatContent,
  saveHeartbeatConfig: vi.fn(),
  getGlobalRoutingMode: vi.fn()
}))
vi.mock("../routing", () => ({ resolveModel: mocks.resolveModel }))
vi.mock("../agent/runtime", () => ({
  createAgentRuntime: vi.fn(),
  getCheckpointer: mocks.getCheckpointer,
  closeCheckpointer: mocks.closeCheckpointer,
  pinCheckpointer: mocks.pinCheckpointer,
  reviveRetiredThread: mocks.reviveRetiredThread
}))
vi.mock("../agent/workflow/run-store", () => ({
  reviveWorkflowThread: mocks.reviveWorkflowThread
}))
vi.mock("../db", () => ({
  createThread: mocks.createThread,
  getThreadCore: mocks.getThreadCore,
  updateThread: mocks.updateThread
}))
vi.mock("../agent/stream-converter", () => ({ StreamConverter: class {} }))
vi.mock("./notify", () => ({ notifyIfBackground: vi.fn() }))
vi.mock("../app-attention-events", () => ({ emitAppAttention: vi.fn() }))
vi.mock("./event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("./heartbeat-session", () => ({ HEARTBEAT_THREAD_ID: "heartbeat" }))

import {
  beginHeartbeatWorkspaceReset,
  isHeartbeatRunning,
  runHeartbeatNow,
  startHeartbeat,
  stopHeartbeat
} from "./heartbeat"
import { withThreadRunMutationLock } from "../ipc/thread-run-mutation-lock"

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

  it("waits for same-thread deletion cleanup before reviving and releases the lock on init failure", async () => {
    let markBlockEntered = (): void => undefined
    let releaseBlock = (): void => undefined
    const blockEntered = new Promise<void>((resolve) => {
      markBlockEntered = resolve
    })
    const block = new Promise<void>((resolve) => {
      releaseBlock = resolve
    })
    const deletionCleanup = withThreadRunMutationLock("heartbeat", async () => {
      markBlockEntered()
      await block
    })
    await blockEntered

    mocks.resolveModel.mockResolvedValue({
      resolvedModelId: "model",
      resolvedTier: "premium",
      routeReason: "test"
    })
    mocks.getHeartbeatContent.mockReturnValue("- inspect workspace")
    mocks.getThreadCore.mockReturnValue(null)
    const releasePin = vi.fn()
    mocks.pinCheckpointer.mockReturnValue(releasePin)
    mocks.getCheckpointer.mockResolvedValue({
      getTuple: vi.fn().mockRejectedValue(new Error("initial snapshot failed"))
    })
    mocks.closeCheckpointer.mockResolvedValue(undefined)

    const heartbeat = runHeartbeatNow()
    await vi.waitFor(() => expect(mocks.resolveModel).toHaveBeenCalledTimes(1))
    expect(mocks.reviveRetiredThread).not.toHaveBeenCalled()
    expect(mocks.reviveWorkflowThread).not.toHaveBeenCalled()
    expect(mocks.createThread).not.toHaveBeenCalled()
    expect(mocks.getCheckpointer).not.toHaveBeenCalled()

    releaseBlock()
    await deletionCleanup
    await heartbeat

    expect(mocks.reviveRetiredThread).toHaveBeenCalledWith("heartbeat")
    expect(mocks.reviveWorkflowThread).toHaveBeenCalledWith("heartbeat")
    expect(mocks.createThread).toHaveBeenCalledWith(
      "heartbeat",
      expect.objectContaining({ workspacePath: "/workspace", isHeartbeat: true })
    )
    expect(mocks.getCheckpointer).toHaveBeenCalledWith("heartbeat")
    expect(releasePin).toHaveBeenCalledTimes(1)

    let successorEntered = false
    await withThreadRunMutationLock("heartbeat", async () => {
      successorEntered = true
    })
    expect(successorEntered).toBe(true)
  })
})
