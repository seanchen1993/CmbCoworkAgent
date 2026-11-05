import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const budgetMock = vi.hoisted(() => vi.fn(() => 500000))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getStoredBotContextBudget: budgetMock
}))

const routingMocks = vi.hoisted(() => ({
  managedModel: vi.fn<() => string | undefined>(),
  resolveModel: vi.fn()
}))
vi.mock("../harness-board/managed-run-model", () => ({
  getManagedRunModelOverride: routingMocks.managedModel
}))
vi.mock("../routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routing")>()),
  resolveModel: routingMocks.resolveModel
}))

const harnessServiceMocks = vi.hoisted(() => ({
  buildHarnessFeatureAgentContext: vi.fn(),
  getHarnessProjectAdapterSnapshot: vi.fn(),
  readHarnessFeatureMetadata: vi.fn(),
  resolveHarnessFeatureCurrentStage: vi.fn()
}))

vi.mock("../harness-board/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../harness-board/service")>()),
  ...harnessServiceMocks
}))

import {
  HARNESS_AGENT_CONTEXT_UNAVAILABLE,
  HarnessAgentContextUnavailableError,
  getHarnessAgentContext,
  getHarnessHookContext,
  resolveStandardTurnRouting,
  prepareStandardThreadRuntimeFactory
} from "./standard-thread-turn"
import { extractErrorDetail } from "./failover"
import { IdleModelServiceHoursError } from "../../shared/idle-model-service-window"
import type { CreateAgentRuntimeOptions } from "./runtime"
import {
  HarnessDeployUnitContextLimitError,
  HarnessSessionContextLimitError
} from "../harness-board/context-integrity"

describe("managed model routing", () => {
  beforeEach(() => {
    routingMocks.managedModel.mockReset()
    routingMocks.resolveModel.mockReset()
  })

  it("preserves service-hours rejections instead of treating them as routing failures", async () => {
    routingMocks.resolveModel.mockRejectedValue(new IdleModelServiceHoursError())
    await expect(resolveStandardTurnRouting({
      taskSource: "chat", threadId: "ordinary", requestedModelId: "builtin:idle-ultra",
      routingMode: "pinned"
    })).rejects.toMatchObject({ status: 400, code: "idle_model_outside_service_hours" })
  })

  it.each([undefined, "resume", "interrupt"] as const)(
    "pins Ultra without automatic routing or failover for continuation %s",
    async (continuation) => {
      routingMocks.managedModel.mockReturnValue("builtin:idle-ultra")
      const routing = await resolveStandardTurnRouting({
        taskSource: "chat",
        threadId: "managed",
        requestedModelId: "original-model",
        routingMode: "auto",
        continuation
      })
      expect(routing.effectiveModelId).toBe("builtin:idle-ultra")
      expect(routing.orderedModelIds).toEqual(["builtin:idle-ultra"])
      expect(routing.result).toMatchObject({ layer: "pinned", fallbackChain: [] })
      expect(routingMocks.resolveModel).not.toHaveBeenCalled()
    }
  )

  it("preserves ordinary routing when the managed run does not override the model", async () => {
    routingMocks.resolveModel.mockResolvedValue({
      resolvedModelId: "original-model",
      resolvedTier: "premium",
      layer: "pinned"
    })
    const routing = await resolveStandardTurnRouting({
      taskSource: "chat",
      threadId: "ordinary",
      requestedModelId: "original-model",
      routingMode: "pinned"
    })
    expect(routing.effectiveModelId).toBe("original-model")
    expect(routingMocks.resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({ requestedModelId: "original-model", routingMode: "pinned" })
    )
  })

  it("surfaces an unavailable Ultra error without falling back to ordinary routing", async () => {
    routingMocks.managedModel.mockImplementation(() => {
      throw new Error("内置 Ultra 模型不可用")
    })
    await expect(
      resolveStandardTurnRouting({ taskSource: "chat", threadId: "managed" })
    ).rejects.toThrow("Ultra 模型不可用")
    expect(routingMocks.resolveModel).not.toHaveBeenCalled()
  })
})

describe("getHarnessAgentContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    harnessServiceMocks.readHarnessFeatureMetadata.mockReturnValue({
      projectId: "project-1",
      slug: "feature-1"
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("forwards the persisted Harness request-user-input policy to the runtime context", async () => {
    const requestUserInputConfig = {
      allowAutoResolution: false,
      autoResolutionType: "select_first" as const,
      defaultTimeoutMs: 90_000,
      userMessage: "请等待用户选择"
    }
    harnessServiceMocks.buildHarnessFeatureAgentContext.mockResolvedValue({
      harnessProjectId: "project-1",
      featureId: "feature-1",
      enableAgentsPrompt: true,
      agentConfig: {
        toolConfig: { requestUserInput: requestUserInputConfig }
      }
    })

    const context = await getHarnessAgentContext(
      { harnessFeature: { projectId: "project-1", slug: "feature-1" } },
      {
        featureBinding: {
          projectId: "project-1",
          slug: "feature-1"
        }
      }
    )

    expect(context.requestUserInputConfig).toEqual(requestUserInputConfig)
    const runtimeOptions = prepareStandardThreadRuntimeFactory({
      source: "desktop",
      runLease: { owner: "desktop", runId: "run-1" },
      baseOptions: { threadId: "thread-1" } as Omit<CreateAgentRuntimeOptions, "modelId">,
      harnessContext: context
    }).optionsForModel()
    expect(runtimeOptions.requestUserInputConfig).toEqual(requestUserInputConfig)
  })

  it("blocks a Harness turn when its critical context cannot be built", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const cause = new Error("catalog worker failed")
    harnessServiceMocks.buildHarnessFeatureAgentContext.mockRejectedValue(cause)

    const error = await getHarnessAgentContext({ harnessFeature: {} }).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(HarnessAgentContextUnavailableError)
    expect(error).toMatchObject({
      name: HARNESS_AGENT_CONTEXT_UNAVAILABLE,
      code: HARNESS_AGENT_CONTEXT_UNAVAILABLE,
      featureId: "feature-1",
      harnessProjectId: "project-1",
      cause
    })
    expect(extractErrorDetail(error)).toMatchObject({
      code: "harness_context_unavailable",
      statusLabel: "Harness 上下文不可用",
      reason: "catalog worker failed"
    })
  })

  it("keeps non-Harness threads on the empty-context fast path", async () => {
    harnessServiceMocks.readHarnessFeatureMetadata.mockReturnValue(null)
    harnessServiceMocks.buildHarnessFeatureAgentContext.mockResolvedValue(null)

    await expect(getHarnessAgentContext({})).resolves.toEqual({})
  })

  it("resolves the bound adapter for a project session without a feature", async () => {
    harnessServiceMocks.readHarnessFeatureMetadata.mockReturnValue(null)
    harnessServiceMocks.buildHarnessFeatureAgentContext.mockResolvedValue(null)
    harnessServiceMocks.getHarnessProjectAdapterSnapshot.mockResolvedValue({
      id: "plugin-v3",
      name: "Kanban V3",
      version: "3.0.0",
      type: "plugin"
    })

    const context = await getHarnessAgentContext({
      harnessProjectSession: { projectId: "project-1", kind: "chat" }
    })
    expect(context).toMatchObject({
      isHarnessProjectSession: true,
      harnessProjectId: "project-1",
      pluginId: "plugin-v3",
      pluginName: "Kanban V3"
    })
    expect(getHarnessHookContext(context).harnessAdapterId).toBe("plugin-v3")
  })

  it("keeps complete Harness context when optional current-stage attribution fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    harnessServiceMocks.buildHarnessFeatureAgentContext.mockResolvedValue({
      harnessProjectId: "project-1",
      featureId: "feature-1",
      systemPromptInject: "critical harness constraints"
    })
    harnessServiceMocks.resolveHarnessFeatureCurrentStage.mockRejectedValue(
      new Error("stage projection unavailable")
    )

    await expect(
      getHarnessAgentContext({ harnessFeature: { projectId: "project-1", slug: "feature-1" } })
    ).resolves.toMatchObject({
      harnessProjectId: "project-1",
      featureId: "feature-1",
      pluginPromptInject: "critical harness constraints"
    })
  })

  it("surfaces an actionable error when plugin session context exceeds the safety budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    harnessServiceMocks.buildHarnessFeatureAgentContext.mockRejectedValue(
      new HarnessSessionContextLimitError(60_001)
    )

    const error = await getHarnessAgentContext({ harnessFeature: {} }).catch(
      (caught: unknown) => caught
    )

    expect(extractErrorDetail(error)).toMatchObject({
      code: "harness_context_unavailable",
      statusLabel: "Harness 上下文超限",
      reason: expect.stringContaining("60001")
    })
  })

  it("surfaces the framework workspace limit instead of omitting repositories", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    harnessServiceMocks.buildHarnessFeatureAgentContext.mockRejectedValue(
      new HarnessDeployUnitContextLimitError("cmbdevclaw", 65)
    )

    const error = await getHarnessAgentContext({ harnessFeature: {} }).catch(
      (caught: unknown) => caught
    )

    expect(extractErrorDetail(error)).toMatchObject({
      code: "harness_context_unavailable",
      statusLabel: "Harness 仓库上下文超限",
      reason: expect.stringContaining("received 65")
    })
  })

})

describe("Bot context budget routing", () => {
  beforeEach(() => { budgetMock.mockReset().mockReturnValue(500000) })
  afterEach(() => { budgetMock.mockReset().mockReturnValue(500000) })

  it("caps an existing Bot thread without changing its model or workspace", () => {
    const factory = prepareStandardThreadRuntimeFactory({
      source: "bot",
      runLease: { owner: "desktop", runId: "run" },
      baseOptions: { threadId: "existing-bot-thread", workspacePath: "/fixture" }
    })
    expect(factory.optionsForModel("custom:1m-model")).toMatchObject({
      contextBudgetTokens: 500000,
      modelId: "custom:1m-model",
      threadId: "existing-bot-thread",
      workspacePath: "/fixture"
    })
  })

  it("uses edited configuration for the next run while keeping model failover stable", () => {
    const createFactory = () => prepareStandardThreadRuntimeFactory({
      source: "bot",
      runLease: { owner: "desktop", runId: "run" },
      baseOptions: { threadId: "existing-bot-thread", workspacePath: "/fixture" }
    })
    budgetMock.mockReturnValue(400000)
    const active = createFactory()
    expect(active.optionsForModel("first-model").contextBudgetTokens).toBe(400000)
    budgetMock.mockReturnValue(600000)
    expect(active.optionsForModel("fallback-model").contextBudgetTokens).toBe(400000)
    expect(createFactory().optionsForModel().contextBudgetTokens).toBe(600000)
    expect(budgetMock).toHaveBeenCalledTimes(2)
  })

  it.each(["desktop", "im", "scheduler", "heartbeat"] as const)(
    "leaves ordinary %s runs on their model's original budget",
    (source) => {
      const options = prepareStandardThreadRuntimeFactory({
        source,
        runLease: { owner: "desktop", runId: "run" },
        baseOptions: { threadId: "ordinary-thread", workspacePath: "/fixture" }
      }).optionsForModel("custom:1m-model")
      expect(options.contextBudgetTokens).toBeUndefined()
      expect(budgetMock).not.toHaveBeenCalled()
    }
  )
})

describe("opt-in mock runtime policy",()=>{
  it("only omits prompt extensions for the new explicit flag, preserving existing IM and beta options",()=>{
    const base={threadId:"thread",workspacePath:"/fixture",harnessAgentsPrompt:"private agents",pluginPromptInject:"private plugin",additionalAgentsWorkspacePaths:["/private"],additionalAgentsWorkspaceMappings:[] } as Omit<CreateAgentRuntimeOptions,"modelId">
    const options=(remotePolicy?:import("./standard-thread-turn").RemoteTurnPolicy)=>prepareStandardThreadRuntimeFactory({source:"bot",runLease:{owner:"desktop",runId:"run"},baseOptions:base,harnessContext:{},remotePolicy}).optionsForModel()
    expect(options().harnessAgentsPrompt).toBe("private agents")
    expect(options({disableAgentsPrompt:true}).pluginPromptInject).toBe("private plugin")
    const mock=options({omitPromptExtensions:true,allowedToolNames:["bot_work_list"],allowedSkillNames:[],allowedExpertNames:[]})
    expect(mock.harnessAgentsPrompt).toBeUndefined()
    expect(mock.pluginPromptInject).toBeUndefined()
    expect(mock.additionalAgentsWorkspacePaths).toEqual([])
    expect(mock.allowedToolNames).toEqual(["bot_work_list"])
    expect(mock.allowedSkillNames).toEqual([])
  })
})
