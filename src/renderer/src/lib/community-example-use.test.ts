import { expect, it } from "vitest"
import { parseClawProfile, type ClawView } from "../../../shared/mods/claw"
import type { ModWorkspaceStatus } from "../../../shared/mods/types"
import {
  applyExampleUse,
  applyInstalledPluginUse,
  prepareExampleUse,
  prepareInstalledPluginUse,
  readExampleUsage,
  type ExampleUseApi
} from "./community-example-use"

function fixture(implicit = false) {
  let global = false
  let live = true
  const calls: string[] = []
  const status: ModWorkspaceStatus = {
    workspace: "C:/owned",
    enabled: false,
    outputPolicy: true,
    mods: [],
    diagnostics: [],
    functionMods: [
      {
        pluginId: "weather",
        name: "token-weather",
        digest: "a".repeat(64),
        state: "ready",
        capabilities: ["ui.render"]
      },
      {
        pluginId: "replay",
        name: "replay-theater",
        digest: "b".repeat(64),
        state: "needs-approval",
        capabilities: ["ui.render", "file.read"]
      },
      { pluginId: "other", name: "other", digest: "c".repeat(64), state: "ready", capabilities: [] }
    ]
  }
  const original = parseClawProfile({
    id: "original",
    name: "我的助手",
    capabilities: status
      .functionMods!.filter((row) => row.state === "ready")
      .map((row) => ({
        pluginId: row.pluginId,
        name: row.name,
        digest: row.digest!
      })),
    models: { default: "main", roles: { review: "reviewer" } },
    skills: { mode: "selected", items: [] },
    mcp: { mode: "selected", items: [] },
    builtins: { contextMeter: true }
  })
  const claw: ClawView = {
    workspace: status.workspace,
    revision: 4,
    bindingRevision: 2,
    enabled: false,
    applicable: true,
    issues: [],
    capabilities: status.functionMods!,
    profiles: [structuredClone(original)],
    active: implicit ? null : structuredClone(original)
  }
  let afterSave: (() => void) | undefined
  let afterGrant: (() => void) | undefined
  const api: ExampleUseApi = {
    status: async () => structuredClone(status),
    globalEnabled: async () => global,
    clawView: async () => structuredClone(claw),
    configureGlobal: async (enabled) => {
      calls.push("global")
      global = enabled
      return global
    },
    configure: async (_thread, enabled, outputPolicy, workspace) => {
      expect(workspace).toBe(status.workspace)
      expect(outputPolicy).toBe(true)
      calls.push("project")
      status.enabled = enabled
    },
    approveFunction: async (thread, id, digest, workspace) => {
      expect([thread, id, digest, workspace]).toEqual([
        "thread",
        "replay",
        "b".repeat(64),
        status.workspace
      ])
      calls.push("grant")
      status.functionMods![1].state = "ready"
      afterGrant?.()
    },
    clawChange: async (_thread, mutation) => {
      expect(mutation.workspace).toBe(status.workspace)
      expect(mutation.revision).toBe(claw.revision)
      calls.push(mutation.kind)
      if (mutation.kind === "save") {
        const profile = parseClawProfile(mutation.profile)
        claw.profiles = [...claw.profiles.filter((row) => row.id !== profile.id), profile]
        claw.revision++
        afterSave?.()
      } else {
        expect(mutation.bindingRevision).toBe(claw.bindingRevision)
        claw.active = claw.profiles.find((row) => row.id === mutation.id)!
        claw.bindingRevision = ++claw.revision
      }
      return structuredClone(claw)
    }
  }
  const context = {
    threadId: "thread",
    workspace: status.workspace,
    assertCurrent: () => {
      if (!live) throw Error("SCOPE_CHANGED")
    }
  }
  const installation = {
    pluginId: "replay",
    pluginName: "replay-theater",
    alreadyInstalled: true,
    requiresApproval: true as const
  }
  return {
    api,
    context,
    installation,
    calls,
    claw,
    status,
    original,
    invalidate: () => {
      live = false
    },
    setAfterSave: (fn: () => void) => {
      afterSave = fn
    },
    setAfterGrant: (fn: () => void) => {
      afterGrant = fn
    }
  }
}

it("prepares read-only consent, then replaces Weather while preserving every other selection", async () => {
  const f = fixture()
  const plan = await prepareExampleUse(f.api, f.context, f.installation)
  expect(f.calls).toEqual([])
  expect(plan.selection.removed.map((row) => row.name)).toEqual(["token-weather"])
  await applyExampleUse(f.api, f.context, plan, () => {})
  expect(f.calls).toEqual(["grant", "save", "apply", "global", "project"])
  expect(f.claw.active?.capabilities.map((row) => row.name)).toEqual(["other", "replay-theater"])
  for (const key of ["models", "skills", "mcp", "builtins"] as const)
    expect(f.claw.active?.[key]).toEqual(f.original[key])
  expect(f.claw.profiles.find((row) => row.id === "original")).toEqual(f.original)
})

it("uses the catalogue title for a new combination while preserving existing user names", async () => {
  const f = fixture()
  const plan = await prepareExampleUse(f.api, f.context, f.installation, "修改回放")
  expect(plan.selection.profile.name).toBe("官方示例 · 修改回放")
  expect(plan.target.name).toBe("replay-theater")
  await applyExampleUse(f.api, f.context, plan, () => {})
  f.claw.active!.name = "我的回放搭配"
  f.claw.profiles.find((row) => row.id === f.claw.active!.id)!.name = "我的回放搭配"
  const reused = await prepareExampleUse(f.api, f.context, f.installation, "修改回放")
  expect(reused.selection.profile.name).toBe("我的回放搭配")
})

it("pins the implicit ready selection before granting, and enables execution only after applying", async () => {
  const f = fixture(true)
  const plan = await prepareExampleUse(f.api, f.context, f.installation)
  await applyExampleUse(f.api, f.context, plan, () => {})
  expect(f.calls).toEqual(["save", "apply", "grant", "save", "apply", "global", "project"])
  expect(f.claw.profiles[1].capabilities.map((row) => row.name)).toEqual(["token-weather", "other"])
})

it.each(["revision", "binding", "digest", "grant", "policy", "scope"])(
  "rejects stale %s before any write",
  async (change) => {
    const f = fixture()
    const plan = await prepareExampleUse(f.api, f.context, f.installation)
    if (change === "revision") f.claw.revision++
    if (change === "binding") f.claw.bindingRevision++
    if (change === "digest") f.status.functionMods![1].digest = "d".repeat(64)
    if (change === "grant") f.status.functionMods![0].state = "needs-approval"
    if (change === "policy") f.status.outputPolicy = false
    if (change === "scope") f.invalidate()
    await expect(applyExampleUse(f.api, f.context, plan, () => {})).rejects.toThrow()
    expect(f.calls).toEqual([])
  }
)

it("refuses to absorb concurrent selection changes from an awaited save response", async () => {
  const f = fixture(true)
  const plan = await prepareExampleUse(f.api, f.context, f.installation)
  f.setAfterSave(() => {
    f.claw.bindingRevision = ++f.claw.revision
    f.claw.active = f.original
  })
  await expect(applyExampleUse(f.api, f.context, plan, () => {})).rejects.toThrow(
    "写入后的状态已变化"
  )
  expect(f.calls).toEqual(["save"])
})

it("stops after an unknown grant result, and an explicit fresh attempt does not repeat the grant", async () => {
  const f = fixture(true)
  const plan = await prepareExampleUse(f.api, f.context, f.installation)
  f.setAfterGrant(() => {
    throw Error("transport interrupted")
  })
  await expect(applyExampleUse(f.api, f.context, plan, () => {})).rejects.toThrow(
    "transport interrupted"
  )
  expect(f.calls).toEqual(["save", "apply", "grant"])
  expect(f.claw.active?.capabilities.some((row) => row.name === "replay-theater")).toBe(false)
  const refreshed = await prepareExampleUse(f.api, f.context, f.installation)
  await applyExampleUse(f.api, f.context, refreshed, () => {})
  expect(f.calls.filter((call) => call === "grant")).toHaveLength(1)
  expect(f.claw.active?.capabilities.some((row) => row.name === "replay-theater")).toBe(true)
})

it("does not grant, apply or enable after leaving while the baseline save is pending", async () => {
  const f = fixture(true)
  const plan = await prepareExampleUse(f.api, f.context, f.installation)
  f.setAfterSave(f.invalidate)
  await expect(applyExampleUse(f.api, f.context, plan, () => {})).rejects.toThrow("SCOPE_CHANGED")
  expect(f.calls).toEqual(["save"])
})

it("does not create another profile when the exact target is already selected", async () => {
  const f = fixture()
  let plan = await prepareExampleUse(f.api, f.context, f.installation)
  await applyExampleUse(f.api, f.context, plan, () => {})
  f.calls.length = 0
  plan = await prepareExampleUse(f.api, f.context, f.installation)
  await applyExampleUse(f.api, f.context, plan, () => {})
  expect(f.calls).toEqual([])
})

it("checks room for both baseline and example before any grant or write", async () => {
  const f = fixture(true)
  f.claw.profiles = Array.from({ length: 23 }, (_, index) => ({
    ...structuredClone(f.original),
    id: `saved-${index}`
  }))
  await expect(prepareExampleUse(f.api, f.context, f.installation)).rejects.toThrow("24 个保存上限")
  expect(f.calls).toEqual([])
})

it("reuses exact saved compositions across repeated Weather and Replay switches", async () => {
  const f = fixture()
  for (let index = 0; index < 40; index++) {
    const installation =
      index % 2 === 0
        ? f.installation
        : {
            ...f.installation,
            pluginId: "weather",
            pluginName: "token-weather"
          }
    const plan = await prepareExampleUse(f.api, f.context, installation)
    await applyExampleUse(f.api, f.context, plan, () => {})
    expect(f.claw.active?.capabilities.map((row) => row.name)).toEqual([
      "other",
      installation.pluginName
    ])
    expect(f.claw.active?.models).toEqual(f.original.models)
  }
  expect(f.claw.profiles).toHaveLength(3)
  expect(f.calls.filter((call) => call === "save")).toHaveLength(2)
  expect(f.claw.profiles.find((row) => row.id === "original")).toEqual(f.original)
})

it("reuses a saved candidate after failed apply without repeating save or grant", async () => {
  const f = fixture()
  const change = f.api.clawChange
  f.api.clawChange = async (thread, mutation) => {
    if (mutation.kind === "apply") throw Error("apply interrupted")
    return change(thread, mutation)
  }
  const plan = await prepareExampleUse(f.api, f.context, f.installation)
  await expect(applyExampleUse(f.api, f.context, plan, () => {})).rejects.toThrow(
    "apply interrupted"
  )
  const saved = structuredClone(f.claw.profiles)
  f.api.clawChange = change
  f.calls.length = 0
  const refreshed = await prepareExampleUse(f.api, f.context, f.installation)
  await applyExampleUse(f.api, f.context, refreshed, () => {})
  expect(f.calls).toEqual(["apply", "global", "project"])
  expect(f.claw.profiles).toEqual(saved)
  expect(f.claw.active?.id).toBe(plan.selection.profile.id)
})

it("can use an identical saved composition at capacity without overwriting its name", async () => {
  const f = fixture()
  const plan = await prepareExampleUse(f.api, f.context, f.installation)
  f.claw.profiles = [
    parseClawProfile({ ...plan.selection.profile, name: "自定义名称" }),
    ...Array.from({ length: 23 }, (_, index) => ({
      ...structuredClone(f.original),
      id: `saved-${index}`
    }))
  ]
  const refreshed = await prepareExampleUse(f.api, f.context, f.installation)
  await applyExampleUse(f.api, f.context, refreshed, () => {})
  expect(f.claw.profiles).toHaveLength(24)
  expect(f.claw.active?.name).toBe("自定义名称")
  expect(f.calls).toEqual(["grant", "apply", "global", "project"])
})

it("does not reuse similar profiles with different model or component settings", async () => {
  const f = fixture()
  const plan = await prepareExampleUse(f.api, f.context, f.installation)
  const models = structuredClone(plan.selection.profile)
  models.id = "different-model"
  models.models!.default = "different"
  const components = structuredClone(plan.selection.profile)
  components.id = "different-components"
  components.capabilities[1].components = { mode: "selected", ids: ["panel"], config: {} }
  f.claw.profiles.push(parseClawProfile(models), parseClawProfile(components))
  const refreshed = await prepareExampleUse(f.api, f.context, f.installation)
  expect(f.claw.profiles.some((row) => row.id === refreshed.selection.profile.id)).toBe(false)
  await applyExampleUse(f.api, f.context, refreshed, () => {})
  expect(f.calls).toContain("save")
})

it("reloads installed usage from the current chat and reports conflicts without writes", async () => {
  const f = fixture()
  const examples = [
    {
      id: "replay-theater" as const,
      pluginName: "replay-theater",
      title: "Replay",
      description: "",
      usage: "",
      commit: "",
      upstreamUrl: "",
      installation: { state: "installed" as const, pluginId: "replay" }
    }
  ]
  expect(await readExampleUsage(f.api, f.context, examples)).toEqual({
    "replay-theater": "conflict"
  })
  expect(f.calls).toEqual([])
  const plan = await prepareExampleUse(f.api, f.context, f.installation)
  await applyExampleUse(f.api, f.context, plan, () => {})
  expect(await readExampleUsage(f.api, f.context, examples)).toEqual({ "replay-theater": "using" })
  f.status.enabled = false
  expect(await readExampleUsage(f.api, f.context, examples)).toEqual({
    "replay-theater": "installed"
  })
  f.invalidate()
  await expect(readExampleUsage(f.api, f.context, examples)).rejects.toThrow("SCOPE_CHANGED")
})

it("previews only applicable example components and invalidates a mode change before writes", async () => {
  const f = fixture(true)
  f.status.functionMods![1].components = [
    {
      id: "chat",
      name: "Chat",
      kind: "module",
      entry: "chat.ts",
      dependsOn: [],
      actionIds: [],
      usage: "chat"
    },
    {
      id: "project",
      name: "Project",
      kind: "module",
      entry: "project.ts",
      dependsOn: [],
      actionIds: [],
      usage: "project"
    }
  ]
  const plan = await prepareExampleUse(f.api, f.context, f.installation)
  expect(
    plan.selection.profile.capabilities.find((item) => item.pluginId === "replay")?.components
  ).toEqual({ mode: "selected", ids: ["chat"], config: {} })
  expect(f.calls).toEqual([])
  f.claw.usageContext = "project"
  await expect(applyExampleUse(f.api, f.context, plan, () => {})).rejects.toThrow("已变化")
  expect(f.calls).toEqual([])
})

it("adds a ready installed plugin without inferring official example conflicts or losing settings", async () => {
  const f = fixture()
  f.status.functionMods![1].state = "ready"
  f.claw.active!.completionRules = []
  f.claw.active!.flow = {
    revision: 1,
    digest: "f".repeat(64),
    updatedAt: 1,
    definition: {
      schemaVersion: 2,
      id: "kept-flow",
      name: "保留流程",
      goal: "keep",
      execution: { kind: "host" },
      timeoutMs: 1000,
      maxExecutions: 1,
      steps: [{ id: "keep", name: "保留", kind: "agent", enabled: true, prompt: "保留原流程" }]
    }
  }
  const previous = structuredClone(f.claw.active!)
  const plan = await prepareInstalledPluginUse(f.api, f.context, f.installation, "我的回放")
  expect(f.calls).toEqual([])
  expect(plan.selection.alreadySelected).toBe(false)
  expect(plan.selection.profile.name).toBe("使用插件 · 我的回放")
  expect(plan.replacements).toEqual([])
  await applyInstalledPluginUse(f.api, f.context, plan, () => {})
  expect(f.calls).toEqual(["save", "apply", "global", "project"])
  expect(f.claw.active?.capabilities.map((row) => row.name)).toEqual([
    "token-weather",
    "other",
    "replay-theater"
  ])
  expect(f.claw.profiles.find((row) => row.id === "original")).toEqual(f.original)
  for (const key of ["models", "skills", "mcp", "builtins", "flow", "completionRules"] as const)
    expect(f.claw.active?.[key]).toEqual(previous[key])
})

it("keeps an exact implicit ready plugin unbound without saving another composition", async () => {
  const f = fixture(true)
  const plan = await prepareInstalledPluginUse(f.api, f.context, {
    pluginId: "other",
    pluginName: "other"
  })
  expect(plan.selection.alreadySelected).toBe(true)
  expect(plan.replacements).toEqual([])
  await applyInstalledPluginUse(f.api, f.context, plan, () => {})
  expect(f.calls).toEqual(["global", "project"])
  expect(f.claw.active).toBeNull()
})

it("refuses an invalid empty component choice instead of claiming the installed source is usable", async () => {
  const f = fixture()
  const mod = f.status.functionMods![1]
  mod.state = "ready"
  mod.components = [
    {
      id: "panel",
      name: "Panel",
      kind: "module",
      entry: "panel.ts",
      dependsOn: [],
      actionIds: [],
      usage: "chat"
    }
  ]
  f.claw.active!.capabilities = [
    {
      pluginId: mod.pluginId,
      name: mod.name,
      digest: mod.digest!,
      components: { mode: "selected", ids: [], config: {} }
    }
  ]
  await expect(prepareInstalledPluginUse(f.api, f.context, f.installation)).rejects.toThrow(
    "已选组件"
  )
  expect(f.calls).toEqual([])
})

it("preserves a nonempty installed component choice and its parameters across a source update", async () => {
  const f = fixture()
  const mod = f.status.functionMods![1]
  mod.state = "ready"
  mod.components = ["panel", "helper"].map((id) => ({
    id,
    name: id,
    kind: "module" as const,
    entry: `${id}.ts`,
    dependsOn: [],
    actionIds: [],
    usage: "chat" as const
  }))
  const components = {
    mode: "selected" as const,
    ids: ["panel"],
    config: { panel: { label: "mine" } }
  }
  f.claw.active!.capabilities = [
    { pluginId: mod.pluginId, name: mod.name, digest: "e".repeat(64), components }
  ]
  const plan = await prepareInstalledPluginUse(f.api, f.context, f.installation)
  expect(plan.replacements).toMatchObject([
    {
      previous: { digest: "e".repeat(64), components },
      next: { digest: mod.digest, components },
      reason: "version"
    }
  ])
  await applyInstalledPluginUse(f.api, f.context, plan, () => {})
  expect(f.claw.active!.capabilities[0].components).toEqual(components)
})

it("refuses unavailable selected components instead of silently discarding their parameters", async () => {
  const f = fixture()
  const mod = f.status.functionMods![1]
  mod.state = "ready"
  mod.components = [
    {
      id: "new",
      name: "New",
      kind: "module",
      entry: "new.ts",
      dependsOn: [],
      actionIds: [],
      usage: "chat"
    }
  ]
  f.claw.active!.capabilities = [
    {
      pluginId: mod.pluginId,
      name: mod.name,
      digest: mod.digest!,
      components: { mode: "selected", ids: ["old"], config: { old: { label: "mine" } } }
    }
  ]
  await expect(prepareInstalledPluginUse(f.api, f.context, f.installation)).rejects.toThrow(
    "已选组件"
  )
  expect(f.calls).toEqual([])
})

it("pins the exact chat in an installed plan even when another chat has identical directory state", async () => {
  const f = fixture()
  const plan = await prepareInstalledPluginUse(f.api, f.context, f.installation)
  await expect(
    applyInstalledPluginUse(f.api, { ...f.context, threadId: "other-chat" }, plan, () => {})
  ).rejects.toThrow("范围已变化")
  expect(f.calls).toEqual([])
})

it("reviews a disabled installed source without mutation and enables, grants and selects after one consent", async () => {
  const f = fixture(true)
  f.status.functionMods![1].state = "disabled"
  const installation = { ...f.installation, activationRequired: true }
  const plan = await prepareInstalledPluginUse(f.api, f.context, installation)
  expect(plan.activationRequired).toBe(true)
  expect(f.calls).toEqual([])
  await expect(applyInstalledPluginUse(f.api, f.context, plan, () => {})).rejects.toThrow(
    "尚未启用"
  )
  expect(f.calls).toEqual([])
  const result = await applyInstalledPluginUse(f.api, f.context, plan, () => {}, {
    enable: async () => {
      f.calls.push("enable")
      f.status.functionMods![1].state = "needs-approval"
    },
    configurationReady: async () => true
  })
  expect(result).toEqual({ state: "ready" })
  expect(f.calls).toEqual(["save", "apply", "enable", "grant", "save", "apply", "global", "project"])
  expect(f.claw.active?.capabilities.map((row) => row.pluginId)).toEqual([
    "weather", "other", "replay"
  ])
})

it("uses a native retained exact grant after enablement without granting it a second time", async () => {
  const f = fixture()
  f.status.functionMods![1].state = "disabled"
  const plan = await prepareInstalledPluginUse(f.api, f.context, {
    ...f.installation,
    activationRequired: true
  })
  await applyInstalledPluginUse(f.api, f.context, plan, () => {}, {
    enable: async () => {
      f.calls.push("enable")
      f.status.functionMods![1].state = "ready"
    },
    configurationReady: async () => true
  })
  expect(f.calls.filter((call) => call === "enable")).toHaveLength(1)
  expect(f.calls).not.toContain("grant")
  const ready = await prepareInstalledPluginUse(f.api, f.context, f.installation)
  expect(ready.selection.alreadySelected).toBe(true)
  f.calls.length = 0
  await applyInstalledPluginUse(f.api, f.context, ready, () => {})
  expect(f.calls).toEqual([])
})

it("retains the one exact consent through required native configuration without authorizing early", async () => {
  const f = fixture()
  f.status.functionMods![1].state = "disabled"
  const plan = await prepareInstalledPluginUse(f.api, f.context, {
    ...f.installation,
    activationRequired: true
  })
  const result = await applyInstalledPluginUse(f.api, f.context, plan, () => {}, {
    enable: async () => {
      f.calls.push("enable")
      f.status.functionMods![1].state = "needs-approval"
    },
    configurationReady: async () => false
  })
  expect(result.state).toBe("configuration")
  expect(f.calls).toEqual(["enable"])
  if (result.state !== "configuration") throw Error("CONFIGURATION_PLAN_REQUIRED")
  expect(result.plan.activationRequired).toBe(false)
  await applyInstalledPluginUse(f.api, f.context, result.plan, () => {})
  expect(f.calls).toEqual(["enable", "grant", "save", "apply", "global", "project"])
})

it.each(["digest", "chat", "workspace", "selection"])(
  "refuses retained configuration consent after the %s changes",
  async (change) => {
    const f = fixture()
    f.status.functionMods![1].state = "disabled"
    const plan = await prepareInstalledPluginUse(f.api, f.context, {
      ...f.installation,
      activationRequired: true
    })
    const result = await applyInstalledPluginUse(f.api, f.context, plan, () => {}, {
      enable: async () => { f.status.functionMods![1].state = "needs-approval" },
      configurationReady: async () => false
    })
    if (result.state !== "configuration") throw Error("CONFIGURATION_PLAN_REQUIRED")
    if (change === "digest") f.status.functionMods![1].digest = "e".repeat(64)
    if (change === "selection") f.claw.bindingRevision++
    const context = {
      ...f.context,
      ...(change === "chat" ? { threadId: "another-chat" } : {}),
      ...(change === "workspace" ? { workspace: "C:/another" } : {})
    }
    await expect(applyInstalledPluginUse(f.api, context, result.plan, () => {})).rejects.toThrow(
      "已变化"
    )
    expect(f.calls).toEqual([])
  }
)

it("does not retry an unknown catalog enablement or grant execution on its behalf", async () => {
  const f = fixture()
  f.status.functionMods![1].state = "disabled"
  const plan = await prepareInstalledPluginUse(f.api, f.context, {
    ...f.installation,
    activationRequired: true
  })
  const activation = {
    enable: async () => {
      f.calls.push("enable")
      f.status.functionMods![1].state = "needs-approval"
      throw Error("LOST_ENABLE_REPLY")
    },
    configurationReady: async () => true
  }
  await expect(applyInstalledPluginUse(f.api, f.context, plan, () => {}, activation)).rejects.toThrow(
    "LOST_ENABLE_REPLY"
  )
  await expect(applyInstalledPluginUse(f.api, f.context, plan, () => {}, activation)).rejects.toThrow(
    "已变化"
  )
  expect(f.calls).toEqual(["enable"])
})

it("requires a fresh installed plan after a lost grant reply and does not grant twice", async () => {
  const f = fixture()
  const plan = await prepareInstalledPluginUse(f.api, f.context, f.installation)
  f.setAfterGrant(() => {
    throw Error("lost grant reply")
  })
  await expect(applyInstalledPluginUse(f.api, f.context, plan, () => {})).rejects.toThrow(
    "lost grant reply"
  )
  expect(f.calls).toEqual(["grant"])
  await expect(applyInstalledPluginUse(f.api, f.context, plan, () => {})).rejects.toThrow("已变化")
  expect(f.calls).toEqual(["grant"])
  const refreshed = await prepareInstalledPluginUse(f.api, f.context, f.installation)
  await applyInstalledPluginUse(f.api, f.context, refreshed, () => {})
  expect(f.calls.filter((call) => call === "grant")).toHaveLength(1)
})

it.each(["capacity", "identity"])(
  "blocks installed %s conflicts without removing another source",
  async (change) => {
    const f = fixture()
    f.claw.active!.capabilities =
      change === "capacity"
        ? Array.from({ length: 8 }, (_, index) => ({
            pluginId: `source-${index}`,
            name: `source-${index}`,
            digest: "f".repeat(64)
          }))
        : [{ pluginId: "different-id", name: f.installation.pluginName, digest: "f".repeat(64) }]
    const previous = structuredClone(f.claw.active)
    await expect(prepareInstalledPluginUse(f.api, f.context, f.installation)).rejects.toThrow(
      change === "capacity" ? "上限" : "身份已变化"
    )
    expect(f.calls).toEqual([])
    expect(f.claw.active).toEqual(previous)
  }
)

it("does not call a selected source usable while native combination issues remain", async () => {
  const f = fixture()
  f.claw.issues = ["技能来源已变化"]
  await expect(
    prepareInstalledPluginUse(f.api, f.context, {
      pluginId: "other",
      pluginName: "other"
    })
  ).rejects.toThrow("待处理问题")
  expect(f.calls).toEqual([])
})
