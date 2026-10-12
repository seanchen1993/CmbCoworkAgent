import { afterEach, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { BotStore } from "./store"
import { BOT_SCHEMA_VERSION } from "./schema"
import type { BotSkill } from "../../shared/bot-types"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

function fixture(persistent = false) {
  const root = mkdtempSync(join(tmpdir(), "cmb-routine-skills-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = persistent ? join(root, "bots.sqlite") : ":memory:"
  let now = Date.now()
  const store = new BotStore(path, () => now)
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "项目检查" })
  const skill = store.saveSkill({
    botId: bot.id,
    name: "检查构建",
    instructions: "核对构建状态并附证据",
    enabled: true
  })
  const input = {
    nonce: "schedule",
    botId: bot.id,
    name: "每日检查",
    prompt: "核对今天的构建结果",
    timezone: "UTC",
    enabled: true,
    schedule: { kind: "event" as const, topic: "build.completed" },
    skills: [{ botId: bot.id, id: skill.id, version: skill.version }]
  }
  return {
    root,
    path,
    store,
    bot,
    conversationId,
    skill,
    input,
    advance: (ms: number) => {
      now += ms
    }
  }
}

function verify(store: BotStore, skill: BotSkill) {
  const trial = store.trialSkill({
    nonce: `trial-${skill.id}-${skill.version}`,
    botId: skill.botId,
    skillId: skill.id,
    version: skill.version,
    inputs: "测试项目",
    criteria: "构建号与结果均有原始证据"
  })
  const claim = store.claim("trial-review")!
  expect(claim.run.id).toBe(trial.runId)
  store.finish(claim.lease, "succeeded", "构建编号 42，检查通过，证据已交付")
  store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "已核对构建记录和结果" })
}

it("requires actual trial review and validates scope before binding a schedule", () => {
  const { store, skill, input } = fixture()
  expect(() => store.saveRoutine(input)).toThrow("尚未通过试跑验收")
  expect(store.routines(input.botId)).toHaveLength(0)
  verify(store, skill)
  const other = store.createBot({ nonce: "other", name: "其他" }).bot
  expect(() =>
    store.saveRoutine({ ...input, skills: [{ ...input.skills[0], botId: other.id }] })
  ).toThrow("所属 Bot")
  expect(() => store.saveRoutine({ ...input, skills: [...input.skills, ...input.skills] })).toThrow(
    "选择无效"
  )
  expect(() =>
    store.saveRoutine({ ...input, skills: [{ ...input.skills[0], version: 0 }] })
  ).toThrow("选择无效")
  const saved = store.saveRoutine(input)
  expect(saved.skillReferences).toEqual([{ ...input.skills[0], name: skill.name }])
  expect(store.saveRoutine(input)).toEqual(saved)
  expect(() => store.saveRoutine({ ...input, skills: [] })).toThrow("同一请求")
})

it("pins manual, event and scheduled runs independently of later routine edits and deletion", () => {
  const { store, skill, input, advance } = fixture()
  verify(store, skill)
  const saved = store.saveRoutine(input)
  const manual = store.runRoutine({ id: saved.id, nonce: "manual" })
  const event = store.emitEvent({ nonce: "event", topic: "build.completed", payload: "build42" })
    .runIds[0]
  store.saveRoutine({ ...saved, schedule: { kind: "once", at: store.now() + 1000 } })
  advance(1001)
  const scheduled = store.dispatchDueRoutines()[0]
  for (const id of [manual.id, event, scheduled]) {
    expect(store.skillReferences.forRun(id)).toEqual(saved.skillReferences)
    expect(
      store.message({
        conversationId: store.getRun(id).conversationId,
        id: store.getRun(id).messageId
      }).skillReferences
    ).toEqual(saved.skillReferences)
  }
  const latest = store.routine(input.botId, saved.id)
  const detached = store.saveRoutine({ ...latest, skills: [], enabled: false })
  expect(detached.skillReferences).toBeUndefined()
  expect(store.skillReferences.forRun(manual.id)).toEqual(saved.skillReferences)
  store.deleteRoutine({
    nonce: "delete",
    botId: input.botId,
    id: detached.id,
    revision: detached.revision
  })
  expect(store.routineSkills.read(saved.id)).toEqual([])
  expect(store.skillReferences.forRun(manual.id)).toEqual(saved.skillReferences)
})

it.each(["event", "scheduled"] as const)(
  "pauses an outdated %s routine once without blocking unrelated work or upgrading its queued task",
  (kind) => {
    const { store, skill, input, conversationId, advance } = fixture()
    verify(store, skill)
    const saved = store.saveRoutine(
      kind === "event"
        ? input
        : { ...input, schedule: { kind: "interval", everyMs: 60_000, anchor: store.now() + 1000 } }
    )
    const queued = store.runRoutine({ id: saved.id, nonce: "queued-before-update" })
    const next = store.saveSkill({ ...skill, instructions: "修改后的步骤，需要重新验收" })
    const unbound = store.saveRoutine({
      ...input,
      nonce: "unbound",
      skills: [],
      schedule: saved.schedule
    })
    advance(1001)
    const dispatch = (nonce: string) =>
      kind === "event"
        ? store.emitEvent({ nonce, topic: "build.completed", payload: "one" }).runIds
        : store.dispatchDueRoutines()
    const first = dispatch("first")
    expect(first).toHaveLength(1)
    expect(store.getRun(first[0]).source).toContain(unbound.id)
    const paused = store.routine(input.botId, saved.id)
    expect(paused.enabled).toBe(false)
    expect(paused.skillReferences?.[0].version).toBe(1)
    expect(paused.skillIssue).toContain("新版本")
    const notices = () =>
      store.messages(conversationId).filter((item) => item.text.includes("例程「每日检查」已暂停"))
    expect(notices()).toHaveLength(1)
    dispatch("second")
    expect(notices()).toHaveLength(1)
    expect(() =>
      store.skillReferences.assertCurrent(store.skillReferences.forRun(queued.id))
    ).toThrow("新版本")
    expect(() => store.runRoutine({ id: saved.id, nonce: "stale-manual" })).toThrow("新版本")
    expect(() => store.saveRoutine({ ...paused, enabled: true })).toThrow("新版本")
    const edited = store.saveRoutine({ ...paused, prompt: "保留旧绑定，先调整输入" })
    expect(edited.skillReferences).toEqual(saved.skillReferences)
    // Reviewing the new version alone does not upgrade any old routine binding.
    for (const run of store.snapshot().runs.filter((run) => run.status === "queued"))
      store.cancel(run.id)
    verify(store, next)
    expect(store.routine(input.botId, saved.id).skillReferences?.[0].version).toBe(1)
    const rebind = {
      ...edited,
      enabled: true,
      skills: [{ botId: input.botId, id: next.id, version: next.version }]
    }
    expect(() => store.saveRoutine(rebind)).toThrow(
      expect.objectContaining({ code: "approval_required" })
    )
    const rebound = store.saveRoutine(rebind, { kind: "human" })
    expect(rebound.skillReferences?.[0].version).toBe(2)
    expect(rebound.skillIssue).toBeUndefined()
  }
)

it("does not transfer verification or enable bound routines when cloning a Bot", () => {
  const { store, skill, input, bot } = fixture()
  verify(store, skill)
  store.saveRoutine(input)
  const cloned = store.cloneBot({ nonce: "clone", id: bot.id, revision: bot.revision })
  const copy = store.routines(cloned.bot.id)[0]
  const copiedSkill = store.skills(cloned.bot.id)[0]
  expect(copy.enabled).toBe(false)
  expect(copy.skillReferences).toEqual([
    { botId: cloned.bot.id, id: copiedSkill.id, name: skill.name, version: 1 }
  ])
  expect(copy.skillIssue).toContain("尚未通过试跑验收")
  expect(() => store.runRoutine({ id: copy.id, nonce: "copy-run" })).toThrow("尚未通过试跑验收")
})

it("recovers bindings and save receipts, including v23 upgrade without altering old schedules", () => {
  const { store, skill, input, path, root } = fixture(true)
  const oldRoutine = store.saveRoutine({ ...input, skills: [] })
  store.close()
  const old = new DatabaseSync(path)
  old.exec("DROP TABLE bot_routine_skills; UPDATE bot_schema SET version=23")
  old.close()
  const upgraded = new BotStore(path)
  cleanup.push(() => upgraded.close())
  expect(upgraded.routine(input.botId, oldRoutine.id)).toEqual(oldRoutine)
  expect(upgraded.db.exec("SELECT version FROM bot_schema")[0].values[0][0]).toBe(
    BOT_SCHEMA_VERSION
  )
  expect(
    readdirSync(join(root, "backups")).filter((name) => name.startsWith("bots-v23-"))
  ).toHaveLength(1)
  verify(upgraded, skill)
  const boundInput = { ...input, nonce: "bind", id: oldRoutine.id, revision: oldRoutine.revision }
  const bound = upgraded.saveRoutine(boundInput)
  upgraded.close()
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  expect(reopened.routine(input.botId, bound.id)).toEqual(bound)
  const next = reopened.saveSkill({ ...skill, instructions: "changed after save" })
  expect(next.version).toBe(2)
  expect(reopened.saveRoutine(boundInput)).toEqual(bound)
  expect(reopened.routine(input.botId, bound.id).skillIssue).toContain("新版本")
})
