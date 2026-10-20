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
import { CreatorRequestBudgets } from "../../mods/devtools/creator-request-budget"
import * as stageDebug from "../../mods/devtools/project-stage-debug"

vi.mock("../../storage", () => ({ getPlugins: vi.fn(() => []) }))

const threadId = "authoring-tool-test"
const workspace = "workspace"
function fixture() {
  const service = {
    isCreatorMode: vi.fn((id, root) => id === threadId && root === workspace),
    status: vi.fn(() => ({ enabled: true })),
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
  it("can inspect native stage baselines and request a plan but has no debug approval action", async () => {
    const service = fixture()
    const scope = { threadId, workspace, incarnation: { token: "creator", legacyCreatedAt: 1 } }
    Object.assign(service, { projectAuthoringContext: () => ({ scope, assertCurrent: () => {} }),
      assertScope: vi.fn() })
    const list = vi.fn(() => ({ snapshots: [], branches: [], diagnostics: [] }))
    vi.spyOn(stageDebug, "getProjectStageDebugSessions").mockReturnValue({ list } as unknown as
      ReturnType<typeof stageDebug.getProjectStageDebugSessions>)
    const author = createModAuthoringTool({ threadId, workspace })
    expect(JSON.parse(await author.invoke({ action: "project_stage_debug_list" }))).toMatchObject({ ok: true })
    expect(list).toHaveBeenCalledWith({ scope, guard: expect.any(Function) })
    await expect(author.invoke({ action: "project_stage_debug_create" } as never)).rejects.toThrow()
    releaseLocalThreadRunLease(threadId, "desktop", "first")
    expect(JSON.parse(await author.invoke({ action: "project_stage_debug_list" })))
      .toMatchObject({ ok: false, error: "DEVELOPMENT_TURN_CHANGED" })
    expect(list).toHaveBeenCalledTimes(1)
  })
  it("retains the request repair budget when tools are rebuilt during the same native run", async () => {
    const service = fixture()
    const ledger = new CreatorRequestBudgets()
    Object.assign(service, { claimAuthoringBudget: (_thread: string, run: string, kind: "operation" | "candidate") =>
      ledger.claim(workspace, run, kind) })
    const files = [{ path: "mods/main.ts", text: "export const register = () => {}" }]
    const args = { action: "submit" as const, id: "demo", name: "Demo", revision: 0, files }
    for (let i = 0; i < 3; i++)
      expect(JSON.parse(await createModAuthoringTool({ threadId, workspace }).invoke(args)).ok).toBe(true)
    expect(JSON.parse(await createModAuthoringTool({ threadId, workspace }).invoke(args)))
      .toMatchObject({ ok: false, error: "DEVELOPMENT_REPAIR_BUDGET" })
    expect(service.submit).toHaveBeenCalledTimes(3)
    expect(ledger.latest(workspace)).toMatchObject({ runId: "first", candidates: 3, operations: 4 })
  })
  it("returns exact startup diagnostics and bounds same-turn repair to two attempts", async () => {
    const service = fixture()
    const files = [
      {
        path: "mods/main.ts",
        text: 'export const register = (on) => { on("session.start", async ($) => {}) }'
      }
    ]
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
    const result = await author.invoke({ action: "request_trial", id: "demo", revision: 1 })
    expect(JSON.parse(result)).toMatchObject({ ok: false, error: "MODS_COMMAND_CONFLICT" })
    expect(result).not.toContain("PRIVATE_VALUE")
  })
  it("offers combined submission, current-chat resume and undo, and review-only formal reuse", async () => {
    const service = fixture()
    const author = createModAuthoringTool({ threadId, workspace })
    const files = [{ path: "mods/main.ts", text: "export const register = () => {}" }]
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
