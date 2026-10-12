import { afterEach, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, link } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { BotSkillCatalogProcess } from "./skill-catalog-process"
import { readBotSkillCatalog } from "./skill-catalog-reader"
import { readSkillResource, scanSkillResources } from "./skill-resource-files"
import { resetSkillPluginCatalogSnapshotsForTests } from "../skill-plugin-catalog/reader"

const roots: string[] = []
afterEach(async () => {
  resetSkillPluginCatalogSnapshotsForTests()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-catalog-")))
  roots.push(root)
  const source = {
    builtinSkillsDir: join(root, "builtin"),
    customSkillsDir: join(root, "custom"),
    pluginsStorePath: join(root, "plugins.json"),
    disabledSkillsPath: join(root, "disabled.json"),
    disabledSkillsRevision: 0,
    globalRevision: 0
  }
  for (const directory of [source.builtinSkillsDir, source.customSkillsDir]) await mkdir(directory)
  const skill = async (directory: string, name: string, body: string) => {
    await mkdir(join(directory, name), { recursive: true })
    await writeFile(
      join(directory, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Workflow description\n---\n${body}`
    )
  }
  await skill(source.builtinSkillsDir, "review", "BUILTIN_STEPS")
  await skill(source.customSkillsDir, "review", "CUSTOM_STEPS")
  const plugin = join(root, "plugin")
  await skill(join(plugin, "skills"), "review", "PLUGIN_STEPS")
  await writeFile(join(plugin, "plugin.json"), JSON.stringify({ name: "plugin", skills: "skills" }))
  const row = {
    id: "plugin-one",
    name: "Plugin",
    version: "1",
    description: "test",
    author: "fixture",
    path: plugin,
    enabled: true,
    skillCount: 1,
    mcpServerCount: 0,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01"
  }
  await writeFile(source.pluginsStorePath, JSON.stringify([row]))
  await writeFile(source.disabledSkillsPath, "[]")
  return { root, source, skill, row }
}

it("reuses custom precedence, exact plugin identities and standalone disable semantics", async () => {
  const f = await fixture()
  const first = await readBotSkillCatalog(f.source)
  expect(first.skills.map((item) => item.instructions).sort()).toEqual([
    "CUSTOM_STEPS",
    "PLUGIN_STEPS"
  ])
  expect(first.skills.every((item) => /^desktop:[a-f0-9]{64}$/.test(item.id))).toBe(true)
  await writeFile(f.source.disabledSkillsPath, '["review"]')
  const disabled = await readBotSkillCatalog({ ...f.source, disabledSkillsRevision: 1 })
  expect(disabled.skills.map((item) => item.instructions)).toEqual(["PLUGIN_STEPS"])
  expect(disabled.skills[0].id).toBe(first.skills.find((item) => item.pluginId)!.id)
  await writeFile(f.source.pluginsStorePath, JSON.stringify([{ ...f.row, enabled: false }]))
  expect(
    (await readBotSkillCatalog({ ...f.source, disabledSkillsRevision: 1, globalRevision: 1 }))
      .skills
  ).toEqual([])
})

it("rejects oversized bodies and escaping symlinks without losing unrelated valid skills", async () => {
  const f = await fixture()
  await f.skill(f.source.customSkillsDir, "too-large", "x".repeat(64001))
  await f.skill(f.root, "outside", "PRIVATE_DO_NOT_IMPORT")
  await symlink(
    join(f.root, "outside"),
    join(f.source.customSkillsDir, "escape"),
    process.platform === "win32" ? "junction" : "dir"
  )
  const value = await readBotSkillCatalog(f.source)
  expect(value.skills).toHaveLength(2)
  expect(value.warnings.join(" ")).toContain("too-large")
  expect(JSON.stringify(value.skills)).not.toContain("PRIVATE_DO_NOT_IMPORT")
})

it("reads the same bounded catalog in a real disposable process and honors pre-cancellation", async () => {
  const f = await fixture()
  const worker = new BotSkillCatalogProcess({
    entry: resolve("src/main/bots/skill-catalog-entry.ts"),
    execArgv: ["--import", "tsx"]
  })
  const snapshot = await worker.read(f.source, new AbortController().signal)
  expect(snapshot.skills.map((item) => item.instructions).sort()).toEqual([
    "CUSTOM_STEPS",
    "PLUGIN_STEPS"
  ])
  const signal = AbortSignal.abort(new Error("cancelled before scan"))
  await expect(worker.read(f.source, signal)).rejects.toThrow("cancelled before scan")
})

it("lists and reads only versioned skill resources, rejecting links, traversal, ADS and changed assets", async () => {
  const f = await fixture(),
    root = join(f.source.customSkillsDir, "review")
  await mkdir(join(root, "scripts"))
  await writeFile(join(root, "scripts", "review.cjs"), "console.log('ORIGINAL_SCRIPT')")
  await writeFile(join(f.root, "private.txt"), "PRIVATE_SOURCE")
  await symlink(join(f.root, "private.txt"), join(root, "escape.txt"))
  await link(join(f.root, "private.txt"), join(root, "hardlink.txt"))
  const skill = (await readBotSkillCatalog(f.source)).skills.find((item) => !item.pluginId)!
  expect(skill.resources.map((item) => item.path)).toEqual([
    ".",
    "SKILL.md",
    "scripts",
    "scripts/review.cjs"
  ])
  expect((await readSkillResource(skill, "scripts/review.cjs")).bytes.toString()).toBe(
    "console.log('ORIGINAL_SCRIPT')"
  )
  for (const path of [
    "../private.txt",
    "/private.txt",
    "C:/private.txt",
    "scripts/review.cjs:private",
    "scripts/../SKILL.md",
    "escape.txt",
    "hardlink.txt"
  ])
    await expect(readSkillResource(skill, path)).rejects.toThrow()
  await writeFile(join(root, "scripts", "review.cjs"), "console.log('UNREVIEWED_SCRIPT')")
  await expect(readSkillResource(skill, "scripts/review.cjs")).rejects.toThrow("已变化")
})

it("does not silently truncate an oversized resource tree into an apparently complete skill", async () => {
  const f = await fixture(),
    root = join(f.source.customSkillsDir, "review")
  for (let i = 0; i < 512; i++) await writeFile(join(root, `reference-${i}.txt`), "x")
  await expect(scanSkillResources(root)).rejects.toThrow("过多")
  const result = await readBotSkillCatalog(f.source)
  expect(result.skills.map((item) => item.instructions)).toEqual(["PLUGIN_STEPS"])
  expect(result.warnings.join(" ")).toContain("review")
})

it("does not expose a disabled nested skill through its parent's resource directory", async () => {
  const f = await fixture(),
    root = join(f.source.customSkillsDir, "review")
  await f.skill(root, "child", "DISABLED_CHILD_INSTRUCTIONS")
  await writeFile(join(root, "child", "private-script.cjs"), "DISABLED_CHILD_SCRIPT")
  await writeFile(f.source.disabledSkillsPath, '["review/child"]')
  const result = await readBotSkillCatalog({ ...f.source, disabledSkillsRevision: 1 })
  expect(result.skills.some((item) => item.name === "child")).toBe(false)
  const parent = result.skills.find((item) => !item.pluginId && item.name === "review")!
  expect(parent.resources.some((item) => item.path.startsWith("child"))).toBe(false)
  await expect(readSkillResource(parent, "child/private-script.cjs")).rejects.toThrow("不属于")
})
