import { afterEach, describe, expect, it, vi } from "vitest"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { createAgent } from "langchain"
import type { CreateAgentRuntimeOptions } from "../agent/runtime"
import type { ModsManager } from "../mods/manager"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { FunctionTurnLifecycle, type FunctionTurnLifecycleHost } from "../mods/v2/turn-lifecycle"
import { createFunctionSessionViewMiddleware } from "../agent/mods-session-view"
import { getLocalThreadRunLease, onLocalThreadRunLeaseReleased } from "../agent/thread-run-lease"

const mocks = vi.hoisted(() => ({
  manager: undefined as unknown,
  createAgentRuntime: vi.fn(),
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
  createAgentRuntime: mocks.createAgentRuntime,
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
vi.mock("../mods/manager", () => ({ getModsManager: () => mocks.manager }))
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
    mocks.manager = undefined
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it.each(["answer", "silent", "cancel", "error"])(
    "observes the actual heartbeat graph and settles %s without taking foreground queue ownership",
    async (ending) => {
      vi.clearAllMocks()
      const authorities = new ModRuntimeAuthorities()
      const start = vi.fn<FunctionTurnLifecycleHost["start"]>(async () => {})
      const complete = vi.fn<FunctionTurnLifecycleHost["complete"]>(async () => {
        expect(getLocalThreadRunLease("heartbeat")).toBeUndefined()
        expect(isHeartbeatRunning()).toBe(false)
        expect(mocks.closeCheckpointer).toHaveBeenCalledTimes(1)
      })
      const lifecycle = new FunctionTurnLifecycle({
        start,
        complete,
        error: (error) => {
          throw error
        },
        isBusy: (threadId) => !!getLocalThreadRunLease(threadId),
        onIdle: (listener) => onLocalThreadRunLeaseReleased((lease) => listener(lease.threadId))
      })
      const manager = {
        startFunctionTurn: lifecycle.start.bind(lifecycle),
        functionTurns: lifecycle,
        releaseExpiredRuntimeBindings: vi.fn(),
        bindFunctionSession: vi.fn(),
        updateFunctionSessionMessages: vi.fn(),
        updateFunctionSessionRequest: vi.fn()
      }
      mocks.manager = manager
      mocks.resolveModel.mockResolvedValue(null)
      mocks.getHeartbeatContent.mockReturnValue("- inspect workspace")
      mocks.getThreadCore.mockReturnValue(null)
      mocks.pinCheckpointer.mockReturnValue(() => {})
      mocks.closeCheckpointer.mockResolvedValue(undefined)
      const prune = vi.fn(async () => {})
      mocks.getCheckpointer.mockResolvedValue({
        getTuple: async () => undefined,
        deleteThread: prune
      })
      let runtimeOptions: CreateAgentRuntimeOptions | undefined
      let modelCalls = 0
      class HeartbeatModel extends BaseChatModel {
        bindTools(): this {
          return this
        }
        _llmType() {
          return "heartbeat-real-graph"
        }
        async _generate(): Promise<ChatResult> {
          modelCalls++
          expect(start).toHaveBeenCalledTimes(1)
          if (ending === "error") throw new Error("controlled heartbeat failure")
          if (ending === "cancel") {
            const binding = start.mock.calls[0][0]
            lifecycle.abort(binding.workspace, binding.threadId, binding.turnId)
            runtimeOptions!.abortSignal!.throwIfAborted()
          }
          const text = ending === "silent" ? "HEARTBEAT_OK" : "actual heartbeat answer"
          const message = new AIMessage({
            id: "heartbeat-answer",
            content: text,
            usage_metadata: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
            response_metadata: { model_name: "heartbeat-provider" }
          })
          return { generations: [{ message, text }] }
        }
      }
      mocks.createAgentRuntime.mockImplementation((options: CreateAgentRuntimeOptions) => {
        runtimeOptions = options
        const { authority } = authorities.create({
          workspace: options.workspacePath!,
          threadId: options.threadId!,
          turnId: options.hookTurnId!
        })
        return createAgent({
          model: new HeartbeatModel({}),
          tools: [],
          middleware: [
          createFunctionSessionViewMiddleware(
              manager as unknown as ModsManager,
              authority,
              "heartbeat-provider",
              options.modTurnRunId
            )
          ]
        })
      })
      try {
        await runHeartbeatNow()
        await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
        expect(modelCalls).toBe(1)
        const facts = complete.mock.calls[0][1]
        expect(facts.reason).toBe(
          ending === "cancel" ? "aborted" : ending === "silent" ? "answer" : ending
        )
        expect(facts.turnId).toBe(runtimeOptions?.hookTurnId)
        expect(facts.turnId).not.toBe("heartbeat")
        expect(runtimeOptions?.modTurnRunId).toBe(start.mock.calls[0][0].runId)
        expect(runtimeOptions?.currentRunMessageQueueOwnerToken).toBeUndefined()
        if (ending === "answer" || ending === "silent") {
          expect(facts.answer).toBe(
            ending === "silent" ? "HEARTBEAT_OK" : "actual heartbeat answer"
          )
          expect(facts.usage).toEqual({
            model: "heartbeat-provider",
            input_tokens: 8,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
          })
        } else expect(facts.usage).toBeUndefined()
        expect(prune).toHaveBeenCalledTimes(ending === "silent" ? 1 : 0)
      } finally {
        lifecycle.close()
        authorities.close()
      }
    }
  )

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
