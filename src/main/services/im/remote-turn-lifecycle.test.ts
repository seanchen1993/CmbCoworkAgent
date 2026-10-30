import { afterEach, expect, it, vi } from "vitest"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { createAgent } from "langchain"
import { MemorySaver } from "@langchain/langgraph"
import type { CreateAgentRuntimeOptions } from "../../agent/runtime"
import type { ModsManager } from "../../mods/manager"
import { ModRuntimeAuthorities } from "../../mods/runtime-instance"
import { FunctionTurnLifecycle, type FunctionTurnLifecycleHost } from "../../mods/v2/turn-lifecycle"
import { createFunctionSessionViewMiddleware } from "../../agent/mods-session-view"
import {
  createTurnCompletionGateMiddleware,
  readTurnCompletionGateReport
} from "../../agent/turn-completion-integrity"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  onLocalThreadRunLeaseReleased,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"

const fixture = vi.hoisted(() => ({
  manager: undefined as unknown,
  runtime: vi.fn(),
  close: vi.fn(async () => {}),
  persist: vi.fn(() => 1),
  update: vi.fn(),
  finish: vi.fn(async () => {}),
  revision: false
}))
vi.mock("../../mods/manager", () => ({ getModsManager: () => fixture.manager }))
vi.mock("../../agent/runtime", () => ({
  hasPendingApprovalForRuntimeThread: () => false,
  createAgentRuntime: fixture.runtime,
  pinCheckpointer: () => () => {},
  closeCheckpointer: fixture.close
}))
vi.mock("../../agent/standard-thread-turn", async (original) => ({
  ...(await original<typeof import("../../agent/standard-thread-turn")>()),
  resolveHarnessFeatureBindingContext: async () => undefined,
  getHarnessAgentContext: async () => ({}),
  getHarnessHookContext: () => ({}),
  prepareStandardUserPrompt: async ({ rawMessage }: { rawMessage: string }) => ({
    accepted: true,
    content: rawMessage
  }),
  resolveStandardTurnRouting: async () => ({ orderedModelIds: ["first", "second"] }),
  createStandardTurnTrace: () => ({
    setExecutionMode: vi.fn(),
    getTraceContext: () => ({}),
    setModelId: vi.fn(),
    setModelName: vi.fn(),
    finish: fixture.finish
  })
}))
vi.mock("../../agent/turn-attribution", () => ({
  TurnAttributionRecorder: class {
    onStreamChunk() {
      /* Attribution is outside the lifecycle fixture. */
    }
    sync() {
      /* No adoption statistics are persisted by this fixture. */
    }
    getFileWritePaths() {
      return []
    }
  }
}))
vi.mock("../../agent/trace/turn-trace-recorder", () => ({
  TurnTraceRecorder: class {
    onStreamChunk() {
      /* The fixture observes usage through real graph middleware. */
    }
  }
}))
vi.mock("../../agent/renderer-stream-mirror", () => ({
  mirrorStandardTurnStreamToRenderer: vi.fn(),
  notifyRemoteThreadChanged: vi.fn()
}))
vi.mock("../../hooks/thread-scope-persistence", () => ({
  createPersistentThreadHookScope: () => ({})
}))
vi.mock("../../hooks/result-callback", () => ({ makeBroadcastHookResultCallback: () => () => {} }))
vi.mock("../../agent/skill-lifecycle/completion-hooks", () => ({
  runCompletionHooksWithRevision: async ({
    runRevision
  }: {
    runRevision(prompt: string): Promise<void>
  }) => {
    if (fixture.revision) await runRevision("real revision")
    return "passed"
  }
}))
vi.mock("../../db", async (original) => ({
  ...(await original<typeof import("../../db")>()),
  flushStrict: async () => {},
  upsertThreadMessages: fixture.persist,
  updateThread: fixture.update,
  getThread: vi.fn(),
  getThreadMessages: () => []
}))
vi.mock("../../routing", () => ({ rememberRoutingDecision: vi.fn() }))
vi.mock("../../models/registry", () => ({
  getModelConfigByRef: () => ({ model: "configured-model" })
}))
vi.mock("../agent-auto-commit", () => ({
  discardAgentAutoCommitTracking: vi.fn(),
  maybeAutoCommitAfterAgentRun: vi.fn(),
  recordAgentTouchedFile: vi.fn(),
  startAgentGitSnapshot: vi.fn()
}))
vi.mock("./desktop-run-bridge", () => ({
  executeRemoteStandardTurnOnDesktopRunBody: vi.fn(),
  withImInboxRuntimePolicy: vi.fn()
}))

import { executePreparedRemoteStandardTurn } from "./remote-runner"

afterEach(() => {
  const lease = getLocalThreadRunLease("remote")
  if (lease) releaseLocalThreadRunLease(lease.threadId, lease.owner, lease.runId)
  fixture.manager = undefined
  fixture.revision = false
  vi.clearAllMocks()
})

it.each(["answer", "cancel", "parent-cancel", "error", "retry", "revision", "refusal"])(
  "settles a remote %s through the actual graph without releasing the transport's lease",
  async (ending) => {
    const controller = new AbortController()
    const authorities = new ModRuntimeAuthorities()
    const checkpointer = new MemorySaver()
    const start = vi.fn<FunctionTurnLifecycleHost["start"]>(async () => {})
    const complete = vi.fn<FunctionTurnLifecycleHost["complete"]>(async () => {})
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
    fixture.manager = manager
    fixture.revision = ending === "revision"
    let calls = 0
    const options: CreateAgentRuntimeOptions[] = []
    class RemoteModel extends BaseChatModel {
      bindTools(): this {
        return this
      }
      _llmType() {
        return "remote-real-graph"
      }
      async _generate(): Promise<ChatResult> {
        calls++
        expect(start).toHaveBeenCalledTimes(1)
        if (ending === "retry" && calls === 1)
          throw Object.assign(new Error("server unavailable"), { status: 503 })
        if (ending === "error") throw new Error("controlled remote failure")
        if (ending === "cancel") lifecycle.abort("/workspace", "remote", "user-id")
        if (ending === "parent-cancel") controller.abort()
        options.at(-1)!.abortSignal!.throwIfAborted()
        const message = new AIMessage({
          id: `remote-${calls}`,
          content: `actual remote answer ${calls}`,
          usage_metadata: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
          response_metadata: {
            model_name: "real-remote-provider",
            ...(ending === "refusal" ? { finish_reason: "content_filter" } : {})
          }
        })
        return { generations: [{ message, text: String(message.content) }] }
      }
    }
    fixture.runtime.mockImplementation((input: CreateAgentRuntimeOptions) => {
      options.push(input)
      const { authority } = authorities.create(
        {
          workspace: input.workspacePath!,
          threadId: input.threadId!,
          turnId: input.hookTurnId!
        },
        input.abortSignal
      )
      return createAgent({
        model: new RemoteModel({}),
        tools: [],
        checkpointer,
        middleware: [
          createTurnCompletionGateMiddleware({ observationRunToken: input.modTurnRunId }),
          createFunctionSessionViewMiddleware(
            manager as unknown as ModsManager,
            authority,
            "real-remote-provider",
            input.modTurnRunId
          )
        ]
      })
    })
    claimLocalThreadRunLease({ threadId: "remote", runId: "physical", owner: "im" })
    try {
      const promise = executePreparedRemoteStandardTurn({
        rawMessage: "remote request",
        userMessageId: "user-id",
        threadId: "remote",
        targetKind: "thread",
        metadata: {},
        workspacePath: "/workspace",
        runId: "physical",
        runOwner: "im",
        source: "im",
        routingTaskSource: "chat",
        signal: controller.signal,
        disableAutoCommit: true
      })
      if (["cancel", "parent-cancel", "error", "refusal"].includes(ending))
        await expect(promise).rejects.toThrow()
      else
        await expect(promise).resolves.toBe(`actual remote answer ${ending === "answer" ? 1 : 2}`)
      expect(calls).toBe(ending === "retry" || ending === "revision" ? 2 : 1)
      expect(options.every((option) => option.modTurnRunId === "physical")).toBe(true)
      expect(options.every((option) => option.currentRunMessageQueueOwnerToken === undefined)).toBe(
        true
      )
      expect(getLocalThreadRunLease("remote")?.runId).toBe("physical")
      expect(complete).not.toHaveBeenCalled()
      expect(fixture.close).toHaveBeenCalledTimes(1)
      releaseLocalThreadRunLease("remote", "im", "physical")
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
      const facts = complete.mock.calls[0][1]
      const aborted = ending === "cancel" || ending === "parent-cancel"
      expect(facts.reason).toBe(
        aborted
          ? "aborted"
          : ending === "refusal"
            ? "refusal"
            : ending === "error"
              ? "error"
              : "answer"
      )
      if (ending === "refusal") {
        expect(facts).toHaveProperty("refusal", { category: null, explanation: null })
        expect(fixture.finish).not.toHaveBeenCalledWith("success")
      }
      expect(readTurnCompletionGateReport("remote", "physical")).toBeNull()
      expect(facts.turnId).toBe("user-id")
      expect(controller.signal.aborted).toBe(ending === "parent-cancel")
      if (!aborted && ending !== "error") {
        expect(facts.usage).toEqual({
          model: "real-remote-provider",
          input_tokens: ending === "revision" ? 16 : 8,
          output_tokens: ending === "revision" ? 4 : 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        })
      } else expect(facts.usage).toBeUndefined()
    } finally {
      lifecycle.close()
      authorities.close()
    }
  }
)
