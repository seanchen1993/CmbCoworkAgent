import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { RuntimePluginSourceBinding } from "./plugins/runtime-source-scope"
import type { PluginMetadata } from "./types"

vi.mock("electron", () => ({ app: {} }))

const previous = process.env.CMB_COWORK_AGENT_HOME
let root: string | undefined
afterEach(() => {
  vi.resetModules()
  if (previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = previous
  if (root) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("cmb-runtime-skills-")
    )
      throw Error("Unsafe fixture cleanup")
    rmSync(root, { recursive: true, force: true })
    root = undefined
  }
})

async function fixture() {
  root = mkdtempSync(join(tmpdir(), "cmb-runtime-skills-"))
  process.env.CMB_COWORK_AGENT_HOME = join(root, "home")
  const plugin = (id: string): PluginMetadata => {
    const path = join(root!, id)
    mkdirSync(join(path, "skills"), { recursive: true })
    writeFileSync(join(path, "plugin.json"), JSON.stringify({ name: id, version: "1.0.0" }))
    return {
      id,
      path,
      name: id,
      version: "1.0.0",
      description: "",
      author: "",
      enabled: true,
      createdAt: "",
      updatedAt: "",
      skillCount: 1,
      hookCount: 0,
      mcpServerCount: 0
    }
  }
  const parent = plugin("parent"),
    selected = plugin("selected")
  vi.resetModules()
  const runtime = await import("./plugins/runtime-source-scope")
  const storage = await import("./storage")
  const binding: RuntimePluginSourceBinding = {
    plugin: parent,
    mode: "capabilities",
    preserveParentContext: false,
    capabilitySources: [
      {
        plugin: selected,
        packageDigest: "b".repeat(64),
        capability: {
          id: "selected-skill",
          title: "Selected",
          kind: "flow",
          usage: "project",
          entry: "skills/selected/SKILL.md",
          dependsOn: []
        }
      }
    ],
    threadId: "real-thread",
    incarnationKey: "incarnation",
    projectId: "native-project",
    operationId: "operation",
    workspace: root,
    packageDigest: "a".repeat(64),
    stageId: "stage"
  }
  return { runtime, storage, binding, parent, selected }
}

it.each(["metadata", "directories"] as const)(
  "reads authority once for each %s projection and rejects revocation on the next public call",
  async (kind) => {
    const f = await fixture()
    let current = true
    const authority = vi.fn(() => {
      if (!current) throw Error("SOURCE_REVOKED")
    })
    const token = f.runtime.issueRuntimePluginSourceToken(f.binding, undefined, authority)
    f.runtime.withRuntimePluginSource(token, () => {
      const read = () =>
        kind === "metadata"
          ? f.storage.getEnabledPluginSkillSourceMetadata().map((item) => item.sourceDir)
          : f.storage.getEnabledPluginSkillsSources()
      authority.mockClear()
      expect(read()).toEqual([join(f.selected.path, "skills", "selected")])
      expect(authority).toHaveBeenCalledTimes(1)
      current = false
      expect(read).toThrow("SOURCE_REVOKED")
      expect(authority).toHaveBeenCalledTimes(2)
    })
  }
)

it.each([
  ["legacy", undefined, ["selected", "parent"]],
  ["host", undefined, ["selected", "parent"]],
  ["capabilities", true, ["selected", "parent"]],
  ["capabilities", false, ["selected"]],
  ["capabilities", undefined, ["selected"]]
] as const)(
  "preserves %s parent selection when preserveParentContext is %s",
  async (mode, preserve, expected) => {
    const f = await fixture()
    const token = f.runtime.issueRuntimePluginSourceToken({
      ...f.binding,
      mode,
      preserveParentContext: preserve
    })
    f.runtime.withRuntimePluginSource(token, () => {
      expect(f.storage.getEnabledPluginSkillSourceMetadata().map((item) => item.pluginId)).toEqual(
        expected
      )
    })
  }
)

it("keeps an explicit empty capability selection isolated from ambient installed plugins", async () => {
  const f = await fixture()
  mkdirSync(process.env.CMB_COWORK_AGENT_HOME!, { recursive: true })
  writeFileSync(
    join(process.env.CMB_COWORK_AGENT_HOME!, "plugins.json"),
    JSON.stringify([f.selected])
  )
  const token = f.runtime.issueRuntimePluginSourceToken({ ...f.binding, capabilitySources: [] })
  f.runtime.withRuntimePluginSource(token, () => {
    expect(f.storage.getEnabledPluginSkillSourceMetadata()).toEqual([])
    expect(f.storage.getEnabledPluginSkillsSources()).toEqual([])
  })
})
