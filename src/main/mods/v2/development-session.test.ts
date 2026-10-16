import { randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import {
  FunctionDevelopmentSessions,
  type DevelopmentActivation,
  type DevelopmentDriver,
  type DevelopmentScope,
  type DevelopmentRevision
} from "./development-session"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { publishDevelopmentTurnSettlement } from "./development-turn-settlement"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

const closes: Array<() => void> = []
it("keeps real SDK effects behind explicit mode, settlement and exact capability consent", async () => {
  const f = fixture()
  const real = { ...f.input, validation: "authorized-real" as const,
    purpose: "Read current workspace and call an approved service", capabilities: ["http.fetch"] }
  expect(() => f.stage({ ...real, validation: undefined })).toThrow("CAPABILITY_UNSUPPORTED")
  expect(() => f.stage({ ...real, capabilities: ["native.rawIPC"] })).toThrow("CAPABILITY_UNSUPPORTED")
  expect(() => f.stage({ ...real, capabilities: ["event:*"] })).toThrow("CAPABILITY_UNSUPPORTED")
  expect(f.stage(real)).toMatchObject({ phase: "needs-approval", addedCapabilities: ["http.fetch"] })
  f.settled()
  expect(f.driver.prepare).not.toHaveBeenCalled()
  f.registry.approve(f.scope, real.componentId, real.compiledDigest, real.capabilities, () => {})
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  expect(() => f.activation()!.assertCapability("http.fetch")).not.toThrow()
  expect(() => f.activation()!.assertCapability("fs.write")).toThrow("CAPABILITY_DENIED")
  const next = { ...real, revision: 2, compiledDigest: "c".repeat(64),
    capabilities: ["http.fetch", "fs.write"] }
  expect(f.stage(next)).toMatchObject({ phase: "needs-approval", activeRevision: 1,
    addedCapabilities: ["fs.write"] })
  expect(() => f.activation()!.assertCapability("fs.write")).toThrow("CAPABILITY_DENIED")
  await f.registry.stop(f.scope, real.componentId, () => {})
  expect(() => f.activation()!.assertCapability("http.fetch")).toThrow("REVOKED")
})

it("permits a statically declared supported event only after its real trial consent", async () => {
  const f = fixture()
  const revision = { ...f.input, validation: "authorized-real" as const,
    capabilities: ["event:prompt.compose"] }
  expect(f.stage(revision).phase).toBe("needs-approval")
  f.settled()
  expect(f.driver.prepare).not.toHaveBeenCalled()
  f.registry.approve(f.scope, revision.componentId, revision.compiledDigest, revision.capabilities, () => {})
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  expect(() => f.activation()!.assertCapability("event:prompt.compose")).not.toThrow()
  expect(() => f.activation()!.assertCapability("event:fs.write")).toThrow("CAPABILITY_DENIED")
})

it("reports native resource diagnostics only for the exact active generation", async () => {
  const diagnostics = vi.fn<NonNullable<DevelopmentDriver["diagnostics"]>>(() => ({
    providers: 2, subscriptions: 1, inFlight: 1, unknownRequests: 1, backgroundResources: -1
  }))
  const f = fixture({ diagnostics })
  f.stage(); f.approve(); f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  expect(diagnostics).toHaveBeenLastCalledWith(f.scope, f.activation()!.id)
  expect(f.registry.status(f.scope)?.diagnostics).toEqual({
    providers: 2, subscriptions: 1, inFlight: 1, unknownRequests: 1
  })
  diagnostics.mockImplementation(() => { throw Error("old generation") })
  expect(f.registry.status(f.scope)?.diagnostics).toBeUndefined()
  await f.registry.stop(f.scope, f.input.componentId, () => {})
  diagnostics.mockClear()
  expect(f.registry.status(f.scope)?.diagnostics).toBeUndefined()
  expect(diagnostics).not.toHaveBeenCalled()
})

it("requires consent again when a later upgrade reintroduces a removed permission", async () => {
  const f = fixture()
  const first = { ...f.input, validation: "authorized-real" as const,
    capabilities: ["ui.resolve", "http.fetch"] }
  f.stage(first)
  f.registry.approve(f.scope, first.componentId, first.compiledDigest, first.capabilities, () => {})
  f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.activeRevision).toBe(1))
  f.stage({ ...first, revision: 2, capabilities: ["ui.resolve"] })
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.activeRevision).toBe(2))
  expect(f.stage({ ...first, revision: 3 })).toMatchObject({
    phase: "needs-approval", activeRevision: 2, addedCapabilities: ["http.fetch"]
  })
  expect(() => f.activation()!.assertCapability("http.fetch")).toThrow("CAPABILITY_DENIED")
})

it("does not restart an active version on repeated consent or accept a future permission envelope", async () => {
  const f = fixture()
  f.stage(); f.approve(); f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  const activation = f.activation()
  expect(f.approve().phase).toBe("active")
  await Promise.resolve()
  expect(f.activation()).toBe(activation)
  expect(f.driver.prepare).toHaveBeenCalledOnce()
  expect(f.driver.retire).toHaveBeenCalledOnce()
  expect(() => f.registry.approve(f.scope,f.input.componentId,f.input.compiledDigest,
    [...f.input.capabilities,"store.set"],()=>{})).toThrow("APPROVAL_CHANGED")
})
it("reports only allowlisted preparation codes, never localized or arbitrary error bodies", async () => {
  for (const [error, expected] of [
    [new ModFunctionError("MODS_RETURN_UNDEFINED", "敏感路径不能发布"), "MODS_RETURN_UNDEFINED"],
    [new ModFunctionError("MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED", "敏感路径不能发布"), "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED"],
    [new ModFunctionError("MODS_PRIVATE_UNKNOWN", "敏感路径不能发布"), "MODS_DEVELOPMENT_PREPARE_FAILED"],
    [new Error("MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED: sensitive detail"), "MODS_DEVELOPMENT_PREPARE_FAILED"]
  ] as const) {
    const f = fixture({ prepare: async () => { throw error } })
    f.stage(); f.approve(); f.settled()
    await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("failed"))
    expect(f.registry.status(f.scope)?.error).toBe(expected)
  }
})
afterEach(() => {
  for (const close of closes.splice(0)) close()
})
function fixture(overrides: Partial<DevelopmentDriver> = {}) {
  const scope: DevelopmentScope = {
    workspace: "workspace",
    threadId: randomUUID(),
    incarnation: { token: randomUUID(), legacyCreatedAt: 1 }
  }
  const input: DevelopmentRevision = {
    componentId: randomUUID(),
    draftId: "test",
    revision: 1,
    sourcePath: "immutable-source",
    bundleDigest: "a".repeat(64),
    compiledDigest: "b".repeat(64),
    turnId: "turn",
    capabilities: ["ui.resolve"]
  }
  let activation: DevelopmentActivation | undefined
  const dispose = vi.fn(async () => {})
  const driver: DevelopmentDriver = {
    assertScope: () => {},
    prepare: vi.fn(async () => ({ dispose })),
    retire: vi.fn(async () => {}),
    activate: (value) => {
      activation = value
    },
    changed: () => {},
    ...overrides
  }
  const registry = new FunctionDevelopmentSessions(driver)
  closes.push(() => registry.close())
  const stage = (revision = input) => registry.stage(scope, revision, () => {})
  const approve = () =>
    registry.approve(scope, input.componentId, input.compiledDigest, input.capabilities, () => {})
  const settled = () => registry.noteSettled(scope, "turn", "completed")
  return {
    registry,
    scope,
    input,
    stage,
    approve,
    settled,
    driver,
    dispose,
    activation: () => activation
  }
}

it("does not load code before real settlement and trusted approval", async () => {
  const f = fixture()
  expect(f.stage().phase).toBe("needs-approval")
  f.settled()
  expect(f.driver.prepare).not.toHaveBeenCalled()
  expect(() =>
    f.registry.approve(
      f.scope,
      f.input.componentId,
      f.input.compiledDigest,
      f.input.capabilities,
      () => {
        throw Error("not-user")
      }
    )
  ).toThrow("not-user")
  expect(f.driver.prepare).not.toHaveBeenCalled()
  f.approve()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  expect(f.driver.prepare).toHaveBeenCalledOnce()
})

it("waits for the actual physical lease and never steals it", async () => {
  const f = fixture()
  claimLocalThreadRunLease({ threadId: f.scope.threadId, runId: "running", owner: "desktop" })
  closes.push(() => {
    releaseLocalThreadRunLease(f.scope.threadId, "desktop", "running")
  })
  f.stage()
  f.approve()
  f.settled()
  expect(f.driver.prepare).not.toHaveBeenCalled()
  expect(f.registry.status(f.scope)?.waitingReason).toBe("waiting-for-idle")
  releaseLocalThreadRunLease(f.scope.threadId, "desktop", "running")
  f.registry.idle(f.scope.threadId)
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  expect(f.registry.status(f.scope)?.waitingReason).toBeUndefined()
})

it.each(["failed", "cancelled"] as const)(
  "explains a %s creation turn without granting activation or poisoning its replacement",
  async (outcome) => {
    const changed = vi.fn()
    let busy = true
    const f = fixture({ changed, isBusy: () => busy })
    f.stage()
    f.approve()
    expect(f.registry.status(f.scope)?.waitingReason).toBe("turn-finishing")
    changed.mockClear()
    f.registry.noteSettled(f.scope, "turn", outcome)
    expect(changed).toHaveBeenCalledOnce()
    expect(f.registry.status(f.scope)?.waitingReason).toBe("turn-interrupted")
    f.approve()
    f.registry.idle(f.scope.threadId)
    expect(f.driver.prepare).not.toHaveBeenCalled()
    f.stage({ ...f.input, revision: 2, turnId: "replacement" })
    expect(f.registry.status(f.scope)?.waitingReason).toBe("turn-finishing")
    f.registry.noteSettled(f.scope, "replacement", "completed")
    expect(f.registry.status(f.scope)?.waitingReason).toBe("conversation-busy")
    expect(f.driver.prepare).not.toHaveBeenCalled()
    busy = false
    f.registry.idle(f.scope.threadId)
    await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
    expect(f.registry.status(f.scope)?.waitingReason).toBeUndefined()
    expect(f.driver.prepare).toHaveBeenCalledOnce()
  }
)

it("rejects unsupported effects, stale revisions and another component", () => {
  const f = fixture()
  expect(() => f.stage({ ...f.input, capabilities: ["process.run"] })).toThrow("UNSUPPORTED")
  f.stage()
  expect(() => f.stage()).toThrow("REVISION_CONFLICT")
  expect(() => f.stage({ ...f.input, componentId: "other", revision: 2 })).toThrow("CAPACITY")
})

it("retries unchanged interrupted drafts only through a new successfully completed turn", async () => {
  const f = fixture()
  f.stage()
  f.approve()
  const retry = { ...f.input, turnId: "retry" }
  expect(() => f.stage(retry)).toThrow("REVISION_CONFLICT")
  f.registry.noteSettled(f.scope, "turn", "cancelled")
  for (const invalid of [
    f.input,
    { ...retry, draftId: "other" },
    { ...retry, sourcePath: "other" },
    { ...retry, bundleDigest: "d".repeat(64) },
    { ...retry, compiledDigest: "d".repeat(64) },
    { ...retry, capabilities: [] },
    { ...retry, capabilities: [...retry.capabilities, "store.get"] }
  ]) expect(() => f.stage(invalid)).toThrow("REVISION_CONFLICT")
  expect(f.stage(retry).waitingReason).toBe("turn-finishing")
  f.registry.noteSettled(f.scope, "turn", "completed")
  f.registry.idle(f.scope.threadId)
  expect(f.driver.prepare).not.toHaveBeenCalled()
  f.registry.noteSettled(f.scope, "retry", "failed")
  expect(f.registry.status(f.scope)?.waitingReason).toBe("turn-interrupted")
  f.stage({ ...retry, turnId: "retry-again" })
  f.registry.noteSettled(f.scope, "retry-again", "completed")
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  expect(f.driver.prepare).toHaveBeenCalledOnce()
  expect(() => f.stage({ ...retry, turnId: "after-active" })).toThrow("REVISION_CONFLICT")
})

it("preserves the active revision when a later preflight fails", async () => {
  let fail = false
  const f = fixture({
    prepare: async () => {
      if (fail) throw Error("bad-code")
      return { dispose: async () => {} }
    }
  })
  f.stage()
  f.approve()
  f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  fail = true
  f.stage({ ...f.input, revision: 2, compiledDigest: "c".repeat(64) })
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("failed"))
  expect(f.registry.status(f.scope)?.activeRevision).toBe(1)
  expect(() => f.activation()!.assertCapability("ui.resolve")).not.toThrow()
  expect(() => f.activation()!.assertCapability("http.fetch")).toThrow("DENIED")
})

it("checks a capability group once without reusing authority across calls", async () => {
  const f = fixture()
  f.input.capabilities = ["ui.resolve", "event:ui.render", "event:tool.call"]
  let sourceCurrent = true
  const guard = vi.fn(() => {
    if (!sourceCurrent) throw Error("AUTHORING_VERSION_CHANGED")
  })
  f.registry.stage(f.scope, f.input, guard)
  f.approve()
  f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  const activation = f.activation()!
  guard.mockClear()
  activation.assertCapabilities(["event:ui.render", "event:tool.call"])
  expect(guard).toHaveBeenCalledTimes(1)
  expect(() => activation.assertCapabilities(["event:ui.render", "http.fetch"])).toThrow("DENIED")
  expect(guard).toHaveBeenCalledTimes(2)
  activation.assertCapabilities([])
  expect(guard).toHaveBeenCalledTimes(3)
  sourceCurrent = false
  expect(() => activation.assertCapabilities(["event:ui.render"])).toThrow("AUTHORING_VERSION_CHANGED")
  expect(() => activation.assertCapabilities([])).toThrow("AUTHORING_VERSION_CHANGED")
  expect(() => activation.assertCapability("ui.resolve")).toThrow("AUTHORING_VERSION_CHANGED")
  expect(guard).toHaveBeenCalledTimes(6)
})

it("does not treat a recreated thread or cancelled turn as successful settlement", async () => {
  const f = fixture()
  f.stage()
  f.approve()
  publishDevelopmentTurnSettlement({
    ...f.scope,
    incarnation: { token: "other", legacyCreatedAt: 1 },
    turnId: "turn",
    outcome: "completed"
  })
  publishDevelopmentTurnSettlement({ ...f.scope, turnId: "turn", outcome: "cancelled" })
  await Promise.resolve()
  expect(f.driver.prepare).not.toHaveBeenCalled()
  publishDevelopmentTurnSettlement({ ...f.scope, turnId: "turn", outcome: "completed" })
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
})

it.each(["drain-failed", "MODS_DEVELOPMENT_BUSY"])("marks post-retirement %s unknown and does not automatically replay", async (failure) => {
  const f = fixture({
    retire: vi.fn(async (_scope, beforeEffects) => {
      beforeEffects()
      throw Error(failure)
    })
  })
  f.stage()
  f.approve()
  f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("unknown"))
  f.registry.idle(f.scope.threadId)
  expect(f.driver.retire).toHaveBeenCalledOnce()
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(() => f.approve()).toThrow("RETIRE_UNCONFIRMED")
  expect(() => f.stage({ ...f.input, revision: 2 })).toThrow("RETIRE_UNCONFIRMED")
  await f.registry.stop(f.scope, f.input.componentId, () => {})
  expect(f.registry.status(f.scope)?.phase).toBe("unknown")
})

it("preserves the old activation when retirement cannot pause before any effects", async () => {
  let busy = false
  const f = fixture({ retire: async (_scope, beforeEffects) => {
    if (busy) throw Error("MODS_DEVELOPMENT_BUSY")
    beforeEffects()
  } })
  f.stage(); f.approve(); f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  busy = true
  f.stage({ ...f.input, revision: 2 })
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.error).toBe("MODS_DEVELOPMENT_BUSY"))
  expect(f.registry.status(f.scope)?.phase).toBe("queued")
  expect(f.registry.status(f.scope)?.activeRevision).toBe(1)
  expect(() => f.activation()!.assertCapability("ui.resolve")).not.toThrow()
  busy = false
  f.registry.idle(f.scope.threadId)
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.activeRevision).toBe(2))
})

it("stops an unapproved candidate without retiring the ordinary session", async () => {
  const f = fixture()
  f.stage()
  await f.registry.stop(f.scope, f.input.componentId, () => {})
  expect(f.driver.retire).not.toHaveBeenCalled()
  expect(f.registry.status(f.scope)?.phase).toBe("stopped")
})

it("waits for logical turn completion after physical lease release", async () => {
  let busy = true
  const f = fixture({ isBusy: () => busy })
  f.stage()
  f.approve()
  f.settled()
  expect(f.driver.prepare).not.toHaveBeenCalled()
  busy = false
  f.registry.idle(f.scope.threadId)
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
})

it("revokes an in-flight candidate before it can activate", async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const activate = vi.fn()
  const dispose = vi.fn(async () => {})
  const f = fixture({
    prepare: async () => {
      await pending
      return { dispose }
    },
    activate
  })
  f.stage()
  f.approve()
  f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("preflight"))
  const stopped = f.registry.stop(f.scope, f.input.componentId, () => {})
  finish()
  await stopped
  expect(activate).not.toHaveBeenCalled()
  expect(dispose).toHaveBeenCalledOnce()
  expect(f.registry.status(f.scope)?.phase).toBe("stopped")
})

it("requires new consent for capability additions without revoking the old active revision", async () => {
  const f = fixture()
  f.stage()
  f.approve()
  f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  const status = f.stage({ ...f.input, revision: 2, capabilities: ["ui.resolve", "store.set"] })
  expect(status.phase).toBe("needs-approval")
  expect(f.registry.activeFor(f.scope.workspace, f.scope.threadId)?.revision.revision).toBe(1)
  expect(() => f.activation()!.assertCapability("store.set")).toThrow("DENIED")
})

it("retains an idle wake during candidate cleanup until the real lease is released", async () => {
  const cleanup = Promise.withResolvers<void>()
  let first = true
  const f = fixture({
    prepare: vi.fn(async () => ({ dispose: async () => { await cleanup.promise } })),
    retire: vi.fn(async (_scope, beforeEffects) => {
      if (first) {
        first = false
        throw Error("MODS_DEVELOPMENT_BUSY")
      }
      beforeEffects()
    })
  })
  f.stage(); f.approve(); f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("queued"))
  f.registry.idle(f.scope.threadId)
  expect(f.driver.prepare).toHaveBeenCalledOnce()
  cleanup.resolve()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  expect(f.driver.prepare).toHaveBeenCalledTimes(2)
})

it("reclaims only settled stopped entries and requires fresh approval for a replacement component", async () => {
  const f = fixture()
  f.stage(); f.approve(); f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  expect(f.registry.retention(f.scope)).toMatchObject({ releasable: false, reason: "active" })
  await f.registry.stop(f.scope, f.input.componentId, () => {})
  expect(f.registry.retention(f.scope)).toEqual({ releasable: true, revisions: [] })
  const second = f.registry.stage(f.scope, { ...f.input, componentId: "replacement" }, () => {})
  expect(second.phase).toBe("needs-approval")
  expect(second.activeRevision).toBeUndefined()
  expect(f.driver.prepare).toHaveBeenCalledOnce()
})

it("stopped observations during candidate drain are not cache release proofs", async () => {
  const prepared = Promise.withResolvers<void>()
  const f = fixture({ prepare: async () => {
    await prepared.promise
    return { dispose: async () => {} }
  } })
  f.stage(); f.approve(); f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("preflight"))
  const stopped = f.registry.stop(f.scope, f.input.componentId, () => {})
  expect(f.registry.retention(f.scope)).toEqual({ releasable: false, revisions: null, reason: "draining" })
  prepared.resolve()
  await stopped
  expect(f.registry.retention(f.scope)?.releasable).toBe(true)
})

it("reuses capacity across more than 32 explicitly stopped scopes", async () => {
  const f = fixture()
  for (let index = 0; index < 40; index++) {
    const scope = { ...f.scope, threadId: `stopped-${index}` }
    f.registry.stage(scope, f.input, () => {})
    await f.registry.stop(scope, f.input.componentId, () => {})
  }
  expect(() => f.stage()).not.toThrow()
})

it("external close fences the exact activation and never frees failed or pending drain", async () => {
  const f = fixture()
  f.stage(); f.approve(); f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  const drain = Promise.withResolvers<void>()
  f.registry.retireExternal(f.activation()!, () => drain.promise)
  expect(f.registry.retention(f.scope)?.reason).toBe("draining")
  expect(() => f.stage({ ...f.input, revision: 2 })).toThrow("APPLYING")
  drain.reject(Error("lost physical owner"))
  await vi.waitFor(() => expect(f.registry.retention(f.scope)?.reason).toBe("unknown"))
  expect(f.registry.retention(f.scope)?.revisions).toBeNull()
})

it("successful external drain cannot clear a prior unknown stop outcome", async () => {
  let fail = false
  const f = fixture({ retire: async (_scope, beforeEffects) => {
    beforeEffects()
    if (fail) throw Error("uncertain cleanup")
  } })
  f.stage(); f.approve(); f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  fail = true
  await f.registry.stop(f.scope, f.input.componentId, () => {})
  expect(f.registry.status(f.scope)?.phase).toBe("unknown")
  const drained = vi.fn(async () => {})
  f.registry.retireExternal(f.activation()!, drained)
  await vi.waitFor(() => expect(f.registry.retention(f.scope)?.reason).toBe("unknown"))
  expect(drained).toHaveBeenCalledOnce()
  expect(f.registry.retention(f.scope)?.releasable).toBe(false)
})


it("explicit busy stop shares its drain, fences admission and publishes stopped only after cleanup", async () => {
  const drain = Promise.withResolvers<void>()
  let stopping = false
  const retire = vi.fn<DevelopmentDriver["retire"]>(async (_scope, _before, waitForIdle) => {
    if (!waitForIdle) return
    stopping = true
    await drain.promise
  })
  const f = fixture({ retire })
  f.stage(); f.approve(); f.settled()
  await vi.waitFor(() => expect(f.registry.status(f.scope)?.phase).toBe("active"))
  const stop = f.registry.stop(f.scope, f.input.componentId, () => {})
  const duplicate = f.registry.stop(f.scope, f.input.componentId, () => {})
  expect(f.registry.status(f.scope)?.phase).toBe("retiring")
  expect(() => f.registry.assertAdmission(f.scope.workspace, f.scope.threadId)).toThrow("APPLYING")
  expect(() => f.stage({ ...f.input, revision: 2 })).toThrow("APPLYING")
  expect(() => f.approve()).toThrow("APPROVAL_CHANGED")
  expect(() => f.activation()!.assertCurrent()).toThrow("REVOKED")
  await vi.waitFor(() => expect(stopping).toBe(true))
  expect(f.registry.status(f.scope)?.phase).toBe("retiring")
  drain.resolve()
  await Promise.all([stop, duplicate])
  expect(retire).toHaveBeenCalledTimes(2)
  expect(f.registry.status(f.scope)?.phase).toBe("stopped")
  expect(f.registry.retention(f.scope)?.releasable).toBe(true)
  expect(f.stage({ ...f.input, revision: 2 }).phase).toBe("needs-approval")
})
