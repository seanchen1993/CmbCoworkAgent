import { afterEach, describe, expect, it, vi } from "vitest"

type SocketListener = (...args: unknown[]) => void

const mocks = vi.hoisted(() => {
  const sockets: FakeWebSocket[] = []

  class FakeWebSocket {
    static readonly OPEN = 1

    readonly listeners = new Map<string, SocketListener[]>()
    readonly readyState = FakeWebSocket.OPEN

    constructor() {
      sockets.push(this)
    }

    on(event: string, listener: SocketListener): this {
      const listeners = this.listeners.get(event) ?? []
      listeners.push(listener)
      this.listeners.set(event, listeners)
      return this
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }

    removeAllListeners(): void {
      this.listeners.clear()
    }

    terminate(): void {
      this.removeAllListeners()
    }

    ping(): void {
      void this.readyState
    }
  }

  return {
    FakeWebSocket,
    sockets,
    closeCheckpointer: vi.fn<(threadId: string) => Promise<void>>(),
    releaseCheckpointerPin: vi.fn()
  }
})

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("ws", () => ({ default: mocks.FakeWebSocket }))
vi.mock("uuid", () => ({ v4: () => "new-chatx-thread" }))
vi.mock("@langchain/core/messages", () => ({ HumanMessage: class {} }))
vi.mock("../storage", () => ({
  getChatXConfig: () => ({
    enabled: true,
    wsUrl: "ws://chatx.test",
    robots: [
      {
        chatId: "chat-1",
        workDir: "C:/workspace",
        fromId: "robot",
        clientId: "client",
        clientSecret: "secret",
        toUserList: []
      }
    ]
  }),
  purgeThreadCheckpointArtifacts: vi.fn()
}))
vi.mock("../agent/runtime", () => ({
  createAgentRuntime: vi.fn(),
  closeCheckpointer: mocks.closeCheckpointer,
  pinCheckpointer: () => mocks.releaseCheckpointerPin,
  retireThreadCheckpointers: vi.fn()
}))
vi.mock("../db/index", () => ({
  createThread: vi.fn(),
  deleteThread: vi.fn(),
  getAllThreadSummaries: () => [
    {
      thread_id: "thread-1",
      metadata: JSON.stringify({ chatxChatId: "chat-1", chatxSender: "sender-1" })
    }
  ],
  getThreadCore: () => ({ metadata: JSON.stringify({ workspacePath: "C:/workspace" }) })
}))
vi.mock("../agent/stream-converter", () => ({ StreamConverter: class {} }))
vi.mock("./notify", () => ({ notifyAlways: vi.fn(), stripThink: (value: string) => value }))
vi.mock("./event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("../pet", () => ({ showPetCompletedTaskNotice: vi.fn() }))
vi.mock("../app-attention-events", () => ({ emitAppAttention: vi.fn() }))
vi.mock("../models/registry", () => ({
  getAvailableModelConfigOrDefault: () => null,
  toModelRef: vi.fn()
}))
vi.mock("../ipc/stream-data-serialization", () => ({ createStreamDataSerializer: vi.fn() }))
vi.mock("../../shared/agent-runtime-limits", () => ({ getAgentGraphRecursionLimit: () => 1 }))
vi.mock("./heartbeat", () => ({ isHeartbeatRunning: () => false }))
vi.mock("./heartbeat-session", () => ({ HEARTBEAT_THREAD_ID: "heartbeat" }))
vi.mock("./scheduler", () => ({ isTaskRunning: () => false }))
vi.mock("../agent/local-sandbox", () => ({
  LocalSandbox: { hasActiveBackgroundTasks: () => false }
}))

import { isChatXThreadRunning, startChatX, stopChatX } from "./chatx"
import { isExternallyManagedThreadRunBusy } from "./thread-external-run-busy"

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe("ChatX run ownership", () => {
  afterEach(() => {
    stopChatX()
    vi.clearAllMocks()
    mocks.sockets.length = 0
  })

  it("remains busy until the owned checkpointer physically closes", async () => {
    const close = createDeferred()
    mocks.closeCheckpointer.mockReturnValueOnce(close.promise)

    startChatX()
    const socket = mocks.sockets.at(-1)
    expect(socket).toBeDefined()
    socket!.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          msgId: "message-1",
          chatId: "chat-1",
          fromId: "sender-1",
          content: "hello"
        })
      )
    )

    await vi.waitFor(() => {
      expect(mocks.closeCheckpointer).toHaveBeenCalledWith("thread-1")
    })
    expect(isChatXThreadRunning("thread-1")).toBe(true)
    expect(isExternallyManagedThreadRunBusy("thread-1", {})).toBe(true)

    close.resolve()
    await vi.waitFor(() => {
      expect(isChatXThreadRunning("thread-1")).toBe(false)
    })
    expect(isExternallyManagedThreadRunBusy("thread-1", {})).toBe(false)
  })
})
