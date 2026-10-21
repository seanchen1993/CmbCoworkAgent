import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  shell: {}
}))
vi.mock("../storage", () => ({
  getEnabledPluginSkillSourceMetadata: () => [],
  getDisabledSkills: () => []
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
  const store = new ModControlStore(join(owned, "control.sqlite"))
  const guests = new Set<FunctionGuestRuntime>()
  let loads = 0
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [plugin],
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
    plugins: () => [plugin],
    chatEntries: async (current, input, guard) => {
      const skills = await listPluginSkills([
        {
          sourceDir: join(root, "skills"),
          pluginId: current.id,
          pluginName: name,
          pluginRoot: root,
          isProjectModePlugin: false
        }
      ])
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
    await expect(f.service.prepare(pinned, () => {})).rejects.toThrow("PLUGIN_UNAVAILABLE")
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
