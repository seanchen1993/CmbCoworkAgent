import { afterEach, describe, expect, it, vi } from "vitest"
import { CreatorReuseService, type CreatorReuseApproval } from "./creator-reuse"
import { AuthoringDraftStore } from "./authoring-store"
import { ClawStore } from "../claw-store"
import { createAuthoringTemplate } from "./authoring-templates"
import { publishDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import type { AuthoringDocument } from "../../../shared/mods/authoring"
import type { AuthoringInstalledReceipt } from "../../../shared/mods/authoring-install"
import type { DevelopmentScope } from "../v2/development-session"
import type { ClawProfile } from "../../../shared/mods/claw"
import { CreatorCompositionSave } from "./creator-composition-save"
import { CreatorCompositionHistory } from "./creator-composition-history"
import type { DevelopmentTrialStatus } from "../../../shared/mods/development"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "@langchain/core/tools"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent } from "langchain"
import { z } from "zod"
import { readFileSync } from "node:fs"
import ts from "typescript"
import { ModDevelopmentService, setModDevelopmentService } from "./development-service"
import { createCreatorNativeReviewMiddleware } from "../../agent/creator-native-review-middleware"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  onLocalThreadRunLeaseReleased,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"
import {
  clearTurnCompletionGateState,
  createTurnCompletionGateMiddleware,
  describeTurnCompletionFailure,
  readTurnCompletionGateReport
} from "../../agent/turn-completion-integrity"
import { settleAgentFunctionTurn } from "../../agent/agent-run-service"
import { runSettlementPhases } from "../../agent/run-settlement-fence"
import {
  clearCurrentRunMessageQueue,
  createCurrentRunMessageQueueMiddleware,
  peekCurrentRunMessageQueue,
  queueCurrentRunMessage,
  setCurrentRunInjectionNotifier,
  setCurrentRunMessageQueueOwner
} from "../../agent/current-run-message-queue"

const services: CreatorReuseService[] = []
const reviewCleanup: Array<() => void> = []
afterEach(() => {
  for (const cleanup of reviewCleanup.splice(0).reverse()) cleanup()
  setModDevelopmentService(undefined)
  for (const service of services.splice(0)) service.close()
})

function fixture() {
  const values = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    setSetting: (key: string, value: string) => {
      values.set(key, value)
    },
    compareAndSetSetting: (key: string, expected: string | undefined, next: string) => {
      if (values.get(key) !== expected) return false
      values.set(key, next)
      return true
    }
  }
  const scope: DevelopmentScope = {
    workspace: "reuse-workspace",
    threadId: "reuse-thread",
    incarnation: { token: "original", legacyCreatedAt: 1 }
  }
  const source = createAuthoringTemplate({
    id: "demo",
    name: "Demo",
    instruction: "Demo",
    kind: "command"
  })
  let document: AuthoringDocument = {
    id: "demo",
    name: "Demo",
    workspace: scope.workspace,
    revision: 1,
    currentRevision: 1,
    updatedAt: 1,
    source,
    versions: [{ revision: 1, createdAt: 1, digest: source.digest }]
  }
  let live = true,
    busy = false,
    authorized = false,
    pending = false,
    runtimeReady = false
  let installed: AuthoringInstalledReceipt | null = null
  let onIdle: (threadId: string) => void = () => {}
  const assertCurrent = () => {
    if (!live) throw Error("CREATOR_REUSE_SCOPE_CHANGED")
  }
  const context = { scope, assertCurrent }
  const claws = new ClawStore(settings)
  const identity = JSON.stringify([scope.threadId, scope.incarnation.token])
  claws.apply(
    scope.workspace,
    identity,
    {
      id: "initial",
      name: "Initial",
      capabilities: [],
      models: { default: "kept-model", roles: {} }
    },
    0
  )
  const prepared = {
    handle: "prepared",
    installationId: "formal-plugin",
    versionId: "version",
    name: "demo",
    sourceDigest: source.digest,
    compiledDigest: "a".repeat(64),
    catalogDigest: "b".repeat(64),
    configuration: "unchanged" as const,
    review: {
      strictCompatible: true,
      typesValid: true,
      modelProtocol: "result-v1",
      sdkMethods: ["command.register"],
      configurationKeys: [],
      components: [],
      changedFiles: []
    }
  }
  const install = {
    list: vi.fn(() => ({
      workspace: scope.workspace,
      installations: pending
        ? [
            {
              installationId: prepared.installationId,
              name: prepared.name,
              versions: [],
              pending: { operationId: "pending", state: "unknown" as const }
            }
          ]
        : []
    })),
    prepare: vi.fn(async (_input: unknown, binding: { assertCurrent(): void }) => {
      binding.assertCurrent()
      return prepared
    }),
    apply: vi.fn(async (_input: unknown, binding: { assertCurrent(): void }) => {
      binding.assertCurrent()
      installed = {
        installationId: prepared.installationId,
        versionId: prepared.versionId,
        name: prepared.name,
        sourceDigest: prepared.sourceDigest,
        compiledDigest: prepared.compiledDigest
      }
      return {
        operationId: "operation",
        installationId: prepared.installationId,
        versionId: prepared.versionId,
        state: "settled" as const
      }
    }),
    resolveInstalled: vi.fn(async (_input: unknown, binding: { assertCurrent(): void }) => {
      binding.assertCurrent()
      return installed
    }),
    discardPrepared: vi.fn(async () => {})
  }
  const stopTrial = vi.fn(async (_scope: DevelopmentScope, _id: string, guard: () => void) =>
    guard()
  )
  const approveInstalled = vi.fn(
    async (_scope: DevelopmentScope, _receipt: AuthoringInstalledReceipt, guard: () => void) => {
      guard()
      authorized = true
    }
  )
  const applySelection = vi.fn(
    async (
      _workspace: string,
      _threadId: string,
      _profile: ClawProfile,
      commit: () => void,
      guard: () => void
    ) => {
      guard()
      commit()
      guard()
      runtimeReady = true
    }
  )
  const deps = {
    settings,
    drafts: new AuthoringDraftStore(settings),
    claws,
    install,
    readContext: () => context,
    readDraft: () => document,
    identity: () => identity,
    available: async () =>
      installed
        ? [
            {
              pluginId: installed.installationId,
              name: installed.name,
              digest: installed.compiledDigest,
              state: authorized ? ("ready" as const) : ("needs-approval" as const),
              capabilities: []
            }
          ]
        : [],
    stopTrial,
    approveInstalled,
    applySelection,
    runtimeReady: () => runtimeReady,
    assertAuthorized: () => {
      if (!authorized) throw Error("CREATOR_REUSE_AUTHORITY_CHANGED")
    },
    busy: () => busy,
    onIdle: (listener: typeof onIdle) => {
      onIdle = listener
      return () => {}
    },
    changed: vi.fn()
  }
  const create = () => {
    const service = new CreatorReuseService(deps)
    services.push(service)
    return service
  }
  const service = create()
  const request = (turnId?: string, assertTurn = () => {}) =>
    service.request(context, document, { turnId, signal: new AbortController().signal, assertTurn })
  const approval = (): CreatorReuseApproval => {
    const status = service.status(scope)!
    return {
      planId: status.planId!,
      sourceDigest: status.sourceDigest,
      compiledDigest: status.compiledDigest!,
      targetProfileDigest: status.targetProfileDigest!
    }
  }
  return {
    service,
    create,
    request,
    approval,
    scope,
    context,
    install,
    stopTrial,
    approveInstalled,
    applySelection,
    claws,
    identity,
    prepared,
    deps,
    idle: () => {
      busy = false
      onIdle(scope.threadId)
    },
    busy: () => {
      busy = true
    },
    stale: () => {
      live = false
    },
    changeSource: () => {
      document = { ...document, revision: 2 }
    },
    pending: () => {
      pending = true
    },
    runtimePublished: () => {
      runtimeReady = true
    },
    runtimeRetired: () => {
      runtimeReady = false
    },
    revoke: () => {
      authorized = false
    }
  }
}

class ReviewModel extends BaseChatModel {
  readonly calls: BaseMessage[][] = []
  constructor(private readonly names: string[]) {
    super({})
  }
  _llmType(): string {
    return "native-creator-review-test"
  }
  bindTools(): this {
    return this
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push([...messages])
    const message = new AIMessage({
      id: `model-${this.calls.length}`,
      content: this.calls.length === 1 ? "" : "continued normally",
      tool_calls:
        this.calls.length === 1
          ? this.names.map((name, index) => ({ name, args: {}, id: `call-${index}` }))
          : []
    })
    return { generations: [{ message, text: String(message.content) }] }
  }
}

const reviewSchema = z.object({})
function reviewTool(
  work: () => Promise<string>,
  options: { name: string; description: string; schema: typeof reviewSchema }
) {
  return tool(work, options)
}

// Execute the original IPC success/physical-settlement bodies without booting Electron.
// Graph routing, checkpointing, leases and the native reuse observer remain real.
function originalIpcCompletion(f: Awaited<ReturnType<typeof reviewGraphFixture>>) {
  const source = ts.createSourceFile(
    "agent.ts",
    readFileSync(new URL("../../ipc/agent.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let completionGate: ts.IfStatement | undefined, done: ts.Statement[] | undefined
  const visit = (node: ts.Node) => {
    if (
      !completionGate &&
      ts.isIfStatement(node) &&
      node.expression.getText(source) === 'invokeFinalOutcome === "success"' &&
      node.thenStatement
        .getText(source)
        .includes("const completionFailure = readTurnCompletionFailure")
    )
      completionGate = node
    if (!done && ts.isBlock(node)) {
      const index = node.statements.findIndex(
        (statement) => statement.getText(source) === "turnStateShouldDispose = true"
      )
      if (
        index >= 0 &&
        node.statements[index + 1]?.getText(source).startsWith("if (!autoModeTerminal)")
      )
        done = [...node.statements.slice(index, index + 4)]
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const settlement = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "settlePhysicalAgentRun"
  )
  if (!completionGate || !done || !settlement) throw Error("ORIGINAL_IPC_COMPLETION_REQUIRED")
  const controller = f.controller,
    events: unknown[] = []
  const bindings = {
    threadId: f.scope.threadId,
    runToken: f.turnId,
    window: {},
    channel: "native-review-ui",
    invokeFinalReason: undefined,
    turnStateShouldDispose: false,
    invokeDoneAttempted: false,
    invokeFinalOutcome: "success",
    autoModeTerminal: undefined,
    readTurnCompletionFailure: (thread: string, turn: string) => {
      const report = readTurnCompletionGateReport(thread, turn)
      return report ? describeTurnCompletionFailure(report) : null
    },
    markInvokeIncomplete: (reason: string) => {
      throw Error(reason)
    },
    sendHookNotice: () => {},
    markAutoModeTerminal: (outcome: string, endReason: string) => {
      events.push({ outcome, endReason })
    },
    safeSendToWindow: (_window: unknown, _channel: string, event: unknown) => events.push(event),
    getModsManager: () => undefined,
    getThreadCore: () => ({ id: f.scope.threadId }),
    captureThreadIncarnation: () => f.scope.incarnation,
    matchesThreadIncarnation: () => true,
    physicalRunHasSuccessor: () => false,
    ownsPhysicalStreamRunLease: () => true,
    confirmRunCancellationSettlement: () => {},
    invalidateRunCancellationSettlement: () => {},
    runSettlementPhases,
    settleAgentFunctionTurn,
    agentRunExecutionContextStorage: { getStore: () => undefined },
    flushPendingStreamTranscriptMessages: async () => {},
    discardStreamTranscriptToolCallAccumulators: () => {},
    invalidateCurrentRunMessagePreparer: () => {},
    activeRuns: new Map([[f.scope.threadId, controller]]),
    activeRunSettled: new Map(),
    clearCurrentRunMessageQueue: () => {},
    revokeSandboxAclsForRun: () => {},
    notifyAgentRunSettled: () => {},
    shouldDisposeTurnState: () => false,
    discardAgentAutoCommitTracking: () => {},
    releaseLocalThreadRunLease,
    publishDevelopmentTurnSettlement,
    runPostRunMaintenanceInBackground: () => {},
    RUN_SETTLEMENT_NOTIFICATION_TIMEOUT_MS: 1000
  }
  const javascript = ts.transpileModule(
    [
      completionGate.getText(source),
      ...done.map((statement) => statement.getText(source)),
      settlement.getText(source),
      "return settlePhysicalAgentRun"
    ].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const execute = new Function(...Object.keys(bindings), javascript)(
    ...Object.values(bindings)
  ) as (input: Record<string, unknown>) => Promise<void>
  return {
    events,
    settle: () =>
      execute({
        kind: "invoke",
        functionTurnReason: "answer",
        threadId: f.scope.threadId,
        runToken: f.turnId,
        controller,
        settledPromise: Promise.resolve(),
        resolveSettlement: () => {},
        removeWindowListener: () => {},
        settleNotifications: async () => {},
        cleanupNotificationSkills: () => {},
        turnStateShouldDispose: false,
        disposeTurnState: () => {}
      })
  }
}

async function reviewGraphFixture() {
  const f = fixture(),
    turnId = "native-review-turn"
  const development = new ModDevelopmentService({
    drafts: f.deps.drafts,
    runtime: {
      developmentRetention: () => ({ releasable: false, revisions: [] }),
      developmentStatus: () => [],
      stageDevelopment: () => {
        throw Error("TEST_MUST_NOT_EXECUTE_TRIAL")
      },
      approveDevelopment: () => {
        throw Error("TEST_MUST_NOT_APPROVE_TRIAL")
      },
      stopDevelopment: () => {
        throw Error("TEST_MUST_NOT_STOP_TRIAL")
      }
    },
    versionsRoot: "unused-native-review-versions",
    workerEntry: "unused-native-review-worker",
    context: () => f.context,
    changed: () => {}
  })
  development.configureReuse(f.service)
  await development.setEnabled(f.scope.threadId, f.scope.workspace, true)
  setModDevelopmentService(development)
  setCurrentRunMessageQueueOwner(f.scope.threadId, turnId)
  expect(
    claimLocalThreadRunLease({
      threadId: f.scope.threadId,
      runId: turnId,
      owner: "desktop"
    }).acquired
  ).toBe(true)
  f.deps.busy = () => !!getLocalThreadRunLease(f.scope.threadId)
  const stopIdle = onLocalThreadRunLeaseReleased((lease) => {
    if (lease.threadId === f.scope.threadId) f.idle()
  })
  reviewCleanup.push(() => {
    stopIdle()
    releaseLocalThreadRunLease(f.scope.threadId, "desktop", turnId)
    clearTurnCompletionGateState(f.scope.threadId, turnId)
    clearCurrentRunMessageQueue(f.scope.threadId, turnId)
    setCurrentRunInjectionNotifier(() => {})
  })
  const controller = new AbortController()
  const middleware = createCreatorNativeReviewMiddleware({
    threadId: f.scope.threadId,
    workspace: f.scope.workspace,
    runToken: turnId,
    signal: controller.signal
  })!
  expect(middleware).toBeDefined()
  const run = (tools: ReturnType<typeof reviewTool>[]) => {
    const model = new ReviewModel(tools.map((item) => item.name))
    const graph = createAgent({
      model,
      tools,
      checkpointer: new MemorySaver(),
      middleware: [middleware, createTurnCompletionGateMiddleware({ ownerRunToken: turnId }),
        createCurrentRunMessageQueueMiddleware(turnId)]
    })
    const config = { configurable: { thread_id: f.scope.threadId }, recursionLimit: 18 }
    return {
      model,
      graph,
      config,
      snapshot: async (): Promise<{
        next: readonly string[]
        values: { messages: BaseMessage[] }
      }> => graph.getState(config),
      invoke: () =>
        graph.invoke(
          {
            messages: [
              new HumanMessage({
                id: "original-human",
                content: "prepare the dependency for native review"
              })
            ]
          },
          config
        )
    }
  }
  const settle = (outcome: "completed" | "failed" | "cancelled" = "completed") =>
    publishDevelopmentTurnSettlement({
      threadId: f.scope.threadId,
      incarnation: f.scope.incarnation,
      turnId,
      outcome
    })
  return { ...f, development, turnId, controller, run, settle }
}

describe("native creator review handoff in the actual agent graph", () => {
  it("lets the original queue inject a real user steer before ending an early-approved review", async () => {
    const f = await reviewGraphFixture()
    const prepared = Promise.withResolvers<void>(), finishTool = Promise.withResolvers<void>()
    const injected: string[] = []
    setCurrentRunInjectionNotifier((thread, messages, context) => {
      expect(thread).toBe(f.scope.threadId)
      expect(context?.runToken).toBe(f.turnId)
      injected.push(...messages.map(message => message.id))
    })
    const graph = f.run([reviewTool(async () => {
      await f.request(f.turnId)
      await f.service.approve(f.context, f.approval())
      prepared.resolve()
      await finishTool.promise
      return "native review prepared and already approved"
    }, { name: "mod_authoring", description: "Original preparation", schema: reviewSchema })])
    const pending = graph.invoke()
    await prepared.promise
    expect(queueCurrentRunMessage(f.scope.threadId, {
      id: "actual-user-steer", content: "先别安装，请按我刚补充的方案修改"
    }, f.turnId)).toBe(true)
    expect(peekCurrentRunMessageQueue(f.scope.threadId)).toHaveLength(1)
    expect(f.install.apply).not.toHaveBeenCalled()
    finishTool.resolve()
    const result = await pending
    expect(graph.model.calls).toHaveLength(2)
    expect(graph.model.calls[1].at(-1)).toMatchObject({
      id: "actual-user-steer", content: "先别安装，请按我刚补充的方案修改"
    })
    expect(injected).toEqual(["actual-user-steer"])
    expect(peekCurrentRunMessageQueue(f.scope.threadId)).toEqual([])
    expect((result.messages as BaseMessage[]).filter(HumanMessage.isInstance)
      .map(message => message.id)).toEqual(["original-human", "actual-user-steer"])
    expect((await graph.snapshot()).next).toEqual([])
    expect(f.install.apply).not.toHaveBeenCalled()
  })

  it("reaches original IPC UI completion and completed settlement after the real graph ends", async () => {
    const f = await reviewGraphFixture()
    const graph = f.run([
      tool(
        async () => {
          await f.request(f.turnId)
          await f.service.approve(f.context, f.approval())
          return "native review prepared and user already approved"
        },
        { name: "mod_authoring", description: "Original native preparation", schema: z.object({}) }
      )
    ])
    await graph.invoke()
    expect(graph.model.calls).toHaveLength(1)
    expect((await graph.snapshot()).next).toEqual([])
    expect(f.install.apply).not.toHaveBeenCalled()
    const ipc = originalIpcCompletion(f)
    expect(ipc.events).toEqual([{ outcome: "success", endReason: "normal" }, { type: "done" }])
    await ipc.settle()
    expect(getLocalThreadRunLease(f.scope.threadId)).toBeUndefined()
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    "settles the whole ToolNode batch and original checkpoint before review (early approval %s)",
    async (earlyApproval) => {
      const f = await reviewGraphFixture()
      const prepared = Promise.withResolvers<void>(),
        tail = Promise.withResolvers<void>()
      const graph = f.run([
        tool(
          async () => {
            await f.request(f.turnId)
            if (earlyApproval) await f.service.approve(f.context, f.approval())
            prepared.resolve()
            return JSON.stringify(f.service.status(f.scope))
          },
          {
            name: "mod_authoring",
            description: "Original native preparation",
            schema: z.object({})
          }
        ),
        tool(
          async () => {
            await tail.promise
            return "the other original tool completed"
          },
          { name: "batch_tail", description: "Other original batch work", schema: z.object({}) }
        )
      ])
      const pending = graph.invoke()
      await prepared.promise
      expect(graph.model.calls).toHaveLength(1)
      expect(f.install.apply).not.toHaveBeenCalled()
      expect(f.service.hasPendingTurnReview(f.context, f.turnId)).toBe(true)
      let finished = false
      void pending.then(() => {
        finished = true
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(finished).toBe(false)
      tail.resolve()
      const result = await pending
      const state = await graph.snapshot()
      expect(state.next).toEqual([])
      expect(graph.model.calls).toHaveLength(1)
      const messages = result.messages as BaseMessage[]
      expect(messages.filter(HumanMessage.isInstance).map((message) => message.id)).toEqual([
        "original-human"
      ])
      expect(messages.filter(AIMessage.isInstance)).toHaveLength(1)
      expect(
        messages
          .filter(ToolMessage.isInstance)
          .map((message) => message.tool_call_id)
          .sort()
      ).toEqual(["call-0", "call-1"])
      expect(state.values.messages.map((message) => message.id)).toEqual(
        messages.map((message) => message.id)
      )
      const completion = readTurnCompletionGateReport(f.scope.threadId, f.turnId)
      expect(completion ? describeTurnCompletionFailure(completion) : null).toBeNull()
      expect(f.install.apply).not.toHaveBeenCalled()

      // The original completed observer is the only path that settles the plan.
      // Its original installer still waits for real physical lease release.
      f.settle()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(f.install.apply).not.toHaveBeenCalled()
      expect(f.service.hasPendingTurnReview(f.context, f.turnId)).toBe(false)
      releaseLocalThreadRunLease(f.scope.threadId, "desktop", f.turnId)
      if (!earlyApproval) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(f.service.status(f.scope)?.phase).toBe("needs-approval")
        expect(f.install.apply).not.toHaveBeenCalled()
        await f.service.approve(f.context, f.approval())
      }
      await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
      expect(f.install.apply).toHaveBeenCalledTimes(1)
      expect(f.approveInstalled).toHaveBeenCalledTimes(1)
      expect(f.applySelection).toHaveBeenCalledTimes(1)
    }
  )

  it.each(["source", "compiled", "turn", "scope", "mode", "lease", "queue-owner", "failed", "unknown"])(
    "does not yield for changed or unconfirmed original facts: %s",
    async (change) => {
      const f = await reviewGraphFixture()
      const graph = f.run([
        tool(
          async () => {
            await f.request(change === "turn" ? "different-original-turn" : f.turnId)
            if (change === "source") f.changeSource()
            if (change === "compiled") f.prepared.compiledDigest = "c".repeat(64)
            if (change === "scope") f.stale()
            if (change === "mode")
              await f.development.setMode(f.scope.threadId, f.scope.workspace, "normal")
            if (change === "lease") {
              releaseLocalThreadRunLease(f.scope.threadId, "desktop", f.turnId)
              // Reusing the public run id cannot revive the captured physical owner.
              claimLocalThreadRunLease({
                threadId: f.scope.threadId,
                owner: "desktop",
                runId: f.turnId
              })
            }
            if (change === "queue-owner") {
              clearCurrentRunMessageQueue(f.scope.threadId, f.turnId)
              setCurrentRunMessageQueueOwner(f.scope.threadId, f.turnId)
            }
            if (change === "failed") {
              f.settle("failed")
              await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("failed"))
            }
            if (change === "unknown") {
              f.install.apply.mockResolvedValueOnce({
                operationId: "operation",
                installationId: "formal-plugin",
                versionId: "version",
                state: "unknown"
              } as never)
              f.settle()
              await f.service.approve(f.context, f.approval())
              releaseLocalThreadRunLease(f.scope.threadId, "desktop", f.turnId)
              await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("unknown"))
              claimLocalThreadRunLease({
                threadId: f.scope.threadId,
                owner: "desktop",
                runId: f.turnId
              })
            }
            if (["source", "compiled", "turn", "scope", "failed", "unknown"].includes(change))
              expect(f.service.hasPendingTurnReview(f.context, f.turnId)).toBe(false)
            if (change === "mode")
              expect(
                f.development.hasPendingNativeTurnReview(
                  f.scope.threadId, f.scope.workspace, f.turnId
                )
              ).toBe(false)
            return JSON.stringify({ phase: "needs-approval", planId: "not-authority" })
          },
          {
            name: "mod_authoring",
            description: "Original native preparation",
            schema: z.object({})
          }
        )
      ])
      const result = await graph.invoke()
      expect(graph.model.calls).toHaveLength(2)
      expect(result.messages.at(-1)?.content).toBe("continued normally")
      expect(f.install.apply).toHaveBeenCalledTimes(change === "unknown" ? 1 : 0)
      expect(f.approveInstalled).not.toHaveBeenCalled()
    }
  )

  it("never treats ordinary tool review JSON as a native plan", async () => {
    const f = await reviewGraphFixture()
    const graph = f.run([
      tool(
        async () =>
          JSON.stringify({
            phase: "needs-approval",
            turnId: f.turnId,
            sourceDigest: f.prepared.sourceDigest,
            compiledDigest: f.prepared.compiledDigest
          }),
        {
          name: "ordinary_tool",
          description: "Untrusted ordinary output",
          schema: z.object({})
        }
      )
    ])
    await graph.invoke()
    expect(graph.model.calls).toHaveLength(2)
    expect(f.service.status(f.scope)).toBeUndefined()
    expect(f.install.prepare).not.toHaveBeenCalled()
    expect(f.install.apply).not.toHaveBeenCalled()
  })

  it("does not install handoff middleware outside the original desktop creator scope", async () => {
    const f = await reviewGraphFixture()
    expect(
      createCreatorNativeReviewMiddleware({
        threadId: f.scope.threadId,
        workspace: "different-workspace",
        runToken: f.turnId
      })
    ).toBeUndefined()
    expect(
      createCreatorNativeReviewMiddleware({
        threadId: f.scope.threadId,
        workspace: f.scope.workspace,
        runToken: "different-run"
      })
    ).toBeUndefined()
    releaseLocalThreadRunLease(f.scope.threadId, "desktop", f.turnId)
    claimLocalThreadRunLease({ threadId: f.scope.threadId, owner: "mods", runId: f.turnId })
    expect(
      createCreatorNativeReviewMiddleware({
        threadId: f.scope.threadId,
        workspace: f.scope.workspace,
        runToken: f.turnId
      })
    ).toBeUndefined()
    releaseLocalThreadRunLease(f.scope.threadId, "mods", f.turnId)
    claimLocalThreadRunLease({ threadId: f.scope.threadId, owner: "desktop", runId: f.turnId })
    await f.development.setMode(f.scope.threadId, f.scope.workspace, "normal")
    expect(
      createCreatorNativeReviewMiddleware({
        threadId: f.scope.threadId,
        workspace: f.scope.workspace,
        runToken: f.turnId
      })
    ).toBeUndefined()
  })
})

describe("one-review formal creator reuse", () => {
  it("projects a cold unstarted review as requiring fresh preparation without changing its record", async () => {
    const f = fixture()
    const write = vi.spyOn(f.deps.settings, "compareAndSetSetting")
    await f.request()
    const approval = f.approval()
    const [storageKey, , stored] = write.mock.calls.at(-1)!
    f.service.close()
    write.mockClear()
    const restored = f.create()
    expect(restored.status(f.scope)).toMatchObject({
      ...approval,
      phase: "failed",
      error: "CREATOR_REUSE_PREPARE_REQUIRED"
    })
    expect(f.deps.settings.getSetting(storageKey)).toBe(stored)
    expect(write).not.toHaveBeenCalled()
    await expect(restored.approve(f.context, approval)).rejects.toThrow(
      "CREATOR_REUSE_PREPARE_REQUIRED"
    )
    expect(f.install.prepare).toHaveBeenCalledTimes(1)
    expect(f.install.apply).not.toHaveBeenCalled()
    expect(f.approveInstalled).not.toHaveBeenCalled()
    await restored.request(f.context, f.deps.readDraft(), {
      signal: new AbortController().signal,
      assertTurn: () => {}
    })
    expect(restored.status(f.scope)).toMatchObject({ phase: "needs-approval" })
    expect(restored.status(f.scope)?.error).toBeUndefined()
    expect(restored.status(f.scope)?.planId).not.toBe(approval.planId)
    await expect(restored.approve(f.context, approval)).rejects.toThrow(
      "CREATOR_REUSE_APPROVAL_CHANGED"
    )
    expect(f.install.prepare).toHaveBeenCalledTimes(2)
    expect(f.install.apply).not.toHaveBeenCalled()
    expect(f.approveInstalled).not.toHaveBeenCalled()
  })

  it("prepares the current changed draft and source only after a fresh explicit request", async () => {
    const f = fixture()
    await f.request()
    const old = f.approval()
    f.service.close()
    const source = createAuthoringTemplate({
      id: "demo",
      name: "Demo",
      instruction: "New source",
      kind: "command"
    })
    const next = { ...f.deps.readDraft(), revision: 2, currentRevision: 2, source }
    f.deps.readDraft = () => next
    f.prepared.sourceDigest = source.digest
    f.prepared.compiledDigest = "c".repeat(64)
    const restored = f.create()
    expect(restored.status(f.scope)).toMatchObject({
      phase: "failed",
      sourceDigest: old.sourceDigest
    })
    await expect(restored.approve(f.context, old)).rejects.toThrow("CREATOR_REUSE_PREPARE_REQUIRED")
    expect(f.install.prepare).toHaveBeenCalledTimes(1)
    await restored.request(f.context, next, {
      signal: new AbortController().signal,
      assertTurn: () => {}
    })
    expect(restored.status(f.scope)).toMatchObject({
      phase: "needs-approval",
      revision: 2,
      sourceDigest: source.digest,
      compiledDigest: f.prepared.compiledDigest
    })
    expect(restored.status(f.scope)?.planId).not.toBe(old.planId)
    expect(f.install.apply).not.toHaveBeenCalled()
  })

  it("does not offer an old review or replay writes in another thread, directory or incarnation", async () => {
    const f = fixture()
    await f.request()
    const approval = f.approval()
    f.service.close()
    const restored = f.create()
    for (const change of [
      { threadId: "other-thread" },
      { workspace: "other-directory" },
      { incarnation: { token: "recreated", legacyCreatedAt: 2 } }
    ]) {
      const scope = { ...f.scope, ...change }
      expect(restored.status(scope)).toBeUndefined()
      await expect(restored.approve({ ...f.context, scope }, approval)).rejects.toThrow(
        "CREATOR_REUSE_APPROVAL_CHANGED"
      )
    }
    expect(f.install.prepare).toHaveBeenCalledTimes(1)
    expect(f.install.apply).not.toHaveBeenCalled()
    expect(f.approveInstalled).not.toHaveBeenCalled()
  })

  it("keeps interrupted writes and unknown records on their read-only reconciliation path", async () => {
    const f = fixture()
    const write = vi.spyOn(f.deps.settings, "compareAndSetSetting")
    await f.request()
    const [storageKey, , stored] = write.mock.calls.at(-1)!
    f.service.close()
    const restored = f.create()
    for (const phase of ["applying", "unknown"] as const) {
      const plan = JSON.parse(stored)
      plan.status.phase = phase
      plan.step = "installing"
      f.deps.settings.setSetting(storageKey, JSON.stringify(plan))
      expect(restored.status(f.scope)?.phase).toBe("unknown")
      await expect(restored.reconcile(f.context)).resolves.toMatchObject({ phase: "unknown" })
    }
    const started = JSON.parse(stored)
    started.step = "installing"
    f.deps.settings.setSetting(storageKey, JSON.stringify(started))
    expect(restored.status(f.scope)?.phase).toBe("needs-approval")
    expect(f.install.prepare).toHaveBeenCalledTimes(1)
    expect(f.install.apply).not.toHaveBeenCalled()
    expect(f.approveInstalled).not.toHaveBeenCalled()
  })

  it("completes a named save through the real reuse approval without a second installer", async () => {
    const f = fixture()
    const history = new CreatorCompositionHistory(f.deps.settings)
    let trials: DevelopmentTrialStatus[] = [{ componentId: "trial", draftId: "demo", revision: 1,
      bundleDigest: f.prepared.sourceDigest, compiledDigest: f.prepared.compiledDigest,
      phase: "active", capabilities: [] }]
    f.stopTrial.mockImplementation(async (_scope, _id, guard) => { guard(); trials = [] })
    const save = new CreatorCompositionSave(history, {
      trials: () => trials,
      prepareReuse: async (_threadId, _dependency, input) => {
        await f.service.request(f.context, f.deps.readDraft(), input)
        return f.service.status(f.scope)!
      },
      reuseFacts: scope => f.service.compositionFacts(scope)
    })
    const current = () => f.claws.selection(f.scope.workspace, f.identity).profile
    const reconcile = () => save.reconcile({ scope: f.scope, identity: f.identity, current,
      assertCurrent: f.context.assertCurrent, validate: async () => {} })
    f.deps.changed.mockImplementation(() => { queueMicrotask(() => { void reconcile() }) })
    expect(await save.start({ scope: f.scope, identity: f.identity, name: "Daily", revision: 0,
      profile: current(), signal: new AbortController().signal, assertTurn: () => {} }))
      .toMatchObject({ saved: false, phase: "needs-approval" })
    expect(history.list(f.scope.workspace)).toEqual([])
    expect(f.install.apply).not.toHaveBeenCalled()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(save.status(f.scope)).toMatchObject({ saved: true }))
    expect(history.load(f.scope.workspace, "Daily", 1)).toEqual(current())
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
    expect(f.applySelection).toHaveBeenCalledTimes(1)
    save.close()
  })
  it("prepares without effects and commits only the exact user-approved source and target", async () => {
    const f = fixture()
    await f.request()
    expect(f.service.status(f.scope)).toMatchObject({
      phase: "needs-approval",
      capabilities: ["command.register"]
    })
    expect(f.stopTrial).not.toHaveBeenCalled()
    expect(f.install.apply).not.toHaveBeenCalled()
    expect(f.approveInstalled).not.toHaveBeenCalled()
    await expect(
      f.service.approve(f.context, { ...f.approval(), targetProfileDigest: "c".repeat(64) })
    ).rejects.toThrow("CREATOR_REUSE_APPROVAL_CHANGED")
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    expect(f.stopTrial).toHaveBeenCalledTimes(1)
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledExactlyOnceWith(
      f.scope,
      expect.objectContaining({
        compiledDigest: "a".repeat(64),
        sourceDigest: f.prepared.sourceDigest
      }),
      expect.any(Function)
    )
    const selected = f.claws.selection(f.scope.workspace, f.identity).profile!
    expect(selected.models?.default).toBe("kept-model")
    expect(selected.capabilities).toEqual([
      expect.objectContaining({ pluginId: "formal-plugin", name: "demo", digest: "a".repeat(64) })
    ])
    expect(f.claws.read(f.scope.workspace).profiles).toContainEqual(selected)
    await f.service.approve(f.context, f.approval())
    await f.request()
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.applySelection).toHaveBeenCalledTimes(1)
  })
  it("waits for the successful creator turn and physical idle, without retaining its expired author guard", async () => {
    const f = fixture()
    let turnLive = true
    await f.request("turn", () => {
      if (!turnLive) throw Error("DEVELOPMENT_TURN_CHANGED")
    })
    f.busy()
    await f.service.approve(f.context, f.approval())
    turnLive = false
    publishDevelopmentTurnSettlement({
      threadId: f.scope.threadId,
      turnId: "turn",
      outcome: "completed",
      incarnation: f.scope.incarnation
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(f.install.apply).not.toHaveBeenCalled()
    f.idle()
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
  })
  it("rejects changed drafts and selections before stopping or granting", async () => {
    const f = fixture()
    await f.request()
    const approval = f.approval()
    f.changeSource()
    await expect(f.service.approve(f.context, approval)).rejects.toThrow(
      "CREATOR_REUSE_SOURCE_CHANGED"
    )
    expect(f.stopTrial).not.toHaveBeenCalled()
    expect(f.install.apply).not.toHaveBeenCalled()
  })
  it("records uncertain installation and never grants or replays its write", async () => {
    const f = fixture()
    f.install.apply.mockResolvedValueOnce({
      operationId: "operation",
      installationId: "formal-plugin",
      versionId: "version",
      state: "unknown"
    } as never)
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("unknown"))
    expect(f.approveInstalled).not.toHaveBeenCalled()
    f.service.close()
    const restored = f.create()
    expect(restored.status(f.scope)?.phase).toBe("unknown")
    await expect(restored.approve(f.context, f.approval())).rejects.toThrow(
      "CREATOR_REUSE_PREPARE_REQUIRED"
    )
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    f.pending()
    await expect(
      restored.request(f.context, f.deps.readDraft(), {
        signal: new AbortController().signal,
        assertTurn: () => {}
      })
    ).rejects.toThrow("CREATOR_REUSE_INSTALL_UNCONFIRMED")
    expect(f.install.apply).toHaveBeenCalledTimes(1)
  })
  it("retains completed facts after service recreation without reinstalling or recreating consent", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    f.service.close()
    const restored = f.create()
    expect(restored.status(f.scope)?.phase).toBe("active")
    await restored.approve(f.context, f.approval())
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("reconciles a lost completion acknowledgement from exact installed/grant/saved-binding facts only", async () => {
    const f = fixture()
    f.applySelection.mockImplementationOnce(
      async (_workspace, _threadId, _profile, commit, guard) => {
        guard()
        commit()
        guard()
        f.runtimePublished()
        throw Error("LOST_COMPLETION_ACK")
      }
    )
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("unknown"))
    f.service.close()
    const restored = f.create()
    await expect(restored.reconcile(f.context)).resolves.toMatchObject({
      phase: "active",
      installationId: "formal-plugin"
    })
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
    expect(f.applySelection).toHaveBeenCalledTimes(1)
  })
  it("does not infer successful runtime activation from a saved binding after physical retirement failed", async () => {
    const f = fixture()
    f.applySelection.mockImplementationOnce(
      async (_workspace, _threadId, _profile, commit, guard) => {
        guard()
        commit()
        throw Error("MODS_COMPOSITION_APPLY_UNCONFIRMED")
      }
    )
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("unknown"))
    f.service.close()
    const restored = f.create()
    await expect(restored.reconcile(f.context)).resolves.toMatchObject({ phase: "unknown" })
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
    expect(f.applySelection).toHaveBeenCalledTimes(1)
  })
  it("keeps the same approved plan queued when installer admission is busy", async () => {
    const f = fixture()
    f.install.apply.mockRejectedValueOnce(Error("PLUGIN_CATALOG_BUSY"))
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.install.apply).toHaveBeenCalledTimes(1))
    expect(f.service.status(f.scope)?.phase).toBe("applying")
    expect(f.approveInstalled).not.toHaveBeenCalled()
    f.idle()
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    expect(f.install.prepare).toHaveBeenCalledTimes(1)
    expect(f.install.apply).toHaveBeenCalledTimes(2)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("prepares during an active model operation and waits to begin trusted writes", async () => {
    const f = fixture()
    f.busy()
    await f.request()
    expect(f.service.status(f.scope)?.phase).toBe("needs-approval")
    await f.service.approve(f.context, f.approval())
    expect(f.stopTrial).not.toHaveBeenCalled()
    expect(f.install.apply).not.toHaveBeenCalled()
    f.idle()
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
  })
  it("waits after install and grant invalidation without aborting their own guards or replaying writes", async () => {
    const f = fixture()
    const install = f.install.apply.getMockImplementation()!
    f.install.apply.mockImplementationOnce(async (input, binding) => {
      const result = await install(input, binding)
      f.busy()
      // The real installer calls its guard again after pluginsChanged invalidates sessions.
      binding.assertCurrent()
      return result
    })
    const approve = f.approveInstalled.getMockImplementation()!
    f.approveInstalled.mockImplementationOnce(async (scope, receipt, guard) => {
      await approve(scope, receipt, guard)
      f.busy()
      guard()
    })
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.install.apply).toHaveBeenCalledTimes(1))
    expect(f.service.status(f.scope)?.phase).toBe("applying")
    expect(f.approveInstalled).not.toHaveBeenCalled()
    f.idle()
    await vi.waitFor(() => expect(f.approveInstalled).toHaveBeenCalledTimes(1))
    expect(f.service.status(f.scope)?.phase).toBe("applying")
    expect(f.applySelection).not.toHaveBeenCalled()
    f.idle()
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    expect(f.install.prepare).toHaveBeenCalledTimes(1)
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
    expect(f.stopTrial).toHaveBeenCalledTimes(1)
  })
  it("keeps an uncommitted selection queued after catalog drain admission without installing or granting twice", async () => {
    const f = fixture()
    f.applySelection.mockRejectedValueOnce(Error("MODS_CONFIG_RELOAD_BUSY"))
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.applySelection).toHaveBeenCalledTimes(1))
    expect(f.service.status(f.scope)?.phase).toBe("applying")
    f.idle()
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
    expect(f.applySelection).toHaveBeenCalledTimes(2)
  })
  it("reports revoked completed authority and notifies without restoring consent", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    f.service.reconcileAuthorizations()
    f.deps.changed.mockClear()
    f.revoke()
    expect(f.service.status(f.scope)).toMatchObject({
      phase: "failed",
      error: "CREATOR_REUSE_AUTHORITY_CHANGED"
    })
    f.service.reconcileAuthorizations()
    expect(f.deps.changed).toHaveBeenCalledExactlyOnceWith(f.scope.threadId)
    f.service.reconcileAuthorizations()
    expect(f.deps.changed).toHaveBeenCalledTimes(1)
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("keeps saved installation facts but requires positive runtime proof after retirement or restart", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    f.runtimeRetired()
    expect(f.service.status(f.scope)).toMatchObject({
      phase: "unknown",
      error: "CREATOR_REUSE_RUNTIME_UNCONFIRMED",
      installationId: "formal-plugin"
    })
    await expect(f.service.reconcile(f.context)).resolves.toMatchObject({ phase: "unknown" })
    f.runtimePublished()
    await expect(f.service.reconcile(f.context)).resolves.toMatchObject({ phase: "active" })
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("deduplicates concurrent read-only recovery probes for the same exact scope", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    f.install.resolveInstalled.mockClear()
    await Promise.all([f.service.reconcile(f.context), f.service.reconcile(f.context)])
    expect(f.install.resolveInstalled).toHaveBeenCalledTimes(1)
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("can prepare the next draft revision after observing the previous installed revision", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    const previous = f.approval()
    f.changeSource()
    await expect(f.service.reconcile(f.context)).resolves.toMatchObject({ phase: "active" })
    await f.request()
    expect(f.service.status(f.scope)).toMatchObject({ phase: "needs-approval", revision: 2 })
    expect(f.approval().planId).not.toBe(previous.planId)
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("does not overwrite a saved reusable combination edited after the exact plan was prepared", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    f.changeSource()
    await f.request()
    const approval = f.approval()
    const state = f.claws.read(f.scope.workspace)
    const edited = { ...state.profiles[0], name: "Person edited this saved combination" }
    f.claws.write(f.scope.workspace, { ...state, profiles: [edited] }, state.revision)
    await expect(f.service.approve(f.context, approval)).rejects.toThrow(
      "CREATOR_REUSE_TARGET_CHANGED"
    )
    expect(f.claws.read(f.scope.workspace).profiles).toEqual([edited])
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("reads completion facts after authoring ends without calling a draft write guard", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    f.service.close()
    const restored = f.create()
    f.deps.readDraft = () => {
      throw Error("DEVELOPMENT_DISABLED")
    }
    await expect(restored.reconcile(f.context)).resolves.toMatchObject({ phase: "active" })
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
    f.deps.changed.mockClear()
    await restored.reconcile(f.context)
    await restored.reconcile(f.context)
    expect(f.deps.changed).not.toHaveBeenCalled()
  })
  it("does not apply an explicitly approved plan from an interrupted authoring turn", async () => {
    const f = fixture()
    await f.request("cancelled-turn")
    await f.service.approve(f.context, f.approval())
    publishDevelopmentTurnSettlement({
      threadId: f.scope.threadId,
      turnId: "cancelled-turn",
      outcome: "cancelled",
      incarnation: f.scope.incarnation
    })
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("failed"))
    f.idle()
    expect(f.install.apply).not.toHaveBeenCalled()
    expect(f.approveInstalled).not.toHaveBeenCalled()
  })
})
