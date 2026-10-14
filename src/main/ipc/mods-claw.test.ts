import { expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { registerClawHandlers } from "./mods-claw"
import { flowDigest } from "../mods/flows/store"
import { parseFlowDefinition } from "../../shared/mods/flows/schema"
import type { FlowDefinition } from "../../shared/mods/flows/types"
import { createHostReviewFlow } from "../../shared/mods/flows/templates"
import { clawIssues, type ClawView } from "../../shared/mods/claw"
import type { ModsManager } from "../mods/manager"
import type { FunctionModsManager } from "../mods/v2/manager"

function fixture() {
  const entries = new Map<string, string>()
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, input: unknown) => Promise<ClawView>
  >()
  const source = {
    pluginId: "a",
    name: "review",
    digest: "a".repeat(64),
    state: "ready" as const,
    capabilities: []
  }
  const state = { workspace: "a", idle: true, applicable: true }
  const invalidate = vi.fn()
  const validateModels = vi.fn(async () => undefined)
  const sources = vi.fn(async () => ({
    skills: [{ id: "skill-a", name: "Skill A", digest: "a".repeat(64) }],
    mcp: [{ id: "mcp-a", name: "MCP A", digest: "b".repeat(64) }]
  }))
  const functions = {
    status: vi.fn(async () => [source]),
    clawSelectionIssues: (_workspace, profile, available) => clawIssues(profile, available)
  } as unknown as FunctionModsManager
  registerClawHandlers(
    { handle: (key, fn) => handlers.set(key, fn) } as unknown as IpcMain,
    {
      store: {
        getSetting: (key, fallback) => entries.get(key) ?? fallback,
        setSetting: (key, value) => entries.set(key, value)
      },
      isEnabled: () => true,
      closeFunctionThread: invalidate
    } as unknown as ModsManager,
    functions,
    {
      scope: (event) => {
        if (event !== sender) throw Error("untrusted")
        return state.workspace
      },
      applicable: () => state.applicable,
      validateModels,
      sources,
      assertIdle: () => {
        if (!state.idle) throw Error("busy")
      },
      changed: vi.fn()
    }
  )
  const sender = {} as IpcMainInvokeEvent
  const call = (mutation: unknown) =>
    handlers.get("mods:claw-change")!(sender, {
      threadId: "thread",
      mutation: { workspace: "a", ...(mutation as object) }
    })
  const profile = {
    id: "p",
    name: "Profile",
    capabilities: [{ pluginId: source.pluginId, name: source.name, digest: source.digest }]
  }
  return {
    call,
    profile,
    state,
    invalidate,
    validateModels,
    sources,
    functions,
    view: () => handlers.get("mods:claw-view")!(sender, "thread"),
    catalog: () => handlers.get("mods:claw-sources")!(sender, "thread")
  }
}

it("rejects a stale application preview before changing the thread binding", async () => {
  const f = fixture()
  await f.call({ kind: "save", profile: f.profile, revision: 0 })
  await expect(
    f.call({ kind: "apply", id: "p", revision: 1, bindingRevision: 99 })
  ).rejects.toThrow("重新核对")
  expect(f.invalidate).not.toHaveBeenCalled()
  const applied = await f.call({ kind: "apply", id: "p", revision: 1, bindingRevision: 0 })
  expect(applied.active?.id).toBe("p")
  await expect(
    f.call({ kind: "apply", id: null, revision: 2, bindingRevision: 0 })
  ).rejects.toThrow("重新核对")
  expect((await f.view()).active?.id).toBe("p")
})

it("saves and applies builtin opt-in snapshots with no uploaded plugins", async () => {
  const f = fixture()
  vi.mocked(f.functions.status).mockResolvedValue([])
  const enabled = { ...f.profile, capabilities: [], builtins: { contextMeter: true } }
  const saved = await f.call({ kind: "save", profile: enabled, revision: 0 })
  expect(saved.profiles[0].builtins?.contextMeter).toBe(true)
  expect(saved.active).toBeNull()
  const applied = await f.call({ kind: "apply", id: enabled.id, revision: saved.revision })
  expect(applied.active?.builtins?.contextMeter).toBe(true)
  const edited = await f.call({
    kind: "save",
    revision: applied.revision,
    profile: { ...enabled, builtins: { contextMeter: false } }
  })
  expect(edited.active?.builtins?.contextMeter).toBe(true)
  const disabled = await f.call({ kind: "apply", id: enabled.id, revision: edited.revision })
  expect(disabled.active?.builtins?.contextMeter).toBe(false)
  expect(f.invalidate).toHaveBeenCalledTimes(2)
  await expect(
    f.call({
      kind: "save",
      revision: disabled.revision,
      profile: { ...enabled, builtins: { contextMeter: true, tier: "builtin" } }
    })
  ).rejects.toThrow("内置模组")
  expect((await f.view()).revision).toBe(disabled.revision)
})

it("preserves the selected capability array order through save and apply", async () => {
  const f = fixture()
  const a = f.profile.capabilities[0]
  const z = { pluginId: "z", name: "second", digest: "b".repeat(64) }
  vi.mocked(f.functions.status).mockResolvedValue(
    [a, z].map((item) => ({
      ...item,
      state: "ready",
      capabilities: []
    }))
  )
  const saved = await f.call({
    kind: "save",
    revision: 0,
    profile: { ...f.profile, capabilities: [z, a] }
  })
  expect(saved.profiles[0].capabilities.map((item) => item.pluginId)).toEqual(["z", "a"])
  const applied = await f.call({ kind: "apply", id: f.profile.id, revision: saved.revision })
  expect(applied.active?.capabilities.map((item) => item.pluginId)).toEqual(["z", "a"])
})

it("validates selected component dependencies, configuration and bound action ownership before persistence", async () => {
  const f = fixture()
  const base = {
    id: "base",
    name: "Base",
    kind: "module" as const,
    entry: "base.ts",
    dependsOn: [],
    actionIds: []
  }
  const review = {
    ...base,
    id: "review",
    name: "Review",
    entry: "review.ts",
    dependsOn: ["base"],
    actionIds: ["review"],
    configSchema: {
      type: "object",
      properties: { strict: { type: "boolean" } },
      required: ["strict"]
    }
  }
  vi.mocked(f.functions.status).mockResolvedValue([
    { ...f.profile.capabilities[0], state: "ready", capabilities: [], components: [base, review] }
  ])
  const profile = (ids: string[], config: Record<string, Record<string, unknown>>) => ({
    ...f.profile,
    capabilities: [{ ...f.profile.capabilities[0], components: { mode: "selected", ids, config } }]
  })
  await expect(
    f.call({
      kind: "save",
      revision: 0,
      profile: profile(["review"], { review: { strict: false } })
    })
  ).rejects.toThrow("DEPENDENCY_REQUIRED")
  await expect(
    f.call({ kind: "save", revision: 0, profile: profile(["base", "review"], {}) })
  ).rejects.toThrow("配置")
  await expect(
    f.call({ kind: "save", revision: 0, profile: profile(["base"], { review: {} }) })
  ).rejects.toThrow("CONFIG_UNSELECTED")
  const flow = parseFlowDefinition({
    ...createHostReviewFlow("component"),
    steps: [
      {
        id: "action",
        name: "Review action",
        kind: "plugin-action",
        enabled: true,
        pluginId: "a",
        plugin: "review",
        digest: "a".repeat(64),
        actionId: "review",
        input: {}
      }
    ]
  })
  await expect(
    f.call({
      kind: "save",
      revision: 0,
      profile: {
        ...profile(["base"], {}),
        flow: { definition: flow, digest: flowDigest(flow), revision: 1, updatedAt: 1 }
      }
    })
  ).rejects.toThrow("组件未加入")
  const saved = await f.call({
    kind: "save",
    revision: 0,
    profile: profile(["base", "review"], { review: { strict: false } })
  })
  expect(saved.profiles[0].capabilities[0].components?.config.review.strict).toBe(false)
  const applied = await f.call({ kind: "apply", revision: saved.revision, id: f.profile.id })
  expect(applied.active?.capabilities[0].components?.ids).toEqual(["base", "review"])
})

it("saves and applies a host flow with no Function Mods while retaining provider checks", async () => {
  const f = fixture()
  vi.mocked(f.functions.status).mockResolvedValue([])
  const definition = parseFlowDefinition(createHostReviewFlow("host"))
  const profile = {
    ...f.profile,
    capabilities: [],
    flow: { definition, digest: flowDigest(definition), revision: 1, updatedAt: 1 }
  }
  const saved = await f.call({ kind: "save", revision: 0, profile })
  expect(saved.profiles[0].flow?.definition).toEqual(definition)
  const applied = await f.call({ kind: "apply", revision: saved.revision, id: profile.id })
  expect(applied.active?.capabilities).toEqual([])
  expect(applied.active?.flow?.definition.schemaVersion).toBe(2)
  const withAction = parseFlowDefinition({
    ...definition,
    steps: [
      ...definition.steps,
      {
        id: "action",
        name: "Action",
        enabled: true,
        kind: "plugin-action",
        pluginId: "b",
        plugin: "b",
        digest: "b".repeat(64),
        actionId: "run",
        input: {}
      }
    ]
  })
  await expect(
    f.call({
      kind: "save",
      revision: applied.revision,
      profile: {
        ...profile,
        flow: { definition: withAction, digest: flowDigest(withAction), revision: 2, updatedAt: 2 }
      }
    })
  ).rejects.toThrow("动作来源未加入组合")
})
it("loads source metadata only on demand and rejects a changed scope after catalog await", async () => {
  const f = fixture()
  await f.view()
  expect(f.sources).not.toHaveBeenCalled()
  expect(await f.catalog()).toEqual(await f.sources())
  f.sources.mockImplementationOnce(async () => {
    f.state.workspace = "changed"
    return { skills: [], mcp: [] }
  })
  await expect(f.catalog()).rejects.toThrow("CLAW_SCOPE_CHANGED")
})

it("validates selected identities on save and again on apply without mutating a bound snapshot", async () => {
  const f = fixture()
  const sources = await f.sources()
  const selected = {
    ...f.profile,
    skills: { mode: "selected", items: sources.skills },
    mcp: { mode: "selected", items: [] }
  }
  await f.call({ kind: "save", profile: selected, revision: 0 })
  const bound = await f.call({ kind: "apply", id: "p", revision: 1 })
  expect(bound.active?.skills).toEqual(selected.skills)
  expect(bound.active?.mcp).toEqual(selected.mcp)
  await f.call({
    kind: "save",
    profile: { ...selected, skills: { mode: "all", items: [] } },
    revision: 2
  })
  expect((await f.view()).active?.skills).toEqual(selected.skills)
  f.sources.mockResolvedValue({ skills: [], mcp: [] })
  await expect(f.call({ kind: "save", profile: selected, revision: 3 })).rejects.toThrow("Skill A")
  expect((await f.view()).revision).toBe(3)
})

it("rejects a source removed between save and apply", async () => {
  const f = fixture()
  const sources = await f.sources()
  await f.call({
    kind: "save",
    profile: { ...f.profile, mcp: { mode: "selected", items: sources.mcp } },
    revision: 0
  })
  f.sources.mockResolvedValue({ skills: [], mcp: [] })
  await expect(f.call({ kind: "apply", id: "p", revision: 1 })).rejects.toThrow("MCP A")
  expect(f.invalidate).not.toHaveBeenCalled()
  expect((await f.view()).active).toBeNull()
})

it("saves without applying and only applies after idle validation with full invalidation", async () => {
  const f = fixture()
  expect((await f.call({ kind: "save", profile: f.profile, revision: 0 })).active).toBeNull()
  expect(f.invalidate).not.toHaveBeenCalled()
  f.state.idle = false
  await expect(f.call({ kind: "apply", id: "p", revision: 1 })).rejects.toThrow("busy")
  expect((await f.view()).revision).toBe(1)
  f.state.idle = true
  expect((await f.call({ kind: "apply", id: "p", revision: 1 })).active?.name).toBe("Profile")
  expect(f.invalidate).toHaveBeenCalledWith("thread")
  expect((await f.call({ kind: "apply", id: null, revision: 2 })).active).toBeNull()
})
it("rejects stale configuration, unauthorized version and unsupported threads", async () => {
  const f = fixture()
  await expect(f.call({ kind: "save", profile: f.profile, revision: 2 })).rejects.toThrow("已变化")
  await expect(
    f.call({
      kind: "save",
      profile: {
        ...f.profile,
        capabilities: [{ ...f.profile.capabilities[0], digest: "b".repeat(64) }]
      },
      revision: 0
    })
  ).rejects.toThrow("未授权")
  f.state.applicable = false
  await expect(f.call({ kind: "save", profile: f.profile, revision: 0 })).rejects.toThrow(
    "支持的本地项目会话"
  )
  expect(f.invalidate).not.toHaveBeenCalled()
})
it("rechecks scope and expected revision after asynchronous discovery", async () => {
  const f = fixture()
  vi.spyOn(f.functions, "status").mockImplementationOnce(async () => {
    f.state.workspace = "b"
    return []
  })
  await expect(f.call({ kind: "save", profile: f.profile, revision: 0 })).rejects.toThrow(
    "CLAW_SCOPE_CHANGED"
  )
  expect((await f.view()).profiles).toEqual([])
})

it("requires the project shown to the user even when the other project has the same revision", async () => {
  const f = fixture()
  f.state.workspace = "b"
  await expect(f.call({ kind: "save", profile: f.profile, revision: 0 })).rejects.toThrow(
    "项目目录已改变"
  )
  expect((await f.view()).profiles).toEqual([])
})

it("does not require a missing model from a disabled flow step when saving a composition", async () => {
  const f = fixture()
  const definition: FlowDefinition = {
    schemaVersion: 1,
    id: "flow",
    name: "Flow",
    plugin: "review",
    goal: "Work",
    timeoutMs: 1000,
    maxExecutions: 3,
    steps: [
      { id: "off", name: "Off", enabled: false, kind: "agent", prompt: "Work", modelId: "missing" },
      { id: "on", name: "On", enabled: true, kind: "approval", prompt: "Confirm" }
    ]
  }
  await f.call({
    kind: "save",
    revision: 0,
    profile: {
      ...f.profile,
      models: { default: "custom:live", roles: {} },
      flow: { definition, digest: flowDigest(definition), revision: 1, updatedAt: 1 }
    }
  })
  expect(f.validateModels).toHaveBeenCalledExactlyOnceWith(["custom:live"])
})

it("validates native step sources and model roles against the composition before saving", async () => {
  const f = fixture()
  const sources = await f.sources()
  const definition: FlowDefinition = {
    schemaVersion: 1,
    id: "native",
    name: "Native",
    plugin: "review",
    goal: "Work",
    timeoutMs: 1000,
    maxExecutions: 3,
    steps: [
      {
        id: "skill",
        name: "Skill",
        kind: "skill",
        enabled: true,
        skill: sources.skills[0],
        prompt: "Review",
        modelRole: "reviewer"
      }
    ]
  }
  const profile = {
    ...f.profile,
    skills: { mode: "selected" as const, items: sources.skills },
    flow: {
      definition,
      digest: flowDigest(parseFlowDefinition(definition)),
      revision: 1,
      updatedAt: 1
    }
  }
  await expect(f.call({ kind: "save", revision: 0, profile })).rejects.toThrow("缺少模型角色")
  const withModel = { ...profile, models: { roles: { reviewer: "custom:review" } } }
  await expect(
    f.call({
      kind: "save",
      revision: 0,
      profile: {
        ...withModel,
        skills: { mode: "selected", items: [] }
      }
    })
  ).rejects.toThrow("来源未加入组合")
  await f.call({ kind: "save", revision: 0, profile: withModel })
  expect(f.validateModels).toHaveBeenCalledWith(["custom:review"])
  f.sources.mockResolvedValue({ skills: [], mcp: sources.mcp })
  await expect(f.call({ kind: "apply", revision: 1, id: "p" })).rejects.toThrow("Skill")
})

it("rejects a stale MCP node even when the profile inherits all services", async () => {
  const f = fixture()
  const sources = await f.sources()
  const definition: FlowDefinition = {
    schemaVersion: 1,
    id: "native",
    name: "Native",
    plugin: "review",
    goal: "Work",
    timeoutMs: 1000,
    maxExecutions: 3,
    steps: [
      {
        id: "mcp",
        name: "Call",
        kind: "mcp-tool",
        enabled: true,
        provider: { ...sources.mcp[0], digest: "c".repeat(64) },
        toolName: "echo",
        schemaDigest: "d".repeat(64),
        input: {}
      }
    ]
  }
  await expect(
    f.call({
      kind: "save",
      revision: 0,
      profile: {
        ...f.profile,
        flow: {
          definition,
          digest: flowDigest(parseFlowDefinition(definition)),
          revision: 1,
          updatedAt: 1
        }
      }
    })
  ).rejects.toThrow("Call")
})

it("does not resolve disabled native sources or their missing model roles", async () => {
  const f = fixture()
  const definition = parseFlowDefinition({
    schemaVersion: 1,
    id: "disabled-native",
    name: "Disabled",
    plugin: "review",
    goal: "Work",
    timeoutMs: 1000,
    maxExecutions: 3,
    steps: [
      {
        id: "skill",
        name: "Skill",
        kind: "skill",
        enabled: false,
        skill: { id: "removed", name: "Removed", digest: "a".repeat(64) },
        prompt: "Review",
        modelRole: "removed",
        modelId: "removed-model"
      },
      {
        id: "mcp",
        name: "MCP",
        kind: "mcp-tool",
        enabled: false,
        provider: { id: "removed-mcp", name: "Removed", digest: "a".repeat(64) },
        toolName: "echo",
        schemaDigest: "b".repeat(64),
        input: {}
      },
      { id: "approve", name: "Approve", kind: "approval", enabled: true, prompt: "Confirm" }
    ]
  })
  await f.call({
    kind: "save",
    revision: 0,
    profile: {
      ...f.profile,
      flow: { definition, digest: flowDigest(definition), revision: 1, updatedAt: 1 }
    }
  })
  await f.call({ kind: "apply", revision: 1, id: "p" })
  expect(f.sources).not.toHaveBeenCalled()
  expect(f.validateModels).not.toHaveBeenCalled()
  expect((await f.view()).active?.flow?.definition.steps).toEqual(definition.steps)
})

it("does not treat same-name MCP providers as the same selected source", async () => {
  const f = fixture()
  const sources = await f.sources()
  const other = { ...sources.mcp[0], id: "other-provider" }
  f.sources.mockResolvedValue({ ...sources, mcp: [...sources.mcp, other] })
  const definition = parseFlowDefinition({
    schemaVersion: 1,
    id: "same-name",
    name: "Same name",
    plugin: "review",
    goal: "Work",
    timeoutMs: 1000,
    maxExecutions: 3,
    steps: [
      {
        id: "mcp",
        name: "MCP",
        kind: "mcp-tool",
        enabled: true,
        provider: other,
        toolName: "echo",
        schemaDigest: "b".repeat(64),
        input: {}
      }
    ]
  })
  await expect(
    f.call({
      kind: "save",
      revision: 0,
      profile: {
        ...f.profile,
        mcp: { mode: "selected", items: sources.mcp },
        flow: { definition, digest: flowDigest(definition), revision: 1, updatedAt: 1 }
      }
    })
  ).rejects.toThrow("来源未加入组合")
  expect((await f.view()).revision).toBe(0)
  expect(f.invalidate).not.toHaveBeenCalled()
})
