import { afterEach, describe, expect, it, vi } from "vitest"
import { createModCompositionTool } from "./mod-composition-tool"
import {
  setModDevelopmentService,
  type ModDevelopmentService
} from "../../mods/devtools/development-service"
import {
  setCreatorCompositionService,
  type CreatorCompositionService
} from "../../mods/devtools/creator-composition"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../thread-run-lease"
import { CreatorRequestBudgets } from "../../mods/devtools/creator-request-budget"

const threadId = "composition-tool-test"
function fixture() {
  const mode = { isCreatorMode: vi.fn(() => true), captureCreatorMode: vi.fn(() => () => {}) }
  const service = {
    catalog: vi.fn(async () => ({ catalogToken: "a".repeat(64) })),
    refreshStatus: vi.fn(async () => ({ phase: "active" })),
    stage: vi.fn(async () => ({ phase: "queued" })),
    cancel: vi.fn(() => ({ phase: "cancelled" })),
    undo: vi.fn(async () => ({ phase: "queued" })),
    save: vi.fn(async () => ({ name: "Review", revision: 1 })),
    applySaved: vi.fn(async () => ({ phase: "queued" })),
    details: vi.fn(async () => ({ provider: { pluginId: "one" } }))
  }
  setModDevelopmentService(mode as unknown as ModDevelopmentService)
  setCreatorCompositionService(service as unknown as CreatorCompositionService)
  claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
  return { mode, service }
}
afterEach(() => {
  setModDevelopmentService(undefined)
  setCreatorCompositionService(undefined)
  releaseLocalThreadRunLease(threadId, "desktop", "run")
})
describe("creator native composition tool", () => {
  it("uses the frozen cumulative operation budget instead of a lower per-tool limit", async () => {
    const f = fixture()
    const ledger = new CreatorRequestBudgets()
    Object.assign(f.mode, { claimAuthoringBudget: (_thread: string, run: string,
      kind: "operation" | "candidate") => ledger.claim("workspace", run, kind) })
    const native = createModCompositionTool({ threadId, workspace: "workspace" })
    for (let i = 0; i < 32; i++)
      expect(JSON.parse(await native.invoke({ action: "status" })).ok).toBe(true)
    expect(JSON.parse(await native.invoke({ action: "status" })))
      .toMatchObject({ ok: false, error: "DEVELOPMENT_TURN_BUDGET" })
    expect(JSON.parse(await createModCompositionTool({ threadId, workspace: "workspace" })
      .invoke({ action: "status" })))
      .toMatchObject({ ok: false, error: "DEVELOPMENT_TURN_BUDGET" })
    expect(f.service.refreshStatus).toHaveBeenCalledTimes(32)
  })

  it("routes directory search/refresh and pinned provider details", async () => {
    const f = fixture(),
      native = createModCompositionTool({ threadId, workspace: "workspace" })
    await native.invoke({ action: "list", query: "review", cursor: 12, refresh: true })
    await native.invoke({ action: "details", pluginId: "one", catalogToken: "a".repeat(64) })
    expect(f.service.catalog).toHaveBeenCalledWith(threadId, 12, { query: "review", refresh: true })
    expect(f.service.details).toHaveBeenCalledWith(threadId, "one", "a".repeat(64))
  })
  it("routes cancel, scoped undo and exact named template revisions without exposing model scope", async () => {
    const f = fixture(),
      native = createModCompositionTool({ threadId, workspace: "workspace" })
    expect(JSON.parse(await native.invoke({ action: "cancel" }))).toMatchObject({
      ok: true,
      result: { phase: "cancelled" }
    })
    await native.invoke({ action: "undo" })
    await native.invoke({
      action: "save",
      savedName: "Review",
      savedRevision: 0,
      catalogToken: "a".repeat(64)
    })
    await native.invoke({ action: "apply_saved", savedName: "Review", savedRevision: 1 })
    expect(f.service.cancel).toHaveBeenCalledWith(threadId, "workspace")
    expect(f.service.undo).toHaveBeenCalledWith(threadId, "workspace", {
      turnId: "run",
      assertTurn: expect.any(Function)
    })
    expect(f.service.save).toHaveBeenCalledWith(
      threadId,
      "Review",
      0,
      "a".repeat(64),
      expect.any(Function),
      { turnId: "run", signal: undefined }
    )
    expect(f.service.applySaved).toHaveBeenCalledWith(
      threadId,
      "run",
      "Review",
      1,
      expect.any(Function)
    )
  })
  it("uses fresh source status and explains unconfirmed application without promising rollback", async () => {
    const f = fixture()
    const native = createModCompositionTool({ threadId, workspace: "workspace" })
    expect(JSON.parse(await native.invoke({ action: "status" }))).toMatchObject({
      ok: true,
      result: { phase: "active" }
    })
    expect(f.service.refreshStatus).toHaveBeenCalledExactlyOnceWith(threadId)
    f.service.stage.mockRejectedValueOnce(Error("MODS_COMPOSITION_APPLY_UNCONFIRMED"))
    const failed = JSON.parse(
      await native.invoke({ action: "stage", catalogToken: "a".repeat(64) })
    )
    expect(failed).toMatchObject({ ok: false, error: "MODS_COMPOSITION_APPLY_UNCONFIRMED" })
    expect(failed.hint).toContain("提交前检查失败")
    expect(failed.hint).toContain("不可自动重试")
    expect(failed.hint).not.toContain("失败保留原组合")
  })
  it("stages exact catalog choices with a captured host turn and no model-supplied scope", async () => {
    const f = fixture()
    const input = { threadId, workspace: "workspace" }
    const native = createModCompositionTool(input)
    input.threadId = "retargeted"
    const value = {
      action: "stage" as const,
      catalogToken: "a".repeat(64),
      capabilities: [{ pluginId: "one", name: "One", digest: "b".repeat(64) }]
    }
    expect(JSON.parse(await native.invoke(value))).toMatchObject({
      ok: true,
      result: { phase: "queued" }
    })
    expect(f.service.stage).toHaveBeenCalledWith(
      threadId,
      "run",
      expect.objectContaining({
        capabilities: value.capabilities,
        catalogToken: value.catalogToken
      }),
      expect.any(Function)
    )
  })
  it("rejects mode changes and released/reacquired same-name turns before listing or staging", async () => {
    const f = fixture()
    const native = createModCompositionTool({ threadId, workspace: "workspace" })
    f.mode.isCreatorMode.mockReturnValue(false)
    expect(JSON.parse(await native.invoke({ action: "list" }))).toMatchObject({
      ok: false,
      error: "DEVELOPMENT_TURN_CHANGED"
    })
    f.mode.isCreatorMode.mockReturnValue(true)
    releaseLocalThreadRunLease(threadId, "desktop", "run")
    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
    expect(JSON.parse(await native.invoke({ action: "list" }))).toMatchObject({
      ok: false,
      error: "DEVELOPMENT_TURN_CHANGED"
    })
    expect(f.service.catalog).not.toHaveBeenCalled()
    expect(f.service.stage).not.toHaveBeenCalled()
  })
})
