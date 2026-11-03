import { afterEach, expect, it, vi } from "vitest"
import type { DevelopmentScope } from "../v2/development-session"
import type { DevelopmentTrialStatus } from "../../../shared/mods/development"
import { publishDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import { CreatorTrialUndoScheduler } from "./creator-trial-undo"

const services: CreatorTrialUndoScheduler[] = []
const scope: DevelopmentScope = { workspace: "workspace", threadId: "trial-undo-test",
  incarnation: { token: "first", legacyCreatedAt: 1 } }
function fixture() {
  let busy = true
  let alive = true
  let trial: DevelopmentTrialStatus = { componentId: "mod", draftId: "mod", revision: 1,
    bundleDigest: "a".repeat(64), compiledDigest: "b".repeat(64), phase: "active",
    activeRevision: 1, activeDigest: "b".repeat(64), capabilities: [] }
  let idle = () => {}
  const stop = vi.fn(async () => { trial = { ...trial, phase: "stopped" } })
  const service = new CreatorTrialUndoScheduler({
    read: () => [trial], stop, busy: () => busy,
    onIdle: listener => { idle = () => listener(scope.threadId); return () => {} }, changed: vi.fn()
  })
  services.push(service)
  const guard = () => { if (!alive) throw Error("SCOPE_CHANGED") }
  return { service, stop, guard, settle: (outcome: "completed" | "cancelled" = "completed") =>
    publishDevelopmentTurnSettlement({ ...scope, turnId: "turn", outcome }),
  idle: () => { busy = false; idle() },
  edit: () => { trial = { ...trial, revision: 2 } },
  replace: (patch: Partial<DevelopmentTrialStatus>) => { trial = { ...trial, ...patch } },
  leave: () => { alive = false } }
}
afterEach(() => { for (const service of services.splice(0)) service.close() })

it("queues without stopping its own turn, then waits for real idle before stopping", async () => {
  const f = fixture()
  await f.service.request(scope, "mod", "turn", f.guard)
  f.settle()
  expect(f.stop).not.toHaveBeenCalled()
  f.idle()
  await vi.waitFor(() => expect(f.service.status(scope.threadId)?.phase).toBe("active"))
  expect(f.stop).toHaveBeenCalledOnce()
})
it("does not stop a later source version that replaced the queued target", async () => {
  const f = fixture()
  await f.service.request(scope, "mod", "turn", f.guard)
  f.settle()
  f.edit()
  f.idle()
  await vi.waitFor(() => expect(f.service.status(scope.threadId)?.error)
    .toBe("DEVELOPMENT_UNDO_SOURCE_CHANGED"))
  expect(f.stop).not.toHaveBeenCalled()
})
it("does not perform an undo from an interrupted turn or a stale scope", async () => {
  const f = fixture()
  await f.service.request(scope, "mod", "turn", f.guard)
  f.settle("cancelled")
  f.idle()
  await vi.waitFor(() => expect(f.service.status(scope.threadId)?.phase).toBe("failed"))
  expect(f.stop).not.toHaveBeenCalled()
  f.leave()
  expect(f.service.status(scope.threadId)).toBeUndefined()
})

it.each(["component", "revision"])(
  "keeps an old undo failure as history after an actually active replacement %s", async kind => {
    const f = fixture()
    await f.service.request(scope, "mod", "turn", f.guard)
    f.settle("cancelled")
    await vi.waitFor(() => expect(f.service.status(scope.threadId))
      .toMatchObject({ phase: "failed", superseded: false }))
    f.replace({ ...(kind === "component" ? { componentId: "new-mod", draftId: "new-mod" } : {}),
      revision: 2, compiledDigest: "c".repeat(64), activeRevision: 2,
      activeDigest: "c".repeat(64), phase: "active" })
    expect(f.service.status(scope.threadId)).toMatchObject({
      phase: "failed", error: "DEVELOPMENT_UNDO_TURN_INTERRUPTED", superseded: true,
      componentId: "mod", revision: 1, compiledDigest: "b".repeat(64)
    })
    f.idle()
    expect(f.stop).not.toHaveBeenCalled()
  }
)

it.each(["needs-approval", "unknown", "stopped"] as const)(
  "does not dismiss an unresolved undo because a later trial is merely %s", async phase => {
    const f = fixture()
    await f.service.request(scope, "mod", "turn", f.guard)
    f.settle("cancelled")
    await vi.waitFor(() => expect(f.service.status(scope.threadId)?.phase).toBe("failed"))
    f.replace({ componentId: "later", revision: 2, phase,
      compiledDigest: "c".repeat(64), activeRevision: undefined, activeDigest: undefined })
    expect(f.service.status(scope.threadId)).toMatchObject({ phase: "failed", superseded: false })
    expect(f.stop).not.toHaveBeenCalled()
  }
)

it("does not confuse a changed draft with a replacement running revision", async () => {
  const f = fixture()
  await f.service.request(scope, "mod", "turn", f.guard)
  f.settle("cancelled")
  await vi.waitFor(() => expect(f.service.status(scope.threadId)?.phase).toBe("failed"))
  f.replace({ revision: 2, bundleDigest: "c".repeat(64), compiledDigest: "d".repeat(64) })
  expect(f.service.status(scope.threadId)).toMatchObject({ phase: "failed", superseded: false })
  expect(f.stop).not.toHaveBeenCalled()
})
