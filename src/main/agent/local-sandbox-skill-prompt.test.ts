import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { LocalSandbox } from "./local-sandbox"
import { SkillLifecycleRegistry } from "./skill-lifecycle/registry"
import { setModsManager, type ModsManager } from "../mods/manager"

const roots: string[] = []
afterEach(() => {
  setModsManager(undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-skill-prompt-"))
  roots.push(root)
  const skill = join(root, "skills", "review")
  mkdirSync(skill, { recursive: true })
  const path = join(skill, "SKILL.md")
  const source = "---\nname: review\ndescription: Review\n---\nfirst\nsecond\nthird"
  writeFileSync(path, source)
  writeFileSync(join(skill, "support.txt"), "support")
  const sandbox = new LocalSandbox({
    rootDir: root,
    runId: "prompt-test",
    skillLifecycleRegistry: new SkillLifecycleRegistry([join(root, "skills")])
  })
  return { root, skill, path, source, sandbox }
}
it("expands the complete Skill before pagination and leaves support files unchanged", async () => {
  const f = fixture()
  const presentationEvent = vi.fn(async (_w, _t, _e, input) => ({
    text: "intro\n" + input.text + "\ntail"
  }))
  setModsManager({
    classicEvent: async (_w: unknown, _t: unknown, _e: unknown, input: unknown, signal: unknown, core: (input: unknown, signal: unknown) => Promise<unknown>) => core(input, signal),
    isActive: () => false,
    isEnabled: () => true,
    presentationEvent
  } as unknown as ModsManager)
  const first = await f.sandbox.read(f.path, 0, 2)
  const last = await f.sandbox.read(f.path, 7, 3)
  expect(first).toContain("intro")
  expect(last).toContain("tail")
  expect(presentationEvent).toHaveBeenCalledOnce()
  expect(presentationEvent.mock.calls[0][3]).toEqual({ skill: "review", text: f.source })
  expect(await f.sandbox.read(join(f.skill, "support.txt"))).toContain("support")
  expect(presentationEvent).toHaveBeenCalledOnce()
})
it("refuses changed source pages and sources modified while hooks are running", async () => {
  const f = fixture()
  setModsManager({
    classicEvent: async (_w: unknown, _t: unknown, _e: unknown, input: unknown, signal: unknown, core: (input: unknown, signal: unknown) => Promise<unknown>) => core(input, signal),
    isActive: () => false,
    isEnabled: () => true,
    presentationEvent: async () => ({ text: "safe" })
  } as unknown as ModsManager)
  expect(await f.sandbox.read(f.path)).toContain("safe")
  writeFileSync(f.path, f.source + "\nchanged")
  expect(await f.sandbox.read(f.path)).toContain("MODS_SKILL_SOURCE_CHANGED")
  setModsManager(undefined)
  const other = fixture()
  setModsManager({
    classicEvent: async (_w: unknown, _t: unknown, _e: unknown, input: unknown, signal: unknown, core: (input: unknown, signal: unknown) => Promise<unknown>) => core(input, signal),
    isActive: () => false,
    isEnabled: () => true,
    presentationEvent: async () => {
      writeFileSync(other.path, "replaced")
      return { text: "must-not-leak" }
    }
  } as unknown as ModsManager)
  const result = await other.sandbox.read(other.path)
  expect(result).toContain("MODS_SKILL_SOURCE_CHANGED")
  expect(result).not.toContain("must-not-leak")
})
it("does not invoke expansion when Mods is disabled", async () => {
  const f = fixture()
  const presentationEvent = vi.fn()
  setModsManager({
    classicEvent: async (_w: unknown, _t: unknown, _e: unknown, input: unknown, signal: unknown, core: (input: unknown, signal: unknown) => Promise<unknown>) => core(input, signal),
    isActive: () => false,
    isEnabled: () => false,
    presentationEvent
  } as unknown as ModsManager)
  expect(await f.sandbox.read(f.path)).toContain("first")
  expect(presentationEvent).not.toHaveBeenCalled()
})

it("does not expose raw later pages after Mods is disabled mid-runtime", async () => {
  const f = fixture()
  let enabled = true
  setModsManager({
    classicEvent: async (_w: unknown, _t: unknown, _e: unknown, input: unknown, signal: unknown, core: (input: unknown, signal: unknown) => Promise<unknown>) => core(input, signal),
    isActive: () => false,
    isEnabled: () => enabled,
    presentationEvent: async () => ({ text: "filtered" })
  } as unknown as ModsManager)
  expect(await f.sandbox.read(f.path)).toContain("filtered")
  enabled = false
  const result = await f.sandbox.read(f.path)
  expect(result).toContain("MODS_SCOPE_CHANGED")
  expect(result).not.toContain("first")
})
