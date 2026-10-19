import { afterEach, describe, expect, it, vi } from "vitest"
import { resolve } from "node:path"
import { AuthoringDraftStore } from "./authoring-store"
import { createAuthoringTemplate } from "./authoring-templates"
import {
  ModDevelopmentService,
  developmentTrialEnvelope,
  type DevelopmentRuntime
} from "./development-service"
import { AuthoringCompileError } from "./authoring-compile-diagnostics"
import { DevelopmentCandidateError } from "./development-candidate-diagnostics"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  AuthoringVersionRepository,
  type PreparedAuthoringVersion
} from "./authoring-version-repository"
import type {
  DevelopmentReuseStatus,
  DevelopmentTrialStatus
} from "../../../shared/mods/development"
import type { AuthoringAtomicSettings } from "./authoring-config-snapshot"
import type { CreatorReuseService } from "./creator-reuse"
import { CreatorPlanningService } from "./creator-planning"

afterEach(() => vi.restoreAllMocks())

it("normalizes the real Windows runtime path before reading an optional planner, including no selection", async () => {
  const raw = "C:\\owned\\creator-workspace"
  const f = fixture((value) => (value === raw ? "workspace" : value))
  const invoke = vi.fn()
  const planner = new CreatorPlanningService({
    settings: f.storage,
    current: (threadId, workspace) => {
      const context = f.service.reuseContext(threadId)
      if (workspace !== context.scope.workspace) throw Error("DEVELOPMENT_SCOPE_CHANGED")
      return context
    },
    catalog: async () => [],
    invoke,
    changed: () => {}
  })
  f.service.configurePlanning(planner)
  const prompt = vi.spyOn(planner, "prompt")
  await f.service.setMode("one", "workspace", "creator")
  const signal = new AbortController().signal
  await expect(f.service.planningPrompt("one", raw, signal)).resolves.toBeNull()
  expect(prompt).toHaveBeenCalledWith("one", "workspace", signal)
  expect(invoke).not.toHaveBeenCalled()
  prompt.mockClear()
  await expect(f.service.planningPrompt("one", "C:\\different", signal)).resolves.toBeNull()
  expect(prompt).not.toHaveBeenCalled()
})

it("still stops on a genuine scope change rather than swallowing it as optional planner fallback", async () => {
  const f = fixture((value) => (value === "raw-workspace" ? "workspace" : value))
  await f.service.setMode("one", "workspace", "creator")
  const captured = f.service.reuseContext("one")
  const planner = new CreatorPlanningService({
    settings: f.storage,
    current: () => {
      f.changeIdentity()
      captured.assertCurrent()
      return captured
    },
    catalog: async () => [],
    invoke: vi.fn(),
    changed: () => {}
  })
  f.service.configurePlanning(planner)
  await expect(
    f.service.planningPrompt("one", "raw-workspace", new AbortController().signal)
  ).rejects.toThrow("DEVELOPMENT_SCOPE_CHANGED")
})

function fixture(normalizeWorkspace?: (workspace: string) => string) {
  const settings = new Map<string, string>()
  const storage: AuthoringAtomicSettings = {
    getSetting: (key, fallback) => settings.get(key) ?? fallback ?? "",
    compareAndSetSetting: (key, expected, value) => {
      if (settings.get(key) !== expected) return false
      settings.set(key, value)
      return true
    }
  }
  const drafts = new AuthoringDraftStore(storage)
  let token = "first"
  let canRun = true
  let requestGroup: string | undefined
  const runtime: DevelopmentRuntime = {
    preflightDevelopment: vi.fn(async () => {}),
    developmentRetention: vi.fn(() => ({ releasable: true, revisions: [] })),
    stageDevelopment: vi.fn(),
    developmentStatus: vi.fn(() => []),
    approveDevelopment: vi.fn(),
    stopDevelopment: vi.fn()
  }
  const analyze = vi.fn(async (source) => ({
    digest: source.digest,
    valid: true,
    runtimeVerified: false,
    diagnostics: [],
    capabilities: []
  }))
  const deps: ConstructorParameters<typeof ModDevelopmentService>[0] = {
    drafts,
    runtime,
    versionsRoot: resolve("output/test-development-versions"),
    workerEntry: resolve("output/test-development-worker.js"),
    historySettings: storage,
    changed: vi.fn(),
    analyze,
    canRun: () => canRun,
    requestGroup: () => requestGroup,
    normalizeWorkspace,
    context: (threadId) => {
      const captured = token
      return {
        scope: {
          workspace: "workspace",
          threadId,
          incarnation: { token: captured, legacyCreatedAt: 1 }
        },
        assertCurrent: () => {
          if (token !== captured) throw Error("DEVELOPMENT_SCOPE_CHANGED")
        }
      }
    }
  }
  const service = new ModDevelopmentService(deps)
  const source = createAuthoringTemplate({
    id: "demo",
    name: "Demo",
    instruction: "Demo",
    kind: "command"
  })
  const save = (revision = 0) =>
    service.save("one", {
      id: "demo",
      name: "Demo",
      expectedRevision: revision,
      files: source.files
    })
  return {
    service,
    storage,
    runtime,
    drafts,
    save,
    analyze,
    recreate: () => new ModDevelopmentService(deps),
    setRequestGroup: (value: string | undefined) => {
      requestGroup = value
    },
    changeIdentity: () => {
      token = "second"
    },
    disableMods: () => {
      canRun = false
    }
  }
}

function mockPreparedVersions() {
  const records = new WeakMap<object, PreparedAuthoringVersion>()
  vi.spyOn(AuthoringVersionRepository.prototype, "prepare").mockImplementation(async (input) => {
    input.assertCurrent()
    const token = { kind: "authoring-preparation" as const }
    const record: PreparedAuthoringVersion = {
      schemaVersion: 1,
      coverage: "prepared-source-only-v1",
      versionId: String(input.revision),
      installationId: input.installationId,
      workspace: input.workspace,
      draftId: input.draftId,
      revision: input.revision,
      source: input.source,
      sourceDigest: input.source.digest,
      compiledDigest: String(input.revision).repeat(64),
      createdAt: 1
    }
    records.set(token, record)
    return {
      record,
      token,
      review: {
        strictCompatible: true,
        typesValid: true,
        modelProtocol: "result-v1",
        sdkMethods: input.revision === 3 ? ["fs.write"] : ["ui.resolve"],
        registrationEvents: ["ui.render"],
        registrationEventsVerified: true
      }
    }
  })
  vi.spyOn(AuthoringVersionRepository.prototype, "assertPrepared").mockImplementation(
    (token) => records.get(token)!
  )
  vi.spyOn(AuthoringVersionRepository.prototype, "preparedSourceDirectory").mockReturnValue(
    resolve("output/test-development-source")
  )
}

describe("conversational authoring scope", () => {
  it("uses only the host's original goal identity for cumulative multi-turn repair accounting", async () => {
    const f = fixture()
    await f.service.setMode("one", "workspace", "creator")
    f.setRequestGroup("goal:original")
    for (let n = 0; n < 3; n++) f.service.claimAuthoringBudget("one", `native-${n}`, "candidate")
    expect(() => f.service.claimAuthoringBudget("one", "automatic-next-turn", "candidate"))
      .toThrow("DEVELOPMENT_REPAIR_BUDGET")
    const resumed = f.recreate()
    await resumed.setMode("one", "workspace", "creator")
    expect(() => resumed.claimAuthoringBudget("one", "automatic-another-turn", "candidate"))
      .toThrow("DEVELOPMENT_REPAIR_BUDGET")
    expect(resumed.status("one").request).toMatchObject({ groupId: "goal:original", candidates: 3 })
    expect(resumed.status("one").request).not.toHaveProperty("nativeRuns")
  })
  it("recovers request accounting beside original draft references without restoring execution authority", async () => {
    const f = fixture()
    await f.service.setMode("one", "workspace", "creator")
    f.service.claimAuthoringBudget("one", "original-chat-run", "candidate")
    const draft = f.save()
    const recreated = f.recreate()
    expect(recreated.status("one")).toMatchObject({
      request: { runId: "original-chat-run", candidates: 1 },
      drafts: [{ id: draft.id, revision: draft.revision, digest: draft.source.digest }],
      trials: []
    })
    expect(f.runtime.stageDevelopment).not.toHaveBeenCalled()
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
    f.changeIdentity()
    expect(recreated.status("one").request).toBeUndefined()
  })
  it("keeps ordinary reuse status reads lightweight and probes only unconfirmed recovery", async () => {
    const f = fixture()
    let phase: DevelopmentReuseStatus["phase"] = "active"
    const reconcile = vi.fn(async () => undefined)
    f.service.configureReuse({
      status: () => ({
        phase,
        name: "Demo",
        draftId: "demo",
        revision: 1,
        sourceDigest: "a".repeat(64),
        capabilities: []
      }),
      reconcile
    } as unknown as CreatorReuseService)
    await f.service.refreshReuse("one")
    await f.service.refreshReuse("one")
    expect(reconcile).not.toHaveBeenCalled()
    phase = "unknown"
    await f.service.refreshReuse("one")
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
  it("restores the immediately preceding active source as a new checked revision after service recreation", async () => {
    mockPreparedVersions()
    const f = fixture()
    await f.service.setMode("one", "workspace", "creator")
    const first = f.save()
    let trials: DevelopmentTrialStatus[] = []
    vi.mocked(f.runtime.developmentStatus).mockImplementation(() => trials)
    vi.mocked(f.runtime.stageDevelopment).mockImplementation((_scope, candidate) => {
      trials = [
        { ...candidate, capabilities: [...candidate.capabilities], phase: "needs-approval" }
      ]
    })
    const signal = new AbortController().signal
    await f.service.requestTrial("one", "demo", 1, "first", signal, () => {})
    trials = [{ ...trials[0], phase: "active", activeRevision: 1, activeDigest: "1".repeat(64) }]
    const second = createAuthoringTemplate({
      id: "demo",
      name: "Demo",
      instruction: "Second version",
      kind: "command"
    })
    f.service.save("one", { id: "demo", name: "Demo", expectedRevision: 1, files: second.files })
    await f.service.requestTrial("one", "demo", 2, "second", signal, () => {})
    trials = [{ ...trials[0], phase: "active", activeRevision: 2, activeDigest: "2".repeat(64) }]
    const recreated = f.recreate()
    await recreated.setMode("one", "workspace", "creator")
    expect(recreated.status("one").trials[0].canUndo).toBe(true)
    await recreated.undoTrial("one", "undo", signal, () => {})
    expect(recreated.read("one", "demo")).toMatchObject({
      revision: 3,
      source: { digest: first.source.digest }
    })
    expect(f.runtime.stageDevelopment).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        revision: 3,
        compiledDigest: "3".repeat(64),
        validation: "authorized-real",
        capabilities: ["fs.write", "event:ui.render"]
      }),
      expect.any(Function)
    )
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
  })
  it("queues first-generation undo through the native idle scheduler instead of stopping inside its tool stack", async () => {
    mockPreparedVersions()
    const f = fixture()
    await f.service.setMode("one", "workspace", "creator")
    f.save()
    await f.service.requestTrial("one", "demo", 1, "first", new AbortController().signal, () => {})
    vi.mocked(f.runtime.developmentStatus).mockReturnValue([
      {
        componentId: "demo",
        draftId: "demo",
        revision: 1,
        bundleDigest: "a".repeat(64),
        compiledDigest: "1".repeat(64),
        capabilities: [],
        phase: "active",
        activeRevision: 1,
        activeDigest: "1".repeat(64)
      }
    ])
    const queueStop = vi.fn(async () => ({ phase: "queued" }))
    f.service.configureTrialUndoStop(queueStop)
    await expect(f.service.undoTrial("one", "undo")).resolves.toMatchObject({
      action: "stop-queued"
    })
    expect(queueStop).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "one" }),
      "demo",
      "undo",
      expect.any(Function)
    )
    expect(f.runtime.stopDevelopment).not.toHaveBeenCalled()
    f.service.configureTrialUndoStatus(() => ({ phase: "queued" }))
    expect(f.service.status("one").trials[0].canUndo).toBe(false)
  })
  it("submits a complete source through one preparation without a duplicate check", async () => {
    const f = fixture()
    await f.service.setMode("one", "workspace", "creator")
    const source = createAuthoringTemplate({
      id: "demo",
      name: "Demo",
      instruction: "Demo",
      kind: "command"
    })
    const prepare = vi.spyOn(f.service, "requestTrial").mockResolvedValue(f.service.status("one"))
    const result = await f.service.submit(
      "one",
      { id: "demo", name: "Demo", expectedRevision: 0, files: source.files },
      "turn",
      new AbortController().signal,
      () => {}
    )
    expect(result).toMatchObject({
      document: { revision: 1 },
      check: { valid: true, runtimeVerified: false }
    })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(f.analyze).not.toHaveBeenCalled()
  })
  it("returns actionable preparation diagnostics with the saved draft and no trial success claim", async () => {
    const f = fixture()
    await f.service.setMode("one", "workspace", "creator")
    const source = createAuthoringTemplate({
      id: "demo",
      name: "Demo",
      instruction: "Demo",
      kind: "command"
    })
    vi.spyOn(f.service, "requestTrial").mockRejectedValue(
      new AuthoringCompileError([
        { code: "compile", message: "Unexpected token", file: "mods/main.ts", line: 2 }
      ])
    )
    const result = await f.service.submit(
      "one",
      { id: "demo", name: "Demo", expectedRevision: 0, files: source.files },
      "turn",
      new AbortController().signal,
      () => {}
    )
    expect(result).toMatchObject({
      document: { revision: 1 },
      check: {
        valid: false,
        runtimeVerified: false,
        diagnostics: [{ message: "Unexpected token" }]
      }
    })
    expect(f.analyze).not.toHaveBeenCalled()
    expect(f.runtime.stageDevelopment).not.toHaveBeenCalled()
  })
  it("returns candidate failure before staging and accepts a corrected source in the same turn", async () => {
    mockPreparedVersions()
    const f = fixture()
    await f.service.setMode("one", "workspace", "creator")
    const source = createAuthoringTemplate({
      id: "demo",
      name: "Demo",
      instruction: "Weather",
      kind: "command"
    })
    vi.mocked(f.runtime.preflightDevelopment!).mockRejectedValueOnce(
      new ModFunctionError("MODS_RETURN_UNDEFINED")
    )
    const submit = (revision: number) =>
      f.service.submit(
        "one",
        {
          id: "demo",
          name: "Demo",
          expectedRevision: revision,
          files: source.files
        },
        "turn",
        new AbortController().signal,
        () => {}
      )
    await expect(submit(0)).rejects.toMatchObject({
      name: "DevelopmentCandidateError",
      message: "MODS_RETURN_UNDEFINED",
      target: { id: "demo", revision: 1 },
      diagnostics: [{ code: "MODS_RETURN_UNDEFINED", event: "session.start" }]
    })
    expect(f.service.read("one", "demo").revision).toBe(1)
    expect(f.runtime.stageDevelopment).not.toHaveBeenCalled()
    await expect(submit(1)).resolves.toMatchObject({ document: { revision: 2 } })
    expect(f.runtime.preflightDevelopment).toHaveBeenCalledTimes(2)
    expect(f.runtime.stageDevelopment).toHaveBeenCalledTimes(1)
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
  })
  it("does not turn a cancelled or replaced preflight scope into a repairable code failure", async () => {
    mockPreparedVersions()
    const f = fixture()
    await f.service.setMode("one", "workspace", "creator")
    f.save()
    vi.mocked(f.runtime.preflightDevelopment!).mockImplementationOnce(async () => {
      f.changeIdentity()
      throw new ModFunctionError("MODS_RETURN_UNDEFINED")
    })
    await expect(
      f.service.requestTrial("one", "demo", 1, "turn", new AbortController().signal, () => {})
    ).rejects.not.toBeInstanceOf(DevelopmentCandidateError)
    expect(f.runtime.stageDevelopment).not.toHaveBeenCalled()
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
  })
  it("resumes the exact persisted draft through fresh preparation, without approving it", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    f.save()
    const prepare = vi.spyOn(f.service, "requestTrial").mockResolvedValue(f.service.status("one"))
    const signal = new AbortController().signal,
      guard = vi.fn()
    await f.service.resumeTrial("one", "demo", 1, "fresh-turn", signal, guard)
    expect(prepare).toHaveBeenCalledExactlyOnceWith("one", "demo", 1, "fresh-turn", signal, guard)
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
  })
  it("switches ordinary authoring off without retiring approved live Mods or reviving old tools", async () => {
    const f = fixture()
    await f.service.setMode("one", "workspace", "creator")
    const assertCreator = f.service.captureCreatorMode("one", "workspace")
    expect(f.service.status("one")).toMatchObject({ mode: "creator", enabled: true })
    const authority = f.service.projectAuthoringContext("one")
    await f.service.setMode("one", "workspace", "normal")
    expect(f.service.status("one")).toMatchObject({ mode: "normal", enabled: true })
    expect(f.service.isEnabled("one", "workspace")).toBe(true)
    expect(f.service.isCreatorMode("one", "workspace")).toBe(false)
    expect(f.runtime.stopDevelopment).not.toHaveBeenCalled()
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
    expect(() => authority.assertCurrent()).toThrow("DEVELOPMENT_SCOPE_CHANGED")
    await f.service.setMode("one", "workspace", "creator")
    expect(() => assertCreator()).toThrow("DEVELOPMENT_SCOPE_CHANGED")
    expect(() => f.service.captureCreatorMode("one", "workspace")()).not.toThrow()
    expect(f.runtime.stopDevelopment).not.toHaveBeenCalled()
  })
  it("requests exact real effects/events while retaining only the legacy local event envelope", () => {
    expect(
      developmentTrialEnvelope({
        sdkMethods: ["fs.read", "fs.write"],
        registrationEvents: ["command.run"],
        registrationEventsVerified: true
      })
    ).toEqual({
      validation: "authorized-real",
      capabilities: ["fs.read", "fs.write", "event:command.run"]
    })
    expect(
      developmentTrialEnvelope({
        sdkMethods: [],
        registrationEvents: ["prompt.compose"],
        registrationEventsVerified: true
      })
    ).toEqual({
      validation: "authorized-real",
      capabilities: ["event:prompt.compose"]
    })
    expect(
      developmentTrialEnvelope({
        sdkMethods: ["ui.resolve"],
        registrationEvents: ["ui.render"],
        registrationEventsVerified: true
      })
    ).toMatchObject({ validation: "session-local" })
    for (const registrationEventsVerified of [undefined, false])
      expect(() =>
        developmentTrialEnvelope({ sdkMethods: ["http.fetch"], registrationEventsVerified })
      ).toThrow("DEVELOPMENT_EVENT_AUTHORITY_UNVERIFIED")
  })
  it("requires exact reviewed source and current target before approving real effects", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    vi.mocked(f.runtime.developmentStatus).mockReturnValue([
      {
        componentId: "demo",
        draftId: "demo",
        revision: 1,
        compiledDigest: "a".repeat(64),
        bundleDigest: "b".repeat(64),
        capabilities: ["http.fetch"],
        phase: "needs-approval",
        validation: "authorized-real"
      }
    ])
    for (const source of [undefined, "c".repeat(64)])
      await expect(
        f.service.approve("one", "workspace", "demo", 1, "a".repeat(64), source)
      ).rejects.toThrow("DEVELOPMENT_APPROVAL_SOURCE_REQUIRED")
    await expect(
      f.service.approve("one", "other", "demo", 1, "a".repeat(64), "b".repeat(64))
    ).rejects.toThrow("DEVELOPMENT_SCOPE_CHANGED")
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
    await f.service.approve("one", "workspace", "demo", 1, "a".repeat(64), "b".repeat(64))
    expect(f.runtime.approveDevelopment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workspace: "workspace", threadId: "one" }),
      "demo",
      "a".repeat(64),
      ["http.fetch"],
      expect.any(Function)
    )
  })
  it("does not revive an old project-preview authority after creator mode is re-enabled", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    const authority = f.service.projectAuthoringContext("one")
    authority.assertCurrent()
    await f.service.setEnabled("one", "workspace", false)
    expect(() => authority.assertCurrent()).toThrow("DEVELOPMENT_SCOPE_CHANGED")
    await f.service.setEnabled("one", "workspace", true)
    expect(() => authority.assertCurrent()).toThrow("DEVELOPMENT_SCOPE_CHANGED")
    expect(() => f.service.projectAuthoringContext("one").assertCurrent()).not.toThrow()
  })
  it("reads before enabling and closing without granting or installing anything", async () => {
    const f = fixture()
    expect(f.service.status("one").enabled).toBe(false)
    expect(() => f.save()).toThrow("DEVELOPMENT_DISABLED")
    await f.service.setEnabled("one", "workspace", true)
    expect(f.save().revision).toBe(1)
    expect(f.runtime.stageDevelopment).not.toHaveBeenCalled()
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
    await f.service.setEnabled("one", "workspace", false)
    expect(f.service.status("one")).toMatchObject({ enabled: false, drafts: [{ revision: 1 }] })
  })
  it("isolates drafts from other threads and recreated thread identities", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    f.save()
    await f.service.setEnabled("two", "workspace", true)
    expect(f.service.status("two").drafts).toEqual([])
    expect(() => f.service.read("two", "demo")).toThrow("AUTHORING_VERSION_MISSING")
    f.changeIdentity()
    expect(f.service.status("one")).toMatchObject({ enabled: false, drafts: [] })
  })
  it("keeps shared draft storage unchanged until explicit promotion", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    f.save()
    expect(f.drafts.list("workspace")).toEqual([])
    const result = f.service.promote("one", "workspace", "demo", 1)
    expect(result.id).toMatch(/^creator-/)
    expect(f.drafts.list("workspace")).toHaveLength(1)
    expect(f.runtime.stageDevelopment).not.toHaveBeenCalled()
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
    expect(() => f.service.promote("one", "other", "demo", 1)).toThrow("DEVELOPMENT_SCOPE_CHANGED")
  })
  it("checks compare-and-swap revisions without altering saved content", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    const first = f.save()
    expect(() => f.save()).toThrow("AUTHORING_VERSION_CHANGED")
    await expect(f.service.check("one", "demo", 2, new AbortController().signal)).rejects.toThrow(
      "AUTHORING_VERSION_CHANGED"
    )
    expect(f.service.read("one", "demo").source).toEqual(first.source)
  })
  it("promotes full source identities without truncation collisions or overwriting edits", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    const ids = ["a".repeat(43) + "first", "a".repeat(43) + "other"]
    for (const id of ids) {
      const source = createAuthoringTemplate({ id, name: id, instruction: id, kind: "command" })
      f.service.save("one", { id, name: id, expectedRevision: 0, files: source.files })
    }
    const one = f.service.promote("one", "workspace", ids[0], 1)
    const two = f.service.promote("one", "workspace", ids[1], 1)
    expect(one.id).not.toBe(two.id)
    expect(f.service.promote("one", "workspace", ids[0], 1).revision).toBe(1)
    f.drafts.save({
      workspace: "workspace",
      id: one.id,
      name: "User edit",
      source: two.source,
      expectedRevision: 1,
      assertCurrent: () => {}
    })
    expect(() => f.service.promote("one", "workspace", ids[0], 1)).toThrow(
      "DEVELOPMENT_PROMOTION_CHANGED"
    )
    expect(f.drafts.list("workspace").find((item) => item.id === one.id)?.currentRevision).toBe(2)
  })
  it("does not activate a draft when asking for compiler diagnostics", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    f.save()
    expect(await f.service.check("one", "demo", 1, new AbortController().signal)).toMatchObject({
      valid: true,
      runtimeVerified: false
    })
    expect(f.runtime.stageDevelopment).not.toHaveBeenCalled()
  })
  it("refuses stale user approval and never expands permission from supplied ids", async () => {
    const f = fixture()
    await f.service.setEnabled("one", "workspace", true)
    await expect(
      f.service.approve("one", "workspace", "missing", 1, "a".repeat(64))
    ).rejects.toThrow("DEVELOPMENT_APPROVAL_STALE")
    expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
  })
  it("respects the existing Mods master switch", async () => {
    const f = fixture()
    f.disableMods()
    await expect(f.service.setEnabled("one", "workspace", true)).rejects.toThrow(
      "DEVELOPMENT_MODS_DISABLED"
    )
    expect(f.service.status("one").enabled).toBe(false)
  })
})

it("reclaims invalid enabled scopes only when the host proves no retained runtime", async () => {
  const f = fixture()
  for (let index = 0; index < 16; index++)
    await f.service.setEnabled(`old-${index}`, "workspace", true)
  await expect(f.service.setEnabled("overflow", "workspace", true)).rejects.toThrow("SESSION_LIMIT")
  f.changeIdentity()
  await expect(f.service.setEnabled("fresh", "workspace", true)).resolves.toMatchObject({
    enabled: true
  })
  expect(f.runtime.stopDevelopment).not.toHaveBeenCalled()
})

it.each(["active", "unknown", "draining"] as const)(
  "does not evict stale %s ownership to make room",
  async (reason) => {
    const f = fixture()
    vi.mocked(f.runtime.developmentRetention).mockReturnValue({
      releasable: false,
      revisions: null,
      reason
    })
    for (let index = 0; index < 16; index++)
      await f.service.setEnabled(`old-${index}`, "workspace", true)
    f.changeIdentity()
    await expect(f.service.setEnabled("fresh", "workspace", true)).rejects.toThrow("SESSION_LIMIT")
    expect(f.runtime.stopDevelopment).not.toHaveBeenCalled()
  }
)

it("releases only unreferenced prepared memory receipts, without deleting durable sources", async () => {
  const f = fixture()
  const scope = {
    workspace: "workspace",
    threadId: "one",
    incarnation: { token: "first", legacyCreatedAt: 1 }
  }
  // Cache bookkeeping has no filesystem operations; these opaque values must never be entered.
  const cache = (f.service as unknown as { prepared: Map<string, unknown> }).prepared
  const first = { scope, revision: 1 },
    second = { scope, revision: 2 },
    third = { scope, revision: 3 }
  cache.set("old", first)
  cache.set("active", second)
  cache.set("pending", third)
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({
    releasable: false,
    revisions: [2, 3],
    reason: "active"
  })
  await f.service.setEnabled("one", "workspace", true)
  expect([...cache.keys()]).toEqual(["active", "pending"])
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({
    releasable: false,
    revisions: null,
    reason: "unknown"
  })
  await f.service.setEnabled("one", "workspace", true)
  expect([...cache.keys()]).toEqual(["active", "pending"])
  expect(f.runtime.stopDevelopment).not.toHaveBeenCalled()
})

it("keeps development revision numbers monotonic beyond sixteen while retaining active source history", async () => {
  const f = fixture()
  await f.service.setEnabled("one", "workspace", true)
  f.save()
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({
    releasable: false,
    revisions: [1],
    reason: "active"
  })
  for (let revision = 1; revision < 24; revision++)
    expect(f.save(revision).revision).toBe(revision + 1)
  const draft = f.service.read("one", "demo")
  expect(draft.versions.map((row) => row.revision)).toEqual([1, 22, 23, 24])
  expect(f.runtime.stopDevelopment).not.toHaveBeenCalled()
})

it("unknown development ownership prevents compacting history to bypass capacity", async () => {
  const f = fixture()
  await f.service.setEnabled("one", "workspace", true)
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({
    releasable: false,
    revisions: null,
    reason: "unknown"
  })
  for (let revision = 0; revision < 16; revision++) f.save(revision)
  expect(() => f.save(16)).toThrow("LIMIT")
  expect(f.service.read("one", "demo").versions).toHaveLength(16)
})

it("a reentrant retention change aborts draft compaction before its CAS", async () => {
  const f = fixture()
  await f.service.setEnabled("one", "workspace", true)
  f.save()
  vi.mocked(f.runtime.developmentRetention)
    .mockReturnValueOnce({ releasable: true, revisions: [] })
    .mockReturnValue({ releasable: false, revisions: null, reason: "unknown" })
  expect(() => f.save(1)).toThrow("DEVELOPMENT_RETENTION_CHANGED")
  expect(f.service.read("one", "demo").revision).toBe(1)
})

it("prepared collection protects latest snapshots, runtime revisions and physical source references", async () => {
  const f = fixture()
  await f.service.setEnabled("one", "workspace", true)
  const scope = {
    workspace: "workspace",
    threadId: "one",
    incarnation: { token: "first", legacyCreatedAt: 1 }
  }
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({
    releasable: false,
    revisions: [1],
    reason: "active"
  })
  f.runtime.referencesSourceDirectory = (path) => path.includes("physical")
  const records = [
    { versionId: "active", revision: 1 },
    { versionId: "unused", revision: 2 },
    { versionId: "physical", revision: 3 },
    { versionId: "previous", revision: 4 },
    { versionId: "latest", revision: 5 }
  ].map((row) => ({ ...row, draftId: "demo", workspace: "workspace", createdAt: row.revision }))
  const collected: string[] = []
  const repository = {
    listRecords: () => records,
    collectUnreferenced: (
      _workspace: string,
      retained: (row: (typeof records)[number]) => boolean
    ) => {
      for (const row of records) if (!retained(row)) collected.push(row.versionId)
    }
  }
  const collect = (
    f.service as unknown as {
      collectPrepared(scope: unknown, repository: unknown, guard: () => void): void
    }
  ).collectPrepared.bind(f.service)
  collect(scope, repository, () => {})
  expect(collected).toEqual(["unused"])
  collected.length = 0
  vi.mocked(f.runtime.developmentRetention).mockReturnValue({
    releasable: false,
    revisions: null,
    reason: "draining"
  })
  collect(scope, repository, () => {})
  expect(collected).toEqual([])
})
