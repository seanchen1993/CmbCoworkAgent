import { describe, expect, it, vi } from "vitest"
import { parseClawProfile } from "../../../shared/mods/claw"
import type {
  DevelopmentReuseStatus,
  DevelopmentTrialStatus
} from "../../../shared/mods/development"
import { CreatorCompositionHistory } from "./creator-composition-history"
import {
  CreatorCompositionSave,
  type CompositionReuseFacts,
  type CompositionSavePorts
} from "./creator-composition-save"

function fixture(count = 1) {
  const settings = new Map<string, string>()
  const history = new CreatorCompositionHistory({
    getSetting: (key, fallback = "") => settings.get(key) ?? fallback,
    compareAndSetSetting: (key, expected, value) => {
      if (settings.get(key) !== expected) return false
      settings.set(key, value)
      return true
    }
  })
  const scope = {
    workspace: "workspace",
    threadId: "chat",
    incarnation: { token: "first", legacyCreatedAt: 1 }
  }
  let current = parseClawProfile({
    id: "original",
    name: "Original",
    capabilities: [],
    models: { default: "model", roles: {} },
    builtins: { contextMeter: true }
  })
  let trials: DevelopmentTrialStatus[] = Array.from({ length: count }, (_, index) => ({
    componentId: `component-${index}`,
    draftId: `draft-${index}`,
    revision: 1,
    bundleDigest: "a".repeat(64),
    compiledDigest: "b".repeat(64),
    phase: "active",
    capabilities: []
  }))
  let facts: CompositionReuseFacts | undefined
  const prepareReuse = vi.fn<CompositionSavePorts["prepareReuse"]>(async (_thread, dependency) => {
    const status: DevelopmentReuseStatus = {
      phase: "needs-approval",
      planId: `plan-${dependency.draftId}`,
      name: dependency.draftId,
      draftId: dependency.draftId,
      revision: dependency.revision,
      sourceDigest: dependency.bundleDigest,
      compiledDigest: "c".repeat(64),
      capabilities: []
    }
    const profile = parseClawProfile({
      ...current,
      id: `reuse-${dependency.draftId}`,
      capabilities: [
        ...current.capabilities,
        {
          pluginId: `installed-${dependency.draftId}`,
          name: dependency.draftId,
          digest: "c".repeat(64)
        }
      ]
    })
    facts = { status, before: structuredClone(current), profile }
    return status
  })
  const ports: CompositionSavePorts = {
    trials: () => trials,
    prepareReuse,
    reuseFacts: () => facts
  }
  let coordinator = new CreatorCompositionSave(history, ports)
  const start = (name = "Daily") =>
    coordinator.start({
      scope,
      identity: "identity",
      name,
      revision: 0,
      profile: current,
      turnId: "turn",
      signal: new AbortController().signal,
      assertTurn: () => {}
    })
  const reconcile = () =>
    coordinator.reconcile({
      scope,
      identity: "identity",
      current: () => current,
      assertCurrent: () => {},
      validate: async () => {}
    })
  const activate = () => {
    current = facts!.profile
    facts!.status = {
      ...facts!.status,
      phase: "active",
      installationId: `installed-${facts!.status.draftId}`
    }
    trials = trials.filter((item) => item.draftId !== facts!.status.draftId)
  }
  return {
    history,
    settings,
    start,
    reconcile,
    activate,
    prepareReuse,
    scope,
    coordinator: () => coordinator,
    restart: () => {
      coordinator.close()
      coordinator = new CreatorCompositionSave(history, ports)
    },
    setCurrent: (value: typeof current) => {
      current = value
    },
    current: () => current,
    setTrials: (value: DevelopmentTrialStatus[]) => {
      trials = value
    },
    trials: () => trials,
    facts: () => facts!,
    status: () => coordinator.status(scope)
  }
}

describe("saving combinations containing local trials", () => {
  it("does not save an empty combination; saves exact original transaction facts after native confirmation", async () => {
    const f = fixture()
    expect(await f.start()).toMatchObject({ saved: false, phase: "needs-approval", name: "Daily" })
    expect(f.history.list("workspace")).toEqual([])
    await f.reconcile()
    expect(f.history.list("workspace")).toEqual([])
    f.activate()
    await f.reconcile()
    expect(f.status()).toMatchObject({ saved: true, phase: "saved", revision: 1 })
    expect(f.history.load("workspace", "Daily", 1)).toEqual(f.current())
    expect(f.current().models).toEqual({ default: "model", roles: {} })
    expect(f.prepareReuse).toHaveBeenCalledTimes(1)
    await f.reconcile()
    expect(f.prepareReuse).toHaveBeenCalledTimes(1)
  })
  it("prepares dependencies serially through the same native review and saves only when all are active", async () => {
    const f = fixture(2)
    await f.start()
    expect(f.prepareReuse).toHaveBeenCalledTimes(1)
    f.activate()
    await Promise.all([f.reconcile(), f.reconcile()])
    expect(f.prepareReuse).toHaveBeenCalledTimes(2)
    expect(f.history.list("workspace")).toEqual([])
    f.activate()
    await f.reconcile()
    expect(f.history.load("workspace", "Daily", 1).capabilities).toHaveLength(2)
  })
  it("binds the formal candidate separately and rejects a changed native compiled identity", async () => {
    const f = fixture()
    await f.start()
    expect(f.history.saveIntent(f.scope)).toMatchObject({
      nativeReuseCompiledDigest: "c".repeat(64),
      dependencies: [{ activeTrialCompiledDigest: "b".repeat(64) }]
    })
    f.facts().status.compiledDigest = "d".repeat(64)
    f.facts().profile.capabilities[0].digest = "d".repeat(64)
    f.activate()
    await f.reconcile()
    expect(f.status()).toMatchObject({
      saved: false,
      phase: "failed",
      error: "COMPOSITION_SAVE_TARGET_CHANGED"
    })
    expect(f.history.list("workspace")).toEqual([])
  })
  it("rejects a replaced active trial while native preparation is in flight", async () => {
    const f = fixture(),
      original = f.prepareReuse.getMockImplementation()!
    f.prepareReuse.mockImplementationOnce(async (...args) => {
      const status = await original(...args)
      f.setTrials(f.trials().map((trial) => ({ ...trial, compiledDigest: "d".repeat(64) })))
      return status
    })
    expect(await f.start()).toMatchObject({
      saved: false,
      phase: "failed",
      error: "COMPOSITION_SAVE_SOURCE_CHANGED"
    })
    expect(f.history.list("workspace")).toEqual([])
  })
  it("preserves native preparation failure rather than exposing an approvable pending save", async () => {
    const f = fixture(),
      original = f.prepareReuse.getMockImplementation()!
    f.prepareReuse.mockImplementationOnce(async (...args) => ({
      ...(await original(...args)),
      phase: "failed",
      error: "AUTHORING_VERSION_CHECK_FAILED",
      compiledDigest: undefined
    }))
    expect(await f.start()).toMatchObject({
      saved: false,
      phase: "failed",
      error: "AUTHORING_VERSION_CHECK_FAILED"
    })
    expect(f.history.list("workspace")).toEqual([])
  })
  it("normalizes old trial-only digest records without inventing a formal digest or resuming after restart", async () => {
    const f = fixture()
    await f.start()
    const [key, raw] = [...f.settings.entries()][0]
    const state = JSON.parse(raw)
    delete state.saveIntents[0].nativeReuseCompiledDigest
    for (const dependency of state.saveIntents[0].dependencies) {
      dependency.compiledDigest = dependency.activeTrialCompiledDigest
      delete dependency.activeTrialCompiledDigest
    }
    f.settings.set(key, JSON.stringify(state))
    f.restart()
    expect(f.history.saveIntent(f.scope)).toMatchObject({
      dependencies: [{ activeTrialCompiledDigest: "b".repeat(64) }]
    })
    expect(f.history.saveIntent(f.scope)?.nativeReuseCompiledDigest).toBeUndefined()
    f.activate()
    await f.reconcile()
    expect(f.status()).toMatchObject({ saved: false, phase: "needs-review" })
    expect(f.history.list("workspace")).toEqual([])
    expect(f.prepareReuse).toHaveBeenCalledTimes(1)
  })
  it("keeps an unknown installation visible without repeating prepare or saving", async () => {
    const f = fixture()
    await f.start()
    f.facts().status.phase = "unknown"
    f.facts().status.error = "INSTALL_OUTCOME_UNCONFIRMED"
    await f.reconcile()
    await f.reconcile()
    expect(f.status()).toMatchObject({ phase: "unknown", saved: false })
    expect(f.prepareReuse).toHaveBeenCalledTimes(1)
    expect(f.history.list("workspace")).toEqual([])
    f.setTrials([])
    await expect(f.start()).rejects.toThrow("COMPOSITION_SAVE_NEEDS_REVIEW")
    expect(f.coordinator().cancel(f.scope)).toBe(true)
    expect(f.prepareReuse).toHaveBeenCalledTimes(1)
  })
  it("does not restore consent or resume a pending save after restart", async () => {
    const f = fixture()
    await f.start()
    f.restart()
    f.activate()
    await f.reconcile()
    expect(f.status()).toMatchObject({ phase: "needs-review", saved: false })
    expect(f.prepareReuse).toHaveBeenCalledTimes(1)
    expect(f.history.list("workspace")).toEqual([])
  })
  it("does not silently save a reduced selection when restart lost an in-flight trial", async () => {
    const f = fixture()
    await f.start()
    f.restart()
    f.setTrials([])
    await expect(f.start()).rejects.toThrow("COMPOSITION_SAVE_NEEDS_REVIEW")
    expect(f.history.list("workspace")).toEqual([])
  })
  it("does not save a cancelled intent after an already confirmed installation finishes", async () => {
    const f = fixture()
    await f.start()
    expect(f.coordinator().cancel(f.scope)).toBe(true)
    f.activate()
    await f.reconcile()
    expect(f.status()).toMatchObject({ phase: "cancelled", saved: false })
    expect(f.history.list("workspace")).toEqual([])
  })
  it("rejects manual selection changes rather than saving the old intent over new choices", async () => {
    const f = fixture()
    await f.start()
    f.activate()
    f.setCurrent({ ...f.current(), models: { default: "another-model", roles: {} } })
    await f.reconcile()
    expect(f.status()).toMatchObject({ phase: "failed", error: "COMPOSITION_SAVE_TARGET_CHANGED" })
    expect(f.history.list("workspace")).toEqual([])
  })
  it("rejects newly added or updated trials while native reuse is being confirmed", async () => {
    const f = fixture(2)
    await f.start()
    f.activate()
    f.setTrials(f.trials().map((item) => ({ ...item, revision: 2 })))
    await f.reconcile()
    expect(f.status()).toMatchObject({ phase: "failed", error: "COMPOSITION_SAVE_SOURCE_CHANGED" })
    expect(f.prepareReuse).toHaveBeenCalledTimes(1)
    expect(f.history.list("workspace")).toEqual([])
  })
  it("rejects unstable trial replacement and invalid expected saved revisions before preparing", async () => {
    const f = fixture()
    f.setTrials(f.trials().map((item) => ({ ...item, phase: "queued" })))
    await expect(f.start()).rejects.toThrow("COMPOSITION_TRIAL_NOT_STABLE")
    expect(f.prepareReuse).not.toHaveBeenCalled()
    f.setTrials(f.trials().map((item) => ({ ...item, phase: "active" })))
    f.history.save("workspace", "Daily", 0, f.current())
    await expect(f.start()).rejects.toThrow("COMPOSITION_SAVED_CHANGED")
    expect(f.prepareReuse).not.toHaveBeenCalled()
  })
  it("does not overwrite a same-name template changed while waiting for approval", async () => {
    const f = fixture()
    await f.start()
    f.history.save("workspace", "Daily", 0, f.current())
    f.activate()
    await f.reconcile()
    expect(f.status()).toMatchObject({ phase: "failed", error: "COMPOSITION_SAVED_CHANGED" })
    expect(f.history.load("workspace", "Daily", 1).capabilities).toEqual([])
  })
})
