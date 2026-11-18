import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const budgetMock = vi.hoisted(() => vi.fn(() => 500000))
const promptHook = vi.hoisted(() => vi.fn())
const skillRoots = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []))
vi.mock("../hooks/required-skill", async importOriginal => ({
  ...(await importOriginal<typeof import("../hooks/required-skill")>()),
  runHooksEnriched: promptHook
}))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getStoredBotContextBudget: budgetMock,
  getEnabledSkillsSources: skillRoots,
  getDisabledSkillDirs: () => [],
  getEnabledPluginSkillSourceMetadata: () => []
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

const knowledgeMocks = vi.hoisted(() => ({ isKnowledgeDepositionBlocked: vi.fn(() => false) }))
vi.mock("../services/knowledge-base-manager", () => knowledgeMocks)

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
import { prepareStandardUserPrompt, validateExplicitSkillReference } from "./standard-thread-turn"
import { createHookScope } from "../hooks/scope"
import { createSkillUseTracker } from "./skill-lifecycle/tracker"
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

describe("original submit body receipt", () => {
  const prepare = (rawMessage: string, internalGoalInput?: boolean) => prepareStandardUserPrompt({
    rawMessage, initialModelInput: rawMessage, allowExplicitSkillFromMessage: false, internalGoalInput,
    threadId: "synthetic-input", workspacePath: "/fixture",
    turnState: { hookScope: createHookScope({ disabled: true }), skillUseTracker: createSkillUseTracker(), skillHookKeys: new Set() },
    harnessAgentContext: {}, onHookResult: () => {}, onHookSkippedFactory: () => () => {}
  })
  it.each(["message", "prompt", "userPrompt"])("uses the accepted %s rewrite, not additionalContext as an attachment grant", async key => {
    const original = '<attachment filename="sample.txt">private</attachment>'
    promptHook.mockResolvedValue({ updatedInput: { [key]: "Only say hello" }, additionalContext: original })
    const result = await prepare(original)
    expect(result.accepted).toBe(true)
    if (!result.accepted) throw new Error("expected accepted submit")
    expect(result.submissionContent).toBe("Only say hello")
    expect(result.content).toContain(original) // Preserve original Hook behavior for all callers.
    expect(promptHook.mock.calls.at(-1)![1]).toBe("UserPromptSubmit")
  })
  it.each(["replacement"])("does not restore literal goal scaffolding in an explicitly ordinary Bot input (%j)", async rewrite => {
    const original = '[Starting active goal]\n<attachment filename="sample.txt">private</attachment>'
    promptHook.mockResolvedValue({ updatedInput: { message: rewrite } })
    expect(await prepare(original, false)).toMatchObject({ accepted: true, content: rewrite, submissionContent: rewrite })
    // Existing callers and real runtime-owned goal prompts keep their original protection.
    expect(await prepare(original)).toMatchObject({ accepted: true, content: original })
    expect(await prepare(original, true)).toMatchObject({ accepted: true, content: original })
  })
  it.each(["message", "prompt", "userPrompt"])("refuses a fully removed Bot %s without changing default submissions", async key => {
    const original = '<attachment filename="sample.txt">private</attachment>'
    for (const rewrite of ["", " "]) {
      promptHook.mockResolvedValue({ updatedInput: { [key]: rewrite } })
      expect(await prepare(original, false)).toMatchObject({ accepted: false, blockedBy: "user_prompt_submit" })
      expect(await prepare(original)).toMatchObject({ accepted: true, content: rewrite || original })
      expect(await prepare(original, true)).toMatchObject({ accepted: true, content: original })
      promptHook.mockResolvedValue({ updatedInput: { [key]: rewrite }, additionalContext: "Approved context" })
      expect(await prepare(original, false)).toMatchObject({ accepted: true, content: `Approved context\n\n${rewrite}`, submissionContent: rewrite })
    }
  })
  it("keeps ordinary input unchanged and grants nothing on a blocked submit", async () => {
    promptHook.mockResolvedValue({ additionalContext: "context" })
    const accepted = await prepare("user input")
    expect(accepted).toMatchObject({ accepted: true, submissionContent: "user input", content: "context\n\nuser input" })
    promptHook.mockResolvedValue({ blocked: true, reason: "blocked" })
    const rejected = await prepare("user input")
    expect(rejected.accepted).toBe(false)
    expect(rejected).not.toHaveProperty("submissionContent")
  })
})

describe("desktop-selected Bot skill in the original submit chain", () => {
  it("blocks a renamed trusted Bot selection before Hooks and preserves legacy path matching", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-exact-skill-"))
    const directory = join(root, "review")
    const path = join(directory, "SKILL.md")
    mkdirSync(directory)
    writeFileSync(path, "---\nname: replacement\ndescription: A renamed skill.\n---\nReview it.\n")
    skillRoots.mockResolvedValue([root])
    promptHook.mockReset().mockResolvedValue({})
    const original = { name: "review", path }
    const prepare = (exactTrustedExplicitSkill?: boolean) => prepareStandardUserPrompt({
      rawMessage: "Check the report", initialModelInput: "Check the report",
      trustedExplicitSkill: original, exactTrustedExplicitSkill, allowExplicitSkillFromMessage: false,
      threadId: "selected-work-thread", workspacePath: root,
      turnState: {
        hookScope: createHookScope({ disabled: true }), skillUseTracker: createSkillUseTracker(), skillHookKeys: new Set()
      },
      harnessAgentContext: {}, onHookResult: () => {}, onHookSkippedFactory: () => () => {}
    })
    try {
      await expect(validateExplicitSkillReference(original, undefined, undefined, true)).resolves.toContain("review")
      await expect(prepare(true)).resolves.toMatchObject({ accepted: false, blockedBy: "explicit_skill" })
      expect(promptHook).not.toHaveBeenCalled()
      await expect(validateExplicitSkillReference({ name: "replacement", path }, undefined, undefined, true)).resolves.toBeNull()
      await expect(prepare()).resolves.toMatchObject({ accepted: true })
    } finally {
      skillRoots.mockResolvedValue([])
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(["pre-block", "submit-block", "rewrite"])("runs the target policy in order (%s)", async outcome => {
    const root = mkdtempSync(join(tmpdir(), "bot-selected-skill-"))
    const directory = join(root, "review")
    const path = join(directory, "SKILL.md")
    mkdirSync(directory)
    writeFileSync(path, "---\nname: review\ndescription: Review the actual draft.\n---\nReview it.\n")
    skillRoots.mockResolvedValueOnce([root])
    promptHook.mockClear()
    const hookScope = createHookScope({ disabled: true })
    promptHook.mockImplementation(async (_hooks, event) => {
      if (event === "PreSkillUse") return outcome === "pre-block"
        ? { blocked: true, reason: "Skill policy" }
        : { additionalContext: "Skill policy context" }
      expect(hookScope.activeSkillNames.has("review")).toBe(true)
      return outcome === "submit-block"
        ? { blocked: true, reason: "Submit policy" }
        : { updatedInput: { message: "Allowed body" }, additionalContext: "Submit policy context" }
    })
    try {
      const result = await prepareStandardUserPrompt({
        rawMessage: "Original draft", initialModelInput: "Original draft",
        trustedExplicitSkill: { name: "review", path }, allowExplicitSkillFromMessage: false,
        internalGoalInput: false, threadId: "selected-work-thread", workspacePath: root,
        turnState: { hookScope, skillUseTracker: createSkillUseTracker(), skillHookKeys: new Set() },
        harnessAgentContext: {}, onHookResult: () => {}, onHookSkippedFactory: () => () => {}
      })
      expect(promptHook.mock.calls.map(([, event]) => event)).toEqual(
        outcome === "pre-block" ? ["PreSkillUse"] : ["PreSkillUse", "UserPromptSubmit"]
      )
      expect(promptHook.mock.calls[0][2]).toMatchObject({ sessionId: "selected-work-thread", skillPath: path })
      if (outcome !== "rewrite") {
        expect(result).toMatchObject({ accepted: false, blockedBy: outcome === "pre-block" ? "explicit_skill" : "user_prompt_submit" })
        return
      }
      expect(result).toMatchObject({ accepted: true, submissionContent: "Allowed body" })
      if (!result.accepted) throw new Error("Expected accepted submit")
      expect(result.content).toContain("Allowed body")
      expect(result.content).toContain("Skill policy context")
      expect(result.content).toContain("Submit policy context")
      expect(result.content).toContain(path)
      expect(result.content).not.toContain("Original draft")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("getHarnessAgentContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    knowledgeMocks.isKnowledgeDepositionBlocked.mockReturnValue(false)
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

  it("refuses a deposition turn while its knowledge directory is synchronizing", async () => {
    knowledgeMocks.isKnowledgeDepositionBlocked.mockReturnValue(true)
    const metadata = {
      harnessProjectSession: { projectId: "project-1", kind: "system-constraints-update" }
    }
    await expect(
      getHarnessAgentContext(metadata, { workspacePath: "/knowledge/kb" })
    ).rejects.toThrow("知识库正在同步")
    expect(knowledgeMocks.isKnowledgeDepositionBlocked).toHaveBeenCalledWith(
      metadata,
      "/knowledge/kb"
    )
    expect(harnessServiceMocks.buildHarnessFeatureAgentContext).not.toHaveBeenCalled()
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
