import { afterEach, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { BotStore } from "./store"
import { BOT_SKILL_DEPENDENCY_SOURCE } from "../../shared/bot-skill-dependencies"
import { parseSkillDependencies } from "../skills/dependencies"
import { BotDomainError } from "../../shared/bot-types"
const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
const text = `---
cmbdevclaw-dependencies:
  schemaVersion: 1
  checks:
    - {id: platform, kind: platform, platforms: [darwin]}
---
Use the established workflow.`
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const bot = store.createBot({ nonce: "a", name: "A" })
  const skill = store.saveSkill({
    botId: bot.bot.id,
    name: "Skill",
    instructions: text,
    enabled: true
  })
  const input = {
    nonce: "check",
    expectedDataEpoch: store.dataEpoch(),
    skill: { botId: skill.botId, id: skill.id, version: skill.version }
  }
  return { store, bot, skill, input }
}
it("pins the user-selected private origin in the normal inbox and recovers the exact nonce", () => {
  const f = fixture()
  const receipt = f.store.skillDependencies.submit(f.input)
  expect(f.store.getRun(receipt.runId)).toMatchObject({
    lane: "user",
    source: BOT_SKILL_DEPENDENCY_SOURCE,
    status: "queued",
    botId: f.bot.bot.id
  })
  expect(f.store.skillReferences.forMessage(receipt.messageId)).toEqual([
    { ...f.input.skill, name: f.skill.name }
  ])
  expect(receipt.skill).toMatchObject({
    scope: "bot",
    sha256: createHash("sha256").update(text).digest("hex")
  })
  expect(f.store.skillDependencies.pinned(receipt.runId)?.declaration.state).toBe("structured")
  f.store.saveSkill({ ...f.skill, instructions: "changed" })
  expect(f.store.skillDependencies.submit(f.input)).toEqual(receipt)
  expect(() => f.store.skillDependencies.submit({ ...f.input, nonce: "new" })).toThrow("新版本")
  expect(f.store.snapshot().runs).toHaveLength(1)
  expect(f.store.skills(f.bot.bot.id)[0].verified).toBe(false)
})
it("rejects another Bot private source and atomically keeps the queue empty", () => {
  const f = fixture()
  const b = f.store.createBot({ nonce: "b", name: "B" })
  expect(() =>
    f.store.skillDependencies.submit({
      ...f.input,
      skill: { ...f.input.skill, botId: b.bot.id }
    })
  ).toThrow()
  expect(f.store.snapshot().runs).toHaveLength(0)
  expect(f.store.messages(b.conversationId)).toHaveLength(0)
})
it("uses an independently published user-library revision without inheriting trial verification", () => {
  const f = fixture()
  const item = f.store.skillLibrary.publish({
    nonce: "publish",
    botId: f.skill.botId,
    skillId: f.skill.id,
    version: f.skill.version,
    libraryRevision: 0
  })
  const b = f.store.createBot({ nonce: "b", name: "B" })
  const receipt = f.store.skillDependencies.submit({
    ...f.input,
    skill: { botId: b.bot.id, id: item.id, version: item.revision }
  })
  expect(receipt.skill.scope).toBe("user")
  expect(f.store.skillDependencies.pinned(receipt.runId)?.declaration.checks).toHaveLength(1)
  expect(f.store.skillLibrary.current(b.bot.id, item.id, item.revision).verified).toBe(false)
  expect(() =>
    f.store.skillDependencies.submit({
      ...f.input,
      skill: { botId: b.bot.id, id: item.id, version: item.revision + 1 }
    })
  ).toThrow("不同")
})
it("restored epoch and conflicting original nonce never create a second operation", () => {
  const f = fixture()
  const receipt = f.store.skillDependencies.submit(f.input)
  expect(() =>
    f.store.skillDependencies.submit({
      ...f.input,
      expectedDataEpoch: "restored",
      nonce: "new"
    })
  ).toThrow(BotDomainError)
  expect(() =>
    f.store.skillDependencies.submit({
      ...f.input,
      skill: { ...f.input.skill, version: 2 }
    })
  ).toThrow("不同")
  expect(f.store.snapshot().runs.map((r) => r.id)).toEqual([receipt.runId])
})
it("keeps free compatibility text and empty declarations unverified", () => {
  const f = fixture()
  const plain = f.store.saveSkill({
    ...f.skill,
    instructions: "---\ncompatibility: Requires Git\n---\nSteps."
  })
  const view = f.store.skillDependencies.view({
    botId: f.skill.botId,
    id: f.skill.id,
    version: plain.version
  })
  expect(view.declaration.state).toBe("unstructured")
  expect(view.history).toEqual([])
})
it("uses the existing ordered history index and bounded recent queue materialization", () => {
  const f = fixture()
  f.store.skillDependencies.submit(f.input)
  const plan = f.store.db.exec(
    `EXPLAIN QUERY PLAN WITH recent AS (SELECT id,message_id,status,created_at,result FROM bot_runs WHERE bot_id=? AND source=? ORDER BY created_at DESC,id DESC LIMIT 128) SELECT r.id FROM recent r JOIN bot_run_skills s ON s.run_id=r.id AND s.skill_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 20`,
    [f.bot.bot.id, BOT_SKILL_DEPENDENCY_SOURCE, f.skill.id]
  )
  const details = JSON.stringify(plan)
  expect(details).toContain("bot_routine_history")
  expect(details).toContain("sqlite_autoindex_bot_run_skills")
  expect(details).not.toMatch(/SCAN bot_runs/)
  expect(f.store.skillDependencies.view(f.input.skill).history).toHaveLength(1)
})

it("pins installed catalog dependency declarations and refuses changed source snapshots", () => {
  const f = fixture(),
    id = `desktop:${"a".repeat(64)}`
  const source = {
    id,
    catalogId: "installed",
    name: "Installed",
    description: "",
    instructions: "Workflow.",
    sha256: "b".repeat(64),
    fileStamp: "stable-1",
    filePath: "/installed/SKILL.md",
    catalogPath: "/installed",
    rootPath: "/installed",
    resources: [],
    dependencies: parseSkillDependencies(text),
    compatibility: "",
    pluginId: null,
    pluginName: null,
    source: "user" as const
  }
  const apply = (next = source) =>
    f.store.externalSkills.apply({ skills: [next], warnings: [], truncated: false })
  apply()
  const input = { ...f.input, skill: { botId: f.bot.bot.id, id, version: 1 } },
    receipt = f.store.skillDependencies.submit(input)
  expect(receipt.skill).toMatchObject({ scope: "desktop", sha256: source.sha256, version: 1 })
  expect(f.store.skillDependencies.pinned(receipt.runId)?.declaration).toEqual(source.dependencies)
  apply({ ...source, sha256: "c".repeat(64), fileStamp: "stable-2" })
  expect(f.store.skillDependencies.submit(input)).toEqual(receipt)
  expect(() => f.store.skillDependencies.submit({ ...input, nonce: "after-update" })).toThrow(
    "新版本"
  )
  const replacement = f.store.skillDependencies.submit({
    ...input,
    nonce: "replacement",
    skill: { ...input.skill, version: 2 }
  })
  expect(replacement.skill.sha256).toBe("c".repeat(64))
  f.store.externalSkills.suspend("catalog unavailable")
  expect(() => f.store.skillDependencies.origin({ ...input.skill, version: 2 })).toThrow(
    "unavailable"
  )
})

it("bounds admission without duplicate receipts or partial messages when the queue is full", () => {
  const f = fixture()
  for (let index = 0; index < 16; index++)
    f.store.skillDependencies.submit({ ...f.input, nonce: `check-${index}` })
  const receipt = f.store.skillDependencies.submit({ ...f.input, nonce: "check-0" })
  expect(f.store.getRun(receipt.runId).status).toBe("queued")
  expect(() => f.store.skillDependencies.submit({ ...f.input, nonce: "seventeenth" })).toThrow(
    "尚有依赖检查"
  )
  expect(f.store.snapshot().runs).toHaveLength(16)
  expect(f.store.messages(f.bot.conversationId)).toHaveLength(16)
})
