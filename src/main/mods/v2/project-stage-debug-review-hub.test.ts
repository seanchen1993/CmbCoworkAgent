import { randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { ProjectStageDebugReviewHub } from "./project-stage-debug-review-hub"
import type { NativeStageDebugReviewRequest } from "./platform-project-stage-debug-provider"
import type { NativePlatformCallContext } from "./platform-capabilities-types"

afterEach(() => vi.restoreAllMocks())
function fixture() {
  let active = true, sourceCurrent = true
  const guard = vi.fn(() => { if (!active) throw Error("CALL_ALREADY_ENDED") })
  const scope = { threadId: "creator", workspace: "/workspace", incarnation: { token: "thread-token", legacyCreatedAt: 1 } }
  const context: NativePlatformCallContext = { ...scope, incarnation: JSON.stringify(scope.incarnation), generation: "source-generation",
    caller: { name: "stage-debugger", provider: "stage-debugger", digest: "current-source", generation: "guest-generation" },
    signal: new AbortController().signal, assertCurrent: guard, publish: vi.fn(), invoke: vi.fn() }
  const input: NativeStageDebugReviewRequest = {
    context, scope, draftId: "candidate", revision: 2, assertCurrent: guard,
    preparation: { id: randomUUID(), snapshotId: "a".repeat(64), sourceProjectId: "source",
      stageId: "review", mode: "stage", candidateDigest: "b".repeat(64),
      affectedStageIds: ["review"], canCreate: true, diagnostics: [] }
  }
  const publish = vi.fn(() => true)
  const fresh = vi.fn(async () => { if (!sourceCurrent) throw Error("SOURCE_REMOVED") })
  const hub = new ProjectStageDebugReviewHub(publish, fresh)
  return { scope, input, publish, fresh, hub,
    endAction: () => { active = false }, revokeSource: () => { sourceCurrent = false } }
}
it("returns queued navigation rather than claiming renderer opened or user approved", async () => {
  const f = fixture()
  expect(await f.hub.request(f.input)).toEqual({ requested: true, queued: true })
  const intent = await f.hub.current(f.scope.threadId, f.scope.workspace, f.scope.incarnation)
  expect(intent).toMatchObject({ draftId: "candidate", revision: 2, caller: { name: "stage-debugger", digest: "current-source" } })
  expect(intent).not.toHaveProperty("preparationId")
  expect(intent).not.toHaveProperty("executionGranted")
  expect(JSON.stringify(intent)).not.toContain(f.input.preparation.id)
})
it("reads after the old action has ended by fresh native checks, not a retained guest grant", async () => {
  const f = fixture()
  await f.hub.request(f.input)
  f.endAction()
  await expect(f.hub.current(f.scope.threadId, f.scope.workspace, f.scope.incarnation)).resolves.toMatchObject({ draftId: "candidate" })
  expect(f.fresh).toHaveBeenCalledOnce()
})
it("does not return another workspace, incarnation or thread intent", async () => {
  const f = fixture()
  await f.hub.request(f.input)
  expect(await f.hub.current("other", f.scope.workspace, f.scope.incarnation)).toBeUndefined()
  expect(await f.hub.current(f.scope.threadId, "/foreign", f.scope.incarnation)).toBeUndefined()
  expect(await f.hub.current(f.scope.threadId, f.scope.workspace, { ...f.scope.incarnation, token: "replacement" })).toBeUndefined()
  expect(f.fresh).not.toHaveBeenCalled()
})
it("refuses removed or changed caller sources without exposing stale live authorization", async () => {
  const f = fixture()
  await f.hub.request(f.input)
  f.revokeSource()
  expect(await f.hub.current(f.scope.threadId, f.scope.workspace, f.scope.incarnation)).toBeUndefined()
})
it("does not persist review intentions or permissions across restart", async () => {
  const f = fixture()
  await f.hub.request(f.input)
  const restarted = new ProjectStageDebugReviewHub(f.publish, f.fresh)
  expect(await restarted.current(f.scope.threadId, f.scope.workspace, f.scope.incarnation)).toBeUndefined()
})
it("keeps an undelivered navigation available for trusted readback without claiming opened", async () => {
  const f = fixture()
  f.publish.mockReturnValueOnce(false)
  expect(await f.hub.request(f.input)).toEqual({ requested: true, queued: false })
  expect(await f.hub.current(f.scope.threadId, f.scope.workspace, f.scope.incarnation)).toBeDefined()
})
it("expires intentions and returns only the latest scoped request", async () => {
  const f = fixture(), now = Date.now()
  vi.spyOn(Date, "now").mockReturnValue(now)
  await f.hub.request(f.input)
  const first = await f.hub.current(f.scope.threadId, f.scope.workspace, f.scope.incarnation)
  await f.hub.request(f.input)
  expect((await f.hub.current(f.scope.threadId, f.scope.workspace, f.scope.incarnation))!.id).not.toBe(first!.id)
  vi.mocked(Date.now).mockReturnValue(now + 6 * 60 * 1000)
  expect(await f.hub.current(f.scope.threadId, f.scope.workspace, f.scope.incarnation)).toBeUndefined()
})
it("does not return a replaced request after an asynchronous fresh check", async () => {
  const f = fixture()
  await f.hub.request(f.input)
  let done!: () => void
  f.fresh.mockImplementationOnce(() => new Promise<void>(resolve => { done = resolve }))
  const pending = f.hub.current(f.scope.threadId, f.scope.workspace, f.scope.incarnation)
  await f.hub.request(f.input)
  done()
  expect(await pending).toBeUndefined()
})
it("withdraws an intent whose original request loses authority during publication", async () => {
  const f = fixture()
  f.publish.mockImplementationOnce(() => { f.endAction(); return true })
  await expect(f.hub.request(f.input)).rejects.toThrow("CALL_ALREADY_ENDED")
  expect(await f.hub.current(f.scope.threadId, f.scope.workspace, f.scope.incarnation)).toBeUndefined()
})
