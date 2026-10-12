import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotSkillCatalogSync } from "./skill-catalog-sync"
import { BotSkillCatalogProcess } from "./skill-catalog-process"
import { writeBotModelSnapshot } from "./model-config"
import {
  invalidateBotModelSnapshot,
  completeBotModelSnapshotGeneration,
  botModelSnapshotGeneration
} from "./model-config-fence"

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-skill-sync-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store = new BotStore(join(root, "bots.sqlite"))
  cleanup.push(() => store.close())
  const source = {
    builtinSkillsDir: join(root, "builtin"),
    customSkillsDir: join(root, "custom"),
    pluginsStorePath: join(root, "plugins.json"),
    disabledSkillsPath: join(root, "disabled.json"),
    disabledSkillsRevision: 0,
    globalRevision: 0
  }
  await mkdir(source.builtinSkillsDir)
  const skillRoot = join(source.customSkillsDir, "review")
  await mkdir(skillRoot, { recursive: true })
  const file = join(skillRoot, "SKILL.md")
  await writeFile(file, "---\nname: review\n---\nORIGINAL_INSTRUCTIONS")
  await writeFile(source.pluginsStorePath, "[]")
  await writeFile(source.disabledSkillsPath, "[]")
  const modelFile = join(root, "models.private"),
    config = { version: 1 as const, defaultRef: null, models: [], skillSources: source }
  await writeBotModelSnapshot(modelFile, config)
  const worker = new BotSkillCatalogProcess({
    entry: resolve("src/main/bots/skill-catalog-entry.ts"),
    execArgv: ["--import", "tsx"]
  })
  const service = new BotSkillCatalogSync(store, modelFile, worker)
  cleanup.push(() => service.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "A" })
  await service.ensure()
  return { root, store, bot, conversationId, service, worker, file, source, modelFile, config }
}

it("fences changed files and disabled skills before the next tool, preserving durable version identities", async () => {
  const f = await fixture()
  const skill = f.store.externalSkills.list(f.bot.id)[0]
  expect(skill).toMatchObject({
    name: "review",
    scope: "desktop",
    version: 1
  })
  expect(f.store.externalSkills.current(f.bot.id, skill.id).instructions).toBe(
    "ORIGINAL_INSTRUCTIONS"
  )
  expect(skill).not.toHaveProperty("instructions")
  const run = f.store.send({ nonce: "task", conversationId: f.conversationId, text: "Review" })
    .runIds[0]
  f.store.skillLibrary.readForRun(run, skill.id)
  await writeFile(f.file, "---\nname: review\n---\nUPDATED_INSTRUCTIONS")
  expect(() => f.store.skillLibrary.assertRun(run)).toThrow("来源已变化")
  await f.service.ensure()
  expect(f.store.externalSkills.current(f.bot.id, skill.id)).toMatchObject({
    version: 2,
    instructions: "UPDATED_INSTRUCTIONS"
  })
  expect(() => f.store.skillLibrary.assertRun(run)).toThrow("新版本")
  await writeFile(f.source.disabledSkillsPath, '["review"]')
  expect(() => f.store.externalSkills.current(f.bot.id, skill.id)).toThrow("来源已变化")
  await f.service.ensure()
  expect(f.store.externalSkills.list(f.bot.id)).toEqual([])
  expect(() => f.store.externalSkills.current(f.bot.id, skill.id)).toThrow("停用")
  await writeFile(f.source.disabledSkillsPath, "[]")
  await f.service.ensure(0)
  expect(f.store.externalSkills.current(f.bot.id, skill.id).version).toBeGreaterThan(2)
})

it("fails closed during configuration replacement and worker failure while private skills remain usable", async () => {
  const f = await fixture(),
    skill = f.store.externalSkills.list(f.bot.id)[0]
  const privateSkill = f.store.saveSkill({
    botId: f.bot.id,
    name: "Private",
    instructions: "LOCAL_ONLY",
    enabled: true
  })
  invalidateBotModelSnapshot(f.modelFile)
  expect(() => f.store.externalSkills.current(f.bot.id, skill.id)).toThrow("来源已变化")
  await expect(f.service.ensure()).rejects.toThrow()
  expect(f.store.externalSkills.list(f.bot.id)).toEqual([])
  expect(f.store.skillLibrary.current(f.bot.id, privateSkill.id).instructions).toBe("LOCAL_ONLY")
  completeBotModelSnapshotGeneration(f.modelFile, botModelSnapshotGeneration(f.modelFile))
  const read = vi.spyOn(f.worker, "read").mockRejectedValueOnce(new Error("worker failure"))
  await expect(f.service.ensure(0)).rejects.toThrow("worker failure")
  expect(() => f.store.externalSkills.current(f.bot.id, skill.id)).toThrow("同步失败")
  read.mockRestore()
  await f.service.ensure(0)
  expect(f.store.externalSkills.current(f.bot.id, skill.id).version).toBe(skill.version)
})

it("does not trust persisted external cache after restart, and keeps its mutation surfaces read-only", async () => {
  const f = await fixture(),
    skill = f.store.externalSkills.list(f.bot.id)[0]
  expect(() =>
    f.store.skillLibrary.publish({
      nonce: "publish-external",
      botId: f.bot.id,
      skillId: skill.id,
      version: skill.version,
      libraryRevision: 0
    })
  ).toThrow()
  const peer = new BotStore(join(f.root, "bots.sqlite"))
  try {
    expect(peer.externalSkills.list(f.bot.id)).toEqual([])
    expect(() => peer.externalSkills.current(f.bot.id, skill.id)).toThrow("尚未同步")
  } finally {
    peer.close()
  }
})

it("pins bundled script versions even when SKILL.md is unchanged and detects new resource paths", async () => {
  const f = await fixture(),
    script = join(f.source.customSkillsDir, "review", "review.cjs")
  await writeFile(script, "ORIGINAL")
  await f.service.ensure(0)
  const skill = f.store.externalSkills.list(f.bot.id)[0]
  const runId = f.store.send({
    nonce: "use-script",
    conversationId: f.conversationId,
    text: "Use script"
  }).runIds[0]
  f.store.skillLibrary.readForRun(runId, skill.id)
  expect(f.store.externalSkills.current(f.bot.id, skill.id).resourceCount).toBe(1)
  await writeFile(script, "REPLACED")
  expect(() => f.store.skillLibrary.assertRun(runId)).toThrow("来源已变化")
  await f.service.ensure()
  expect(f.store.externalSkills.current(f.bot.id, skill.id).version).toBe(skill.version + 1)
  expect(() => f.store.skillLibrary.assertRun(runId)).toThrow("新版本")
  await writeFile(join(f.source.customSkillsDir, "review", "added.txt"), "NEW")
  expect(() => f.store.externalSkills.current(f.bot.id, skill.id)).toThrow("来源已变化")
  await f.service.ensure()
  expect(f.store.externalSkills.current(f.bot.id, skill.id).resourceCount).toBe(2)
})
