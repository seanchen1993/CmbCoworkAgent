import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
import { resolve } from "node:path"
import type { PluginMetadata } from "../types"
import { issueRuntimePluginSourceToken, withRuntimePluginSource } from "../plugins/runtime-source-scope"
import { IdleModelServiceHoursError } from "../../shared/idle-model-service-window"
import type { CreateAgentRuntimeOptions } from "./runtime"
import {
  HarnessDeployUnitContextLimitError,
  HarnessRequiredContextError,
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
  it("does not start context preparation for an already cancelled physical run", async () => {
    const controller = new AbortController()
    controller.abort(new DOMException("cancelled before context", "AbortError"))
    await expect(getHarnessAgentContext({}, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" })
    expect(harnessServiceMocks.buildHarnessFeatureAgentContext).not.toHaveBeenCalled()
  })

  it("forwards physical cancellation and preserves its error instead of context fallback", async () => {
    const controller = new AbortController()
    harnessServiceMocks.buildHarnessFeatureAgentContext.mockImplementationOnce((_metadata, options) => {
      expect(options.signal).toBe(controller.signal)
      controller.abort(new DOMException("cancelled while loading context", "AbortError"))
      return Promise.reject(controller.signal.reason)
    })
    await expect(getHarnessAgentContext({}, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" })
  })

  it("rejects ordinary continuation of a pinned host project thread before legacy resolution", async () => {
    await expect(getHarnessAgentContext({ hostProjectRuntime: { projectId: "local" } }))
      .rejects.toThrow("PROJECT_HOST_RUN_ENTRY_REQUIRED")
    expect(harnessServiceMocks.buildHarnessFeatureAgentContext).not.toHaveBeenCalled()
  })

  it("projects the host-issued stage prompt into the original model context", async () => {
    const workspace = resolve("host-stage-context-test")
    const token = issueRuntimePluginSourceToken({
      threadId: "thread", incarnationKey: "incarnation", projectId: "local", operationId: "op",
      workspace, packageDigest: "a".repeat(64), stageId: "review",
      stagePrompt: "Execute only the review stage; write review.json.",
      requiredContextText: "Exact required generic provider context.",
      plugin: { id: "installed", name: "docs", version: "1.0.0", path: workspace } as PluginMetadata
    })
    const context = await withRuntimePluginSource(token, () => getHarnessAgentContext({
      hostProjectRuntime: { projectId: "local", operationId: "op" }, workspacePath: workspace
    }))
    expect(context.pluginPromptInject).toBe("Execute only the review stage; write review.json.")
    expect(context.harnessNodeName).toBe("review")
    expect(context.harnessAgentsPrompt).toBe("Exact required generic provider context.")
    expect(harnessServiceMocks.buildHarnessFeatureAgentContext).not.toHaveBeenCalled()
  })

  it.each(["composition-legacy:run:unit", "creator-business-trial:trial"])(
    "preserves original knowledge and host-owned stage guidance for %s", async projectId => {
      const workspace = resolve("isolated-original-stage")
      harnessServiceMocks.buildHarnessFeatureAgentContext.mockResolvedValue({
        harnessProjectId: projectId, featureId: "feature-1",
        systemPromptInject: "Original project constraints.",
        harnessAgentsPrompt: "Original selected knowledge.", enableAgentsPrompt: true
      })
      const token = issueRuntimePluginSourceToken({
        mode: "legacy", threadId: "thread", incarnationKey: "incarnation", projectId,
        featureId: "feature-1", operationId: "trial", workspace,
        packageDigest: "a".repeat(64), stageId: "original-managed-stage",
        stagePrompt: "Host-owned isolated sample guidance.",
        plugin: { id: "candidate", name: "sample", version: "1.0.0", path: workspace } as PluginMetadata
      })
      const context = await withRuntimePluginSource(token, () => getHarnessAgentContext({
        harnessFeature: { projectId, slug: "feature-1" }, workspacePath: workspace
      }, { featureBinding: { projectId, slug: "feature-1" } }))
      expect(context.pluginPromptInject).toBe(
        "Original project constraints.\n\nHost-owned isolated sample guidance.")
      expect(context.harnessAgentsPrompt).toBe("Original selected knowledge.")
      expect(context.harnessProjectId).toBe(projectId)
    }
  )
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
      baseOptions: { threadId: "thread-1", modTurnRunId: "untrusted-run" } as Omit<
        CreateAgentRuntimeOptions,
        "modelId"
      >,
      harnessContext: context
    }).optionsForModel()
    expect(runtimeOptions.requestUserInputConfig).toEqual(requestUserInputConfig)
    expect(runtimeOptions.modTurnRunId).toBe("run-1")
    expect(runtimeOptions.currentRunMessageQueueOwnerToken).toBeUndefined()
  })

  it.each([true, false, undefined])("honors the plugin task policy without widening caller restrictions: %s", async (enabled) => {
    harnessServiceMocks.buildHarnessFeatureAgentContext.mockResolvedValue({
      harnessProjectId: "project-1", featureId: "feature-1",
      agentConfig: { toolConfig: { task: enabled === undefined ? undefined : { enabled } } }
    })
    const context = await getHarnessAgentContext(
      { harnessFeature: { projectId: "project-1", slug: "feature-1" } },
      { featureBinding: { projectId: "project-1", slug: "feature-1" } }
    )
    expect(context.disableSubagents).toBe(enabled === false ? true : undefined)
    const options = (restricted: boolean) => prepareStandardThreadRuntimeFactory({
      source: "desktop", runLease: { owner: "desktop", runId: "run-1" },
      baseOptions: { threadId: "thread-1", disableSubagents: restricted } as Omit<CreateAgentRuntimeOptions, "modelId">,
      harnessContext: context
    }).optionsForModel()
    expect(options(true).disableSubagents).toBe(true)
    expect(options(false).disableSubagents).toBe(enabled === false)
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

  it("passes refreshed ordinary project discussion context into the model runtime without a slash or Host token", async () => {
    for (const stage of ["draft", "review"]) {
      const prompt = `Current bound stage ${stage}; discuss its Skill, do not start the stage.`
      harnessServiceMocks.buildHarnessFeatureAgentContext.mockResolvedValue({
        harnessProjectId: "project-1", featureId: "feature-1", systemPromptInject: prompt
      })
      const context = await getHarnessAgentContext({ harnessFeature: {
        projectId: "project-1", slug: "feature-1"
      } }, { featureBinding: { projectId: "project-1", slug: "feature-1" } })
      const options = prepareStandardThreadRuntimeFactory({ source: "desktop",
        runLease: { owner: "desktop", runId: "discussion" },
        baseOptions: { threadId: "discussion-thread", enableAgentsPrompt: true } as Omit<CreateAgentRuntimeOptions, "modelId">,
        harnessContext: context
      }).optionsForModel()
      expect(options.pluginPromptInject).toBe(prompt)
      expect(options.harnessAgentsPrompt).toBeUndefined()
      // createAgentRuntime defaults an omitted enableAgentsPrompt to true.
      expect(options.enableAgentsPrompt ?? true).toBe(true)
      expect(options.pluginRoot).toBeUndefined()
    }
  })

  it("explains missing required knowledge instead of suggesting a model retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    harnessServiceMocks.buildHarnessFeatureAgentContext.mockRejectedValue(
      new HarnessRequiredContextError(["required-team"])
    )
    const error = await getHarnessAgentContext({ harnessFeature: {} }).catch((caught: unknown) => caught)
    expect(extractErrorDetail(error)).toMatchObject({
      code: "harness_context_unavailable", statusLabel: "必需项目知识未装载",
      reason: expect.stringContaining("required-team"), hint: expect.stringContaining("更换模型不能补齐")
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
