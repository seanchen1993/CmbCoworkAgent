import { afterEach, describe, expect, it, vi } from "vitest"
import { CreatorReuseService, type CreatorReuseApproval } from "./creator-reuse"
import { AuthoringDraftStore } from "./authoring-store"
import { ClawStore } from "../claw-store"
import { createAuthoringTemplate } from "./authoring-templates"
import { publishDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import type { AuthoringDocument } from "../../../shared/mods/authoring"
import type { AuthoringInstalledReceipt } from "../../../shared/mods/authoring-install"
import type { DevelopmentScope } from "../v2/development-session"
import type { ClawProfile } from "../../../shared/mods/claw"
import { CreatorCompositionSave } from "./creator-composition-save"
import { CreatorCompositionHistory } from "./creator-composition-history"
import type { DevelopmentTrialStatus } from "../../../shared/mods/development"

const services: CreatorReuseService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.close()
})

function fixture() {
  const values = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    setSetting: (key: string, value: string) => {
      values.set(key, value)
    },
    compareAndSetSetting: (key: string, expected: string | undefined, next: string) => {
      if (values.get(key) !== expected) return false
      values.set(key, next)
      return true
    }
  }
  const scope: DevelopmentScope = {
    workspace: "reuse-workspace",
    threadId: "reuse-thread",
    incarnation: { token: "original", legacyCreatedAt: 1 }
  }
  const source = createAuthoringTemplate({
    id: "demo",
    name: "Demo",
    instruction: "Demo",
    kind: "command"
  })
  let document: AuthoringDocument = {
    id: "demo",
    name: "Demo",
    workspace: scope.workspace,
    revision: 1,
    currentRevision: 1,
    updatedAt: 1,
    source,
    versions: [{ revision: 1, createdAt: 1, digest: source.digest }]
  }
  let live = true,
    busy = false,
    authorized = false,
    pending = false,
    runtimeReady = false
  let installed: AuthoringInstalledReceipt | null = null
  let onIdle: (threadId: string) => void = () => {}
  const assertCurrent = () => {
    if (!live) throw Error("CREATOR_REUSE_SCOPE_CHANGED")
  }
  const context = { scope, assertCurrent }
  const claws = new ClawStore(settings)
  const identity = JSON.stringify([scope.threadId, scope.incarnation.token])
  claws.apply(
    scope.workspace,
    identity,
    {
      id: "initial",
      name: "Initial",
      capabilities: [],
      models: { default: "kept-model", roles: {} }
    },
    0
  )
  const prepared = {
    handle: "prepared",
    installationId: "formal-plugin",
    versionId: "version",
    name: "demo",
    sourceDigest: source.digest,
    compiledDigest: "a".repeat(64),
    catalogDigest: "b".repeat(64),
    configuration: "unchanged" as const,
    review: {
      strictCompatible: true,
      typesValid: true,
      modelProtocol: "result-v1",
      sdkMethods: ["command.register"],
      configurationKeys: [],
      components: [],
      changedFiles: []
    }
  }
  const install = {
    list: vi.fn(() => ({
      workspace: scope.workspace,
      installations: pending
        ? [
            {
              installationId: prepared.installationId,
              name: prepared.name,
              versions: [],
              pending: { operationId: "pending", state: "unknown" as const }
            }
          ]
        : []
    })),
    prepare: vi.fn(async (_input: unknown, binding: { assertCurrent(): void }) => {
      binding.assertCurrent()
      return prepared
    }),
    apply: vi.fn(async (_input: unknown, binding: { assertCurrent(): void }) => {
      binding.assertCurrent()
      installed = {
        installationId: prepared.installationId,
        versionId: prepared.versionId,
        name: prepared.name,
        sourceDigest: prepared.sourceDigest,
        compiledDigest: prepared.compiledDigest
      }
      return {
        operationId: "operation",
        installationId: prepared.installationId,
        versionId: prepared.versionId,
        state: "settled" as const
      }
    }),
    resolveInstalled: vi.fn(async (_input: unknown, binding: { assertCurrent(): void }) => {
      binding.assertCurrent()
      return installed
    }),
    discardPrepared: vi.fn(async () => {})
  }
  const stopTrial = vi.fn(async (_scope: DevelopmentScope, _id: string, guard: () => void) =>
    guard()
  )
  const approveInstalled = vi.fn(
    async (_scope: DevelopmentScope, _receipt: AuthoringInstalledReceipt, guard: () => void) => {
      guard()
      authorized = true
    }
  )
  const applySelection = vi.fn(
    async (
      _workspace: string,
      _threadId: string,
      _profile: ClawProfile,
      commit: () => void,
      guard: () => void
    ) => {
      guard()
      commit()
      guard()
      runtimeReady = true
    }
  )
  const deps = {
    settings,
    drafts: new AuthoringDraftStore(settings),
    claws,
    install,
    readContext: () => context,
    readDraft: () => document,
    identity: () => identity,
    available: async () =>
      installed
        ? [
            {
              pluginId: installed.installationId,
              name: installed.name,
              digest: installed.compiledDigest,
              state: authorized ? ("ready" as const) : ("needs-approval" as const),
              capabilities: []
            }
          ]
        : [],
    stopTrial,
    approveInstalled,
    applySelection,
    runtimeReady: () => runtimeReady,
    assertAuthorized: () => {
      if (!authorized) throw Error("CREATOR_REUSE_AUTHORITY_CHANGED")
    },
    busy: () => busy,
    onIdle: (listener: typeof onIdle) => {
      onIdle = listener
      return () => {}
    },
    changed: vi.fn()
  }
  const create = () => {
    const service = new CreatorReuseService(deps)
    services.push(service)
    return service
  }
  const service = create()
  const request = (turnId?: string, assertTurn = () => {}) =>
    service.request(context, document, { turnId, signal: new AbortController().signal, assertTurn })
  const approval = (): CreatorReuseApproval => {
    const status = service.status(scope)!
    return {
      planId: status.planId!,
      sourceDigest: status.sourceDigest,
      compiledDigest: status.compiledDigest!,
      targetProfileDigest: status.targetProfileDigest!
    }
  }
  return {
    service,
    create,
    request,
    approval,
    scope,
    context,
    install,
    stopTrial,
    approveInstalled,
    applySelection,
    claws,
    identity,
    prepared,
    deps,
    idle: () => {
      busy = false
      onIdle(scope.threadId)
    },
    busy: () => {
      busy = true
    },
    stale: () => {
      live = false
    },
    changeSource: () => {
      document = { ...document, revision: 2 }
    },
    pending: () => {
      pending = true
    },
    runtimePublished: () => {
      runtimeReady = true
    },
    runtimeRetired: () => {
      runtimeReady = false
    },
    revoke: () => {
      authorized = false
    }
  }
}

describe("one-review formal creator reuse", () => {
  it("completes a named save through the real reuse approval without a second installer", async () => {
    const f = fixture()
    const history = new CreatorCompositionHistory(f.deps.settings)
    let trials: DevelopmentTrialStatus[] = [{ componentId: "trial", draftId: "demo", revision: 1,
      bundleDigest: f.prepared.sourceDigest, compiledDigest: f.prepared.compiledDigest,
      phase: "active", capabilities: [] }]
    f.stopTrial.mockImplementation(async (_scope, _id, guard) => { guard(); trials = [] })
    const save = new CreatorCompositionSave(history, {
      trials: () => trials,
      prepareReuse: async (_threadId, _dependency, input) => {
        await f.service.request(f.context, f.deps.readDraft(), input)
        return f.service.status(f.scope)!
      },
      reuseFacts: scope => f.service.compositionFacts(scope)
    })
    const current = () => f.claws.selection(f.scope.workspace, f.identity).profile
    const reconcile = () => save.reconcile({ scope: f.scope, identity: f.identity, current,
      assertCurrent: f.context.assertCurrent, validate: async () => {} })
    f.deps.changed.mockImplementation(() => { queueMicrotask(() => { void reconcile() }) })
    expect(await save.start({ scope: f.scope, identity: f.identity, name: "Daily", revision: 0,
      profile: current(), signal: new AbortController().signal, assertTurn: () => {} }))
      .toMatchObject({ saved: false, phase: "needs-approval" })
    expect(history.list(f.scope.workspace)).toEqual([])
    expect(f.install.apply).not.toHaveBeenCalled()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(save.status(f.scope)).toMatchObject({ saved: true }))
    expect(history.load(f.scope.workspace, "Daily", 1)).toEqual(current())
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
    expect(f.applySelection).toHaveBeenCalledTimes(1)
    save.close()
  })
  it("prepares without effects and commits only the exact user-approved source and target", async () => {
    const f = fixture()
    await f.request()
    expect(f.service.status(f.scope)).toMatchObject({
      phase: "needs-approval",
      capabilities: ["command.register"]
    })
    expect(f.stopTrial).not.toHaveBeenCalled()
    expect(f.install.apply).not.toHaveBeenCalled()
    expect(f.approveInstalled).not.toHaveBeenCalled()
    await expect(
      f.service.approve(f.context, { ...f.approval(), targetProfileDigest: "c".repeat(64) })
    ).rejects.toThrow("CREATOR_REUSE_APPROVAL_CHANGED")
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    expect(f.stopTrial).toHaveBeenCalledTimes(1)
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledExactlyOnceWith(
      f.scope,
      expect.objectContaining({
        compiledDigest: "a".repeat(64),
        sourceDigest: f.prepared.sourceDigest
      }),
      expect.any(Function)
    )
    const selected = f.claws.selection(f.scope.workspace, f.identity).profile!
    expect(selected.models?.default).toBe("kept-model")
    expect(selected.capabilities).toEqual([
      expect.objectContaining({ pluginId: "formal-plugin", name: "demo", digest: "a".repeat(64) })
    ])
    expect(f.claws.read(f.scope.workspace).profiles).toContainEqual(selected)
    await f.service.approve(f.context, f.approval())
    await f.request()
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.applySelection).toHaveBeenCalledTimes(1)
  })
  it("waits for the successful creator turn and physical idle, without retaining its expired author guard", async () => {
    const f = fixture()
    let turnLive = true
    await f.request("turn", () => {
      if (!turnLive) throw Error("DEVELOPMENT_TURN_CHANGED")
    })
    f.busy()
    await f.service.approve(f.context, f.approval())
    turnLive = false
    publishDevelopmentTurnSettlement({
      threadId: f.scope.threadId,
      turnId: "turn",
      outcome: "completed",
      incarnation: f.scope.incarnation
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(f.install.apply).not.toHaveBeenCalled()
    f.idle()
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
  })
  it("rejects changed drafts and selections before stopping or granting", async () => {
    const f = fixture()
    await f.request()
    const approval = f.approval()
    f.changeSource()
    await expect(f.service.approve(f.context, approval)).rejects.toThrow(
      "CREATOR_REUSE_SOURCE_CHANGED"
    )
    expect(f.stopTrial).not.toHaveBeenCalled()
    expect(f.install.apply).not.toHaveBeenCalled()
  })
  it("records uncertain installation and never grants or replays its write", async () => {
    const f = fixture()
    f.install.apply.mockResolvedValueOnce({
      operationId: "operation",
      installationId: "formal-plugin",
      versionId: "version",
      state: "unknown"
    } as never)
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("unknown"))
    expect(f.approveInstalled).not.toHaveBeenCalled()
    f.service.close()
    const restored = f.create()
    expect(restored.status(f.scope)?.phase).toBe("unknown")
    await expect(restored.approve(f.context, f.approval())).rejects.toThrow(
      "CREATOR_REUSE_PREPARE_REQUIRED"
    )
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    f.pending()
    await expect(
      restored.request(f.context, f.deps.readDraft(), {
        signal: new AbortController().signal,
        assertTurn: () => {}
      })
    ).rejects.toThrow("CREATOR_REUSE_INSTALL_UNCONFIRMED")
    expect(f.install.apply).toHaveBeenCalledTimes(1)
  })
  it("retains completed facts after service recreation without reinstalling or recreating consent", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    f.service.close()
    const restored = f.create()
    expect(restored.status(f.scope)?.phase).toBe("active")
    await restored.approve(f.context, f.approval())
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("reconciles a lost completion acknowledgement from exact installed/grant/saved-binding facts only", async () => {
    const f = fixture()
    f.applySelection.mockImplementationOnce(
      async (_workspace, _threadId, _profile, commit, guard) => {
        guard()
        commit()
        guard()
        f.runtimePublished()
        throw Error("LOST_COMPLETION_ACK")
      }
    )
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("unknown"))
    f.service.close()
    const restored = f.create()
    await expect(restored.reconcile(f.context)).resolves.toMatchObject({
      phase: "active",
      installationId: "formal-plugin"
    })
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
    expect(f.applySelection).toHaveBeenCalledTimes(1)
  })
  it("does not infer successful runtime activation from a saved binding after physical retirement failed", async () => {
    const f = fixture()
    f.applySelection.mockImplementationOnce(
      async (_workspace, _threadId, _profile, commit, guard) => {
        guard()
        commit()
        throw Error("MODS_COMPOSITION_APPLY_UNCONFIRMED")
      }
    )
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("unknown"))
    f.service.close()
    const restored = f.create()
    await expect(restored.reconcile(f.context)).resolves.toMatchObject({ phase: "unknown" })
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
    expect(f.applySelection).toHaveBeenCalledTimes(1)
  })
  it("keeps the same approved plan queued when installer admission is busy", async () => {
    const f = fixture()
    f.install.apply.mockRejectedValueOnce(Error("PLUGIN_CATALOG_BUSY"))
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.install.apply).toHaveBeenCalledTimes(1))
    expect(f.service.status(f.scope)?.phase).toBe("applying")
    expect(f.approveInstalled).not.toHaveBeenCalled()
    f.idle()
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    expect(f.install.prepare).toHaveBeenCalledTimes(1)
    expect(f.install.apply).toHaveBeenCalledTimes(2)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("prepares during an active model operation and waits to begin trusted writes", async () => {
    const f = fixture()
    f.busy()
    await f.request()
    expect(f.service.status(f.scope)?.phase).toBe("needs-approval")
    await f.service.approve(f.context, f.approval())
    expect(f.stopTrial).not.toHaveBeenCalled()
    expect(f.install.apply).not.toHaveBeenCalled()
    f.idle()
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
  })
  it("waits after install and grant invalidation without aborting their own guards or replaying writes", async () => {
    const f = fixture()
    const install = f.install.apply.getMockImplementation()!
    f.install.apply.mockImplementationOnce(async (input, binding) => {
      const result = await install(input, binding)
      f.busy()
      // The real installer calls its guard again after pluginsChanged invalidates sessions.
      binding.assertCurrent()
      return result
    })
    const approve = f.approveInstalled.getMockImplementation()!
    f.approveInstalled.mockImplementationOnce(async (scope, receipt, guard) => {
      await approve(scope, receipt, guard)
      f.busy()
      guard()
    })
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.install.apply).toHaveBeenCalledTimes(1))
    expect(f.service.status(f.scope)?.phase).toBe("applying")
    expect(f.approveInstalled).not.toHaveBeenCalled()
    f.idle()
    await vi.waitFor(() => expect(f.approveInstalled).toHaveBeenCalledTimes(1))
    expect(f.service.status(f.scope)?.phase).toBe("applying")
    expect(f.applySelection).not.toHaveBeenCalled()
    f.idle()
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    expect(f.install.prepare).toHaveBeenCalledTimes(1)
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
    expect(f.stopTrial).toHaveBeenCalledTimes(1)
  })
  it("keeps an uncommitted selection queued after catalog drain admission without installing or granting twice", async () => {
    const f = fixture()
    f.applySelection.mockRejectedValueOnce(Error("MODS_CONFIG_RELOAD_BUSY"))
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.applySelection).toHaveBeenCalledTimes(1))
    expect(f.service.status(f.scope)?.phase).toBe("applying")
    f.idle()
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
    expect(f.applySelection).toHaveBeenCalledTimes(2)
  })
  it("reports revoked completed authority and notifies without restoring consent", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    f.service.reconcileAuthorizations()
    f.deps.changed.mockClear()
    f.revoke()
    expect(f.service.status(f.scope)).toMatchObject({
      phase: "failed",
      error: "CREATOR_REUSE_AUTHORITY_CHANGED"
    })
    f.service.reconcileAuthorizations()
    expect(f.deps.changed).toHaveBeenCalledExactlyOnceWith(f.scope.threadId)
    f.service.reconcileAuthorizations()
    expect(f.deps.changed).toHaveBeenCalledTimes(1)
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("keeps saved installation facts but requires positive runtime proof after retirement or restart", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    f.runtimeRetired()
    expect(f.service.status(f.scope)).toMatchObject({
      phase: "unknown",
      error: "CREATOR_REUSE_RUNTIME_UNCONFIRMED",
      installationId: "formal-plugin"
    })
    await expect(f.service.reconcile(f.context)).resolves.toMatchObject({ phase: "unknown" })
    f.runtimePublished()
    await expect(f.service.reconcile(f.context)).resolves.toMatchObject({ phase: "active" })
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("deduplicates concurrent read-only recovery probes for the same exact scope", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    f.install.resolveInstalled.mockClear()
    await Promise.all([f.service.reconcile(f.context), f.service.reconcile(f.context)])
    expect(f.install.resolveInstalled).toHaveBeenCalledTimes(1)
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("can prepare the next draft revision after observing the previous installed revision", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    const previous = f.approval()
    f.changeSource()
    await expect(f.service.reconcile(f.context)).resolves.toMatchObject({ phase: "active" })
    await f.request()
    expect(f.service.status(f.scope)).toMatchObject({ phase: "needs-approval", revision: 2 })
    expect(f.approval().planId).not.toBe(previous.planId)
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("does not overwrite a saved reusable combination edited after the exact plan was prepared", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    f.changeSource()
    await f.request()
    const approval = f.approval()
    const state = f.claws.read(f.scope.workspace)
    const edited = { ...state.profiles[0], name: "Person edited this saved combination" }
    f.claws.write(f.scope.workspace, { ...state, profiles: [edited] }, state.revision)
    await expect(f.service.approve(f.context, approval)).rejects.toThrow(
      "CREATOR_REUSE_TARGET_CHANGED"
    )
    expect(f.claws.read(f.scope.workspace).profiles).toEqual([edited])
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
  })
  it("reads completion facts after authoring ends without calling a draft write guard", async () => {
    const f = fixture()
    await f.request()
    await f.service.approve(f.context, f.approval())
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("active"))
    f.service.close()
    const restored = f.create()
    f.deps.readDraft = () => {
      throw Error("DEVELOPMENT_DISABLED")
    }
    await expect(restored.reconcile(f.context)).resolves.toMatchObject({ phase: "active" })
    expect(f.install.apply).toHaveBeenCalledTimes(1)
    expect(f.approveInstalled).toHaveBeenCalledTimes(1)
    f.deps.changed.mockClear()
    await restored.reconcile(f.context)
    await restored.reconcile(f.context)
    expect(f.deps.changed).not.toHaveBeenCalled()
  })
  it("does not apply an explicitly approved plan from an interrupted authoring turn", async () => {
    const f = fixture()
    await f.request("cancelled-turn")
    await f.service.approve(f.context, f.approval())
    publishDevelopmentTurnSettlement({
      threadId: f.scope.threadId,
      turnId: "cancelled-turn",
      outcome: "cancelled",
      incarnation: f.scope.incarnation
    })
    await vi.waitFor(() => expect(f.service.status(f.scope)?.phase).toBe("failed"))
    f.idle()
    expect(f.install.apply).not.toHaveBeenCalled()
    expect(f.approveInstalled).not.toHaveBeenCalled()
  })
})
