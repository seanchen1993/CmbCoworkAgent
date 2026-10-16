import { rm } from "node:fs/promises"
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
      expect(result.hint).toContain(reason === "revision" ? "公开动作锁" : "不会自动恢复草稿")
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
    expect(service.requestTrial).not.toHaveBeenCalled()
    expect(author.schema.safeParse({ action: "project_install" }).success).toBe(false)
    expect(author.schema.safeParse({ action: "project_approve" }).success).toBe(false)
    releaseLocalThreadRunLease(threadId, "desktop", "run")
    expect(JSON.parse(await author.invoke({ action: "project_read", id: "docs-test" })).ok).toBe(
      false
    )
  })
})
