import { afterEach, describe, expect, it, vi } from "vitest"
import { createModAuthoringTool } from "./mod-authoring-tool"
import {
  setModDevelopmentService,
  type ModDevelopmentService
} from "../../mods/devtools/development-service"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../thread-run-lease"
import { projectAuthoringSessions } from "../../mods/devtools/project-authoring-session"
import { DevelopmentCandidateError } from "../../mods/devtools/development-candidate-diagnostics"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { CreatorRequestBudgets } from "../../mods/devtools/creator-request-budget"
import * as stageDebug from "../../mods/devtools/project-stage-debug"
import { createAuthoringTemplate } from "../../mods/devtools/authoring-templates"
import { createAuthoringSourceBundle } from "../../mods/devtools/authoring-bundle"
import {
  compileNativeComposition,
  nativeCompositionSchema,
  NativeCompositionDependencyError
} from "../../plugins/native-composition"
import {
  assertNativeCompositionDependencies
} from "../../plugins/native-composition-dependencies"
import * as dependencyCatalog from "../../mods/devtools/development-dependency-catalog"
import * as dependencyPreparation from "../../mods/devtools/development-dependency-prepare"
import { ProjectContractError } from "../../mods/devtools/project-contract"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import { resolve } from "node:path"
import { readProjectSource } from "../../mods/devtools/project-source"
import { assertProjectAuthoringSkillMetadata } from "../../mods/devtools/project-authoring-skill-metadata"
import { AuthoringStructureError } from "../../mods/devtools/authoring-structure-diagnostics"

vi.mock("../../storage", () => ({ getPlugins: vi.fn(() => []) }))

const threadId = "authoring-tool-test"
const workspace = "workspace"
function authoringFiles(source?: string) {
  return createAuthoringTemplate({
    id: "demo",
    name: "Demo",
    instruction: "Test",
    kind: "command"
  }).files.map((file) =>
    file.path === "mods/main.ts" && source !== undefined ? { ...file, text: source } : file
  )
}
function currentDocument(id: string, revision: number) {
  return { id, revision, source: { digest: "a".repeat(64), files: authoringFiles() } }
}
function fixture(existing: Record<string, number> = {}) {
  const service = {
    isCreatorMode: vi.fn((id, root) => id === threadId && root === workspace),
    status: vi.fn(() => ({ enabled: true })),
    read: vi.fn((_thread: string, id: string) => {
      const revision = existing[id]
      if (revision === undefined) throw Error("AUTHORING_VERSION_MISSING")
      return currentDocument(id, revision)
    }),
    save: vi.fn(() => ({ revision: 1 })),
    check: vi.fn(async () => ({ valid: true })),
    requestTrial: vi.fn(async () => ({ trials: [] })),
    submit: vi.fn(async () => ({ check: { valid: true, runtimeVerified: false } })),
    resumeTrial: vi.fn(async () => ({ trials: [] })),
    undoTrial: vi.fn(async () => ({ action: "restore-queued" })),
    requestReuse: vi.fn(async () => ({ reuse: { phase: "needs-approval" } }))
  }
  setModDevelopmentService(service as unknown as ModDevelopmentService)
  claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "first" })
  return service
}
afterEach(() => {
  vi.restoreAllMocks()
  releaseLocalThreadRunLease(threadId, "desktop", "first")
  releaseLocalThreadRunLease(threadId, "desktop", "second")
  setModDevelopmentService(undefined)
})

describe("conversation Mod tool", () => {
  it("guides source-only creation and cross-Mod discovery without workspace side effects", async () => {
    fixture()
    const author = createModAuthoringTool({ threadId, workspace })
    expect(author.description).toContain("Do not write temporary workspace files")
    expect(author.description).toContain("catalog(query:'platform.action',catalogSection:'events')")
    expect(author.description).toContain("catalog(query:'platform.act',catalogSection:'sdk')")
    const result = JSON.parse(await author.invoke({
      action: "scaffold", id: "demo", kind: "tool", instruction: "Normalize text"
    }))
    expect(result).toMatchObject({ ok: false, error: "DEVELOPMENT_INPUT", missingFields: ["name"] })
    expect(result.hint).toContain("完整 files 提交 submit")
    expect(result.hint).toContain("不需要写工作区临时文件")
  })
  it("routes exact static discovery queries without exposing installed actions or executing", async () => {
    const service = fixture()
    const tool = createModAuthoringTool({ threadId, workspace })
    const result = JSON.parse(await tool.invoke({ action: "catalog", query: "ui.resolve" }))
    expect(result.ok).toBe(true)
    expect(result.result).toMatchObject({ query: "ui.resolve", matched: true,
      scope: "static-authoring-contract", grantsAuthority: false, sdkMethods: ["ui.resolve"] })
    expect(result.result.content).toContain("resolve(event:UiEvent):UiElements")
    expect(JSON.stringify(result)).not.toContain("pluginId")
    expect(service.submit).not.toHaveBeenCalled()
    expect(service.requestTrial).not.toHaveBeenCalled()
    expect(service.requestReuse).not.toHaveBeenCalled()
  })

  it("returns an actionable fixed manifest diagnostic without granting or executing", async () => {
    const service = fixture({ demo: 1 })
    service.check.mockRejectedValue(new AuthoringStructureError("CLAW_COMPONENT_ENTRY_CONFLICT"))
    const tool = createModAuthoringTool({ threadId, workspace })
    const raw = await tool.invoke({ action: "check", id: "demo", revision: 1 })
    const result = JSON.parse(raw)
    expect(result).toMatchObject({ ok: false, error: "CLAW_COMPONENT_ENTRY_CONFLICT",
      diagnostics: [{ scope: "manifest", path: "/entry" }], executed: false })
    expect(result.hint).toContain("先 read")
    expect(service.requestTrial).not.toHaveBeenCalled()
  })
  it.each([
    ["", "missing"],
    ['description: "   "', "empty"],
    ["description: {secret: PRIVATE_DESCRIPTION}", "not-string"]
  ])("returns safe new-author Skill metadata diagnostics for %s", async (yaml, reason) => {
    const service = fixture()
    Object.assign(service, {
      projectAuthoringContext: () => ({
        scope: { threadId, workspace },
        assertCurrent: () => undefined
      }),
      assertScope: () => undefined
    })
    const original = await readProjectSource(resolve("tests/fixtures/native-compositions/vendor"))
    const source = createAuthoringSourceBundle(
      original.bundle.files.map((file) =>
        file.path === "modules/normalize/SKILL.md"
          ? {
              ...file,
              text: `---\nname: vendor-normalize\n${yaml}\n---\nPRIVATE_BODY`
            }
          : file
      )
    )
    const before = source.digest
    vi.spyOn(projectAuthoringSessions, "compile").mockImplementation(async () => {
      assertProjectAuthoringSkillMetadata(source)
      throw Error("EXPECTED_NEW_AUTHOR_METADATA_REJECTION")
    })
    const author = createModAuthoringTool({ threadId, workspace })
    const raw = await author.invoke({ action: "project_compile", id: "demo", revision: 3 })
    const result = JSON.parse(raw)
    expect(result).toMatchObject({
      ok: false,
      error: "PROJECT_AUTHORING_SKILL_METADATA_INVALID",
      sourceUnchanged: true,
      executed: false,
      diagnosticCount: 1,
      diagnostics: [
        {
          path: "modules/normalize/SKILL.md",
          declarationPath: "/modules/0/skill",
          field: "description",
          reason
        }
      ]
    })
    expect(result.hint).toContain("存量 Host 固定路径执行")
    expect(raw).not.toMatch(/PRIVATE_|stack|Error:/)
    expect(source.digest).toBe(before)
    expect(service.save).not.toHaveBeenCalled()
    expect(service.requestTrial).not.toHaveBeenCalled()
  })

  it("does not trust a diagnostic-shaped ordinary error for Skill metadata", async () => {
    const service = fixture()
    Object.assign(service, {
      projectAuthoringContext: () => ({
        scope: { threadId, workspace },
        assertCurrent: () => undefined
      }),
      assertScope: () => undefined
    })
    vi.spyOn(projectAuthoringSessions, "compile").mockRejectedValue(
      Object.assign(Error("PROJECT_AUTHORING_SKILL_METADATA_INVALID"), {
        diagnostics: [{ message: "PRIVATE_VALUE" }]
      })
    )
    const author = createModAuthoringTool({ threadId, workspace })
    const raw = await author.invoke({ action: "project_compile", id: "demo", revision: 3 })
    expect(JSON.parse(raw)).not.toHaveProperty("diagnostics")
    expect(raw).not.toContain("PRIVATE_VALUE")
  })

  it.each(["plugin", "actionId", "name"] as const)(
    "finds installed authorized actions by a trimmed case-insensitive %s substring", async (field) => {
      const service = fixture()
      Object.assign(service, {
        projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => undefined }),
        assertScope: () => undefined
      })
      const provider: ClawActionDescriptor = {
        pluginId: "actual-install", plugin: "validators", actionId: "validate",
        digest: "a".repeat(64), name: "Validate artifacts", command: "validate", inputSchema: {},
        [field]: "before-MATCH-after"
      }
      const unrelated = { ...provider, pluginId: "other-install", plugin: "other",
        actionId: "other", name: "Other", description: "MATCH is not a searchable field" }
      const actions = vi.fn(async () => [unrelated, provider])
      const author = createModAuthoringTool({ threadId, workspace, projectActions: actions })
      const result = JSON.parse(await author.invoke({ action: "project_actions", query: "  mAtCh  " }))
      expect(result).toMatchObject({ ok: true, result: {
        query: "mAtCh", actions: [provider], nextCursor: null,
        scope: "installed-authorized-public-actions", executed: false, grantsAuthority: false
      } })
      expect(result.result.actions).toEqual([provider])
      expect(actions).toHaveBeenCalledWith(workspace, threadId)
      expect(service.requestReuse).not.toHaveBeenCalled()
      expect(service.requestTrial).not.toHaveBeenCalled()
    }
  )

  it("pages filtered actions before slicing and lets id plus query discover an undeclared action", async () => {
    const service = fixture()
    Object.assign(service, {
      projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => undefined }),
      assertScope: () => undefined
    })
    const read = vi.spyOn(projectAuthoringSessions, "read").mockImplementation(() => {
      throw Error("PROJECT_DRAFT_MUST_NOT_BE_READ_FOR_DISCOVERY")
    })
    const providers: ClawActionDescriptor[] = Array.from({ length: 11 }, (_, index) => ({
      pluginId: `install-${index}`, plugin: index % 2 ? "other" : "verification",
      actionId: `check-${index}`, digest: "a".repeat(64), name: `Check ${index}`,
      command: "check", inputSchema: {}
    }))
    const author = createModAuthoringTool({ threadId, workspace, projectActions: async () => providers })
    const args = { action: "project_actions" as const, id: "demo", revision: 999,
      localActionId: "new.check", query: "verification" }
    const first = JSON.parse(await author.invoke(args))
    expect(first).toMatchObject({ ok: true, result: { nextCursor: 4, actions: [
      providers[0], providers[2], providers[4], providers[6]
    ] } })
    const second = JSON.parse(await author.invoke({ ...args, cursor: first.result.nextCursor }))
    expect(second).toMatchObject({ ok: true, result: { nextCursor: null,
      actions: [providers[8], providers[10]] } })
    expect(first.result).not.toHaveProperty("requirement")
    expect(first.result).not.toHaveProperty("id")
    expect(read).not.toHaveBeenCalled()
  })

  it("returns no matches without advancing authority and validates cursors against filtered actions", async () => {
    const service = fixture()
    Object.assign(service, {
      projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => undefined }),
      assertScope: () => undefined
    })
    const provider: ClawActionDescriptor = { pluginId: "install", plugin: "validators",
      actionId: "verify", digest: "a".repeat(64), name: "Verify", command: "verify", inputSchema: {} }
    const author = createModAuthoringTool({ threadId, workspace, projectActions: async () => [provider] })
    expect(JSON.parse(await author.invoke({ action: "project_actions", query: "missing" })))
      .toMatchObject({ ok: true, result: { actions: [], nextCursor: null,
        executed: false, grantsAuthority: false } })
    expect(JSON.parse(await author.invoke({ action: "project_actions", query: "missing", cursor: 1 })))
      .toMatchObject({ ok: false, error: "DEVELOPMENT_CATALOG_CURSOR" })
    expect(JSON.parse(await author.invoke({ action: "project_actions" })))
      .toMatchObject({ ok: true, result: { actions: [provider], nextCursor: null } })
    expect(service.save).not.toHaveBeenCalled()
    expect(service.requestReuse).not.toHaveBeenCalled()
  })

  it.each(["", "   ", "q".repeat(121)])("rejects an invalid installed-action query before discovery (%j)", async query => {
    fixture()
    const actions = vi.fn(async () => [])
    const author = createModAuthoringTool({ threadId, workspace, projectActions: actions })
    await expect(author.invoke({ action: "project_actions", query })).rejects.toThrow()
    expect(actions).not.toHaveBeenCalled()
  })

  it.each(["creator", "scope"] as const)("keeps the %s guard after asynchronous filtered discovery", async changed => {
    const service = fixture()
    let current = true
    Object.assign(service, {
      projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => {
        if (!current) throw Error("PROJECT_SCOPE_RETIRED")
      } }),
      assertScope: () => undefined
    })
    const provider: ClawActionDescriptor = { pluginId: "install", plugin: "validators",
      actionId: "verify", digest: "a".repeat(64), name: "Verify", command: "verify", inputSchema: {} }
    const actions = vi.fn(async () => {
      if (changed === "creator") service.isCreatorMode.mockReturnValue(false)
      else current = false
      return [provider]
    })
    const author = createModAuthoringTool({ threadId, workspace, projectActions: actions })
    const response = JSON.parse(await author.invoke({ action: "project_actions", query: "verify" }))
    expect(response).toMatchObject({ ok: false,
      error: changed === "creator" ? "DEVELOPMENT_TURN_CHANGED" : "PROJECT_SCOPE_RETIRED" })
    expect(response).not.toHaveProperty("result")
  })

  it("returns contract field reasons from compile without returning fixture bodies or changing source", async () => {
    const service = fixture()
    Object.assign(service, {
      projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => undefined }),
      assertScope: () => undefined
    })
    vi.spyOn(projectAuthoringSessions, "compile").mockRejectedValue(new ProjectContractError([{
      code: "PROJECT_CONTRACT_ARTIFACT_UNDECLARED", file: "tests/project-contract.json",
      path: "/cases/2/files/0/path", message: "Fixture path must match a declared artifact.",
      allowedPaths: ["current-report.json"]
    }], "PROJECT_CONTRACT_FILE_INVALID"))
    const author = createModAuthoringTool({ threadId, workspace })
    const response = JSON.parse(await author.invoke({ action: "project_compile", id: "demo", revision: 3 }))
    expect(response).toMatchObject({ ok: false, error: "PROJECT_CONTRACT_FILE_INVALID",
      sourceUnchanged: true, diagnosticCount: 1, executed: false, diagnostics: [{
        file: "tests/project-contract.json", path: "/cases/2/files/0/path",
        allowedPaths: ["current-report.json"]
      }] })
    expect(response.hint).toContain("不能用content替代")
    expect(service.save).not.toHaveBeenCalled()
  })
  it("returns repairable userConfig diagnostics from the real native composition parser", async () => {
    const service = fixture()
    Object.assign(service, {
      projectAuthoringContext: () => ({
        scope: { threadId, workspace },
        assertCurrent: () => undefined
      }),
      assertScope: () => undefined
    })
    const source = {
      apiVersion: "devclaw.native-composition/v1",
      plugin: { id: "records", version: "2.0.0", title: "Records", description: "Records" },
      resources: [],
      environment: [],
      configuration: {
        userConfig: {
          e2eTimeoutMs: {
            type: "number",
            title: "PRIVATE_TITLE",
            description: "PRIVATE_DESCRIPTION",
            minimum: 1000,
            maximum: 120000,
            default: 987654321
          }
        }
      },
      modules: [
        {
          id: "review",
          version: "2.0.0",
          title: "Review",
          skill: "modules/review/SKILL.md",
          inputs: [],
          outputs: [{ id: "report", path: "REPORT.json", contract: "records.report/v1" }],
          checks: [{ id: "report.verify", kind: "json-schema", artifactId: "report", schema: {} }]
        }
      ]
    }
    const snapshot = JSON.stringify(source)
    vi.spyOn(projectAuthoringSessions, "compile").mockImplementation(async () => {
      compileNativeComposition(source, { files: [], actionCatalog: [] })
      throw Error("EXPECTED_CONFIGURATION_REJECTION")
    })
    const read = vi.spyOn(projectAuthoringSessions, "read")
    const author = createModAuthoringTool({ threadId, workspace })
    const raw = await author.invoke({ action: "project_compile", id: "demo", revision: 4 })
    const response = JSON.parse(raw)
    expect(response).toMatchObject({
      ok: false,
      error: "MODS_USER_CONFIG_INVALID",
      diagnosticCount: 1,
      executed: false,
      diagnostics: [
        {
          scope: "userConfig",
          path: "/e2eTimeoutMs",
          reason: "unsupported-key",
          allowedKeys: expect.arrayContaining(["min", "max"])
        }
      ]
    })
    expect(response.hint).toContain("composition/source.json")
    expect(response.hint).toContain("/configuration/userConfig")
    expect(response.hint).toContain("project_read")
    expect(response.diagnostics[0]).not.toHaveProperty("file")
    expect(raw).not.toMatch(/PRIVATE_|987654321|minimum|maximum|stack/)
    expect(JSON.stringify(source)).toBe(snapshot)
    expect(read).not.toHaveBeenCalled()
    expect(service.save).not.toHaveBeenCalled()
    expect(service.requestTrial).not.toHaveBeenCalled()
  })
  it.each([
    {
      input: { timeout: { type: "number", title: "Timeout" } },
      reason: "invalid-description",
      path: "/timeout/description"
    },
    {
      input: {
        credential: {
          type: "number",
          title: "PRIVATE_TITLE",
          description: "PRIVATE_DESCRIPTION",
          sensitive: true,
          default: "PRIVATE_DEFAULT"
        }
      },
      reason: "invalid-default",
      path: "/credential/default"
    },
    { input: { ["PRIVATE_UNTRUSTED/".repeat(20)]: {} }, reason: "invalid-field-name", path: "" },
    {
      input: JSON.parse('{"constructor":{"default":"PRIVATE_PROTO_VALUE"}}'),
      reason: "invalid-json",
      path: ""
    },
    {
      input: {
        oversized: {
          type: "string",
          title: "PRIVATE_TITLE",
          description: "PRIVATE_OVERSIZE".repeat(5000)
        }
      },
      reason: "schema-limit",
      path: ""
    }
  ])(
    "returns bounded real parser diagnostics for $reason through the ordinary tool",
    async ({ input, reason, path }) => {
      const service = fixture()
      service.check.mockImplementation(async () => {
        parseFunctionUserConfig(input)
        return { valid: true }
      })
      const author = createModAuthoringTool({ threadId, workspace })
      const raw = await author.invoke({ action: "check", id: "demo", revision: 4 })
      const response = JSON.parse(raw)
      expect(response).toMatchObject({
        ok: false,
        error: "MODS_USER_CONFIG_INVALID",
        diagnosticCount: 1,
        diagnostics: [{ scope: "userConfig", reason, path }]
      })
      expect(response.hint).toContain("mods/manifest.json")
      expect(response.hint).not.toContain("composition/source.json")
      expect(raw).not.toMatch(/PRIVATE_|stack/)
      expect(raw.length).toBeLessThan(1600)
      expect(service.save).not.toHaveBeenCalled()
    }
  )
  it("ignores diagnostic-shaped data on ordinary host errors and retains their safe code", async () => {
    const service = fixture()
    service.check.mockRejectedValue(
      Object.assign(new ModFunctionError("MODS_USER_CONFIG_INVALID", "PRIVATE_RAW_ERROR"), {
        diagnostic: { path: "PRIVATE_PATH", reason: "PRIVATE_REASON", message: "PRIVATE_VALUE" },
        stack: "PRIVATE_STACK"
      })
    )
    const raw = await createModAuthoringTool({ threadId, workspace }).invoke({
      action: "check",
      id: "demo",
      revision: 4
    })
    expect(JSON.parse(raw)).toMatchObject({ ok: false, error: "MODS_USER_CONFIG_INVALID" })
    expect(JSON.parse(raw)).not.toHaveProperty("diagnostics")
    expect(raw).not.toContain("PRIVATE_")
  })
  it.each([0, 65])(
    "returns real source parser diagnostics for a compiled %i-file package",
    async (count) => {
      const service = fixture()
      Object.assign(service, {
        projectAuthoringContext: () => ({
          scope: { threadId, workspace },
          assertCurrent: () => undefined
        }),
        assertScope: () => undefined
      })
      vi.spyOn(projectAuthoringSessions, "compile").mockImplementation(async () => {
        createAuthoringSourceBundle(
          Array.from({ length: count }, (_, index) => ({
            path: `PRIVATE_PATH_${index}.md`,
            text: "PRIVATE_CONTENT"
          }))
        )
        throw Error("EXPECTED_SOURCE_LIMIT")
      })
      const raw = await createModAuthoringTool({ threadId, workspace }).invoke({
        action: "project_compile",
        id: "demo",
        revision: 4
      })
      const response = JSON.parse(raw)
      expect(response).toMatchObject({
        ok: false,
        error: "AUTHORING_SOURCE_LIMIT",
        diagnosticCount: 1,
        executed: false,
        diagnostics: [
          {
            scope: "source-bundle",
            resource: "files",
            observed: count,
            min: 1,
            limit: 64
          }
        ]
      })
      expect(response.hint).toContain("1 至 64")
      expect(response.hint).toContain("编译生成包")
      expect(response.hint).toContain("不要假定输入源过大")
      expect(raw).not.toMatch(/PRIVATE_|stack/)
      expect(service.save).not.toHaveBeenCalled()
    }
  )
  it("reports the first UTF-8 byte overflow through the real parser without blaming the retained source", async () => {
    const service = fixture()
    Object.assign(service, {
      projectAuthoringContext: () => ({
        scope: { threadId, workspace },
        assertCurrent: () => undefined
      }),
      assertScope: () => undefined
    })
    const files = [
      { path: "plugin.json", text: "{}" },
      ...Array.from({ length: 5 }, (_, index) => ({
        path: `PRIVATE_${index}.md`,
        text: "中".repeat(20000)
      })),
      { path: "PRIVATE_UNREAD.md", text: "PRIVATE_UNREAD_CONTENT" }
    ]
    vi.spyOn(projectAuthoringSessions, "compile").mockImplementation(async () => {
      createAuthoringSourceBundle(files)
      throw Error("EXPECTED_SOURCE_LIMIT")
    })
    const raw = await createModAuthoringTool({ threadId, workspace }).invoke({
      action: "project_compile",
      id: "demo",
      revision: 4
    })
    const response = JSON.parse(raw)
    expect(response).toMatchObject({
      ok: false,
      error: "AUTHORING_SOURCE_LIMIT",
      diagnosticCount: 1,
      executed: false,
      diagnostics: [
        { scope: "source-bundle", resource: "totalBytes", observedBytes: 300073, limit: 262144 }
      ]
    })
    expect(response.hint).toContain("UTF-8 路径与内容")
    expect(response.hint).toContain("不是完整包总量")
    expect(response.hint).toContain("作者源合法时不要假定输入源过大")
    expect(response.hint).toContain("保留必需 Hooks、知识")
    expect(raw).not.toMatch(/PRIVATE_|中|stack/)
    expect(raw.length).toBeLessThan(1500)
    expect(service.save).not.toHaveBeenCalled()
  })
  it("does not trust source-limit diagnostic-shaped properties on generic errors", async () => {
    const service = fixture()
    service.check.mockRejectedValue(
      Object.assign(Error("AUTHORING_SOURCE_LIMIT"), {
        diagnostic: { resource: "PRIVATE_RESOURCE", observedBytes: "PRIVATE_CONTENT", limit: 1 },
        stack: "PRIVATE_STACK"
      })
    )
    const raw = await createModAuthoringTool({ threadId, workspace }).invoke({
      action: "check",
      id: "demo",
      revision: 4
    })
    expect(JSON.parse(raw)).toMatchObject({ ok: false, error: "AUTHORING_SOURCE_LIMIT" })
    expect(JSON.parse(raw)).not.toHaveProperty("diagnostics")
    expect(raw).not.toContain("PRIVATE_")
  })
  it("discovers exact native check requirements and evaluates real provider input without granting or binding", async () => {
    const service = fixture()
    Object.assign(service, {
      projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => undefined }),
      assertScope: () => undefined
    })
    const source = nativeCompositionSchema.parse({
      apiVersion: "devclaw.native-composition/v1",
      plugin: { id: "records", version: "2.0.0", title: "Records", description: "Records" },
      resources: [], environment: [], modules: [{ id: "review", version: "2.0.0", title: "Review",
        skill: "modules/review/SKILL.md", inputs: [],
        outputs: [{ id: "report", path: "REPORT.json", contract: "records.report/v1" }],
        checks: [{ id: "report.verify", kind: "action", artifactId: "report",
          provider: { plugin: "independent-checks", actionId: "verify" },
          format: "artifact-reference-v1", maxBytes: 28000 }] }]
    })
    vi.spyOn(projectAuthoringSessions, "read").mockReturnValue({ id: "demo", revision: 3,
      source: createAuthoringSourceBundle([{ path: "composition/source.json", text: JSON.stringify(source) }]) } as never)
    const bind = vi.spyOn(projectAuthoringSessions, "bindAction")
    const provider = { pluginId: "actual-install", plugin: "execution-tools", actionId: "run",
      digest: "a".repeat(64), name: "Run command", command: "run-command", inputSchema: {
        type: "object", required: ["argv"], properties: { argv: { type: "array" } }
      } }
    const actions = vi.fn(async () => [provider])
    const author = createModAuthoringTool({ threadId, workspace, projectActions: actions })
    const index = JSON.parse(await author.invoke({ action: "project_actions", id: "demo" }))
    expect(index).toMatchObject({ ok: true, result: { revision: 3, executed: false, grantsAuthority: false,
      requirements: [{ usedBy: "report.verify", artifactContract: "records.report/v1" }],
      discoverAdditionalActions: { action: "project_actions", omit: "id", optionalFields: ["query"] } } })
    expect(JSON.parse(await author.invoke({ action: "project_actions", id: "demo", localActionId: "new.check" })))
      .toMatchObject({ ok: false, error: "NATIVE_COMPOSITION_ACTION_REQUIRED" })
    const found = JSON.parse(await author.invoke({ action: "project_actions", id: "demo", localActionId: "report.verify" }))
    expect(found).toMatchObject({ ok: true, result: { actions: [{ pluginId: "actual-install",
      compositionCompatibility: { status: "incompatible", businessSemanticsVerified: false } }] } })
    expect(found.result.actions[0].compositionCompatibility.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INPUT_REQUIRED_NOT_GUARANTEED", field: "argv" }),
      expect.objectContaining({ code: "ARTIFACT_REFERENCE_PLATFORM_REQUIRED" })
    ]))
    expect(bind).not.toHaveBeenCalled()
    let failure: NativeCompositionDependencyError | undefined
    try { assertNativeCompositionDependencies(source, []) } catch (error) {
      if (error instanceof NativeCompositionDependencyError) failure = error
    }
    if (!failure) throw Error("expected dependency failure")
    vi.spyOn(projectAuthoringSessions, "compile").mockRejectedValue(failure)
    const blocked = JSON.parse(await author.invoke({ action: "project_compile", id: "demo", revision: 3 }))
    expect(blocked).toMatchObject({ ok: false, error: "NATIVE_COMPOSITION_PROVIDER_UNRESOLVED",
      dependencyCount: 1, repair: {
        discovery: { action: "project_actions", id: "demo", localActionId: "report.verify" },
        sourceCatalog: { action: "catalog", catalogSection: "project-dependencies" },
        prepareDependency: [{ action: "dependency_prepare", sourceId: "actual catalog sourceId" }],
        nativeInstallationAndPermissionConfirmationRequired: true, grantsAuthority: false, executed: false
      } })
    expect(blocked.hint).toContain("无需先执行 Function trial")
    expect(service.requestReuse).not.toHaveBeenCalled()
  })

  it("routes uninstalled dependency asset discovery through the Host resource root and pinned source digest", async () => {
    fixture()
    const read = vi.spyOn(dependencyCatalog, "developmentDependencyCatalogPage")
      .mockReturnValue({ section: "project-dependencies", sourceId: "record-validator",
        sourceDigest: "b".repeat(64), installed: false, grantsAuthority: false, executed: false,
        cursor: 0, path: "mods/runner.ts", text: "export const data = 1", digest: "c".repeat(64), totalCharacters: 21 })
    const author = createModAuthoringTool({ threadId, workspace })
    expect(JSON.parse(await author.invoke({ action: "catalog", catalogSection: "project-dependencies",
      assetPath: "record-validator/mods/runner.ts", cursor: 0, sourceDigest: "b".repeat(64) })))
      .toMatchObject({ ok: true, result: { installed: false, grantsAuthority: false, path: "mods/runner.ts" } })
    expect(read).toHaveBeenCalledWith({ mainDirectory: expect.any(String),
      assetPath: "record-validator/mods/runner.ts", cursor: 0, expectedDigest: "b".repeat(64) })
  })

  it("saves the complete pinned dependency through ordinary CAS without checking, installing or executing", async () => {
    const service = fixture()
    const source = createAuthoringSourceBundle([...authoringFiles(),
      { path: "mods/runner.ts", text: "export const original = true" },
      { path: "workflows/verify.workflow.js", text: "// original companion workflow" }])
    const read = vi.spyOn(dependencyCatalog, "readDevelopmentDependencySource").mockReturnValue(source)
    const save = vi.fn((_thread: string, args: { id: string; name: string; expectedRevision: number; files: typeof source.files }) => ({
      id: args.id, name: args.name, revision: args.expectedRevision + 1,
      source: createAuthoringSourceBundle(args.files)
    }))
    Object.assign(service, { save })
    const author = createModAuthoringTool({ threadId, workspace })
    const result = JSON.parse(await author.invoke({ action: "dependency_save", id: "demo", name: "Demo",
      revision: 0, assetPath: "actual-source", sourceDigest: source.digest }))
    expect(read).toHaveBeenCalledWith({ mainDirectory: expect.any(String),
      sourceId: "actual-source", expectedDigest: source.digest })
    expect(save).toHaveBeenCalledWith(threadId, { id: "demo", name: "Demo", expectedRevision: 0,
      files: source.files })
    expect(result).toMatchObject({ ok: true, result: { id: "demo", revision: 1, sourceDigest: source.digest,
      fileIndex: source.files.map((file) => file.path),
      nextStep: { action: "check", id: "demo", revision: 1 },
      afterCheck: { action: "request_reuse", id: "demo", revision: 1 },
      compiled: false, installed: false, grantsAuthority: false, executed: false } })
    expect(result.result).not.toHaveProperty("source")
    expect(JSON.stringify(result).length).toBeLessThan(2000)
    expect(service.check).not.toHaveBeenCalled()
    expect(service.requestTrial).not.toHaveBeenCalled()
    expect(service.requestReuse).not.toHaveBeenCalled()
  })

  it("prepares one explicit catalog source through the fixed Host helper with unchanged budgets", async () => {
    const service = fixture()
    const claimAuthoringBudget = vi.fn(() => ({ candidates: 1 }))
    Object.assign(service, {
      projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => undefined }),
      assertScope: () => undefined,
      claimAuthoringBudget,
      assertAuthoringAvailable: vi.fn()
    })
    const result = { sourceId: "record-validator", draft: { id: "record-validator", revision: 1 },
      phase: "needs-approval", installed: false, grantsAuthority: false, executed: false,
      nextStep: "End this turn now" }
    const prepare = vi.spyOn(dependencyPreparation, "prepareDevelopmentDependency")
      .mockImplementation(async input => {
        input.assertCurrent()
        input.claimCandidate()
        return result as never
      })
    const author = createModAuthoringTool({ threadId, workspace })
    expect(JSON.parse(await author.invoke({ action: "dependency_prepare", sourceId: "record-validator" })))
      .toEqual({ ok: true, result })
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      service, mainDirectory: expect.any(String), sourceId: "record-validator", threadId,
      turnId: "first", id: undefined, expectedDigest: undefined, revision: undefined
    }))
    expect(claimAuthoringBudget).toHaveBeenNthCalledWith(1, threadId, "first", "operation")
    expect(claimAuthoringBudget).toHaveBeenNthCalledWith(2, threadId, "first", "candidate")
    expect(service.requestTrial).not.toHaveBeenCalled()
    expect(service.save).not.toHaveBeenCalled()
    expect(author.description).toContain("dependency_prepare(sourceId)")
    expect(author.schema.safeParse({ action: "dependency_prepare", sourceId: "../record-validator" }).success)
      .toBe(false)
    const missing = JSON.parse(await author.invoke({ action: "dependency_prepare", assetPath: "record-validator" }))
    expect(missing).toMatchObject({ ok: false, error: "DEVELOPMENT_INPUT", missingFields: ["sourceId"] })
    expect(prepare).toHaveBeenCalledOnce()
  })

  it("returns real conflicting dependency draft and native unknown plan diagnostics without replay", async () => {
    const service = fixture()
    Object.assign(service, {
      projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => undefined }),
      assertScope: () => undefined
    })
    const currentDraft = { id: "record-validator", name: "User source", revision: 3,
      sourceDigest: "d".repeat(64) }
    service.read.mockReturnValue({ ...currentDocument("record-validator", 3),
      source: { digest: currentDraft.sourceDigest, files: authoringFiles() } })
    vi.spyOn(dependencyPreparation, "prepareDevelopmentDependency").mockRejectedValue(
      new dependencyPreparation.DependencyPreparationError("DEVELOPMENT_DEPENDENCY_DRAFT_CONFLICT", currentDraft)
    )
    const author = createModAuthoringTool({ threadId, workspace })
    const result = JSON.parse(await author.invoke({ action: "dependency_prepare", sourceId: "record-validator" }))
    expect(result).toMatchObject({ ok: false, error: "DEVELOPMENT_DEPENDENCY_DRAFT_CONFLICT",
      currentDraft: { id: currentDraft.id, revision: 3, sourceDigest: currentDraft.sourceDigest,
        exists: true }, executed: false, grantsAuthority: false })
    expect(result.hint).toContain("不能自动重放")
    expect(result.hint).toContain("显式新 id")
    expect(service.save).not.toHaveBeenCalled()
    expect(service.requestReuse).not.toHaveBeenCalled()
  })

  it.each(["漢字😀", '\\"\n\t\u0000'])(
    "keeps actual unknown-plan tool failure JSON within 24k for long %j diagnostics", async prefix => {
      const service = fixture({ "record-validator": 2 })
      const nativeError = prefix.repeat(8000) + "UNCONFIRMED"
      const reuse = { phase: "failed" as const, error: nativeError, name: "Previous",
        draftId: "previous", revision: 1, sourceDigest: "f".repeat(64), capabilities: [] }
      Object.assign(service, {
        projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => undefined }),
        assertScope: () => undefined,
        status: vi.fn(() => ({ enabled: true, reuse }))
      })
      vi.spyOn(dependencyCatalog, "readDevelopmentDependencySource")
        .mockReturnValue(createAuthoringSourceBundle(authoringFiles()))
      const author = createModAuthoringTool({ threadId, workspace })
      const raw = await author.invoke({ action: "dependency_prepare", sourceId: "record-validator" })
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(24000)
      const result = JSON.parse(raw)
      expect(result).toMatchObject({ ok: false, error: "DEVELOPMENT_DEPENDENCY_REUSE_UNCONFIRMED",
        currentDraft: { id: "record-validator", revision: 2 },
        reuse: { phase: "failed", errorTruncated: true }, executed: false, grantsAuthority: false })
      expect(Buffer.byteLength(JSON.stringify(result.reuse.error))).toBeLessThanOrEqual(1024)
      expect(result.reuse.error).not.toContain("UNCONFIRMED")
      expect(reuse.error).toBe(nativeError)
      expect(service.save).not.toHaveBeenCalled()
      expect(service.check).not.toHaveBeenCalled()
      expect(service.requestReuse).not.toHaveBeenCalled()
    }
  )

  it("does not write missing/stale/unknown dependency selections or bypass original draft CAS", async () => {
    const service = fixture({ demo: 2 })
    const source = createAuthoringSourceBundle(authoringFiles())
    const read = vi.spyOn(dependencyCatalog, "readDevelopmentDependencySource").mockReturnValue(source)
    const save = vi.fn(() => { throw Error("AUTHORING_VERSION_CHANGED") })
    Object.assign(service, { save })
    const author = createModAuthoringTool({ threadId, workspace })
    const args = { action: "dependency_save" as const, id: "demo", name: "Demo", revision: 0,
      assetPath: "actual-source", sourceDigest: source.digest }
    for (const field of ["id", "name", "revision", "assetPath", "sourceDigest"] as const) {
      const missing = JSON.parse(await author.invoke({ ...args, [field]: undefined }))
      expect(missing).toMatchObject({ ok: false, missingFields: [field] })
    }
    expect(save).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    const changed = JSON.parse(await author.invoke(args))
    expect(changed).toMatchObject({ ok: false, error: "AUTHORING_VERSION_CHANGED",
      currentDraft: { id: "demo", revision: 2 } })
    expect(save).toHaveBeenCalledTimes(1)
    for (const error of ["DEVELOPMENT_DEPENDENCY_SOURCE_UNAVAILABLE", "DEVELOPMENT_DEPENDENCY_SOURCE_CHANGED"]) {
      read.mockImplementationOnce(() => { throw Error(error) })
      expect(JSON.parse(await author.invoke(args))).toMatchObject({ ok: false, error })
    }
    expect(save).toHaveBeenCalledTimes(1)
    expect(service.check).not.toHaveBeenCalled()
    expect(service.requestReuse).not.toHaveBeenCalled()
  })

  it.each([true, false])("keeps missing-manifest guidance in the actual project format (readable=%s)", async (readable) => {
    const service = fixture({ demo: 2 })
    Object.assign(service, {
      projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => undefined }),
      assertScope: () => undefined
    })
    vi.spyOn(projectAuthoringSessions, "save").mockRejectedValue(Error("AUTHORING_PLUGIN_MANIFEST_REQUIRED"))
    const read = vi.spyOn(projectAuthoringSessions, "read").mockImplementation(() => {
      if (!readable) throw Error("PROJECT_DRAFT_MISSING")
      return { id: "demo", revision: 4, source: { digest: "b".repeat(64), files: [] } } as never
    })
    const author = createModAuthoringTool({ threadId, workspace })
    const files = authoringFiles().filter((file) => file.path !== "plugin.json")
    const project = JSON.parse(await author.invoke({
      action: "project_save", id: "demo", name: "Demo", revision: 3, files
    }))
    expect(project).toMatchObject({ ok: false, error: "AUTHORING_PLUGIN_MANIFEST_REQUIRED" })
    expect(project.hint).toContain("project_read(id)")
    expect(project.hint).toContain("source.files")
    expect(project.hint).toContain("不要改成纯函数格式或手写生成的 runtime")
    expect(project.hint).not.toContain("mods/manifest.json")
    expect(project.hint).not.toContain("revision=0")
    if (readable) expect(project.currentDraft).toMatchObject({ exists: true, revision: 4, sourceDigest: "b".repeat(64) })
    else expect(project).not.toHaveProperty("currentDraft")
    expect(service.read).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(1)
    const pure = JSON.parse(await author.invoke({ action: "submit", id: "demo", name: "Demo", revision: 2, files }))
    expect(pure).toMatchObject({ ok: false, error: "AUTHORING_PLUGIN_MANIFEST_REQUIRED", currentDraft: { revision: 2 } })
    expect(pure.hint).toContain("mods/manifest.json")
    expect(pure.hint).not.toContain("project_save")
  })
  it("makes an unsaved scaffold and complete first-submit revision explicit without spending repair attempts on input guesses", async () => {
    const service = fixture()
    const ledger = new CreatorRequestBudgets()
    Object.assign(service, {
      claimAuthoringBudget: (_thread: string, run: string, kind: "operation" | "candidate") =>
        ledger.claim(workspace, run, kind)
    })
    const author = createModAuthoringTool({ threadId, workspace })
    const scaffold = JSON.parse(
      await author.invoke({
        action: "scaffold",
        id: "demo",
        name: "Demo",
        kind: "panel",
        instruction: "Show a counter"
      })
    )
    expect(scaffold.result).toMatchObject({ saved: false, nextExpectedRevision: 0 })
    expect(scaffold.result.files.map((file: { path: string }) => file.path)).toEqual(
      expect.arrayContaining(["plugin.json", "mods/manifest.json", "mods/main.ts"])
    )
    expect(scaffold.result.nextStep).toContain("result.files 完整数组")
    expect(JSON.parse(await author.invoke({ action: "read", id: "demo" }))).toMatchObject({
      ok: false,
      error: "AUTHORING_VERSION_MISSING",
      currentDraft: { id: "demo", exists: false, nextExpectedRevision: 0 }
    })
    const args = {
      action: "submit" as const,
      id: "demo",
      name: "Demo",
      revision: 1,
      files: scaffold.result.files
    }
    expect(
      JSON.parse(
        await author.invoke({
          ...args,
          files: args.files.filter((file: { path: string }) => file.path !== "plugin.json")
        })
      )
    ).toMatchObject({
      ok: false,
      error: "AUTHORING_PLUGIN_MANIFEST_REQUIRED",
      currentDraft: { exists: false, nextExpectedRevision: 0 },
      hint: expect.stringContaining("plugin.json、mods/manifest.json")
    })
    expect(JSON.parse(await author.invoke(args))).toMatchObject({
      ok: false,
      error: "AUTHORING_VERSION_CHANGED",
      currentDraft: { exists: false, nextExpectedRevision: 0 }
    })
    const incompatible = args.files.map((file: { path: string; text: string }) =>
      file.path === "plugin.json" ? { ...file, text: '{"name":"demo","mods":"other.json"}' } : file
    )
    expect(
      JSON.parse(await author.invoke({ ...args, revision: 0, files: incompatible }))
    ).toMatchObject({
      ok: false,
      error: "AUTHORING_INSTALL_PURE_SOURCE_REQUIRED",
      hint: expect.stringContaining("mod_business")
    })
    expect(ledger.latest(workspace)).toMatchObject({ candidates: 0, operations: 5 })
    expect(service.submit).not.toHaveBeenCalled()
    expect(JSON.parse(await author.invoke({ ...args, revision: 0 })).ok).toBe(true)
    expect(service.submit).toHaveBeenCalledTimes(1)
    expect(ledger.latest(workspace)).toMatchObject({ candidates: 1, operations: 6 })
  })
  it.each(["request_trial", "resume_trial"] as const)(
    "%s checks the actual saved revision before claiming a candidate and exposes no foreign scope observation",
    async (action) => {
      const service = fixture({ demo: 7 })
      const ledger = new CreatorRequestBudgets()
      Object.assign(service, {
        claimAuthoringBudget: (_thread: string, run: string, kind: "operation" | "candidate") =>
          ledger.claim(workspace, run, kind)
      })
      const author = createModAuthoringTool({ threadId, workspace })
      expect(JSON.parse(await author.invoke({ action, id: "demo", revision: 1 }))).toMatchObject({
        ok: false,
        error: "AUTHORING_VERSION_CHANGED",
        currentDraft: { id: "demo", exists: true, revision: 7, sourceDigest: "a".repeat(64) }
      })
      expect(JSON.parse(await author.invoke({ action, id: "missing", revision: 1 }))).toMatchObject(
        {
          ok: false,
          error: "AUTHORING_VERSION_MISSING",
          currentDraft: { id: "missing", exists: false, nextExpectedRevision: 0 }
        }
      )
      expect(ledger.latest(workspace)).toMatchObject({ candidates: 0, operations: 2 })
      const scaffold = JSON.parse(
        await author.invoke({
          action: "scaffold",
          id: "demo",
          name: "Demo",
          kind: "command",
          instruction: "Update"
        })
      )
      expect(scaffold.result).toMatchObject({ saved: false, nextExpectedRevision: 7 })
      service.read.mockImplementation(() => {
        releaseLocalThreadRunLease(threadId, "desktop", "first")
        throw Error("AUTHORING_VERSION_CHANGED")
      })
      const stale = JSON.parse(await author.invoke({ action, id: "demo", revision: 7 }))
      expect(stale).toMatchObject({ ok: false, error: "DEVELOPMENT_TURN_CHANGED" })
      expect(stale).not.toHaveProperty("currentDraft")
      expect(service.requestTrial).not.toHaveBeenCalled()
      expect(service.resumeTrial).not.toHaveBeenCalled()
    }
  )
  it("discovers the state extension kind through the actual tool schema and emits a bounded unverified executable scaffold", async () => {
    fixture()
    const author = createModAuthoringTool({ threadId, workspace })
    const result = JSON.parse(
      await author.invoke({
        action: "scaffold",
        id: "state-example",
        name: "状态扩展",
        instruction: "保留原状态 writer",
        kind: "state-extension"
      })
    )
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).toContain("state-migration-plan.json")
    expect(JSON.stringify(result)).toContain("AUTHOR_CONFIRMATION_REQUIRED")
    expect(JSON.stringify(result)).toContain("not-migrated")
    expect(author.description).toContain("NOT migrated business state")
  })
  it("can inspect native stage baselines and request a plan but has no debug approval action", async () => {
    const service = fixture()
    const scope = { threadId, workspace, incarnation: { token: "creator", legacyCreatedAt: 1 } }
    Object.assign(service, {
      projectAuthoringContext: () => ({ scope, assertCurrent: () => {} }),
      assertScope: vi.fn()
    })
    const list = vi.fn(() => ({ snapshots: [], branches: [], diagnostics: [] }))
    vi.spyOn(stageDebug, "getProjectStageDebugSessions").mockReturnValue({
      list
    } as unknown as ReturnType<typeof stageDebug.getProjectStageDebugSessions>)
    const author = createModAuthoringTool({ threadId, workspace })
    expect(JSON.parse(await author.invoke({ action: "project_stage_debug_list" }))).toMatchObject({
      ok: true
    })
    expect(list).toHaveBeenCalledWith({ scope, guard: expect.any(Function) })
    await expect(author.invoke({ action: "project_stage_debug_create" } as never)).rejects.toThrow()
    releaseLocalThreadRunLease(threadId, "desktop", "first")
    expect(JSON.parse(await author.invoke({ action: "project_stage_debug_list" }))).toMatchObject({
      ok: false,
      error: "DEVELOPMENT_TURN_CHANGED"
    })
    expect(list).toHaveBeenCalledTimes(1)
  })
  it("retains the request repair budget when tools are rebuilt during the same native run", async () => {
    const service = fixture()
    const ledger = new CreatorRequestBudgets()
    Object.assign(service, {
      claimAuthoringBudget: (_thread: string, run: string, kind: "operation" | "candidate") =>
        ledger.claim(workspace, run, kind)
    })
    const files = authoringFiles()
    const args = { action: "submit" as const, id: "demo", name: "Demo", revision: 0, files }
    for (let i = 0; i < 3; i++)
      expect(
        JSON.parse(await createModAuthoringTool({ threadId, workspace }).invoke(args)).ok
      ).toBe(true)
    expect(
      JSON.parse(await createModAuthoringTool({ threadId, workspace }).invoke(args))
    ).toMatchObject({ ok: false, error: "DEVELOPMENT_REPAIR_BUDGET" })
    expect(service.submit).toHaveBeenCalledTimes(3)
    expect(ledger.latest(workspace)).toMatchObject({ runId: "first", candidates: 3, operations: 4 })
  })
  it("returns exact startup diagnostics and bounds same-turn repair to two attempts", async () => {
    const service = fixture()
    const files = authoringFiles(
      'export const register = (on) => { on("session.start", async ($) => {}) }'
    )
    service.submit.mockRejectedValue(
      new DevelopmentCandidateError(
        new ModFunctionError("MODS_RETURN_UNDEFINED"),
        { id: "weather", revision: 1, digest: "a".repeat(64) },
        files
      )
    )
    const author = createModAuthoringTool({ threadId, workspace })
    const args = { action: "submit" as const, id: "weather", name: "Weather", revision: 0, files }
    expect(JSON.parse(await author.invoke(args))).toMatchObject({
      ok: false,
      error: "MODS_RETURN_UNDEFINED",
      target: { id: "weather", revision: 1 },
      diagnostics: [
        { stage: "candidate-startup", event: "session.start", file: "mods/main.ts", line: 1 }
      ],
      repair: { attempt: 1, maxAttempts: 3, remaining: 2, canRetry: true }
    })
    await author.invoke(args)
    expect(JSON.parse(await author.invoke(args))).toMatchObject({ repair: { canRetry: false } })
    expect(JSON.parse(await author.invoke(args))).toMatchObject({
      ok: false,
      error: "DEVELOPMENT_REPAIR_BUDGET"
    })
    expect(service.submit).toHaveBeenCalledTimes(3)
    expect(service.requestReuse).not.toHaveBeenCalled()
  })
  it.each(["submit", "request_trial", "resume_trial"] as const)(
    "%s reports all missing inputs without consuming candidate repair attempts",
    async (action) => {
      const service = fixture(action === "submit" ? {} : { demo: 1 })
      const ledger = new CreatorRequestBudgets()
      const assertAvailable = vi.fn()
      Object.assign(service, {
        assertAuthoringAvailable: assertAvailable,
        claimAuthoringBudget: (_thread: string, run: string, kind: "operation" | "candidate") =>
          ledger.claim(workspace, run, kind)
      })
      const author = createModAuthoringTool({ threadId, workspace })
      const complete = {
        action,
        id: "demo",
        revision: action === "submit" ? 0 : 1,
        ...(action === "submit"
          ? {
              name: "Demo",
              files: authoringFiles()
            }
          : {})
      }
      const required =
        action === "submit" ? ["id", "name", "revision", "files"] : ["id", "revision"]
      expect(JSON.parse(await author.invoke({ action }))).toMatchObject({
        ok: false,
        missingFields: required
      })
      for (const field of ["id", "revision"] as const) {
        const result = JSON.parse(await author.invoke({ ...complete, [field]: undefined }))
        expect(result).toMatchObject({ ok: false, missingFields: [field] })
        expect(result.hint).toContain("read(id)")
      }
      if (action === "submit") {
        expect(
          JSON.parse(await author.invoke({ ...complete, name: undefined, files: undefined }))
        ).toMatchObject({ ok: false, missingFields: ["name", "files"] })
      }
      expect(ledger.latest(workspace)).toMatchObject({
        candidates: 0,
        operations: action === "submit" ? 4 : 3
      })
      expect(service.submit).not.toHaveBeenCalled()
      expect(service.requestTrial).not.toHaveBeenCalled()
      expect(service.resumeTrial).not.toHaveBeenCalled()
      expect(assertAvailable).not.toHaveBeenCalled()
      expect(JSON.parse(await author.invoke(complete))).toMatchObject({ ok: true })
      expect(assertAvailable).toHaveBeenCalledExactlyOnceWith(threadId)
      expect(ledger.latest(workspace)).toMatchObject({ candidates: 1 })
    }
  )
  it.each(["submit", "request_trial", "resume_trial"] as const)(
    "%s does not consume a repair candidate while the original service is busy",
    async (action) => {
      const service = fixture(action === "submit" ? {} : { demo: 1 })
      const ledger = new CreatorRequestBudgets()
      const assertAvailable = vi.fn<() => void>(() => {
        throw Error("DEVELOPMENT_BUSY")
      })
      Object.assign(service, {
        assertAuthoringAvailable: assertAvailable,
        claimAuthoringBudget: (_thread: string, run: string, kind: "operation" | "candidate") =>
          ledger.claim(workspace, run, kind)
      })
      const author = createModAuthoringTool({ threadId, workspace })
      const args = {
        action,
        id: "demo",
        revision: action === "submit" ? 0 : 1,
        name: "Demo",
        files: authoringFiles()
      }
      expect(JSON.parse(await author.invoke(args))).toMatchObject({
        ok: false,
        error: "DEVELOPMENT_BUSY",
        hint: expect.stringContaining("list/read")
      })
      expect(ledger.latest(workspace)).toMatchObject({ candidates: 0, operations: 1 })
      expect(service.submit).not.toHaveBeenCalled()
      expect(service.requestTrial).not.toHaveBeenCalled()
      expect(service.resumeTrial).not.toHaveBeenCalled()
      assertAvailable.mockImplementation(() => {})
      expect(JSON.parse(await author.invoke(args))).toMatchObject({ ok: true })
      expect(ledger.latest(workspace)).toMatchObject({ candidates: 1, operations: 2 })
    }
  )
  it("keeps unknown candidate outcomes non-retryable after validating inputs", async () => {
    const service = fixture()
    const files = authoringFiles()
    service.submit.mockRejectedValue(
      new DevelopmentCandidateError(
        new ModFunctionError("MODS_RUNTIME_LOST"),
        { id: "demo", revision: 1, digest: "a".repeat(64) },
        files
      )
    )
    const author = createModAuthoringTool({ threadId, workspace })
    expect(
      JSON.parse(
        await author.invoke({
          action: "submit",
          id: "demo",
          revision: 0,
          name: "Demo",
          files
        })
      )
    ).toMatchObject({
      ok: false,
      error: "MODS_RUNTIME_LOST",
      repair: { remaining: 2, canRetry: false }
    })
    expect(service.submit).toHaveBeenCalledTimes(1)
  })
  it("still charges genuine failed candidates and cannot reset an exhausted budget with missing inputs", async () => {
    const service = fixture()
    const ledger = new CreatorRequestBudgets()
    Object.assign(service, {
      claimAuthoringBudget: (_thread: string, run: string, kind: "operation" | "candidate") =>
        ledger.claim(workspace, run, kind)
    })
    const files = authoringFiles('on("session.start", async () => {})')
    service.submit.mockRejectedValue(
      new DevelopmentCandidateError(
        new ModFunctionError("MODS_RETURN_UNDEFINED"),
        { id: "demo", revision: 1, digest: "a".repeat(64) },
        files
      )
    )
    const args = { action: "submit" as const, id: "demo", name: "Demo", revision: 0, files }
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(
        JSON.parse(await createModAuthoringTool({ threadId, workspace }).invoke(args))
      ).toMatchObject({ ok: false, repair: { attempt, canRetry: attempt < 3 } })
    }
    const author = createModAuthoringTool({ threadId, workspace })
    expect(JSON.parse(await author.invoke({ ...args, revision: undefined }))).toMatchObject({
      ok: false,
      missingFields: ["revision"]
    })
    expect(JSON.parse(await author.invoke(args))).toMatchObject({
      ok: false,
      error: "DEVELOPMENT_REPAIR_BUDGET"
    })
    expect(ledger.latest(workspace)).toMatchObject({ candidates: 3, operations: 5 })
    expect(service.submit).toHaveBeenCalledTimes(3)
  })
  it("names missing scaffold fields and preserves a host error code without exposing its message", async () => {
    const service = fixture()
    const author = createModAuthoringTool({ threadId, workspace })
    expect(
      JSON.parse(
        await author.invoke({ action: "scaffold", id: "demo", name: "Demo", kind: "panel" })
      )
    ).toMatchObject({ ok: false, error: "DEVELOPMENT_INPUT", missingFields: ["instruction"] })
    service.requestTrial.mockRejectedValue(
      new ModFunctionError("MODS_COMMAND_CONFLICT", "PRIVATE_VALUE")
    )
    service.read.mockReturnValue(currentDocument("demo", 1))
    const result = await author.invoke({ action: "request_trial", id: "demo", revision: 1 })
    expect(JSON.parse(result)).toMatchObject({ ok: false, error: "MODS_COMMAND_CONFLICT" })
    expect(result).not.toContain("PRIVATE_VALUE")
  })
  it("offers combined submission, current-chat resume and undo, and review-only formal reuse", async () => {
    const service = fixture()
    const author = createModAuthoringTool({ threadId, workspace })
    const files = authoringFiles()
    expect(
      JSON.parse(
        await author.invoke({ action: "submit", id: "demo", name: "Demo", revision: 0, files })
      )
    ).toMatchObject({ ok: true, result: { check: { valid: true, runtimeVerified: false } } })
    expect(service.submit).toHaveBeenCalledExactlyOnceWith(
      threadId,
      { id: "demo", name: "Demo", expectedRevision: 0, files },
      "first",
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(service.check).not.toHaveBeenCalled()
    service.read.mockReturnValue(currentDocument("demo", 1))
    expect(
      JSON.parse(await author.invoke({ action: "resume_trial", id: "demo", revision: 1 }))
    ).toMatchObject({ ok: true })
    expect(service.resumeTrial).toHaveBeenCalledWith(
      threadId,
      "demo",
      1,
      "first",
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(JSON.parse(await author.invoke({ action: "undo_trial" }))).toMatchObject({ ok: true })
    expect(service.undoTrial).toHaveBeenCalledWith(
      threadId,
      "first",
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(
      JSON.parse(await author.invoke({ action: "request_reuse", id: "demo", revision: 1 }))
    ).toMatchObject({ ok: true, result: { reuse: { phase: "needs-approval" } } })
    expect(service.requestReuse).toHaveBeenCalledWith(
      threadId,
      "demo",
      1,
      "first",
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(author.schema.safeParse({ action: "approve_reuse" }).success).toBe(false)
  })
  it("routes the Harness template and explicit compile through the scoped project session", async () => {
    const service = fixture()
    const scope = { threadId, workspace, incarnation: { token: "one", legacyCreatedAt: 1 } }
    Object.assign(service, {
      projectAuthoringContext: () => ({ scope, assertCurrent: () => undefined }),
      assertScope: () => undefined
    })
    const scaffold = vi
      .spyOn(projectAuthoringSessions, "scaffold")
      .mockResolvedValue({ revision: 1 } as never)
    const compile = vi
      .spyOn(projectAuthoringSessions, "compile")
      .mockResolvedValue({ id: "demo", name: "Demo", revision: 2, directory: "isolated",
        source: createAuthoringSourceBundle(authoringFiles()) })
    const author = createModAuthoringTool({ threadId, workspace })
    expect(
      JSON.parse(
        await author.invoke({
          action: "project_scaffold",
          id: "demo",
          name: "Demo",
          template: "harness-data"
        })
      )
    ).toMatchObject({ ok: true, result: { revision: 1 } })
    expect(scaffold).toHaveBeenCalledWith(
      scope,
      "demo",
      "Demo",
      expect.any(Function),
      "harness-data"
    )
    expect(
      JSON.parse(await author.invoke({ action: "project_compile", id: "demo", revision: 1 }))
    ).toMatchObject({ ok: true, result: { revision: 2 } })
    expect(compile).toHaveBeenCalledWith(scope, "demo", 1, expect.any(Function))
    expect(
      JSON.parse(await author.invoke({ action: "project_compile", id: "demo" }))
    ).toMatchObject({ ok: false, error: "DEVELOPMENT_REVISION_REQUIRED" })
  })
  it.each(["composition/source.json", "devclaw.harness.json", "devclaw.project-runtime.json"])(
    "guides the saved %s snapshot using its actual revision without compiling",
    async (path) => {
      const service = fixture()
      Object.assign(service, {
        projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => undefined }),
        assertScope: () => undefined
      })
      const saved = {
        id: "demo", name: "Demo", revision: 7,
        source: { digest: "a".repeat(64), files: [{ path, text: "{}" }] }
      }
      const save = vi.spyOn(projectAuthoringSessions, "save").mockResolvedValue(saved as never)
      const compile = vi.spyOn(projectAuthoringSessions, "compile")
      const author = createModAuthoringTool({ threadId, workspace })
      const response = JSON.parse(await author.invoke({
        action: "project_save", id: "demo", name: "Demo", revision: 6,
        files: saved.source.files
      }))
      expect(response).toMatchObject({ ok: true, result: {
        nextStep: {
          action: path === "devclaw.project-runtime.json" ? "project_doctor" : "project_compile",
          id: "demo", revision: 7
        }
      } })
      expect(save).toHaveBeenCalledTimes(1)
      expect(compile).not.toHaveBeenCalled()
    }
  )
  it.each(["project_doctor", "project_test"] as const)(
    "guides failed %s without source to inspect the real snapshot only",
    async (action) => {
      const service = fixture()
      Object.assign(service, {
        projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => undefined }),
        assertScope: () => undefined
      })
      vi.spyOn(projectAuthoringSessions, "read").mockReturnValue({
        id: "demo", revision: 2, source: { files: [{ path: "plugin.json", text: "{}" }] }
      } as never)
      vi.spyOn(projectAuthoringSessions, "inspect").mockResolvedValue({ valid: false } as never)
      const compile = vi.spyOn(projectAuthoringSessions, "compile")
      const author = createModAuthoringTool({ threadId, workspace })
      const response = JSON.parse(await author.invoke({ action, id: "demo", revision: 2 }))
      expect(response).toMatchObject({ ok: true, result: {
        valid: false, nextStep: { action: "project_read", id: "demo" }
      } })
      expect(response.result.hint).toContain("不要编造运行协议字段或转 shell 猜协议")
      expect(compile).not.toHaveBeenCalled()
    }
  )
  it.each([undefined, "复核用户的需求文档"])(
    "distinguishes prepared development packages from native trial candidates (goal=%s)",
    async (goal) => {
      const service = fixture()
      Object.assign(service, {
        projectAuthoringContext: () => ({ scope: { threadId, workspace }, assertCurrent: () => undefined }),
        assertScope: () => undefined
      })
      vi.spyOn(projectAuthoringSessions, "read").mockReturnValue({
        id: "demo", revision: 3, source: { files: [] }
      } as never)
      const inspect = vi.spyOn(projectAuthoringSessions, "inspect").mockResolvedValue({
        status: "prepared", executed: false, revision: 2, pendingRevision: 3
      } as never)
      const trial = vi.spyOn(projectAuthoringSessions, "requestTrial")
      const compile = vi.spyOn(projectAuthoringSessions, "compile")
      const author = createModAuthoringTool({ threadId, workspace })
      const response = JSON.parse(await author.invoke({
        action: "project_dev", id: "demo", revision: 3, ...(goal ? { goal } : {})
      }))
      expect(response).toMatchObject({ ok: true, result: {
        status: "prepared", executed: false, preparationScope: "development-package-only",
        trialPrepared: false,
        nextStep: { action: "project_request_trial", id: "demo", revision: 3, ...(goal ? { goal } : {}) }
      } })
      if (!goal) {
        expect(response.result.missingFields).toEqual(["goal"])
        expect(response.result.nextStep).not.toHaveProperty("goal")
      }
      expect(response.result.hint).toContain("尚未创建试用候选")
      expect(author.description).toContain("NOT a trial candidate or delivery completion")
      expect(inspect).toHaveBeenCalledTimes(1)
      expect(trial).not.toHaveBeenCalled()
      expect(compile).not.toHaveBeenCalled()
    }
  )
  it("captures the physical turn and rejects a released and reacquired identical run", async () => {
    const service = fixture()
    const author = createModAuthoringTool({ threadId, workspace })
    expect(JSON.parse(await author.invoke({ action: "list" }))).toMatchObject({ ok: true })
    releaseLocalThreadRunLease(threadId, "desktop", "first")
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "first" })
    expect(JSON.parse(await author.invoke({ action: "list" }))).toMatchObject({
      ok: false,
      error: "DEVELOPMENT_TURN_CHANGED"
    })
    expect(service.status).toHaveBeenCalledTimes(1)
  })
  it("does not follow mutation of the factory scope", async () => {
    const service = fixture()
    const input = { threadId, workspace }
    const author = createModAuthoringTool(input)
    input.threadId = "other"
    input.workspace = "other"
    expect(JSON.parse(await author.invoke({ action: "list" }))).toMatchObject({ ok: true })
    expect(service.status).toHaveBeenCalledWith(threadId)
  })
  it("bounds attempts and provides no model approval or installation action", async () => {
    const service = fixture()
    const author = createModAuthoringTool({ threadId, workspace })
    expect(author.schema.safeParse({ action: "approve" }).success).toBe(false)
    expect(author.schema.safeParse({ action: "set_enabled" }).success).toBe(false)
    for (let index = 0; index < 32; index++) await author.invoke({ action: "list" })
    expect(JSON.parse(await author.invoke({ action: "list" }))).toMatchObject({
      ok: false,
      error: "DEVELOPMENT_TURN_BUDGET"
    })
    expect(service.status).toHaveBeenCalledTimes(32)
  })
  it("rejects cancellation and a stale result after asynchronous analysis", async () => {
    const service = fixture()
    service.check.mockImplementation(async () => {
      releaseLocalThreadRunLease(threadId, "desktop", "first")
      return { valid: true }
    })
    const author = createModAuthoringTool({ threadId, workspace })
    expect(
      JSON.parse(await author.invoke({ action: "check", id: "demo", revision: 1 }))
    ).toMatchObject({ ok: false, error: "DEVELOPMENT_TURN_CHANGED" })
    const cancelled = new AbortController()
    cancelled.abort()
    const aborted = createModAuthoringTool({ threadId, workspace, signal: cancelled.signal })
    expect(
      JSON.parse(
        await aborted.invoke({
          action: "save",
          id: "demo",
          name: "Demo",
          revision: 0,
          files: [{ path: "main.ts", text: "ignored" }]
        })
      )
    ).toMatchObject({ ok: false })
    expect(service.save).not.toHaveBeenCalled()
  })
})
