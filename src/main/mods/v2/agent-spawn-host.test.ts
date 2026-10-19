import { beforeEach, describe, expect, it, vi } from "vitest"
import { AIMessage } from "@langchain/core/messages"
import { ModelRefusalError } from "../../agent/model-refusal"
import type { ModsManager } from "../manager"
import { getLocalThreadRunLease } from "../../agent/thread-run-lease"
import { FunctionConversationChildFamilies } from "./conversation-child-family"
import {
  assertCreatorModelAccounting,
  issueCreatorModelAccounting,
  type CreatorModelAccounting
} from "../devtools/creator-model-accounting"
import { CreatorRequestBudgets } from "../devtools/creator-request-budget"
import {
  functionAgentModelFingerprint,
  prepareFunctionAgentPlan,
  runFunctionAgentChild,
  type FunctionAgentPlan
} from "./agent-spawn-host"

const host = vi.hoisted(() => ({
  rows: new Map<string, { metadata: string; created_at: number }>(),
  model: { ref: "custom:model", model: "actual-model", apiKey: "test-only" },
  createRuntime: vi.fn(),
  cleanup: vi.fn(),
  checkpoint: vi.fn(),
  createTrace: vi.fn(),
  finishTrace: vi.fn(),
  options: undefined as undefined | Record<string, unknown>
}))
vi.mock("../../db", () => ({
  // Map-backed child threads must retain the public fallback, not impersonate SQLite.
  getDb: () => {
    throw new Error("AGENT_SPAWN_FIXTURE_NO_NATIVE_DB")
  },
  createThread: (id: string, metadata: Record<string, unknown>) => {
    const row = {
      metadata: JSON.stringify({ ...metadata, cmb_thread_incarnation: "incarnation" }),
      created_at: 1
    }
    host.rows.set(id, row)
    return row
  },
  getThreadCore: (id: string) => host.rows.get(id),
  deleteThread: (id: string) => host.rows.delete(id)
}))
vi.mock("../../models/registry", () => ({
  getModelConfigByRef: (name: string) => (name === "custom:model" ? host.model : undefined)
}))
vi.mock("../../agent/agent-registry", () => ({
  loadAgentProfilesAsync: async () => [],
  resolveProfileFromList: () => null
}))
vi.mock("../../agent/runtime", () => ({
  createAgentRuntime: (...args: unknown[]) => host.createRuntime(...args),
  closeCheckpointer: (...args: unknown[]) => host.checkpoint(...args)
}))
// Runtime streams are test doubles here; real collectors/tools are covered by the integration suite.
vi.mock("../../agent/trace/collector", () => ({
  createTraceCollectorSafely: (...args: unknown[]) => host.createTrace(...args),
  finishTraceInBackground: (...args: unknown[]) => host.finishTrace(...args),
  runTraceSideEffect: (_scope: string, run: () => void) => {
    try {
      run()
    } catch {
      /* Observational only. */
    }
  }
}))
vi.mock("../../agent/local-sandbox", () => ({
  LocalSandbox: {
    cancelBackgroundTasksAndWait: (...args: unknown[]) => host.cleanup(...args),
    revokeGrantedAclsForRun: (...args: unknown[]) => host.cleanup(...args)
  }
}))
vi.mock("../../storage", () => ({
  deleteThreadCheckpoint: (...args: unknown[]) => host.checkpoint(...args)
}))
vi.mock("../../agent/action-stationarity", () => ({ clearActionStationarityTurn: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  host.rows.clear()
  host.createRuntime.mockImplementation(async (options: Record<string, unknown>) => {
    host.options = options
    return {
      stream: async function* () {
        ;(options.onModAgentStarted as () => void)()
        yield ["values", { messages: [new AIMessage("review done")] }]
      }
    }
  })
})

function fixture() {
  const plan: FunctionAgentPlan = {
    prompt: "review changes",
    description: "review",
    type: "general-purpose",
    model: "custom:model",
    workspace: "project",
    modelFingerprint: functionAgentModelFingerprint(host.model)
  }
  const controller = new AbortController()
  const context = {
    parentThreadId: "parent",
    agentId: "child",
    signal: controller.signal,
    assertLive: () => controller.signal.throwIfAborted(),
    started: vi.fn()
  }
  const manager = {
    closeFunctionThread: vi.fn(),
    bindFunctionPeerEndpoint: () => ({ close: vi.fn() }),
    functionAgentRuntimeAuthority: (workspace: string, threadId: string, agentId: string) => ({
      workspace,
      threadId,
      agentId,
      turnId: host.options?.hookTurnId,
      assertLive: () => controller.signal.throwIfAborted()
    })
  } as unknown as ModsManager
  return { plan, controller, context, manager }
}

describe("independent native agent host", () => {
  it.each(["answer", "error", "aborted", "cleanup"])(
    "finalizes optional telemetry only after physical cleanup facts for %s",
    async (outcome) => {
      const { plan, context, manager, controller } = fixture()
      const tracer = { getTraceContext: () => undefined }
      host.createTrace.mockReturnValueOnce(tracer)
      host.cleanup.mockImplementationOnce(async () => {
        expect(host.finishTrace).not.toHaveBeenCalled()
        if (outcome === "cleanup") throw Error("physical cleanup unconfirmed")
      })
      if (outcome === "error") host.createRuntime.mockRejectedValueOnce(Error("runtime failed"))
      if (outcome === "aborted")
        host.createRuntime.mockImplementationOnce(async () => {
          controller.abort()
          throw controller.signal.reason
        })
      const pending = runFunctionAgentChild(manager, plan, context)
      if (outcome === "cleanup") await expect(pending).rejects.toThrow("MODS_AGENT_CLEANUP_FAILED")
      else await pending
      expect(host.finishTrace).toHaveBeenCalledTimes(1)
      expect(host.createTrace.mock.calls[0][3]).toMatchObject({
        traceKind: "subagent",
        executionMode: "normal"
      })
      expect(host.createTrace.mock.calls[0][3]).not.toHaveProperty("parentTraceId")
      expect(host.finishTrace.mock.calls[0].slice(0, 2)).toEqual([
        tracer,
        outcome === "cleanup"
          ? "unknown"
          : outcome === "answer"
            ? "success"
            : outcome === "aborted"
              ? "cancelled"
              : "error"
      ])
    }
  )
  it("inherits the native parent's original CAS budget for the exact physical child", async () => {
    const { plan, context, manager } = fixture()
    const settings = new Map<string, string>()
    const budgets = new CreatorRequestBudgets({
      getSetting: (key, fallback) => settings.get(key) ?? fallback ?? "",
      compareAndSetSetting: (key, expected, value) => {
        if (settings.get(key) !== expected) return false
        settings.set(key, value)
        return true
      }
    })
    const scope = "original-parent-scope",
      run = "original-parent-request"
    budgets.bindModel(scope, run, undefined, { modelAttemptLimit: 1 })
    const parent = issueCreatorModelAccounting(
      {
        assertCurrent: context.assertLive,
        claim: (traceId) => {
          const id = budgets.claimModel(scope, run, traceId)
          return { settle: (usage) => budgets.settleModel(scope, run, id, usage) }
        }
      },
      undefined,
      undefined,
      { workspace: plan.workspace, threadId: context.parentThreadId }
    )
    const runtime = host.createRuntime.getMockImplementation()!
    host.createRuntime.mockImplementation(async (options: Record<string, unknown>) => {
      const accounting = options.creatorAccounting as CreatorModelAccounting
      expect(accounting).toBeDefined()
      expect(accounting).not.toBe(parent)
      assertCreatorModelAccounting(accounting, {
        workspace: plan.workspace,
        threadId: String(options.threadId)
      })
      const attempt = accounting.claim()
      attempt.settle({ inputTokens: 11, outputTokens: 3 })
      expect(() => parent.claim()).toThrow("DEVELOPMENT_MODEL_ATTEMPT_BUDGET")
      return runtime(options)
    })
    const result = await runFunctionAgentChild(manager, plan, {
      ...context,
      creatorAccounting: parent
    })
    expect(result.reason).toBe("answer")
    expect(budgets.latest(scope)?.model?.attempts).toMatchObject([
      { state: "reported", inputTokens: 11, outputTokens: 3 }
    ])
    expect(budgets.latest(scope)?.model?.attempts[0].traceId).toBeUndefined()
    expect(host.rows.size).toBe(0)
  })

  it.each(["forged", "foreign-parent", "foreign-workspace"])(
    "rejects %s accounting without starting a provider",
    async (kind) => {
      const { plan, context, manager } = fixture()
      const accounting =
        kind === "forged"
          ? ({ forChild: vi.fn() } as unknown as CreatorModelAccounting)
          : issueCreatorModelAccounting(
              { assertCurrent: () => {}, claim: () => ({ settle: () => {} }) },
              undefined,
              undefined,
              {
                workspace: kind === "foreign-workspace" ? "foreign" : plan.workspace,
                threadId: kind === "foreign-parent" ? "foreign" : context.parentThreadId
              }
            )
      await expect(
        runFunctionAgentChild(manager, plan, { ...context, creatorAccounting: accounting })
      ).rejects.toThrow("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
      expect(host.createRuntime).not.toHaveBeenCalled()
      expect(host.rows.size).toBe(0)
    }
  )

  it.each(["answer", "startup-error"])(
    "registers the actual factory before runtime and retires it before cleanup for %s",
    async (outcome) => {
      const { plan, context, manager } = fixture()
      // This mocked-runtime unit verifies forwarding/order only. Actual receipt validation is
      // independently covered by conversation-child-family's real DB/lease/authority tests.
      const receipts = new FunctionConversationChildFamilies({ get: () => undefined })
      const parent = receipts.captureParent({
        owner: {},
        physicalParentThreadId: context.parentThreadId,
        target: {
          threadId: context.parentThreadId,
          workspace: plan.workspace,
          incarnation: { token: "unit-parent", legacyCreatedAt: 1 },
          logicalSessionId: "unit-session",
          conversationId: "unit-main",
          branchId: "unit-branch",
          kind: "main",
          checkpointNamespace: ""
        },
        signal: context.signal,
        assertCurrent: context.assertLive,
        assertFactory: context.assertLive
      })
      let factoryLive = false,
        physical = ""
      const register = vi.fn(
        (
          _parent: Parameters<ModsManager["registerFunctionConversationChild"]>[0],
          input: Parameters<ModsManager["registerFunctionConversationChild"]>[1]
        ) => {
          expect(_parent).toBe(parent)
          input.assertCurrent()
          physical = input.physicalThreadId
          expect(host.rows.has(physical)).toBe(true)
          expect(getLocalThreadRunLease(physical)).toMatchObject({
            owner: "mods",
            runId: input.runId
          })
          expect(input.checkpointIncarnation).toEqual({ token: "incarnation", legacyCreatedAt: 1 })
          factoryLive = true
          return () => {
            expect(host.rows.has(physical)).toBe(true)
            expect(getLocalThreadRunLease(physical)?.owner).toBe("mods")
            factoryLive = false
          }
        }
      )
      manager.registerFunctionConversationChild = register
      const runtime = host.createRuntime.getMockImplementation()
      host.createRuntime.mockImplementation(async (...args) => {
        expect(factoryLive).toBe(true)
        if (outcome === "startup-error") throw Error("actual startup failed")
        if (!runtime) throw Error("ACTUAL_FIXTURE_RUNTIME_REQUIRED")
        return runtime(...args)
      })
      manager.closeFunctionThread = vi.fn(() => {
        expect(factoryLive).toBe(false)
      })
      const result = await runFunctionAgentChild(manager, plan, {
        ...context,
        conversationParent: parent
      })
      expect(result.reason).toBe(outcome === "answer" ? "answer" : "error")
      expect(register).toHaveBeenCalledOnce()
      expect(manager.closeFunctionThread).toHaveBeenCalledWith(physical)
      expect(host.rows.has(physical)).toBe(false)
      expect(getLocalThreadRunLease(physical)).toBeUndefined()
    }
  )

  it.each(["metadata", "outcome-error"])(
    "reports explicit provider refusal from %s as incomplete",
    async (source) => {
      const { plan, context, manager } = fixture()
      host.createRuntime.mockImplementation(async (options) => {
        host.options = options
        return {
          stream: async function* () {
            options.onModAgentStarted()
            if (source === "outcome-error") throw new ModelRefusalError()
            yield [
              "values",
              {
                messages: [
                  new AIMessage({
                    content: "",
                    response_metadata: { finish_reason: "content_filter" }
                  })
                ]
              }
            ]
            yield ["values", { messages: [new AIMessage("later answer cannot erase refusal")] }]
          }
        }
      })
      expect(await runFunctionAgentChild(manager, plan, context)).toMatchObject({
        reason: "refusal",
        refusal: { category: null, explanation: null }
      })
    }
  )
  it("freezes a registered role and forwards exact child constraints to the native runtime", async () => {
    const { context, manager } = fixture()
    const registered = {
      name: "lab:review",
      plugin: "lab",
      spec: {
        name: "review",
        description: "Review",
        prompt: "Fixed role",
        tools: ["Read"],
        model: "inherit",
        maxTurns: 2,
        omitClaudeMd: true,
        permissionMode: "plan"
      }
    }
    const plan = await prepareFunctionAgentPlan(
      { prompt: "task", description: "review", subagentType: "lab:review", background: true },
      "project",
      "custom:model",
      registered
    )
    registered.spec.prompt = "Later replacement"
    expect(plan.role?.systemPrompt).toBe("Fixed role")
    await runFunctionAgentChild(manager, { ...plan, allowedToolNames: ["read_file"] }, context)
    expect(host.options).toMatchObject({
      modAgentSystemPrompt: "Fixed role",
      modAgentMaxTurns: 2,
      allowedToolNames: ["read_file"],
      enableAgentsPrompt: false,
      disableMemoryInjection: true,
      filesystemAccess: { shellAccess: "read_only" }
    })
  })
  it("retains failed cleanup identity but releases its unique physical lease", async () => {
    const { plan, context, manager } = fixture()
    host.cleanup.mockRejectedValueOnce(new Error("sandbox cleanup failed"))
    await expect(runFunctionAgentChild(manager, plan, context)).rejects.toThrow(
      "MODS_AGENT_CLEANUP_FAILED"
    )
    const physical = context.started.mock.calls[0][0]
    expect(host.rows.has(physical)).toBe(true)
    expect(getLocalThreadRunLease(physical)).toBeUndefined()
  })
  it("resolves actual models and rejects unavailable roles and unsupported modes", async () => {
    const input = {
      prompt: "review",
      description: "review",
      subagentType: "general-purpose",
      background: true,
      fork: false
    }
    expect(await prepareFunctionAgentPlan(input, "project", "custom:model")).toMatchObject({
      model: "custom:model"
    })
    await expect(
      prepareFunctionAgentPlan({ ...input, subagentType: "missing" }, "project", "custom:model")
    ).rejects.toThrow("MODS_AGENT_SPAWN_TYPE_UNAVAILABLE")
    await expect(
      prepareFunctionAgentPlan({ ...input, background: false }, "project", "custom:model")
    ).rejects.toThrow("MODS_AGENT_SPAWN_MODE_UNSUPPORTED")
    await expect(
      prepareFunctionAgentPlan({ ...input, cwd: "other" }, "project", "custom:model")
    ).rejects.toThrow("MODS_AGENT_SPAWN_CWD_UNSUPPORTED")
  })

  it("creates a separate internal thread and reports ready only from the running graph", async () => {
    const { plan, context, manager } = fixture()
    const result = await runFunctionAgentChild(manager, plan, context)
    expect(context.started).toHaveBeenCalledOnce()
    const physical = context.started.mock.calls[0][0]
    expect(physical).not.toBe("parent")
    expect(host.options).toMatchObject({
      threadId: physical,
      approvalThreadId: "parent",
      managedExecution: true,
      autoApproveFileEdits: false,
      disableSubagents: true
    })
    expect(result).toMatchObject({ answer: "review done", reason: "answer", agentId: "child" })
    expect(manager.closeFunctionThread).toHaveBeenCalledWith(physical)
    expect(host.rows.size).toBe(0)
  })

  it("does not launch when the approved resolved model configuration changes", async () => {
    const { plan, context, manager } = fixture()
    plan.modelFingerprint = "changed"
    await expect(runFunctionAgentChild(manager, plan, context)).rejects.toThrow(
      "MODS_AGENT_SPAWN_MODEL_CHANGED"
    )
    expect(host.createRuntime).not.toHaveBeenCalled()
    expect(host.rows.size).toBe(0)
  })

  it("cleans up startup failure without reporting a started agent", async () => {
    const { plan, context, manager } = fixture()
    host.createRuntime.mockRejectedValue(new Error("initialization failed"))
    const result = await runFunctionAgentChild(manager, plan, context)
    expect(result.reason).toBe("error")
    expect(context.started).not.toHaveBeenCalled()
    expect(host.rows.size).toBe(0)
  })

  it("aborts an independent child through its own owner and releases its native resources", async () => {
    const { plan, context, manager, controller } = fixture()
    host.createRuntime.mockImplementation(async (options: Record<string, unknown>) => {
      host.options = options
      return {
        stream: async function* () {
          ;(options.onModAgentStarted as () => void)()
          controller.abort(new Error("module revoked"))
          yield ["values", {}]
        }
      }
    })
    const result = await runFunctionAgentChild(manager, plan, context)
    expect(result.reason).toBe("aborted")
    expect(host.rows.size).toBe(0)
    expect(host.cleanup).toHaveBeenCalledTimes(2)
  })
})
