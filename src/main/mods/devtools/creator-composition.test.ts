import { afterEach, describe, expect, it, vi } from "vitest"
import { CreatorCompositionService, type CompositionSelectionCatalog } from "./creator-composition"
import { CreatorCompositionHistory } from "./creator-composition-history"
import { flowDigest } from "../flows/store"
import type { SavedFlow } from "../../../shared/mods/flows/types"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import { ClawStore } from "../claw-store"
import { clawIssues } from "../../../shared/mods/claw"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import type { ClawComponentExport } from "../../../shared/mods/claw-components"
import { publishDevelopmentTurnSettlement } from "../v2/development-turn-settlement"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  onLocalThreadRunLeaseReleased,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"

const threadId = "creator-composition-test"
const services: CreatorCompositionService[] = []
const fixtureThreads = new Set<string>()
const capability = (id: string) => ({
  pluginId: id,
  name: id,
  digest: id.repeat(64)
})
function fixture(targetThreadId = threadId, sharedSettings?: Map<string, string>) {
  const threadId = targetThreadId
  const settings = sharedSettings ?? new Map<string, string>()
  const store = new ClawStore({
    getSetting: (key, fallback) => settings.get(key) ?? fallback ?? "",
    setSetting: (key, value) => {
      settings.set(key, value)
    }
  })
  let token = "first"
  let modsEnabled = true
  const grants = new Map([
    ["a", "a".repeat(64)],
    ["b", "b".repeat(64)]
  ])
  let available: FunctionPluginStatus[] = ["a", "b"].map((id) => ({
    ...capability(id),
    state: "ready",
    capabilities: []
  }))
  const closeThread = vi.fn()
  const prepare = vi.fn()
  const afterCommit = vi.fn()
  let configurationBusy = false
  let runtimeReady = false
  const idleListeners = new Set<(threadId: string) => void>()
  const changed = vi.fn()
  const readAvailable = vi.fn(async () => available)
  let resources: CompositionSelectionCatalog = {
    models: [{ id: "existing-model", name: "Existing" }],
    skills: [],
    mcp: [],
    flows: []
  }
  const history = new CreatorCompositionHistory({
    getSetting: (key, fallback) => settings.get(key) ?? fallback ?? "",
    compareAndSetSetting: (key, expected, value) => {
      if (settings.get(key) !== expected) return false
      settings.set(key, value)
      return true
    }
  })
  const context = () => {
    const captured = token
    return {
      scope: {
        workspace: "workspace",
        threadId,
        incarnation: { token: captured, legacyCreatedAt: 1 }
      },
      assertCurrent: () => {
        if (captured !== token) throw Error("COMPOSITION_SCOPE_CHANGED")
      }
    }
  }
  const deps: ConstructorParameters<typeof CreatorCompositionService>[0] = {
    store,
    history,
    context,
    readContext: context,
    assertScope: (scope) => {
      if (scope.incarnation.token !== token) throw Error("COMPOSITION_SCOPE_CHANGED")
    },
    assertAuthorized: (_scope, profile) => {
      if (!modsEnabled) throw Error("COMPOSITION_MODS_DISABLED")
      if (
        profile?.capabilities.some(
          (capability) => grants.get(capability.pluginId) !== capability.digest
        )
      )
        throw Error("COMPOSITION_AUTHORITY_CHANGED")
    },
    runtimeReady: () => runtimeReady,
    identity: () => JSON.stringify([threadId, token]),
    usage: () => ({ usage: "chat", identity: "usage" }),
    available: readAvailable,
    selectionCatalog: async () => resources,
    issues: (_workspace, profile, sources) => clawIssues(profile, sources),
    busy: () => configurationBusy || !!getLocalThreadRunLease(threadId),
    onIdle: (listener) => {
      idleListeners.add(listener)
      const stop = onLocalThreadRunLeaseReleased((lease) => listener(lease.threadId))
      return () => {
        idleListeners.delete(listener)
        stop()
      }
    },
    applySelection: async (_workspace, id, _profile, commitSelection, assertCurrent) => {
      assertCurrent()
      await prepare()
      assertCurrent()
      commitSelection()
      await afterCommit()
      closeThread(id)
      assertCurrent()
      runtimeReady = true
    },
    changed
  }
  const service = new CreatorCompositionService(deps)
  services.push(service)
  fixtureThreads.add(threadId)
  claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
  const settle = (outcome: "completed" | "cancelled" = "completed") => {
    publishDevelopmentTurnSettlement({
      threadId,
      turnId: "run",
      outcome,
      incarnation: { token: "first", legacyCreatedAt: 1 }
    })
    releaseLocalThreadRunLease(threadId, "desktop", "run")
  }
  return {
    service,
    store,
    closeThread,
    prepare,
    readAvailable,
    afterCommit,
    setRuntimeReady: (ready: boolean) => {
      runtimeReady = ready
    },
    holdBusy: (busy: boolean) => {
      configurationBusy = busy
    },
    idle: () => {
      for (const listener of idleListeners) listener(threadId)
    },
    changed,
    settle,
    history,
    settings,
    restart: () => {
      service.close()
      const next = new CreatorCompositionService(deps)
      services.push(next)
      return next
    },
    setResources: (next: CompositionSelectionCatalog) => {
      resources = next
    },
    disableMods: () => {
      modsEnabled = false
    },
    setAvailable: (sources: FunctionPluginStatus[]) => {
      available = sources
    },
    selection: () => store.selection("workspace", JSON.stringify([threadId, "first"])),
    revoke: (id = "b") => {
      grants.delete(id)
      available = available.map((item) =>
        item.pluginId === id ? { ...item, state: "needs-approval" } : item
      )
    },
    recreate: () => {
      token = "replacement"
    }
  }
}
afterEach(() => {
  for (const service of services.splice(0)) service.close()
  for (const id of fixtureThreads) releaseLocalThreadRunLease(id, "desktop", "run")
  fixtureThreads.clear()
})

describe("creator current-chat Mod composition", () => {
  it("patches one model role and then the default without erasing other roles or Mods", async () => {
    const f = fixture()
    f.setResources({ models: [
      { id: "existing-model", name: "Existing" }, { id: "other-model", name: "Other" }
    ], skills: [], mcp: [], flows: [] })
    f.store.apply("workspace", JSON.stringify([threadId, "first"]), {
      id: "original", name: "Original", capabilities: [capability("a")],
      models: { default: "existing-model", roles: {
        review: "existing-model", writer: "existing-model"
      } }
    }, 0)
    const catalog = await f.service.catalog(threadId)
    await f.service.stage(threadId, "run", {
      catalogToken: catalog.catalogToken, capabilities: [],
      models: { roles: { review: "other-model" } }
    }, () => {})
    await f.service.stage(threadId, "run", {
      catalogToken: catalog.catalogToken, capabilities: [],
      models: { default: "other-model", roles: {} }
    }, () => {})
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.selection().profile?.models).toEqual({ default: "other-model", roles: {
      review: "other-model", writer: "existing-model"
    } })
    expect(f.selection().profile?.capabilities.map(item => item.pluginId)).toEqual(["a"])
    expect(f.closeThread).toHaveBeenCalledOnce()
  })

  it("does not rebuild or create undo history when the final selection is already active", async () => {
    const f = fixture()
    f.setRuntimeReady(true)
    f.store.apply(
      "workspace",
      JSON.stringify([threadId, "first"]),
      { id: "original", name: "Original", capabilities: [capability("b")] },
      0
    )
    const catalog = await f.service.catalog(threadId)
    expect(
      await f.service.stage(
        threadId,
        "run",
        { catalogToken: catalog.catalogToken, capabilities: [capability("b")] },
        () => {}
      )
    ).toMatchObject({ phase: "active", canUndo: false })
    f.settle()
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.closeThread).not.toHaveBeenCalled()
    expect(f.store.read("workspace").revision).toBe(1)
  })
  it("prepares the same selected profile when its runtime is not ready", async () => {
    const f = fixture()
    f.store.apply(
      "workspace",
      JSON.stringify([threadId, "first"]),
      { id: "original", name: "Original", capabilities: [capability("b")] },
      0
    )
    const catalog = await f.service.catalog(threadId)
    expect(
      await f.service.stage(
        threadId,
        "run",
        { catalogToken: catalog.catalogToken, capabilities: [capability("b")] },
        () => {}
      )
    ).toMatchObject({ phase: "queued" })
    expect(f.prepare).not.toHaveBeenCalled()
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.closeThread).toHaveBeenCalledTimes(1)
  })
  it("reuses one directory snapshot for pages/search and reveals schemas only for explicit details", async () => {
    const f = fixture()
    f.setAvailable(
      Array.from(
        { length: 14 },
        (_, index): FunctionPluginStatus => ({
          pluginId: `provider-${index}`,
          name: `Provider ${index}`,
          digest: "a".repeat(64),
          state: "ready",
          capabilities: [],
          components: [
            {
              id: "module",
              name: `Module ${index}`,
              kind: "module",
              entry: "module.ts",
              dependsOn: [],
              actionIds: [],
              configSchema: { type: "object", properties: { setting: { type: "string" } } }
            }
          ]
        })
      )
    )
    const first = await f.service.catalog(threadId)
    const second = await f.service.catalog(threadId, 12)
    const search = await f.service.catalog(threadId, 0, { query: "Module 13" })
    expect(first.available).toHaveLength(12)
    expect(second.available).toHaveLength(2)
    expect(search.available.map((item) => item.pluginId)).toEqual(["provider-13"])
    expect(first.available[0].components[0]).toMatchObject({ configurable: true })
    expect(first.available[0].components[0]).not.toHaveProperty("configSchema")
    expect(
      (await f.service.details(threadId, "provider-13", first.catalogToken)).provider.components[0]
    ).toHaveProperty("configSchema")
    expect(f.readAvailable).toHaveBeenCalledTimes(1)
    await f.service.catalog(threadId, 0, { refresh: true })
    expect(f.readAvailable).toHaveBeenCalledTimes(2)
    f.service.reconcile(threadId)
    await f.service.catalog(threadId)
    expect(f.readAvailable).toHaveBeenCalledTimes(3)
  })
  it("keeps a precommit busy candidate queued and retries once after native idle", async () => {
    const f = fixture(),
      catalog = await f.service.catalog(threadId)
    f.prepare.mockImplementationOnce(() => {
      f.holdBusy(true)
      throw Error("MODS_CONFIG_RELOAD_BUSY")
    })
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")], replace: true },
      () => {}
    )
    f.settle()
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(1))
    expect(f.service.status(threadId)).toMatchObject({ phase: "queued", canCancel: true })
    expect(f.selection().profile).toBeNull()
    f.holdBusy(false)
    f.idle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(f.closeThread).toHaveBeenCalledTimes(1)
  })
  it("does not retry BUSY on its own lease release and admits the next composition", async () => {
    const f = fixture()
    const catalog = await f.service.catalog(threadId)
    f.prepare.mockRejectedValueOnce(Error("MODS_CONFIG_RELOAD_BUSY"))
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")], replace: true },
      () => {}
    )
    f.settle()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.service.status(threadId)).toMatchObject({ phase: "queued", canCancel: true })
    expect(f.selection().profile).toBeNull()
    f.idle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.prepare).toHaveBeenCalledTimes(2)

    claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
    const next = await f.service.catalog(threadId)
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: next.catalogToken, capabilities: [capability("a")], replace: true },
      () => {}
    )
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.prepare).toHaveBeenCalledTimes(3)
    expect(f.selection().profile?.capabilities.map((item) => item.name)).toEqual(["a"])
  })
  it("retains a real idle received during a busy preparation", async () => {
    const f = fixture()
    const catalog = await f.service.catalog(threadId)
    f.prepare.mockImplementationOnce(() => {
      f.idle()
      throw Error("MODS_CONFIG_RELOAD_BUSY")
    })
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")], replace: true },
      () => {}
    )
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.prepare).toHaveBeenCalledTimes(2)
    expect(f.closeThread).toHaveBeenCalledTimes(1)
  })
  it("does not replay a postcommit unconfirmed transaction or offer an unsafe undo", async () => {
    const f = fixture(),
      catalog = await f.service.catalog(threadId)
    f.afterCommit.mockRejectedValueOnce(Error("MODS_COMPOSITION_APPLY_UNCONFIRMED"))
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")], replace: true },
      () => {}
    )
    f.settle()
    await vi.waitFor(() =>
      expect(f.service.status(threadId)).toMatchObject({
        phase: "failed",
        error: "MODS_COMPOSITION_APPLY_UNCONFIRMED",
        canUndo: false
      })
    )
    f.idle()
    expect(f.prepare).toHaveBeenCalledTimes(1)
    expect(f.selection().profile?.capabilities.map((item) => item.name)).toEqual(["b"])
  })
  it("rechecks authorization of an undo target and rejects a new incarnation", async () => {
    const f = fixture()
    f.store.apply(
      "workspace",
      JSON.stringify([threadId, "first"]),
      { id: "original", name: "Original", capabilities: [capability("a")] },
      0
    )
    const catalog = await f.service.catalog(threadId)
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")], replace: true },
      () => {}
    )
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    f.revoke("a")
    await expect(f.service.undo(threadId, "workspace")).rejects.toThrow(
      "COMPOSITION_CAPABILITY_UNAUTHORIZED"
    )
    expect(f.selection().profile?.capabilities[0].name).toBe("b")
    f.recreate()
    await expect(f.service.undo(threadId, "workspace")).rejects.toThrow("COMPOSITION_UNDO_STALE")
    expect(f.closeThread).toHaveBeenCalledTimes(1)
  })
  it("deep-patches nested secrets and arrays and deletes only explicitly requested optional fields", async () => {
    const f = fixture()
    f.setAvailable([
      {
        ...capability("a"),
        state: "ready",
        capabilities: [],
        components: [
          {
            id: "connection",
            name: "Connection",
            kind: "module",
            entry: "connection.ts",
            dependsOn: [],
            actionIds: [],
            configSchema: {
              type: "object",
              required: ["connection"],
              properties: {
                connection: {
                  type: "object",
                  required: ["token", "timeout"],
                  additionalProperties: false,
                  properties: {
                    token: { type: "string" },
                    url: { type: "string" },
                    timeout: { type: "number" },
                    hosts: { type: "array", items: { type: "string" } }
                  }
                }
              }
            }
          }
        ]
      }
    ])
    f.store.apply(
      "workspace",
      JSON.stringify([threadId, "first"]),
      {
        id: "original",
        name: "Original",
        capabilities: [
          {
            ...capability("a"),
            components: {
              mode: "selected",
              ids: ["connection"],
              config: {
                connection: {
                  connection: {
                    token: "private-token",
                    url: "old",
                    timeout: 1000,
                    hosts: ["a", "b"]
                  }
                }
              }
            }
          }
        ]
      },
      0
    )
    const catalog = await f.service.catalog(threadId)
    await f.service.stage(
      threadId,
      "run",
      {
        catalogToken: catalog.catalogToken,
        capabilities: [
          {
            ...capability("a"),
            components: {
              mode: "selected",
              ids: ["connection"],
              config: { connection: { connection: { timeout: 5000, hosts: ["c"] } } }
            }
          }
        ]
      },
      () => {}
    )
    await expect(
      f.service.stage(
        threadId,
        "run",
        {
          catalogToken: catalog.catalogToken,
          capabilities: [],
          removeConfigPaths: [
            { pluginId: "a", componentId: "connection", path: "/connection/token" }
          ]
        },
        () => {}
      )
    ).rejects.toThrow()
    await f.service.stage(
      threadId,
      "run",
      {
        catalogToken: catalog.catalogToken,
        capabilities: [],
        removeConfigPaths: [{ pluginId: "a", componentId: "connection", path: "/connection/url" }]
      },
      () => {}
    )
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.selection().profile?.capabilities[0].components?.config.connection).toEqual({
      connection: { token: "private-token", timeout: 5000, hosts: ["c"] }
    })
    expect(JSON.stringify(await f.service.catalog(threadId))).not.toContain("private-token")
  })
  it("accumulates multiple same-turn stages and applies one final candidate", async () => {
    const f = fixture()
    f.store.apply(
      "workspace",
      JSON.stringify([threadId, "first"]),
      { id: "empty", name: "Empty", capabilities: [] },
      0
    )
    const catalog = await f.service.catalog(threadId)
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("a")] },
      () => {}
    )
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")] },
      () => {}
    )
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.selection().profile?.capabilities.map((item) => item.pluginId)).toEqual(["a", "b"])
    expect(f.closeThread).toHaveBeenCalledTimes(1)
  })
  it("cancels queued composition without touching current bindings or replaying after settlement", async () => {
    const f = fixture(),
      catalog = await f.service.catalog(threadId)
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")], replace: true },
      () => {}
    )
    expect(f.service.status(threadId)?.canCancel).toBe(true)
    expect(f.service.cancel(threadId, "workspace")).toMatchObject({
      phase: "cancelled",
      canCancel: false
    })
    f.settle()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.closeThread).not.toHaveBeenCalled()
    expect(f.selection().profile).toBeNull()
  })
  it("restores exact previous selection through durable history after service restart", async () => {
    const f = fixture()
    f.store.apply(
      "workspace",
      JSON.stringify([threadId, "first"]),
      { id: "original", name: "Original", capabilities: [capability("a")] },
      0
    )
    const catalog = await f.service.catalog(threadId)
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")] },
      () => {}
    )
    f.settle()
    await vi.waitFor(() =>
      expect(f.service.status(threadId)).toMatchObject({ phase: "active", canUndo: true })
    )
    const restarted = f.restart()
    expect(restarted.status(threadId)).toMatchObject({ phase: "active", canUndo: true })
    await restarted.undo(threadId, "workspace")
    await vi.waitFor(() =>
      expect(restarted.status(threadId)).toMatchObject({ phase: "active", canUndo: false })
    )
    expect(f.selection().profile?.capabilities.map((item) => item.name)).toEqual(["a"])
    expect(f.closeThread).toHaveBeenCalledTimes(2)
    await expect(restarted.undo(threadId, "workspace")).rejects.toThrow("COMPOSITION_UNDO_STALE")
  })
  it.each(["live", "restored"])(
    "projects %s runtime loss without changing the confirmed history or loading a guest",
    async (origin) => {
      const f = fixture()
      f.store.apply(
        "workspace",
        JSON.stringify([threadId, "first"]),
        { id: "original", name: "Original", capabilities: [capability("a")] },
        0
      )
      const catalog = await f.service.catalog(threadId)
      await f.service.stage(
        threadId,
        "run",
        { catalogToken: catalog.catalogToken, capabilities: [capability("b")] },
        () => {}
      )
      f.settle()
      await vi.waitFor(() =>
        expect(f.service.status(threadId)).toMatchObject({ phase: "active", canUndo: true })
      )
      f.setRuntimeReady(false)
      const service = origin === "restored" ? f.restart() : f.service
      const persisted = new Map(f.settings)
      const notifications = f.changed.mock.calls.length
      for (let index = 0; index < 3; index++)
        expect(service.status(threadId)).toMatchObject({
          phase: "failed",
          error: "COMPOSITION_RUNTIME_UNCONFIRMED",
          canUndo: true
        })
      expect(f.prepare).toHaveBeenCalledTimes(1)
      expect(f.settings).toEqual(persisted)
      expect(f.changed).toHaveBeenCalledTimes(notifications)
      f.setRuntimeReady(true)
      expect(service.status(threadId)).toMatchObject({ phase: "active", canUndo: true })
      expect(service.status(threadId)?.error).toBeUndefined()
      expect(f.prepare).toHaveBeenCalledTimes(1)
      expect(f.settings).toEqual(persisted)
      expect(f.changed).toHaveBeenCalledTimes(notifications)
    }
  )
  it("restores inherited null exactly, and rejects stale or unauthorized undo targets", async () => {
    const f = fixture(),
      catalog = await f.service.catalog(threadId)
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")], replace: true },
      () => {}
    )
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    await f.service.undo(threadId, "workspace")
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.selection().profile).toBeNull()
    f.store.apply(
      "workspace",
      JSON.stringify([threadId, "first"]),
      { id: "manual", name: "Manual", capabilities: [] },
      f.store.read("workspace").revision
    )
    await expect(f.service.undo(threadId, "workspace")).rejects.toThrow("COMPOSITION_UNDO_STALE")
  })
  it("saves a queued named selection and reuses it in another chat with fresh authority checks", async () => {
    const f = fixture(),
      catalog = await f.service.catalog(threadId)
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")], replace: true },
      () => {}
    )
    expect(await f.service.save(threadId, "Review", 0, catalog.catalogToken, () => {})).toEqual({
      name: "Review",
      revision: 1
    })
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    const other = fixture("saved-other-chat", f.settings)
    expect((await other.service.catalog("saved-other-chat")).saved).toMatchObject([
      { name: "Review", revision: 1 }
    ])
    await other.service.applySaved("saved-other-chat", "run", "Review", 1, () => {})
    other.settle()
    await vi.waitFor(() =>
      expect(other.service.status("saved-other-chat")).toMatchObject({
        phase: "active",
        savedName: "Review"
      })
    )
    expect(other.selection().profile?.capabilities.map((item) => item.name)).toEqual(["b"])
    other.revoke()
    await expect(
      other.service.applySaved("saved-other-chat", "next", "Review", 1, () => {})
    ).rejects.toThrow("COMPOSITION_CAPABILITY_UNAUTHORIZED")
    await expect(
      other.service.applySaved("saved-other-chat", "next", "Review", 0, () => {})
    ).rejects.toThrow("COMPOSITION_SAVED_CHANGED")
  })
  it("chooses exact configured model/skill/MCP/flow resources without running a flow", async () => {
    const f = fixture()
    const skill = { id: "skill-one", name: "Skill One", digest: "a".repeat(64) }
    const mcp = { id: "mcp-one", name: "MCP One", digest: "b".repeat(64) }
    const definition: SavedFlow["definition"] = parseFlowDefinition({
      schemaVersion: 2,
      id: "review",
      name: "Review",
      goal: "Review",
      timeoutMs: 60000,
      maxExecutions: 4,
      execution: { kind: "host" },
      steps: [
        {
          id: "draft",
          name: "Draft",
          kind: "agent",
          enabled: true,
          prompt: "Review",
          modelRole: "writer"
        }
      ]
    })
    const flow: SavedFlow = {
      definition,
      revision: 1,
      updatedAt: 1,
      digest: flowDigest(definition)
    }
    f.setResources({
      models: [{ id: "model-two", name: "Two" }],
      skills: [skill],
      mcp: [mcp],
      flows: [flow]
    })
    const catalog = await f.service.catalog(threadId)
    await f.service.stage(
      threadId,
      "run",
      {
        catalogToken: catalog.catalogToken,
        capabilities: [],
        models: { default: "model-two", roles: { writer: "model-two" } },
        skills: { mode: "selected", items: [skill] },
        mcp: { mode: "selected", items: [mcp] },
        flow: { id: "review", revision: 1, digest: flow.digest },
        builtins: { contextMeter: true }
      },
      () => {}
    )
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.selection().profile).toMatchObject({
      models: { default: "model-two" },
      skills: { items: [skill] },
      mcp: { items: [mcp] },
      flow,
      builtins: { contextMeter: true }
    })
    expect(f.closeThread).toHaveBeenCalledTimes(1)
  })
  it.each(["binding", "disabled", "revoked"])(
    "invalidates an active receipt once after %s changes",
    async (reason) => {
      const f = fixture()
      const catalog = await f.service.catalog(threadId)
      await f.service.stage(
        threadId,
        "run",
        { catalogToken: catalog.catalogToken, capabilities: [capability("b")] },
        () => {}
      )
      f.settle()
      await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
      const calls = f.changed.mock.calls.length
      if (reason === "binding")
        f.store.apply(
          "workspace",
          JSON.stringify([threadId, "first"]),
          { id: "manual", name: "Manual", capabilities: [capability("a")] },
          f.store.read("workspace").revision
        )
      else if (reason === "disabled") f.disableMods()
      else f.revoke()
      const expected =
        reason === "binding"
          ? "COMPOSITION_SELECTION_CHANGED"
          : reason === "disabled"
            ? "COMPOSITION_MODS_DISABLED"
            : "COMPOSITION_AUTHORITY_CHANGED"
      f.service.reconcile()
      for (let i = 0; i < 3; i++)
        expect(f.service.status(threadId)).toMatchObject(reason === "binding"
          ? { phase: "superseded", error: undefined, canCancel: false, canUndo: false }
          : { phase: "failed", error: expected })
      await new Promise<void>((resolve) => queueMicrotask(resolve))
      expect(f.changed).toHaveBeenCalledTimes(calls + 1)
    }
  )
  it("re-inspects source digests for model status instead of retaining a stale active receipt", async () => {
    const f = fixture()
    const catalog = await f.service.catalog(threadId)
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")], replace: true },
      () => {}
    )
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    f.setAvailable([
      { ...capability("b"), digest: "c".repeat(64), state: "ready", capabilities: [] }
    ])
    expect(f.service.status(threadId)?.phase).toBe("active")
    await expect(f.service.refreshStatus(threadId)).resolves.toMatchObject({
      phase: "failed",
      error: "COMPOSITION_SOURCE_CHANGED"
    })
  })
  it("queues a merge, preserves inherited Mods, and applies only after successful physical idle", async () => {
    const f = fixture()
    const catalog = await f.service.catalog(threadId)
    expect(
      await f.service.stage(
        threadId,
        "run",
        { catalogToken: catalog.catalogToken, capabilities: [capability("b")] },
        () => {}
      )
    ).toMatchObject({ phase: "queued" })
    expect(f.selection().profile).toBeNull()
    expect(f.closeThread).not.toHaveBeenCalled()
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.selection().profile?.capabilities.map((item) => item.name)).toEqual(["a", "b"])
    expect(f.store.selection("workspace", JSON.stringify(["another", "first"])).profile).toBeNull()
    expect(f.store.read("workspace").profiles).toEqual([])
    expect(f.closeThread).toHaveBeenCalledExactlyOnceWith(threadId)
  })
  it("preserves current sources, model and builtins and redacts values from catalog", async () => {
    const f = fixture()
    f.store.apply(
      "workspace",
      JSON.stringify([threadId, "first"]),
      {
        id: "existing",
        name: "Existing",
        capabilities: [capability("a")],
        models: { default: "existing-model", roles: {} },
        skills: { mode: "selected", items: [] },
        mcp: { mode: "selected", items: [] },
        builtins: { contextMeter: true }
      },
      0
    )
    const catalog = await f.service.catalog(threadId)
    expect(catalog.current).not.toHaveProperty("models")
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")] },
      () => {}
    )
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.selection().profile).toMatchObject({
      models: { default: "existing-model" },
      skills: { mode: "selected", items: [] },
      mcp: { mode: "selected", items: [] },
      builtins: { contextMeter: true }
    })
  })
  it("preserves existing component config, validates changes and does not expose config values", async () => {
    const f = fixture()
    const source: FunctionPluginStatus = {
      ...capability("a"),
      state: "ready",
      capabilities: [],
      components: [
        {
          id: "module",
          kind: "module",
          entry: "module.ts",
          name: "Module",
          dependsOn: [],
          actionIds: [],
          configSchema: {
            type: "object",
            required: ["secret"],
            additionalProperties: false,
            properties: { secret: { type: "string" } }
          }
        }
      ]
    }
    f.setAvailable([source])
    f.store.apply(
      "workspace",
      JSON.stringify([threadId, "first"]),
      {
        id: "existing",
        name: "Existing",
        capabilities: [
          {
            ...capability("a"),
            components: {
              mode: "selected",
              ids: ["module"],
              config: { module: { secret: "hidden" } }
            }
          }
        ]
      },
      0
    )
    const catalog = await f.service.catalog(threadId)
    expect(JSON.stringify(catalog)).not.toContain("hidden")
    await expect(
      f.service.stage(
        threadId,
        "run",
        {
          catalogToken: catalog.catalogToken,
          capabilities: [
            {
              ...capability("a"),
              components: { mode: "selected", ids: ["module"], config: { module: { secret: 123 } } }
            }
          ]
        },
        () => {}
      )
    ).rejects.toThrow()
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("a")] },
      () => {}
    )
    f.settle()
    await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
    expect(f.selection().profile?.capabilities[0].components?.config.module).toEqual({
      secret: "hidden"
    })
  })
  it.each([false, true])(
    "patches retained component settings without exposing or dropping them (replace=%s)",
    async (replace) => {
      const f = fixture()
      f.setAvailable([
        {
          ...capability("a"),
          state: "ready",
          capabilities: [],
          components: ["first", "second", "removed"].map(
            (id): ClawComponentExport => ({
              id,
              kind: "module",
              entry: `${id}.ts`,
              name: id,
              dependsOn: [],
              actionIds: [],
              configSchema:
                id === "first"
                  ? {
                      type: "object",
                      required: ["token", "keep", "label"],
                      additionalProperties: false,
                      properties: {
                        token: { type: "string" },
                        keep: { type: "string" },
                        label: { type: "string" }
                      }
                    }
                  : {
                      type: "object",
                      required: ["value"],
                      additionalProperties: false,
                      properties: { value: { type: "string" } }
                    }
            })
          )
        }
      ])
      f.store.apply(
        "workspace",
        JSON.stringify([threadId, "first"]),
        {
          id: "existing",
          name: "Existing",
          capabilities: [
            {
              ...capability("a"),
              components: {
                mode: "selected",
                ids: ["first", "removed"],
                config: {
                  first: { token: "private-token", keep: "old-setting", label: "old-label" },
                  removed: { value: "old-removed" }
                }
              }
            }
          ]
        },
        0
      )
      const catalog = await f.service.catalog(threadId)
      expect(JSON.stringify(catalog)).not.toContain("private-token")
      const stage = (config: Record<string, Record<string, string>>) =>
        f.service.stage(
          threadId,
          "run",
          {
            catalogToken: catalog.catalogToken,
            replace,
            capabilities: [
              {
                ...capability("a"),
                components: { mode: "selected", ids: ["first", "second"], config }
              }
            ]
          },
          () => {}
        )
      await expect(
        stage({ second: { value: "new-value" }, removed: { value: "bad" } })
      ).rejects.toThrow("CLAW_COMPONENT_CONFIG_UNSELECTED")
      await expect(
        stage({ second: { value: "new-value" }, first: { unexpected: "bad" } })
      ).rejects.toThrow()
      await stage({ second: { value: "new-value" } })
      f.settle()
      await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
      expect(f.selection().profile?.capabilities[0].components?.config).toEqual({
        first: { token: "private-token", keep: "old-setting", label: "old-label" },
        second: { value: "new-value" }
      })
      claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
      const updated = await f.service.catalog(threadId)
      await f.service.stage(
        threadId,
        "run",
        {
          catalogToken: updated.catalogToken,
          replace,
          capabilities: [
            {
              ...capability("a"),
              components: {
                mode: "selected",
                ids: ["first", "second"],
                config: { first: { label: "new-label" } }
              }
            }
          ]
        },
        () => {}
      )
      f.settle()
      await vi.waitFor(() => expect(f.service.status(threadId)?.phase).toBe("active"))
      expect(f.selection().profile?.capabilities[0].components?.config).toEqual({
        first: { token: "private-token", keep: "old-setting", label: "new-label" },
        second: { value: "new-value" }
      })
      expect(JSON.stringify(await f.service.catalog(threadId))).not.toContain("private-token")
    }
  )
  it("keeps the old selection and runtime when host candidate preparation fails", async () => {
    const f = fixture()
    const catalog = await f.service.catalog(threadId)
    f.prepare.mockRejectedValueOnce(Error("COMPOSITION_PREPARE_FAILED"))
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")] },
      () => {}
    )
    f.settle()
    await vi.waitFor(() =>
      expect(f.service.status(threadId)).toMatchObject({
        phase: "failed",
        error: "COMPOSITION_PREPARE_FAILED"
      })
    )
    expect(f.closeThread).not.toHaveBeenCalled()
    expect(f.selection().profile).toBeNull()
  })
  it("keeps the previous selection when grants or source bytes change after staging", async () => {
    const f = fixture()
    f.store.apply(
      "workspace",
      JSON.stringify([threadId, "first"]),
      {
        id: "existing",
        name: "Existing",
        capabilities: [capability("a")]
      },
      0
    )
    const before = f.selection()
    const catalog = await f.service.catalog(threadId)
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")] },
      () => {}
    )
    f.revoke()
    f.settle()
    await vi.waitFor(() =>
      expect(f.service.status(threadId)).toMatchObject({
        phase: "failed",
        error: "COMPOSITION_SOURCE_CHANGED"
      })
    )
    expect(f.selection()).toEqual(before)
    expect(f.closeThread).not.toHaveBeenCalled()
  })
  it("rejects stale lists and unauthorized exact identities without touching the live selection", async () => {
    const f = fixture()
    const catalog = await f.service.catalog(threadId)
    f.revoke()
    await expect(
      f.service.stage(
        threadId,
        "run",
        { catalogToken: catalog.catalogToken, capabilities: [capability("b")] },
        () => {}
      )
    ).rejects.toThrow("COMPOSITION_SOURCE_CHANGED")
    const current = await f.service.catalog(threadId)
    expect(current.available.map((item) => item.name)).toEqual(["a"])
    await expect(
      f.service.stage(
        threadId,
        "run",
        { catalogToken: current.catalogToken, capabilities: [capability("b")] },
        () => {}
      )
    ).rejects.toThrow("COMPOSITION_CAPABILITY_UNAUTHORIZED")
    expect(f.selection().profile).toBeNull()
  })
  it.each(["cancelled", "recreated"])("does not apply after %s authoring scope", async (reason) => {
    const f = fixture()
    const catalog = await f.service.catalog(threadId)
    await f.service.stage(
      threadId,
      "run",
      { catalogToken: catalog.catalogToken, capabilities: [capability("b")], replace: true },
      () => {}
    )
    if (reason === "recreated") f.recreate()
    f.settle(reason === "cancelled" ? "cancelled" : "completed")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(f.selection().profile).toBeNull()
    expect(f.closeThread).not.toHaveBeenCalled()
  })
})
