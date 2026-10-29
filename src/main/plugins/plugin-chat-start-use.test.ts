import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
const installed = vi.hoisted(() => ({ plugins: [] as PluginMetadata[] }))
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  shell: {}
}))
vi.mock("../storage", () => ({
  getEnabledPluginSkillSourceMetadata: () => [],
  getDisabledSkills: () => [],
  getPlugins: () => installed.plugins
}))
import { PluginStartUseService } from "./plugin-start-use"
import { pluginChatStartUseEntries } from "./plugin-chat-start-use"
import { listPluginSkills } from "../ipc/skills"
import { readNativeSkillUsagePolicy } from "./native-skill-usage"
import { ModControlStore } from "../mods/control-store"
import { FunctionModsManager } from "../mods/v2/manager"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import type { PluginMetadata } from "../types"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  installed.plugins = []
})
function fixture(name: string, withMods: boolean) {
  const owned = mkdtempSync(join(tmpdir(), "chat-start-use-"))
  const root = join(owned, "plugin")
  mkdirSync(root)
  const plugin: PluginMetadata = {
    id: "installed",
    name,
    version: "1.0.0",
    path: root,
    enabled: true,
    description: "",
    author: "",
    createdAt: "one",
    updatedAt: "one",
    skillCount: 3,
    mcpServerCount: 0
  }
  writeFileSync(join(root, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }))
  for (const [id, attrs] of [
    ["review", ""],
    ["helper", "user-invocable: false\n"],
    ["stage", ""]
  ]) {
    mkdirSync(join(root, "skills", id), { recursive: true })
    writeFileSync(
      join(root, "skills", id, "SKILL.md"),
      `---\nname: ${name}-${id}\ndescription: ${name} ${id} real metadata\n${attrs}---\nPreserve original business checks.`
    )
  }
  writeFileSync(
    join(root, "devclaw.capabilities.json"),
    JSON.stringify({
      apiVersion: "devclaw.capabilities/v1",
      capabilities: [
        {
          id: "review",
          title: "Review",
          kind: "skill",
          usage: "chat",
          entry: "skills/review/SKILL.md"
        },
        {
          id: "stage",
          title: "Internal stage",
          kind: "skill",
          usage: "project",
          entry: "skills/stage/SKILL.md"
        }
      ]
    })
  )
  if (withMods) {
    mkdirSync(join(root, "mods"))
    writeFileSync(
      join(root, "mods/manifest.json"),
      JSON.stringify({ apiVersion: "cmb.mods/v2", id: name, entry: "register.ts" })
    )
    writeFileSync(
      join(root, "mods/register.ts"),
      `export function register(on) {
      on('session.start', async ($,event,next) => {
        await $.command.register({name:'${name}-check',description:'Actual ${name} check'});
        return next(event)
      })
    }`
    )
  }
  const installedPlugins = [plugin]
  installed.plugins = installedPlugins
  const store = new ModControlStore(join(owned, "control.sqlite"))
  const guests = new Set<FunctionGuestRuntime>()
  let loads = 0
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => installedPlugins,
      enabled: () => true,
      publish: async (_workspace, value) => value,
      changed: () => {}
    },
    () => ({
      load: async (code, options) => {
        loads++
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.add(guest)
        return guest
      },
      stop: () => {
        for (const guest of guests) void guest.dispose()
      }
    })
  )
  const service = new PluginStartUseService({
    plugins: () => installedPlugins,
    enable: async (_pluginId, guard) => {
      guard()
      plugin.enabled = true
    },
    chatEntries: async (current, input, guard) => {
      const skills = await listPluginSkills(current.enabled ? [
        {
          sourceDir: join(root, "skills"),
          pluginId: current.id,
          pluginName: name,
          pluginRoot: root,
          isProjectModePlugin: false
        }
      ] : [])
      const policy = await readNativeSkillUsagePolicy([plugin], () => ({
        usage: "chat",
        assertCurrent: guard
      }))
      policy?.assertCurrent()
      return pluginChatStartUseEntries(
        current.id,
        await manager.status(input.expectedWorkspace),
        skills.filter((skill) => !policy || policy.allowsSkill(skill.path))
      )
    }
  })
  cleanup.push(async () => {
    manager.close()
    for (const guest of guests) await guest.dispose()
    store.close()
    rmSync(owned, { recursive: true, force: true })
  })
  return {
    root,
    plugin,
    manager,
    service,
    loads: () => loads,
    uninstall: () => installedPlugins.splice(0),
    input: {
      threadId: "chat",
      expectedWorkspace: root,
      pluginId: "installed",
      expected: { name, version: "1.0.0" }
    }
  }
}

it.each(["document-review", "warehouse-quality"])(
  "discovers %s with actual native skills and loads real registrations only after approval",
  async (name) => {
    const f = fixture(name, true)
    const before = await f.service.prepare(f.input, () => {})
    expect(before.kind).toBe("chat")
    expect(before.chat?.functionMod).toMatchObject({
      pluginId: "installed",
      name,
      state: "needs-approval"
    })
    expect(before.chat?.skills.map((skill) => skill.name)).toEqual([`${name}-review`])
    expect(f.loads()).toBe(0)
    expect(await f.manager.commands(f.root, "chat")).toEqual([])
    expect(f.loads()).toBe(0)
    await f.manager.approve(f.root, "installed", before.chat!.functionMod!.digest!, () => {})
    const pinned = { ...f.input, expected: { ...f.input.expected, digest: before.identity.digest } }
    const after = await f.service.prepare(pinned, () => {})
    expect(after.chat?.functionMod?.state).toBe("ready")
    const commands = await f.manager.commands(f.root, "chat")
    expect(commands.find((command) => command.command === `${name}-check`)).toMatchObject({
      modId: `function:${name}`,
      digest: after.chat!.functionMod!.digest,
      name: `Actual ${name} check`
    })
    f.plugin.enabled = false
    const approved = vi.spyOn(f.manager, "approve")
    const loadsBeforeDisabled = f.loads()
    const disabled = await f.service.prepare(pinned, () => {})
    expect(disabled).toMatchObject({
      identity: after.identity,
      kind: "chat",
      canOpen: false,
      activationRequired: true,
      issues: [],
      chat: { functionMod: { pluginId: "installed", name, state: "disabled" }, skills: [] }
    })
    expect(disabled.chat?.functionMod?.digest).toBe(after.chat!.functionMod!.digest)
    expect(approved).not.toHaveBeenCalled()
    expect(f.loads()).toBe(loadsBeforeDisabled)
    expect(f.plugin.enabled).toBe(false)
    f.uninstall()
    await expect(f.service.prepare(pinned, () => {})).rejects.toThrow(
      "PLUGIN_START_USE_PLUGIN_UNAVAILABLE"
    )
  }
)

it.each(["release-notes", "dataset-contract"])(
  "reads pure Skill plugin %s from original declarations without inventing a Mod",
  async (name) => {
    const f = fixture(name, false)
    const report = await f.service.prepare(f.input, () => {})
    expect(report.chat?.functionMod).toBeUndefined()
    expect(report.chat?.skills).toEqual([
      {
        id: "plugin:installed/review",
        name: `${name}-review`,
        description: `${name} review real metadata`
      }
    ])
    expect(f.loads()).toBe(0)
  }
)

it("reviews a disabled business source before enabling and preserves native source/workspace grant fences", async () => {
  const f = fixture("quality-review", true)
  f.plugin.enabled = false
  const approve = vi.spyOn(f.manager, "approve")
  const before = await f.service.prepare(f.input, () => {})
  expect(before).toMatchObject({
    activationRequired: true,
    canOpen: false,
    chat: { functionMod: { state: "disabled" }, skills: [] }
  })
  expect(f.plugin.enabled).toBe(false)
  expect(f.loads()).toBe(0)
  expect(approve).not.toHaveBeenCalled()
  const pinned = { ...f.input, expected: before.identity }
  const enabled = await f.service.enable(pinned, () => {})
  expect(enabled.chat?.functionMod?.state).toBe("needs-approval")
  expect(f.loads()).toBe(0)
  expect(await f.manager.commands(f.root, "chat")).toEqual([])
  await f.manager.approve(f.root, "installed", enabled.chat!.functionMod!.digest!, () => {})
  expect((await f.service.prepare(pinned, () => {})).chat?.functionMod?.state).toBe("ready")
  expect((await f.manager.commands(f.root, "chat")).map((command) => command.command)).toContain(
    "quality-review-check"
  )
  expect(approve).toHaveBeenCalledOnce()
  const otherWorkspace = join(f.root, "another-workspace")
  const elsewhere = await f.service.prepare(
    { ...pinned, expectedWorkspace: otherWorkspace },
    () => {}
  )
  expect(elsewhere.chat?.functionMod?.state).toBe("needs-approval")
  expect(await f.manager.commands(otherWorkspace, "another-chat")).toEqual([])
  writeFileSync(join(f.root, "mods/register.ts"), "export function register(on) {}")
  await expect(f.service.prepare(pinned, () => {})).rejects.toThrow("CONTENT_CHANGED")
  const updated = await f.service.prepare(f.input, () => {})
  expect(updated.chat?.functionMod?.state).toBe("needs-approval")
  expect(approve).toHaveBeenCalledOnce()
})
