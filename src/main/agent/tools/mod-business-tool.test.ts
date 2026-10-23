import { afterEach, describe, expect, it, vi } from "vitest"
import { createModBusinessTool } from "./mod-business-tool"
import {
  setCreatorBusinessService,
  type CreatorBusinessService
} from "../../mods/devtools/creator-business"
import {
  setModDevelopmentService,
  type ModDevelopmentService
} from "../../mods/devtools/development-service"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../thread-run-lease"
import { createFilesystemMiddleware } from "deepagents"
import { ToolMessage } from "@langchain/core/messages"
import { BusinessModCatalogValidationError } from "../../plugins/business-mod-catalog-schema"
import {
  BusinessModDuplicateIdError,
  BUSINESS_MOD_DUPLICATE_ID_RECOVERY
} from "../../plugins/business-mod-diagnostics"
import {
  BusinessWorkflowLinkError,
  BusinessWorkflowSkillRenameError
} from "../../plugins/business-workflow-transform"

const threadId = "business-tool-test",
  workspace = "workspace"
function fixture() {
  const mode = {
    isCreatorMode: vi.fn(() => true),
    captureCreatorMode: vi.fn(() => () => {}),
    claimAuthoringBudget: vi.fn()
  }
  const service = {
    catalog: vi.fn(() => ({ sources: [], drafts: [] })),
    example: vi.fn(),
    status: vi.fn(() => ({ drafts: [] })),
    inspect: vi.fn(async () => ({ id: "inspection" })),
    inspectionPage: vi.fn(),
    readMod: vi.fn(),
    readWorkflow: vi.fn(),
    transformWorkflow: vi.fn(),
    readAsset: vi.fn(async () => ({ text: "Python source" })),
    readRawAsset: vi.fn(),
    read: vi.fn(() => ({ revision: 2 })),
    save: vi.fn(() => ({ revision: 2 })),
    preview: vi.fn(async () => ({ valid: true })),
    previewDetails: vi.fn(),
    requestModularization: vi.fn(),
    requestReview: vi.fn(async () => ({ phase: "needs-approval" })),
    requestTrialPreview: vi.fn(async () => ({
      trial: {
        id: "creator-business-trial:actual",
        planId: "plan",
        digest: "a".repeat(64),
        phase: "needs-confirmation",
        canPrepare: false
      },
      drafts: [{ source: "x".repeat(40_000) }]
    }))
  }
  setModDevelopmentService(mode as unknown as ModDevelopmentService)
  setCreatorBusinessService(service as unknown as CreatorBusinessService)
  claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "turn" })
  return { mode, service, tool: createModBusinessTool({ threadId, workspace }) }
}
afterEach(() => {
  setModDevelopmentService(undefined)
  setCreatorBusinessService(undefined)
  releaseLocalThreadRunLease(threadId, "desktop", "turn")
})
describe("native business authoring tool", () => {
  it("returns a safe recovery route for Hook-bound original Skill names without rewriting or preparing review", async () => {
    const f = fixture()
    f.service.transformWorkflow.mockRejectedValue(new BusinessWorkflowSkillRenameError())
    const result = JSON.parse(
      await f.tool.invoke({
        action: "transform_workflow",
        inspectionId: "11111111-1111-4111-8111-111111111111",
        id: "derivative",
        name: "Derivative",
        revision: 0,
        sourceDigest: "b".repeat(64),
        expectedWorkflowDigest: "c".repeat(64),
        changes: [],
        files: []
      })
    )
    expect(result).toMatchObject({
      ok: false,
      error: "BUSINESS_WORKFLOW_SKILL_RENAME_REQUIRES_HOOK_MAPPING"
    })
    expect(result.recovery).toContain("保留原 Skill 名称修改正文")
    expect(result.recovery).toContain("不会自动重写")
    expect(f.service.requestReview).not.toHaveBeenCalled()
  })
  it("exposes source/digest-bound workflow authoring and keeps a large mutation result bounded without replay", async () => {
    const f = fixture(),
      inspectionId = "11111111-1111-4111-8111-111111111111"
    f.service.transformWorkflow.mockResolvedValue({
      draft: { id: "derivative", revision: 1, digest: "a".repeat(64) },
      sourceDigest: "b".repeat(64),
      previousWorkflowDigest: "c".repeat(64),
      workflow: { digest: "d".repeat(64), stages: [{ source: "x".repeat(50_000) }] },
      modules: [{ source: "x".repeat(50_000) }],
      changedIds: ["normalize"],
      replacements: [],
      order: ["normalize", "build"],
      execution: "unverified",
      evidence: "invalidated",
      next: "read source"
    })
    const changes = [
      {
        kind: "replace_skill" as const,
        id: "build",
        skillName: "build-v2",
        skill: { entry: "skills/build-v2/SKILL.md", resources: [] }
      }
    ]
    const args = {
      action: "transform_workflow" as const,
      inspectionId,
      id: "derivative",
      name: "Derivative",
      revision: 0,
      sourceDigest: "b".repeat(64),
      expectedWorkflowDigest: "c".repeat(64),
      changes,
      files: []
    }
    const raw = await f.tool.invoke(args)
    expect(raw.length).toBeLessThan(2000)
    expect(JSON.parse(raw)).toMatchObject({
      ok: true,
      result: {
        draft: { revision: 1 },
        evidence: "invalidated",
        execution: "unverified",
        workflowAction: expect.stringContaining("read_workflow")
      }
    })
    expect(f.service.transformWorkflow).toHaveBeenCalledOnce()
    expect(f.service.requestReview).not.toHaveBeenCalled()
    expect(f.tool.schema.safeParse({ action: "read_workflow", inspectionId }).success).toBe(true)
    expect(f.tool.schema.safeParse({ ...args, protectedModules: [] }).success).toBe(false)
    expect(f.tool.schema.safeParse({ ...args, changes: [{ kind: "erase_checks" }] }).success).toBe(
      false
    )
  })
  it("returns actionable native link diagnostics without saving or claiming business success", async () => {
    const f = fixture()
    f.service.transformWorkflow.mockRejectedValue(
      new BusinessWorkflowLinkError([
        { code: "INPUT_PRODUCER_MISSING", stageId: "build", artifactId: "normalized" }
      ])
    )
    const result = JSON.parse(
      await f.tool.invoke({
        action: "transform_workflow",
        inspectionId: "11111111-1111-4111-8111-111111111111",
        id: "derivative",
        name: "Derivative",
        revision: 0,
        sourceDigest: "b".repeat(64),
        expectedWorkflowDigest: "c".repeat(64),
        changes: [],
        files: []
      })
    )
    expect(result).toMatchObject({
      ok: false,
      error: "BUSINESS_WORKFLOW_LINKS_INVALID",
      diagnostics: [{ code: "INPUT_PRODUCER_MISSING" }]
    })
    expect(result.recovery).toContain("read_workflow")
    expect(f.service.requestReview).not.toHaveBeenCalled()
  })
  it("exposes the executable state example through the closed schema and existing source-only reader", async () => {
    const f = fixture()
    f.service.example.mockResolvedValue({
      exampleId: "autobiz-state-machine",
      installed: false,
      draft: { files: [] }
    })
    expect(
      f.tool.schema.safeParse({ action: "example", exampleId: "autobiz-state-machine" }).success
    ).toBe(true)
    expect(
      f.tool.schema.safeParse({ action: "example", exampleId: "../../local-file" }).success
    ).toBe(false)
    expect(
      JSON.parse(await f.tool.invoke({ action: "example", exampleId: "autobiz-state-machine" }))
    ).toMatchObject({
      ok: true,
      result: { exampleId: "autobiz-state-machine", installed: false }
    })
    expect(f.service.example).toHaveBeenCalledWith(threadId, "autobiz-state-machine")
    expect(f.service.requestTrialPreview).not.toHaveBeenCalled()
    expect(f.service.requestReview).not.toHaveBeenCalled()
  })
  it("describes conditional native recovery without granting model-side recovery actions", () => {
    const { tool } = fixture()
    expect(tool.description).toContain("This tool cannot execute or approve stage recovery")
    expect(tool.description).toContain("follow nextCursor")
    expect(tool.description).toContain("fresh user confirmation")
    expect(tool.description).not.toContain("Stage rollback/debug is not provided")
    expect(tool.schema.safeParse({ action: "apply_recovery" }).success).toBe(false)
  })

  it("exposes the native migration schema as exact bounded document pages", async () => {
    const f = fixture()
    let response = JSON.parse(await f.tool.invoke({ action: "modularization_schema" }))
    let result = response.result
    if (result.format === "json-pages") {
      let json = result.jsonChunk
      while (result.nextCursor !== undefined) {
        response = JSON.parse(
          await f.tool.invoke({ action: "modularization_schema", cursor: result.nextCursor })
        )
        result = response.result
        json += result.jsonChunk
      }
      result = JSON.parse(json)
    }
    expect(result.schema.properties.modules.items.required).toEqual(
      expect.arrayContaining([
        "id",
        "title",
        "node",
        "skill",
        "resources",
        "dependencies",
        "checks"
      ])
    )
    expect(result.schema.properties.kernel.properties.pluginFields.properties).toHaveProperty(
      "keywords"
    )
    expect(result.rules.join(" ")).toContain("boardConfigPath")
    expect(f.service.requestModularization).not.toHaveBeenCalled()
  })

  it("returns trusted field diagnostics for rejected migration plans", async () => {
    const f = fixture()
    const diagnostics = [
      {
        path: "catalog.modules.0.skill",
        code: "invalid_type",
        message: "Expected skill entry and resources"
      }
    ]
    f.service.requestModularization.mockRejectedValueOnce(
      new BusinessModCatalogValidationError(diagnostics)
    )
    const result = JSON.parse(
      await f.tool.invoke({
        action: "request_modularization",
        rawInspectionId: "11111111-1111-4111-8111-111111111111",
        sourceDigest: "a".repeat(64),
        modularizationCatalog: {}
      })
    )
    expect(result).toMatchObject({ ok: false, error: "BUSINESS_MOD_CATALOG_INVALID", diagnostics })
    expect(result.recovery).toContain("modularization_schema")
    expect(result).not.toHaveProperty("result")
    expect(f.service.requestReview).not.toHaveBeenCalled()
  })

  it("reconstructs larger redacted raw sources through exact identity-bound pages", async () => {
    const f = fixture()
    const rawInspectionId = "11111111-1111-4111-8111-111111111111"
    const path = "hooks/original-checker.py"
    const document = {
      path,
      text: '# Original reviewed checker\napi_key = "[redacted]"\n' + "# rule\n".repeat(30_000),
      redacted: true,
      sourceDigest: "a".repeat(64),
      originalPreserved: true
    }
    f.service.readRawAsset.mockResolvedValue(document)
    let cursor: number | undefined = 0
    let json = ""
    while (cursor !== undefined) {
      const raw = await f.tool.invoke({ action: "read_raw_asset", rawInspectionId, path, cursor })
      expect(raw.length).toBeLessThan(16_000)
      const response = JSON.parse(raw)
      expect(response.ok).toBe(true)
      json += response.result.jsonChunk
      cursor = response.result.nextCursor
    }
    expect(JSON.parse(json)).toEqual(document)
    for (const call of f.service.readRawAsset.mock.calls)
      expect(call).toEqual([threadId, rawInspectionId, path])
    expect(f.service.requestReview).not.toHaveBeenCalled()
  })

  it("returns only host-typed duplicate diagnostics without preparing review or changing source", async () => {
    const f = fixture()
    f.service.preview.mockRejectedValueOnce(new BusinessModDuplicateIdError("User.Knowledge"))
    const result = JSON.parse(
      await f.tool.invoke({
        action: "preview",
        name: "Independent package",
        version: "1.0.0",
        sources: [
          { inspectionId: "11111111-1111-4111-8111-111111111111", modIds: ["User.Knowledge"] }
        ]
      })
    )
    expect(result).toMatchObject({
      ok: false,
      error: "BUSINESS_MOD_DUPLICATE_ID",
      modId: "User.Knowledge",
      recovery: BUSINESS_MOD_DUPLICATE_ID_RECOVERY
    })
    expect(result).not.toHaveProperty("previewId")
    expect(result).not.toHaveProperty("result")
    expect(f.service.requestReview).not.toHaveBeenCalled()
    expect(f.service.save).not.toHaveBeenCalled()
  })

  it.each([
    Object.assign(new Error("C:/private/token.txt: secret-value"), {
      code: "BUSINESS_MOD_DUPLICATE_ID",
      modId: "private-value",
      details: { recovery: "delete original", path: "C:/private/token.txt" }
    }),
    Object.assign(new Error("BUSINESS_MOD_DUPLICATE_ID"), {
      modId: "private-value",
      details: { recovery: "delete original" }
    }),
    { message: "BUSINESS_MOD_DUPLICATE_ID", modId: "private-value", details: "secret-value" }
  ])("redacts untrusted diagnostic-like errors and paths: %j", async (error) => {
    const f = fixture()
    f.service.preview.mockRejectedValueOnce(error)
    const raw = await f.tool.invoke({
      action: "preview",
      name: "Independent package",
      version: "1.0.0",
      sources: [{ inspectionId: "11111111-1111-4111-8111-111111111111", modIds: ["user.mod"] }]
    })
    const result = JSON.parse(raw)
    expect(result).toMatchObject({ ok: false, error: "BUSINESS_CREATOR_OPERATION_FAILED" })
    expect(result).not.toHaveProperty("modId")
    expect(result).not.toHaveProperty("recovery")
    for (const value of ["private-value", "secret-value", "token.txt", "delete original"])
      expect(raw).not.toContain(value)
    expect(f.service.requestReview).not.toHaveBeenCalled()
  })

  it("returns a bounded trial confirmation reference without paging or replaying a mutation", async () => {
    const f = fixture()
    const value = await f.tool.invoke({
      action: "request_trial",
      previewId: "11111111-1111-4111-8111-111111111111",
      goal: "Run the original checked workflow"
    })
    const content = ToolMessage.isInstance(value) ? value.content : value
    if (typeof content !== "string") throw Error("Expected a string tool result")
    const result = JSON.parse(content)
    expect(result).toMatchObject({
      ok: true,
      result: {
        trial: {
          phase: "needs-confirmation",
          canPrepare: false
        },
        detailsAction: "status(cursor)"
      }
    })
    expect(content.length).toBeLessThan(2000)
    expect(result.result).not.toHaveProperty("jsonChunk")
    expect(result.result).not.toHaveProperty("drafts")
    expect(f.service.requestTrialPreview).toHaveBeenCalledTimes(1)
  })
  it("keeps real LangChain results structured below the application eviction boundary and pages exact contracts", async () => {
    const f = fixture(),
      inspectionId = "11111111-1111-4111-8111-111111111111"
    const mods = Array.from({ length: 64 }, (_, index) => ({
      id: `mod.${index}`,
      title: "业务步骤".repeat(20),
      dependsOn: [],
      advisory: [],
      nodeId: `node.${index}`
    }))
    const view = {
      id: inspectionId,
      sourceDigest: "a".repeat(64),
      sourceName: "Actual business source",
      kernel: { id: "original.kernel", version: "1.0.0" },
      mods,
      excluded: [],
      warnings: []
    }
    f.service.inspect.mockResolvedValue({
      ...view,
      catalog: { modules: [{ source: "x".repeat(120_000) }] }
    } as never)
    f.service.inspectionPage.mockResolvedValue(view)
    const middleware = createFilesystemMiddleware({ toolTokenLimitBeforeEvict: 6_000 })
    const throughBoundary = async (args: Parameters<typeof f.tool.invoke>[0]) => {
      const result = await middleware.wrapToolCall!(
        {
          toolCall: { id: "actual-business", name: "mod_business", args },
          state: {},
          runtime: {}
        } as never,
        async () => {
          const invoked = await f.tool.invoke(args)
          if (ToolMessage.isInstance(invoked)) return invoked
          return new ToolMessage({
            tool_call_id: "actual-business",
            name: "mod_business",
            content: invoked
          })
        }
      )
      expect(ToolMessage.isInstance(result)).toBe(true)
      if (!ToolMessage.isInstance(result) || typeof result.content !== "string")
        throw Error("Expected a structured string tool message through the actual boundary")
      const content = result.content
      expect(content.length).toBeLessThan(24_000)
      return JSON.parse(content)
    }
    let page = await throughBoundary({ action: "inspect", pluginId: "original" })
    expect(page.result).toMatchObject({ id: inspectionId, kernel: view.kernel })
    expect(page.result).not.toHaveProperty("catalog")
    const selected = [...page.result.mods]
    while (page.result.nextCursor !== undefined) {
      page = await throughBoundary({
        action: "inspect",
        inspectionId,
        cursor: page.result.nextCursor
      })
      selected.push(...page.result.mods)
    }
    expect(selected).toEqual(mods)
    f.service.catalog.mockReturnValue({
      sources: Array.from({ length: 128 }, (_, index) => ({
        pluginId: `plugin-${index}`,
        name: "名称".repeat(80),
        version: "1.0.0",
        enabled: true
      })),
      drafts: []
    } as never)
    page = await throughBoundary({ action: "catalog" })
    const sources = [...page.result.sources]
    while (page.result.nextCursor !== undefined) {
      page = await throughBoundary({ action: "catalog", cursor: page.result.nextCursor })
      sources.push(...page.result.sources)
    }
    expect(sources).toHaveLength(128)
    const contract = { mod: { id: "mod.0", skill: { prompt: '证据\\"'.repeat(9000) } } }
    f.service.readMod.mockResolvedValue(contract)
    page = await throughBoundary({ action: "read_mod", inspectionId, modId: "mod.0" })
    let exactJson = page.result.jsonChunk
    while (page.result.nextCursor !== undefined) {
      page = await throughBoundary({
        action: "read_mod",
        inspectionId,
        modId: "mod.0",
        cursor: page.result.nextCursor
      })
      exactJson += page.result.jsonChunk
    }
    expect(JSON.parse(exactJson)).toEqual(contract)
    const template = {
      exampleId: "autobiz-knowledge",
      installed: false,
      draft: {
        extensions: [{ id: "autobiz.knowledge" }],
        files: [
          {
            path: "mods/business/autobiz.knowledge/provider.py",
            text: "# actual Python\n".repeat(6000)
          }
        ]
      }
    }
    f.service.example.mockResolvedValue(template)
    page = await throughBoundary({ action: "example", exampleId: "autobiz-knowledge" })
    let templateJson = page.result.jsonChunk
    while (page.result.nextCursor !== undefined) {
      page = await throughBoundary({
        action: "example",
        exampleId: "autobiz-knowledge",
        cursor: page.result.nextCursor
      })
      templateJson += page.result.jsonChunk
    }
    expect(JSON.parse(templateJson)).toEqual(template)
    expect(f.tool.schema.safeParse({ action: "example", exampleId: "C:/private" }).success).toBe(
      false
    )
    const previewId = "22222222-2222-4222-8222-222222222222"
    f.service.preview.mockResolvedValue({
      previewId,
      digest: "b".repeat(64),
      valid: true,
      steps: [{ id: "mod.0", title: "Mod" }],
      files: Array.from({ length: 2048 }, (_, index) => ({
        path: `source/${index}.py`,
        digest: "c".repeat(64),
        bytes: 1024
      })),
      diagnostics: []
    } as never)
    page = await throughBoundary({
      action: "preview",
      name: "Scoped preview",
      version: "1.0.0",
      sources: []
    })
    expect(page.result).toMatchObject({ previewId, valid: true, fileCount: 2048 })
    expect(page.result).not.toHaveProperty("files")
    f.service.requestReview.mockResolvedValue({
      drafts: [],
      review: {
        planId: previewId,
        phase: "needs-approval",
        digest: "b".repeat(64),
        canConfirm: false,
        diagnostics: ["source".repeat(20_000)]
      }
    } as never)
    page = await throughBoundary({ action: "request_review", previewId })
    expect(page.result).toMatchObject({
      review: { planId: previewId, phase: "needs-approval" },
      detailsAction: "status(cursor)"
    })
  })
  it("uses exact native source IDs and current chat rather than model-supplied host paths", async () => {
    const f = fixture()
    await f.tool.invoke({ action: "inspect", pluginId: "installed-plugin" })
    expect(f.service.inspect).toHaveBeenCalledExactlyOnceWith(threadId, "installed-plugin")
    await expect(
      f.tool.invoke({ action: "inspect", pluginId: "installed-plugin", directory: "C:/private" })
    ).rejects.toThrow()
    expect(f.service.inspect).toHaveBeenCalledTimes(1)
  })
  it("preserves Python source as business data and shares the original authoring budget", async () => {
    const f = fixture(),
      inspectionId = "11111111-1111-4111-8111-111111111111"
    const files = [
      { path: "mods/business/user.quality/check.py", text: "raise ValueError('not done')" }
    ]
    const result = JSON.parse(
      await f.tool.invoke({
        action: "save",
        id: "quality",
        name: "Quality",
        revision: 1,
        inspectionId,
        modules: [],
        files
      })
    )
    expect(result).toMatchObject({ ok: true, result: { revision: 2 } })
    expect(f.service.save).toHaveBeenCalledExactlyOnceWith(
      threadId,
      expect.objectContaining({
        files,
        revision: 1,
        baseInspectionId: inspectionId
      })
    )
    expect(f.mode.claimAuthoringBudget.mock.calls.map((call) => call[2])).toEqual([
      "operation",
      "candidate"
    ])
  })
  it("only prepares native review; installation, approval and model-selected export paths are absent", async () => {
    const f = fixture(),
      previewId = "11111111-1111-4111-8111-111111111111"
    const result = JSON.parse(await f.tool.invoke({ action: "request_review", previewId }))
    expect(result).toMatchObject({ ok: true, result: { phase: "needs-approval" } })
    expect(f.service.requestReview).toHaveBeenCalledExactlyOnceWith(
      threadId,
      previewId,
      "turn",
      expect.any(Function)
    )
    expect(f.tool.schema.safeParse({ action: "install", previewId }).success).toBe(false)
    await expect(
      f.tool.invoke({ action: "request_review", previewId, output: "C:/overwrite.zip" })
    ).rejects.toThrow()
  })
  it("does not publish after creator mode or physical turn authority changes", async () => {
    const f = fixture()
    f.mode.isCreatorMode.mockReturnValue(false)
    expect(JSON.parse(await f.tool.invoke({ action: "catalog" }))).toMatchObject({
      ok: false,
      error: "DEVELOPMENT_TURN_CHANGED"
    })
    f.mode.isCreatorMode.mockReturnValue(true)
    releaseLocalThreadRunLease(threadId, "desktop", "turn")
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "turn" })
    expect(JSON.parse(await f.tool.invoke({ action: "catalog" }))).toMatchObject({
      ok: false,
      error: "DEVELOPMENT_TURN_CHANGED"
    })
    expect(f.service.catalog).not.toHaveBeenCalled()
  })
  it("does not recreate tools to evade an exhausted cumulative request budget", async () => {
    const f = fixture()
    f.mode.claimAuthoringBudget.mockImplementation(() => {
      throw Error("DEVELOPMENT_TURN_BUDGET")
    })
    for (const tool of [f.tool, createModBusinessTool({ threadId, workspace })]) {
      expect(JSON.parse(await tool.invoke({ action: "catalog" }))).toMatchObject({
        ok: false,
        error: "DEVELOPMENT_TURN_BUDGET"
      })
    }
    expect(f.service.catalog).not.toHaveBeenCalled()
  })
})
