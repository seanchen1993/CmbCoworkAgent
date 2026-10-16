import { expect, it } from "vitest"
import { ClawStore } from "./claw-store"
import { clawIssues, parseClawProfile } from "../../shared/mods/claw"
import { isClawThread } from "./claw-scope"

const profile = {
  id: "review",
  name: "Review",
  capabilities: [{ pluginId: "a", name: "review", digest: "a".repeat(64) }]
}
function fixture() {
  const data = new Map<string, string>()
  const settings = {
    getSetting: (key: string, fallback = "") => data.get(key) ?? fallback,
    setSetting: (key: string, value: string) => {
      data.set(key, value)
    }
  }
  return { data, settings, store: new ClawStore(settings) }
}

it("freezes component configuration per binding while template edits preserve legacy selections", () => {
  const f = fixture()
  const composed = parseClawProfile({
    ...profile,
    capabilities: [
      {
        ...profile.capabilities[0],
        components: {
          mode: "selected",
          ids: ["review"],
          config: { review: { strict: false, count: 0, note: "" } }
        }
      }
    ]
  })
  f.store.write("a", { revision: 0, profiles: [composed], active: profile }, 0)
  f.store.apply("a", '["thread"]', composed, 1)
  const changed = structuredClone(composed)
  changed.capabilities[0].components!.config.review.strict = true
  f.store.write("a", { ...f.store.read("a"), profiles: [changed] }, 2)
  const reopened = new ClawStore(f.settings)
  expect(
    reopened.selection("a", '["thread"]').profile?.capabilities[0].components?.config.review
  ).toEqual({ strict: false, count: 0, note: "" })
  expect(reopened.read("a").active).toEqual(profile)
  expect(reopened.read("a").profiles[0].capabilities[0].components?.config.review.strict).toBe(true)
  expect(() => reopened.apply("a", '["thread"]', changed, 1)).toThrow("已变化")
})
it("distinguishes legacy defaults and empty selection, persists frozen profiles and isolates projects", () => {
  const f = fixture()
  expect(f.store.read("a").active).toBeNull()
  f.store.write("a", { revision: 0, profiles: [profile], active: profile }, 0)
  const next = f.store.read("a")
  next.profiles[0].capabilities = []
  f.store.write("a", next, 1)
  expect(new ClawStore(f.settings).read("a").active?.capabilities).toHaveLength(1)
  f.store.write("a", { ...next, active: { ...profile, capabilities: [] } }, 2)
  expect(f.store.read("a").active?.capabilities).toEqual([])
  expect(f.store.read("b").active).toBeNull()
  expect(() => f.store.write("a", next, 1)).toThrow("已变化")
})
it("does not recover corrupt state by enabling everything", () => {
  const f = fixture()
  f.store.write("a", { revision: 0, profiles: [], active: null }, 0)
  f.data.set([...f.data.keys()][0], '{"profiles":[],"revision":1}')
  expect(() => f.store.read("a")).toThrow()
})
it.each([
  null,
  {},
  { ...profile, capabilities: [profile.capabilities[0], profile.capabilities[0]] },
  { ...profile, capabilities: [{ ...profile.capabilities[0], digest: "bad" }] }
])("rejects malformed selection %j", (value) => expect(() => parseClawProfile(value)).toThrow())
it("requires the exact installed and approved identity", () => {
  const ready = { ...profile.capabilities[0], state: "ready" as const, capabilities: [] }
  expect(clawIssues(profile, [ready])).toEqual([])
  for (const candidate of [
    { ...ready, digest: "b".repeat(64) },
    { ...ready, pluginId: "replacement" },
    { ...ready, state: "disabled" as const }
  ])
    expect(clawIssues(profile, [candidate])).toHaveLength(1)
})

it("detaches uninstalled capabilities from live bindings durably without changing saved templates", () => {
  const f = fixture()
  const composed = parseClawProfile({
    ...profile,
    capabilities: [...profile.capabilities, { pluginId: "b", name: "other", digest: "b".repeat(64) }],
    completionRules: [{ ...profile.capabilities[0], policy: { mode: "check" } }],
    mcp: { mode: "selected", items: [
      { id: "plugin:a/server", name: "removed", digest: "a".repeat(64) },
      { id: "plugin:ab/server", name: "retained", digest: "b".repeat(64) }
    ] },
    models: { default: "model", roles: {} },
    builtins: { contextMeter: true }
  })
  f.store.write("a", { revision: 0, profiles: [composed], active: composed }, 0)
  f.store.apply("a", '["selected"]', composed, 1)
  f.store.apply("a", '["inherited"]', null, 2)
  f.store.write("other", { revision: 0, profiles: [], active: profile }, 0)
  f.store.reconcileInstalledPlugins("a", new Set(["b", "ab"]))
  const reopened = new ClawStore(f.settings)
  const state = reopened.read("a")
  expect(state.revision).toBe(4)
  expect(state.profiles).toEqual([composed])
  expect(state.active).toEqual({ ...composed, capabilities: [composed.capabilities[1]],
    completionRules: [], mcp: { mode: "selected", items: [composed.mcp!.items[1]] } })
  expect(reopened.selection("a", '["selected"]')).toEqual({ revision: 4, profile: state.active })
  expect(reopened.selection("a", '["inherited"]')).toEqual({ revision: 3, profile: null })
  expect(reopened.read("other").active).toEqual(profile)
  expect(() => reopened.apply("a", '["selected"]', composed, 3)).toThrow("已变化")
  reopened.reconcileInstalledPlugins("a", new Set(["b", "ab"]))
  expect(reopened.read("a").revision).toBe(4)
  reopened.reconcileInstalledPlugins("a", new Set())
  expect(reopened.selection("a", '["selected"]').profile?.capabilities).toEqual([])
  expect(reopened.selection("a", '["selected"]').profile).not.toBeNull()
})

it("keeps installed-but-disabled, unapproved or broken packages pinned and rejects corrupt state", () => {
  const f = fixture()
  f.store.write("a", { revision: 0, profiles: [profile], active: profile }, 0)
  f.store.reconcileInstalledPlugins("a", new Set(["a"]))
  expect(f.store.read("a")).toEqual({ revision: 1, profiles: [profile], active: profile })
  f.data.set(JSON.stringify(["claw-profiles-v1", "a"]), "broken")
  expect(() => f.store.reconcileInstalledPlugins("a", new Set())).toThrow()
})
it("limits selection to ordinary chat and its host-created flow children", () => {
  const rows: Record<string, { metadata: object }> = {
    normal: { metadata: { workspacePath: "a" } },
    child: {
      metadata: {
        workspacePath: "a",
        parentThreadId: "normal",
        workflowRunId: "run",
        isInternalFlowRuntime: true
      }
    }
  }
  const read = (id: string) => rows[id] ?? null
  expect(isClawThread("normal", read)).toBe(true)
  expect(isClawThread("child", read)).toBe(true)
  for (const metadata of [
    { workspacePath: "a", harnessProjectId: "p" },
    { workspacePath: "a", scheduledTaskId: "s" },
    { workspacePath: "a", parentThreadId: "normal" },
    { workspacePath: "a", remoteThread: true }
  ]) {
    rows.other = { metadata }
    expect(isClawThread("other", read)).toBe(false)
  }
})

it("inherits nested children through canonical Windows workspace paths and rejects broken parent chains", () => {
  const rows: Record<string, { metadata: object }> = {
    root: { metadata: { workspacePath: "C:/Project" } },
    child: {
      metadata: { workspacePath: "c:/project", parentThreadId: "root", isInternalFlowRuntime: true }
    },
    nested: {
      metadata: {
        workspacePath: "C:/PROJECT",
        parentThreadId: "child",
        isInternalFlowRuntime: true
      }
    }
  }
  const read = (id: string) => rows[id] ?? null
  expect(isClawThread("nested", read, (path) => path.toLowerCase())).toBe(true)
  rows.root.metadata = {
    workspacePath: "c:/project",
    parentThreadId: "nested",
    isInternalFlowRuntime: true
  }
  expect(() => isClawThread("nested", read, (path) => path.toLowerCase())).toThrow(
    "CLAW_PARENT_SCOPE_INVALID"
  )
  rows.root.metadata = { workspacePath: "other" }
  expect(() => isClawThread("nested", read, (path) => path.toLowerCase())).toThrow(
    "CLAW_PARENT_SCOPE_INVALID"
  )
})
