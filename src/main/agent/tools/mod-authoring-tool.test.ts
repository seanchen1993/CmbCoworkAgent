import { afterEach, describe, expect, it, vi } from "vitest"
import { createModAuthoringTool } from "./mod-authoring-tool"
import {
  setModDevelopmentService,
  type ModDevelopmentService
} from "../../mods/devtools/development-service"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../thread-run-lease"
import { projectAuthoringSessions } from "../../mods/devtools/project-authoring-session"

vi.mock("../../storage", () => ({ getPlugins: vi.fn(() => []) }))

const threadId = "authoring-tool-test"
const workspace = "workspace"
function fixture() {
  const service = {
    isEnabled: vi.fn((id, root) => id === threadId && root === workspace),
    status: vi.fn(() => ({ enabled: true })),
    save: vi.fn(() => ({ revision: 1 })),
    check: vi.fn(async () => ({ valid: true })),
    requestTrial: vi.fn(async () => ({ trials: [] }))
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
      .mockResolvedValue({ revision: 2 } as never)
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
