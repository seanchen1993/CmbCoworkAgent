import { expect, it } from "vitest"
import { parseClawProfile, type ClawView } from "../../../shared/mods/claw"
import type { ModWorkspaceStatus } from "../../../shared/mods/types"
import {
  applyExampleUse,
  prepareExampleUse,
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
