import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [] },
  shell: { trashItem: vi.fn() }
}))
const roots: string[] = []
const previous = process.env.CMB_COWORK_AGENT_HOME
afterEach(() => {
  if (previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = previous
  vi.resetModules()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe("scoped production Skill and Hook readers", () => {
  it("bypasses and never contaminates global plugin caches", async () => {
    const root = mkdtempSync(join(tmpdir(), "scoped-plugin-readers-"))
    roots.push(root)
    process.env.CMB_COWORK_AGENT_HOME = join(root, "app")
    mkdirSync(process.env.CMB_COWORK_AGENT_HOME)
    vi.resetModules()
    const storage = await import("../storage")
    const scope = await import("./runtime-source-scope")
    const plugin = {
      id: "plugin-uuid",
      name: "docs",
      version: "1",
      description: "",
      author: "",
      path: join(root, "installed"),
      enabled: true,
      skillCount: 1,
      mcpServerCount: 0,
      hookCount: 1,
      createdAt: "",
      updatedAt: ""
    }
    const fixed = { ...plugin, path: join(root, "fixed") }
    for (const [value, label] of [
      [plugin, "mutable"],
      [fixed, "pinned"]
    ] as const) {
      mkdirSync(join(value.path, "skills", "draft"), { recursive: true })
      mkdirSync(join(value.path, "hooks"))
      writeFileSync(join(value.path, "plugin.json"), '{"name":"docs","skills":"skills"}')
      writeFileSync(join(value.path, "skills/draft/SKILL.md"), "---\nname: draft\n---\nDraft")
      writeFileSync(
        join(value.path, "hooks/hooks.json"),
        JSON.stringify([
          { id: "plugin", event: "PreToolUse", type: "command", command: `echo ${label}` }
        ])
      )
      writeFileSync(
        join(value.path, "skills/draft/hooks.json"),
        JSON.stringify([
          { id: "skill", event: "PreSkillUse", type: "command", command: `echo ${label}-skill` }
        ])
      )
    }
    storage.upsertPlugin(plugin)
    expect(storage.getEnabledPluginHookMetadata()[0].command).toBe("echo mutable")
    expect(
      storage.getEnabledSkillHookMetadata().find((hook) => hook.pluginId === plugin.id)?.command
    ).toBe("echo mutable-skill")
    const token = scope.issueRuntimePluginSourceToken({
      threadId: "thread",
      incarnationKey: "incarnation",
      projectId: "project",
      operationId: "operation",
      workspace: root,
      packageDigest: "a".repeat(64),
      stageId: "draft",
      plugin: fixed
    })
    scope.withRuntimePluginSource(token, () => {
      expect(storage.getEnabledPluginSkillSourceMetadata()[0].pluginRoot).toBe(fixed.path)
      expect(storage.getEnabledPluginSkillsSources()[0]).toBe(join(fixed.path, "skills"))
      expect(storage.getEnabledPluginHookMetadata()[0].command).toBe("echo pinned")
      expect(
        storage.getEnabledSkillHookMetadata().find((hook) => hook.pluginId === plugin.id)?.command
      ).toBe("echo pinned-skill")
      expect(storage.getPlugins()[0].path).toBe(plugin.path)
    })
    expect(storage.getEnabledPluginHookMetadata()[0].command).toBe("echo mutable")
    expect(storage.getEnabledPluginSkillSourceMetadata()[0].pluginRoot).toBe(plugin.path)
    expect(
      storage.getEnabledSkillHookMetadata().find((hook) => hook.pluginId === plugin.id)?.command
    ).toBe("echo mutable-skill")
  })
})
