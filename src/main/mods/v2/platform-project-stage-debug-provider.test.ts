import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createProjectStageDebugPlatformProvider, type StageDebugPlatformDependencies } from "./platform-project-stage-debug-provider"
import type { NativePlatformCallContext } from "./platform-capabilities-types"
import { platformDescriptor } from "./platform-capabilities-validation"
import type { DevelopmentScope } from "./development-session"
import type { StageDebugPreparation, StageDebugBranchView } from "../../../shared/project-runtime/stage-debug"
import type { ModObject } from "../../../shared/mods/types"

afterEach(() => vi.restoreAllMocks())
const snapshotId = "a".repeat(64), expectedDigest = "b".repeat(64)
const input = { snapshotId, draftId: "candidate", revision: 2, expectedDigest, mode: "stage" }
function fixture(reviewAvailable = true) {
  const scope: DevelopmentScope = { threadId: "creator", workspace: "/native/workspace",
    incarnation: { token: "native-token", legacyCreatedAt: 1 } }
  let active = true
  const assertCurrent = vi.fn(() => { if (!active) throw Error("MODS_CALL_SCOPE_CHANGED") })
  const context: NativePlatformCallContext = {
    threadId: scope.threadId, workspace: scope.workspace, incarnation: JSON.stringify(scope.incarnation),
    generation: "provider-generation", caller: { name: "third-party", provider: "third-party", digest: "caller-source", generation: "caller-generation" },
    signal: new AbortController().signal, assertCurrent, publish: vi.fn(), invoke: vi.fn()
  }
  const view = { snapshots: [{ id: snapshotId, projectId: "source-project", stageId: "review",
    stageTitle: "复核", sourceDigest: "c".repeat(64), createdAt: 1, fileCount: 2, totalBytes: 30 }],
    branches: [{ id: "branch", projectId: "branch", sourceProjectId: "source-project", snapshotId,
      stageId: "review", mode: "stage" as const, status: "failed" as StageDebugBranchView["status"],
      candidateDigest: expectedDigest, currentCandidateMatches: true,
      diagnostics: ["private C:/native/source/log.md", "PROJECT_STAGE_DEBUG_INPUTS_CHANGED"] }], diagnostics: [] }
  const prepare = vi.fn(async (): Promise<StageDebugPreparation> => ({ id: randomUUID(), snapshotId,
    sourceProjectId: "source-project", stageId: "review", mode: "stage", candidateDigest: expectedDigest,
    affectedStageIds: ["review"], diagnostics: ["private C:/source/root"], canCreate: true }))
  const list = vi.fn(() => view), guard = vi.fn(assertCurrent)
  const openReview = vi.fn<NonNullable<StageDebugPlatformDependencies["openReview"]>>(
    async () => ({ requested: true, queued: true })
  )
  const deps: StageDebugPlatformDependencies = {
    creator: vi.fn(() => ({ scope, guard })), debug: () => ({ list, prepare }),
    drafts: vi.fn(() => [{ id: "candidate", name: "候选", revision: 2, digest: expectedDigest }]),
    ...(reviewAvailable ? { openReview } : {})
  }
  const original = createProjectStageDebugPlatformProvider(deps)
  const provider = { ...original, act: (...args: Parameters<typeof original.act>) =>
    original.act(...args) as Promise<ModObject> }
  return { scope, context, deps, provider, prepare, list, view, openReview, guard,
    revoke: () => { active = false } }
}

describe("third-party stage debug native capability", () => {
  it("discovers a valid descriptor without reading a service and exposes no execution actions", () => {
    const f = fixture()
    expect(platformDescriptor(f.provider.descriptor)).toEqual(f.provider.descriptor)
    expect(f.list).not.toHaveBeenCalled()
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.provider.descriptor.actions.map((action) => action.id)).toEqual(["inspect", "prepare", "review"])
    expect(f.provider.watch).toBeUndefined()
  })
  it("reads counts without exposing source bytes, private paths, or native preparations", async () => {
    const f = fixture()
    expect(await f.provider.read!(f.context)).toEqual({ status: "ready", snapshotCount: 1,
      branchCount: 1, draftCount: 1, reviewAvailable: true })
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.openReview).not.toHaveBeenCalled()
  })
  it("paginates native snapshots instead of exceeding the public 16KB ceiling", async () => {
    const f = fixture()
    f.view.snapshots = Array.from({ length: 64 }, (_, index) => ({ ...f.view.snapshots[0], id: index.toString(16).padStart(64, "0") }))
    const result = await f.provider.act(f.context, "inspect", { kind: "snapshots", offset: 8, limit: 8 })
    expect(result).toMatchObject({ total: 64, offset: 8, nextOffset: 16 })
    expect((result.items as unknown[]).length).toBe(8)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(16000)
  })
  it("observes actual native failed state and sanitizes details rather than inventing PASS", async () => {
    const f = fixture()
    const value = await f.provider.act(f.context, "inspect", { kind: "branches" })
    expect(value).toMatchObject({ items: [{ status: "failed" }] })
    expect(JSON.stringify(value)).not.toContain("C:/")
    expect(JSON.stringify(value)).toContain("PROJECT_STAGE_DEBUG_INPUTS_CHANGED")
    expect(value).toMatchObject({ items: [{ candidateDigest: expectedDigest, currentCandidateMatches: true }] })
  })
  it("preserves the exact recorded candidate digest and a false current-candidate match", async () => {
    const f = fixture()
    f.view.branches[0].candidateDigest = "e".repeat(64)
    f.view.branches[0].currentCandidateMatches = false
    f.view.branches[0].status = "passed"
    const value = await f.provider.act(f.context, "inspect", { kind: "branches" })
    expect(value).toMatchObject({ items: [{ status: "passed", candidateDigest: "e".repeat(64), currentCandidateMatches: false }] })
  })
  it.each<[string, ModObject]>([
    ["inspect", { kind: "snapshots", threadId: "foreign" }],
    ["inspect", { kind: "snapshots", limit: 9 }],
    ["prepare", { ...input, workspace: "C:/other" }],
    ["prepare", { ...input, sourceRoot: "C:/other" }],
    ["prepare", { ...input, mode: "restore" }],
    ["review", { planId: randomUUID(), preparationId: randomUUID() }]
  ])("strictly refuses guest target/path/unknown fields for %s", async (action, value) => {
    const f = fixture()
    await expect(f.provider.act(f.context, action, value)).rejects.toThrow("PUBLIC_INPUT_INVALID")
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.openReview).not.toHaveBeenCalled()
  })
  it("passes the native creator scope to the real prepare API and returns intention only", async () => {
    const f = fixture()
    const plan = await f.provider.act(f.context, "prepare", input)
    expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ scope: f.scope }), { ...input, threadId: "creator" })
    expect(plan).toMatchObject({ candidateDigest: expectedDigest, canReview: true, executionGranted: false })
    expect(plan).not.toHaveProperty("preparationId")
    expect(plan).not.toHaveProperty("sourceRoot")
    expect(f.openReview).not.toHaveBeenCalled()
  })
  it("revalidates native sources for review and queues navigation without an execution grant", async () => {
    const f = fixture()
    const plan = await f.provider.act(f.context, "prepare", input)
    expect(await f.provider.act(f.context, "review", { planId: plan.planId })).toEqual({ requested: true, queued: true, executionGranted: false })
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(f.openReview).toHaveBeenCalledOnce()
    const request = f.openReview.mock.calls[0][0]
    expect(request).toMatchObject({ scope: f.scope, draftId: "candidate", revision: 2 })
    expect(request.preparation.id).not.toBe(plan.planId)
    await expect(f.provider.act(f.context, "review", { planId: plan.planId })).rejects.toThrow("PUBLIC_PLAN_UNKNOWN")
  })
  it("rejects unknown and restarted plan IDs without replaying native prepare", async () => {
    const f = fixture()
    const plan = await f.provider.act(f.context, "prepare", input)
    const restarted = createProjectStageDebugPlatformProvider(f.deps)
    await expect(restarted.act(f.context, "review", { planId: plan.planId })).rejects.toThrow("PUBLIC_PLAN_UNKNOWN")
    expect(f.prepare).toHaveBeenCalledTimes(1)
  })
  it.each(["digest", "generation", "name"] as const)("binds reviews to the original caller %s", async (field) => {
    const f = fixture()
    const plan = await f.provider.act(f.context, "prepare", input)
    f.context.caller[field] = "replacement"
    await expect(f.provider.act(f.context, "review", { planId: plan.planId })).rejects.toThrow("PUBLIC_PLAN_UNKNOWN")
    expect(f.openReview).not.toHaveBeenCalled()
  })
  it("refuses cross-workspace and cross-incarnation reads without leaking counts", async () => {
    const f = fixture()
    expect(await f.provider.read!({ ...f.context, workspace: "/other" })).toMatchObject({ status: "unavailable", snapshotCount: 0 })
    await expect(f.provider.act({ ...f.context, incarnation: "untrusted incarnation" }, "inspect", { kind: "snapshots" })).rejects.toThrow("CREATOR_SCOPE_CHANGED")
  })
  it("does not deliver a plan after source or creator revocation during prepare", async () => {
    const f = fixture()
    f.prepare.mockImplementationOnce(async () => { f.revoke(); throw Error("MODS_CALL_SCOPE_CHANGED") })
    await expect(f.provider.act(f.context, "prepare", input)).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    expect(f.openReview).not.toHaveBeenCalled()
  })
  it("does not navigate when native revalidation finds changed inputs", async () => {
    const f = fixture()
    const plan = await f.provider.act(f.context, "prepare", input)
    f.prepare.mockRejectedValueOnce(Error("PROJECT_STAGE_DEBUG_INPUTS_CHANGED"))
    await expect(f.provider.act(f.context, "review", { planId: plan.planId })).rejects.toThrow("INPUTS_CHANGED")
    expect(f.openReview).not.toHaveBeenCalled()
  })
  it("never leaks arbitrary original errors or private paths", async () => {
    const f = fixture()
    f.prepare.mockRejectedValueOnce(Error("secret value at C:/private/credential.json"))
    await expect(f.provider.act(f.context, "prepare", input)).rejects.toThrow(/^PROJECT_STAGE_DEBUG_NATIVE_UNAVAILABLE$/)
  })
  it("explicitly marks an unconnected review endpoint unavailable", async () => {
    const f = fixture(false)
    const plan = await f.provider.act(f.context, "prepare", input)
    expect(plan.canReview).toBe(false)
    await expect(f.provider.act(f.context, "review", { planId: plan.planId })).rejects.toThrow("REVIEW_UNAVAILABLE")
  })
  it("expires plans and bounds the process-only registry", async () => {
    const f = fixture()
    const start = Date.now()
    vi.spyOn(Date, "now").mockReturnValue(start)
    const plan = await f.provider.act(f.context, "prepare", input)
    vi.mocked(Date.now).mockReturnValue(start + 16 * 60 * 1000)
    await expect(f.provider.act(f.context, "review", { planId: plan.planId })).rejects.toThrow("PUBLIC_PLAN_UNKNOWN")
    for (let index = 0; index < 32; index++) await f.provider.act(f.context, "prepare", input)
    await expect(f.provider.act(f.context, "prepare", input)).rejects.toThrow("PUBLIC_PLAN_LIMIT")
    f.provider.close!()
    await expect(f.provider.act(f.context, "review", { planId: plan.planId })).rejects.toThrow("PUBLIC_PLAN_UNKNOWN")
  })
})
