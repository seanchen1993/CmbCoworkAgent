import { readdir, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createModAuthoringTool } from "./mod-authoring-tool"
import {
  setModDevelopmentService,
  type ModDevelopmentService
} from "../../mods/devtools/development-service"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../thread-run-lease"
import type { ClawActionDescriptor } from "../../../shared/mods/claw-actions"
import {
  projectAuthoringSessions,
  ProjectDraftLimitError
} from "../../mods/devtools/project-authoring-session"

vi.mock("../../storage", () => ({ getPlugins: vi.fn(() => []) }))
const threadId = "project-authoring-tool-test"
const roots = new Set<string>()
let sequence = 0
afterEach(async () => {
  vi.restoreAllMocks()
  releaseLocalThreadRunLease(threadId, "desktop", "run")
  setModDevelopmentService(undefined)
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.clear()
})

describe("natural language project authoring actions", () => {
  it("reports the exact saved author schema and keeps its real revision when compile rejects a text root", async () => {
    const scope = {
      threadId,
      workspace: "workspace",
      incarnation: { token: `schema-root-${++sequence}`, legacyCreatedAt: 1 }
    }
    setModDevelopmentService({
      isCreatorMode: () => true,
      projectAuthoringContext: () => ({ scope, assertCurrent: () => undefined }),
      assertScope: () => undefined
    } as unknown as ModDevelopmentService)
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
    const original = await projectAuthoringSessions.scaffold(
      scope,
      "schema-root",
      "Schema root",
      () => {},
      "native-modular"
    )
    roots.add(dirname(original.directory))
    const native = original.source.files.find((file) => file.path === "composition/source.json")!
    const value = JSON.parse(native.text)
    value.modules[0].checks[0].schema = { type: "string", minLength: 1 }
    const saved = await projectAuthoringSessions.patch(
      scope,
      {
        id: original.id,
        revision: 1,
        sourceDigest: original.source.digest,
        files: [{ path: native.path, text: JSON.stringify(value) }]
      },
      () => {}
    )
    expect(saved.revision).toBe(2)
    const before = await readdir(dirname(saved.directory))
    vi.spyOn(
      projectAuthoringSessions as unknown as {
        actions: (workspace: string, threadId: string) => Promise<ClawActionDescriptor[]>
      },
      "actions"
    ).mockResolvedValue([])
    const author = createModAuthoringTool({ threadId, workspace: scope.workspace })
    const raw = await author.invoke({
      action: "project_compile",
      id: saved.id,
      revision: saved.revision
    })
    const response = JSON.parse(raw)
    expect(response).toMatchObject({
      ok: false,
      error: "MODS_TOOL_SCHEMA",
      sourceUnchanged: true,
      executed: false,
      diagnosticCount: 1,
      diagnostics: [
        {
          file: native.path,
          path: "/modules/0/checks/0/schema/type",
          code: "PROJECT_JSON_SCHEMA_ROOT_OBJECT_REQUIRED",
          message: expect.stringContaining(
            "Do not silently change the artifact format or remove its checks"
          )
        }
      ]
    })
    expect(raw).not.toMatch(/stack|Error:/)
    expect(projectAuthoringSessions.read(scope, saved.id)).toMatchObject({
      revision: 2,
      source: saved.source
    })
    expect(await readdir(dirname(saved.directory))).toEqual(before)
  })

  it("applies fixed native source deltas alone or atomically with resources through the real tool", async () => {
    const scope = {
      threadId,
      workspace: "workspace",
      incarnation: { token: `delta-${++sequence}`, legacyCreatedAt: 1 }
    }
    setModDevelopmentService({
      isCreatorMode: () => true,
      projectAuthoringContext: () => ({ scope, assertCurrent: () => undefined }),
      assertScope: () => undefined
    } as unknown as ModDevelopmentService)
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
    const original = await projectAuthoringSessions.scaffold(
      scope,
      "delta",
      "Delta",
      () => {},
      "native-modular"
    )
    roots.add(dirname(original.directory))
    const author = createModAuthoringTool({ threadId, workspace: scope.workspace })
    const first = JSON.parse(
      await author.invoke({
        action: "project_patch",
        id: original.id,
        revision: 1,
        sourceDigest: original.source.digest,
        sourcePatch: [{ op: "replace", path: "/plugin/title", value: "Delta title" }]
      })
    )
    expect(first).toMatchObject({
      ok: true,
      result: { revision: 2, preservedUnchangedFiles: true, runtimeVerified: false }
    })
    const current = projectAuthoringSessions.read(scope, original.id)
    const files = [
      { path: "workflows/verify.workflow.js", text: "// Exact inert companion" },
      { path: "tests/verify/case.json", text: '{"case":"retained"}' }
    ]
    const changed = JSON.parse(
      await author.invoke({
        action: "project_patch",
        id: current.id,
        revision: current.revision,
        sourceDigest: current.source.digest,
        files,
        sourcePatch: files.map((file) => ({ op: "add", path: "/resources/-", value: file.path }))
      })
    )
    expect(changed).toMatchObject({ ok: true, result: { revision: 3 } })
    const updated = projectAuthoringSessions.read(scope, current.id)
    expect(updated.source.files).toEqual(expect.arrayContaining(files))
    for (const file of original.source.files.filter(
      (file) => file.path !== "composition/source.json"
    ))
      expect(updated.source.files.find((value) => value.path === file.path)).toEqual(file)
    const failed = JSON.parse(
      await author.invoke({
        action: "project_patch",
        id: updated.id,
        revision: updated.revision,
        sourceDigest: updated.source.digest,
        sourcePatch: [
          { op: "replace", path: "/plugin/title", value: "Never saved" },
          { op: "test", path: "/plugin/id", value: "wrong" }
        ]
      })
    )
    expect(failed).toMatchObject({
      ok: false,
      error: "PROJECT_SOURCE_PATCH_TEST_FAILED",
      currentDraft: { id: updated.id, revision: 3, sourceDigest: updated.source.digest },
      sourcePatch: { operationIndex: 1, path: "/plugin/id" },
      sourceUnchanged: true,
      executed: false
    })
    expect(projectAuthoringSessions.read(scope, updated.id).source).toEqual(updated.source)
    const invalidSchema = JSON.parse(
      await author.invoke({
        action: "project_patch",
        id: updated.id,
        revision: updated.revision,
        sourceDigest: updated.source.digest,
        sourcePatch: [{ op: "replace", path: "/plugin/version", value: "invalid" }]
      })
    )
    expect(invalidSchema).toMatchObject({
      ok: false,
      error: "PROJECT_SOURCE_PATCH_SCHEMA",
      sourcePatch: { path: "/plugin/version" },
      currentDraft: { revision: 3 },
      diagnostics: [{ file: "composition/source.json", path: "/plugin/version",
        code: "PROJECT_SCHEMA_INVALID_FORMAT", message: expect.any(String) }],
      sourceUnchanged: true,
      executed: false
    })
    expect(
      author.schema.safeParse({
        action: "project_patch",
        sourcePatch: [{ op: "move", path: "/modules/0" }]
      }).success
    ).toBe(false)
    expect(author.description).toContain("sourcePatch")
    expect(author.description).toContain("add /modules/-")
  })
  it("diagnoses an unsupported native check kind through real files-patch and complete save without changing r1", async () => {
    const scope = {
      threadId,
      workspace: "workspace",
      incarnation: { token: `schema-${++sequence}`, legacyCreatedAt: 1 }
    }
    setModDevelopmentService({
      isCreatorMode: () => true,
      projectAuthoringContext: () => ({ scope, assertCurrent: () => undefined }),
      assertScope: () => undefined
    } as unknown as ModDevelopmentService)
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
    const original = await projectAuthoringSessions.scaffold(
      scope,
      "schema",
      "Schema",
      () => {},
      "native-modular"
    )
    roots.add(dirname(original.directory))
    const native = original.source.files.find((file) => file.path === "composition/source.json")!
    const value = JSON.parse(native.text)
    value.modules.push({
      ...value.modules[1],
      id: "final",
      checks: [
        {
          id: "report-content",
          kind: "text-nonempty",
          artifactId: "report"
        }
      ]
    })
    const file = { path: native.path, text: JSON.stringify(value) }
    const author = createModAuthoringTool({ threadId, workspace: scope.workspace })
    const before = await readdir(dirname(original.directory))
    for (const action of ["project_patch", "project_save"] as const) {
      const raw = await author.invoke({
        action,
        id: original.id,
        name: original.name,
        revision: original.revision,
        sourceDigest: original.source.digest,
        files:
          action === "project_patch"
            ? [file]
            : original.source.files.map((item) => (item.path === file.path ? file : item))
      })
      const response = JSON.parse(raw)
      expect(response).toMatchObject({
        ok: false,
        error: "PROJECT_AUTHORING_SCHEMA_INVALID",
        sourceUnchanged: true,
        executed: false,
        diagnosticCount: 1,
        diagnostics: [
          {
            file: native.path,
            path: "/modules/2/checks/0/kind",
            code: "PROJECT_SCHEMA_INVALID_UNION",
            message: expect.stringContaining("json-schema or action")
          }
        ]
      })
      expect(response.hint).toContain("不得删除要求或用 execute 绕过编译")
      expect(raw).not.toMatch(/text-nonempty|stack|Error:/)
      expect(projectAuthoringSessions.read(scope, original.id)).toMatchObject({
        revision: 1,
        source: original.source
      })
      expect(await readdir(dirname(original.directory))).toEqual(before)
    }
  })
  it("returns exact undeclared paths and unchanged native source so one atomic patch can repair them", async () => {
    const scope = {
      threadId,
      workspace: "workspace",
      incarnation: { token: `resources-${++sequence}`, legacyCreatedAt: 1 }
    }
    setModDevelopmentService({
      isCreatorMode: () => true,
      projectAuthoringContext: () => ({ scope, assertCurrent: () => undefined }),
      assertScope: () => undefined
    } as unknown as ModDevelopmentService)
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
    const draft = await projectAuthoringSessions.scaffold(
      scope,
      "declared-resources",
      "Resources",
      () => {},
      "native-modular"
    )
    roots.add(dirname(draft.directory))
    const author = createModAuthoringTool({ threadId, workspace: scope.workspace })
    const files = [
      { path: "workflows/verify.workflow.js", text: "// Inert workflow source" },
      { path: "tests/e2e-cases/sample.json", text: '{"scenario":"sample"}' }
    ]
    const patch = {
      action: "project_patch" as const,
      id: draft.id,
      revision: draft.revision,
      sourceDigest: draft.source.digest,
      files
    }
    const raw = await author.invoke(patch)
    if (typeof raw !== "string") throw Error("STRING_REQUIRED")
    const rejected = JSON.parse(raw)
    expect(rejected).toMatchObject({
      ok: false,
      error: "PROJECT_DRAFT_FILE_UNSUPPORTED",
      unsupportedPaths: ["tests/e2e-cases/sample.json", "workflows/verify.workflow.js"],
      declarationPath: "composition/source.json",
      sourceUnchanged: true,
      executed: false,
      currentDraft: { id: draft.id, exists: true, revision: 1, sourceDigest: draft.source.digest }
    })
    expect(rejected.hint).toContain("composition/source.json.resources")
    expect(rejected.hint).toContain("同一次 project_patch")
    expect(rejected.hint).toContain("原子保存")
    expect(rejected.hint).toContain("不能使用 execute、write_file")
    expect(projectAuthoringSessions.read(scope, draft.id).revision).toBe(1)
    const declaration = draft.source.files.find((file) => file.path === "composition/source.json")!
    const source = JSON.parse(declaration.text)
    source.resources = [...source.resources, ...files.map((file) => file.path)]
    const repaired = await author.invoke({
      ...patch,
      files: [{ path: declaration.path, text: JSON.stringify(source) }, ...files]
    })
    if (typeof repaired !== "string") throw Error("STRING_REQUIRED")
    expect(JSON.parse(repaired)).toMatchObject({
      ok: true,
      result: { revision: 2, preservedUnchangedFiles: true }
    })
    expect(projectAuthoringSessions.read(scope, draft.id).source.files).toEqual(
      expect.arrayContaining(files)
    )
  })
  it("reads bounded exact files and patches the same native draft without resubmitting its resources", async () => {
    const scope = {
      threadId,
      workspace: "workspace",
      incarnation: { token: `patch-${++sequence}`, legacyCreatedAt: 1 }
    }
    setModDevelopmentService({
      isCreatorMode: () => true,
      projectAuthoringContext: () => ({ scope, assertCurrent: () => undefined }),
      assertScope: () => undefined
    } as unknown as ModDevelopmentService)
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
    const draft = await projectAuthoringSessions.scaffold(scope, "patch", "Patch", () => {})
    roots.add(dirname(draft.directory))
    const author = createModAuthoringTool({ threadId, workspace: scope.workspace })
    const patch = {
      action: "project_patch" as const,
      id: draft.id,
      revision: draft.revision,
      sourceDigest: draft.source.digest,
      files: [{ path: "README.md", text: "Only this file changes" }]
    }
    const raw = await author.invoke(patch)
    if (typeof raw !== "string") throw Error("STRING_REQUIRED")
    expect(JSON.parse(raw)).toMatchObject({
      ok: true,
      result: { revision: 2, preservedUnchangedFiles: true, runtimeVerified: false }
    })
    const current = projectAuthoringSessions.read(scope, draft.id)
    for (const file of draft.source.files.filter((file) => file.path !== "README.md"))
      expect(current.source.files.find((item) => item.path === file.path)).toEqual(file)
    const page = await author.invoke({
      action: "project_read",
      id: draft.id,
      assetPath: "README.md"
    })
    if (typeof page !== "string") throw Error("STRING_REQUIRED")
    expect(JSON.parse(page)).toMatchObject({
      ok: true,
      result: {
        revision: 2,
        sourceDigest: current.source.digest,
        readMode: "file-page",
        file: { text: "Only this file changes" }
      }
    })
    const stale = await author.invoke(patch)
    if (typeof stale !== "string") throw Error("STRING_REQUIRED")
    expect(JSON.parse(stale)).toMatchObject({
      ok: false,
      error: "PROJECT_DRAFT_REVISION_CHANGED",
      currentDraft: { revision: 2 }
    })
  })
  it.each(["revision", "drafts", "sessions"] as const)(
    "returns actionable %s capacity recovery through the real tool error boundary",
    async (reason) => {
      const scope = {
        threadId,
        workspace: "workspace",
        incarnation: { token: `inc-${++sequence}`, legacyCreatedAt: 1 }
      }
      setModDevelopmentService({
        isCreatorMode: () => true,
        projectAuthoringContext: () => ({ scope, assertCurrent: () => undefined }),
        assertScope: () => undefined
      } as unknown as ModDevelopmentService)
      claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
      vi.spyOn(projectAuthoringSessions, "save").mockRejectedValueOnce(
        new ProjectDraftLimitError(reason)
      )
      const author = createModAuthoringTool({ threadId, workspace: scope.workspace })
      const raw = await author.invoke({
        action: "project_save",
        id: "continuation",
        name: "继续制作",
        revision: 0,
        files: [{ path: "README.md", text: "source" }]
      })
      if (typeof raw !== "string") throw Error("Expected serialized authoring result")
      const result = JSON.parse(raw)
      expect(result).toMatchObject({ ok: false, error: "PROJECT_DRAFT_LIMIT", limit: reason })
      expect(result.hint).toContain("project_read")
      expect(result.hint).toContain(reason === "revision" ? "revision:0" : "project_pack")
      expect(result.hint).toContain(
        reason === "revision" ? "公开动作锁" : "运行、权限与未核对试用不会自动恢复"
      )
    }
  )
  it("lists live authorized actions, binds exact contracts and packages without executing providers", async () => {
    const scope = {
      threadId,
      workspace: "workspace",
      incarnation: { token: `inc-${++sequence}`, legacyCreatedAt: 1 }
    }
    const service = {
      isCreatorMode: () => true,
      projectAuthoringContext: () => ({ scope, assertCurrent: () => undefined }),
      assertScope: () => undefined,
      requestTrial: vi.fn()
    }
    setModDevelopmentService(service as unknown as ModDevelopmentService)
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
    const action: ClawActionDescriptor = {
      pluginId: "fixture-installed-provider",
      plugin: "public-provider",
      digest: "a".repeat(64),
      actionId: "format",
      name: "整理文字",
      command: "format",
      inputSchema: {
        type: "object",
        required: ["text"],
        additionalProperties: false,
        properties: { text: { type: "string" } }
      },
      outputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } }
    }
    let catalog: ClawActionDescriptor[] = [action]
    const projectActions = vi.fn(async () => catalog)
    const author = createModAuthoringTool({ threadId, workspace: scope.workspace, projectActions })
    const invoke = async (input: Parameters<typeof author.invoke>[0]) => {
      const result = await author.invoke(input)
      if (typeof result !== "string") throw Error("Expected serialized authoring result")
      return JSON.parse(result)
    }
    const created = await invoke({ action: "project_scaffold", id: "reuse-docs", name: "复用文档" })
    roots.add(dirname(created.result.directory))
    const listed = await invoke({ action: "project_actions" })
    expect(listed.result.actions[0]).toMatchObject(action)
    expect(listed.result.executed).toBe(false)
    const provider = {
      pluginId: action.pluginId,
      plugin: action.plugin,
      digest: action.digest,
      actionId: action.actionId
    }
    const first = await invoke({
      action: "project_bind_action",
      id: "reuse-docs",
      revision: 1,
      stageId: "review",
      localActionId: "format",
      provider,
      actionInput: { text: "显式输入" }
    })
    expect(first.ok).toBe(true)
    expect(first.result.revision).toBe(2)
    const second = await invoke({
      action: "project_bind_action",
      id: "reuse-docs",
      revision: 2,
      stageId: "review",
      localActionId: "format-again",
      provider,
      actionInput: {},
      inputFrom: { kind: "action", actionId: "format", pointer: "" }
    })
    expect(second.result.revision).toBe(3)
    const lock = JSON.parse(
      second.result.source.files.find(
        (file: { path: string }) => file.path === "devclaw.project-actions.lock.json"
      ).text
    )
    expect(lock.bindings).toHaveLength(2)
    expect(lock.bindings[1].inputSchema).toEqual(action.inputSchema)
    expect(
      (await invoke({ action: "project_doctor", id: "reuse-docs", revision: 3 })).result.valid
    ).toBe(true)
    expect(
      (await invoke({ action: "project_pack", id: "reuse-docs", revision: 3 })).result.output
    ).toMatch(/\.zip$/)
    catalog = [{ ...action, digest: "b".repeat(64) }]
    expect(
      (
        await invoke({
          action: "project_bind_action",
          id: "reuse-docs",
          revision: 3,
          stageId: "review",
          localActionId: "stale",
          provider,
          actionInput: { text: "x" }
        })
      ).error
    ).toBe("PROJECT_ACTION_PROVIDER_CHANGED")
    expect(
      (await invoke({ action: "project_doctor", id: "reuse-docs", revision: 3 })).result.valid
    ).toBe(false)
    expect((await invoke({ action: "project_read", id: "reuse-docs" })).result.revision).toBe(3)
    expect(service.requestTrial).not.toHaveBeenCalled()
    expect(projectActions).toHaveBeenCalledWith(scope.workspace, threadId)
  })
  it("does not publish a catalogue response after losing the physical creator lease", async () => {
    const scope = {
      threadId,
      workspace: "workspace",
      incarnation: { token: `inc-${++sequence}`, legacyCreatedAt: 1 }
    }
    setModDevelopmentService({
      isCreatorMode: () => true,
      projectAuthoringContext: () => ({ scope, assertCurrent: () => undefined }),
      assertScope: () => undefined
    } as unknown as ModDevelopmentService)
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
    let finish!: (value: ClawActionDescriptor[]) => void
    const author = createModAuthoringTool({
      threadId,
      workspace: scope.workspace,
      projectActions: () =>
        new Promise((resolve) => {
          finish = resolve
        })
    })
    const pending = author.invoke({ action: "project_actions" })
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"))
    releaseLocalThreadRunLease(threadId, "desktop", "run")
    finish([])
    expect(JSON.parse(await pending)).toMatchObject({
      ok: false,
      error: "DEVELOPMENT_TURN_CHANGED"
    })
  })
  it("creates, checks, repairs and packages a project without invoking function trial or installation", async () => {
    const scope = {
      threadId,
      workspace: "workspace",
      incarnation: { token: `inc-${++sequence}`, legacyCreatedAt: 1 }
    }
    const service = {
      isCreatorMode: () => true,
      projectAuthoringContext: () => ({ scope, assertCurrent: () => undefined }),
      assertScope: () => undefined,
      requestTrial: vi.fn()
    }
    setModDevelopmentService(service as unknown as ModDevelopmentService)
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
    const author = createModAuthoringTool({ threadId, workspace: scope.workspace })
    const created = JSON.parse(
      await author.invoke({ action: "project_scaffold", id: "docs-test", name: "文档" })
    )
    expect(created.ok).toBe(true)
    roots.add(dirname(created.result.directory))
    expect(created.result.revision).toBe(1)
    const brokenFiles = created.result.source.files.filter(
      (file: { path: string }) => file.path !== "skills/draft/SKILL.md"
    )
    expect(
      JSON.parse(
        await author.invoke({
          action: "project_save",
          id: "docs-test",
          name: "文档",
          revision: 1,
          files: brokenFiles
        })
      ).ok
    ).toBe(true)
    expect(
      JSON.parse(await author.invoke({ action: "project_doctor", id: "docs-test", revision: 2 }))
        .result.valid
    ).toBe(false)
    expect(
      JSON.parse(
        await author.invoke({
          action: "project_save",
          id: "docs-test",
          name: "文档",
          revision: 2,
          files: created.result.source.files
        })
      ).ok
    ).toBe(true)
    expect(
      JSON.parse(await author.invoke({ action: "project_test", id: "docs-test", revision: 3 }))
        .result.valid
    ).toBe(true)
    const packed = JSON.parse(
      await author.invoke({ action: "project_pack", id: "docs-test", revision: 3 })
    )
    expect(packed.ok).toBe(true)
    expect(packed.result.output).toMatch(/\.zip$/)
    expect(JSON.parse(await author.invoke({ action: "project_list" })).result).toContainEqual(
      expect.objectContaining({ id: "docs-test", revision: 3 })
    )
    const trial = JSON.parse(
      await author.invoke({
        action: "project_request_trial",
        id: "docs-test",
        revision: 3,
        goal: "实际生成并复核文档"
      })
    )
    expect(trial).toMatchObject({
      ok: true,
      result: {
        phase: "needs-approval",
        executed: false,
        request: { draftId: "docs-test", revision: 3, goal: "实际生成并复核文档" }
      }
    })
    expect(projectAuthoringSessions.developmentStatus(scope, "docs-test")).toMatchObject({
      status: "prepared",
      executed: false,
      activeRuns: 0
    })
    const readTrial = JSON.parse(await author.invoke({ action: "project_read", id: "docs-test" }))
    expect(readTrial.result.trial).toMatchObject({
      id: trial.result.request.id,
      draftId: "docs-test",
      revision: 3,
      goal: "实际生成并复核文档"
    })
    const listTrial = JSON.parse(await author.invoke({ action: "project_list" }))
    expect(listTrial.result).toContainEqual(
      expect.objectContaining({
        id: "docs-test",
        trial: expect.objectContaining({ id: trial.result.request.id })
      })
    )
    expect(service.requestTrial).not.toHaveBeenCalled()
    expect(author.schema.safeParse({ action: "project_install" }).success).toBe(false)
    expect(author.schema.safeParse({ action: "project_approve" }).success).toBe(false)
    releaseLocalThreadRunLease(threadId, "desktop", "run")
    expect(JSON.parse(await author.invoke({ action: "project_read", id: "docs-test" })).ok).toBe(
      false
    )
  })
})
