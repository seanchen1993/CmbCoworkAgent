import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"
import { BotSearch } from "./search"
const stores: BotStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})

it("uses indexed trial lookups for message pages and sidebar snapshots", () => {
  const f = fixture()
  f.store.trialSkill(f.input)
  const prepare = vi.spyOn(f.store.db, "prepare")
  f.store.messages(f.conversationId)
  f.store.snapshot()
  const queries = prepare.mock.calls.filter(([sql]) => sql.includes("FROM bot_skill_trials t"))
  prepare.mockRestore()
  expect(queries).toHaveLength(2)
  for (const [sql, bindings] of queries) {
    // Inspect the queries issued by the real projection paths, rather than a
    // copied SQL statement that could diverge from the implementation.
    const plan = f.store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`, bindings)
    const details: string[] = []
    try {
      while (plan.step()) details.push(String(plan.getAsObject().detail))
    } finally {
      plan.free()
    }
    expect(details).toContain("SEARCH r USING INDEX bot_trial_trigger_message (message_id=?)")
    expect(details).toContain("SEARCH t USING INDEX bot_trial_run (run_id=?)")
    expect(details.some((detail) => /^SCAN (?:r|t)(?:\s|$)/.test(detail))).toBe(false)
  }
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "订单助手" })
  const skill = store.saveSkill({
    botId: bot.id,
    name: "整理订单",
    instructions: "读取编号并核对结果",
    enabled: true
  })
  return {
    store,
    bot,
    conversationId,
    skill,
    input: {
      nonce: "trial",
      botId: bot.id,
      skillId: skill.id,
      version: skill.version,
      inputs: "ORD-002",
      criteria: "返回订单编号 ORD-002，金额与原单一致"
    }
  }
}
it("preserves the requested delivery format while retaining failures and human review", () => {
  const f = fixture()
  const trial = f.store.trialSkill({ ...f.input, criteria: "只输出一行订单编号" })
  const run = f.store.getRun(trial.runId)
  const prompt = f.store.message({ conversationId: f.conversationId, id: run.messageId }).text
  expect(prompt).toContain("只输出一行订单编号")
  expect(prompt).toContain("按技能与本次验收条件要求的格式交付实际结果")
  expect(prompt).toContain("不要额外附加执行报告或技能验证状态")
  expect(prompt).toContain("若验收失败或结果不完整")
  expect(prompt).toContain("不得自行标记技能通过")
  expect(prompt).not.toContain("交付实际结果、验证证据和未完成事项")
  expect(f.store.skillVersion(f.bot.id, f.skill.id, 1).verified).toBe(false)
  expect(f.store.effects(run.id)).toEqual([])
})

it("pins a skill version, deduplicates a trial and refuses machine completion as validation", () => {
  const f = fixture(),
    trial = f.store.trialSkill(f.input)
  expect(f.store.trialSkill(f.input)).toEqual(trial)
  expect(f.store.snapshot().runs).toHaveLength(1)
  expect(() =>
    f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "matches" })
  ).toThrow("不能标记通过")
  const claim = f.store.claim("host")!
  const next = f.store.saveSkill({ ...f.skill, instructions: "更新后的步骤" })
  expect(f.store.trialForRun(claim.run.id)?.version).toBe(1)
  expect(f.store.skillVersion(f.bot.id, f.skill.id, 1).instructions).toBe("读取编号并核对结果")
  f.store.finish(claim.lease, "succeeded", "ORD-002 金额已核对，产物已交付")
  expect(f.store.skillVersion(f.bot.id, f.skill.id, 1).verified).toBe(false)
  f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "已人工核对订单号与金额" })
  expect(f.store.skillVersion(f.bot.id, f.skill.id, 1).verified).toBe(true)
  expect(f.store.skillVersion(f.bot.id, f.skill.id, next.version).verified).toBe(false)
  expect(() => f.store.trialSkill({ ...f.input, nonce: "stale-version" })).toThrow("版本已更新")
})

it("presents only the exact trial trigger while preserving its original execution text and version", () => {
  const f = fixture(),
    trial = f.store.trialSkill(f.input),
    run = f.store.getRun(trial.runId),
    original = f.store.message({ conversationId: f.conversationId, id: run.messageId })
  expect(original.skillTrial).toEqual({
    id: trial.id,
    skillId: f.skill.id,
    name: f.skill.name,
    version: 1,
    inputs: f.input.inputs,
    criteria: f.input.criteria
  })
  expect(original.text).toContain("Run taught skill: 整理订单")
  expect(original.text).toContain("Approval boundaries:")
  expect(
    f.store.snapshot().conversations.find((item) => item.id === f.conversationId)?.lastMessage
  ).toEqual({ text: "试跑技能 · 整理订单", createdAt: original.createdAt })
  f.store.saveSkill({ ...f.skill, name: "新的技能名称", instructions: "新版本步骤" })
  const copied = f.store.send({
    nonce: "ordinary-copy",
    conversationId: f.conversationId,
    text: original.text
  })
  expect(
    f.store.snapshot().conversations.find((item) => item.id === f.conversationId)?.lastMessage?.text
  ).toBe(original.text.slice(0, 180))
  const claim = f.store.claim("host")!
  expect(claim.run.id).toBe(trial.runId)
  f.store.finish(claim.lease, "succeeded", original.text)
  const page = f.store.messages(f.conversationId, undefined, 200, original.sequence - 1)
  expect(page.find((message) => message.id === original.id)).toEqual(original)
  expect(page.find((message) => message.id === copied.messageId)?.skillTrial).toBeUndefined()
  expect(page.find((message) => message.sender === "bot")?.skillTrial).toBeUndefined()
  const replay = f.store.messagesForRun(trial.runId).find((message) => message.id === original.id)!
  expect(replay.text).toBe(original.text)
  expect(replay.skillTrial).toBeUndefined()
  // Explicit searches can still locate the unchanged full instruction for audit.
  expect(
    new BotSearch(f.store)
      .search({ kind: "message", query: "Approval boundaries", conversationId: f.conversationId })
      .matches.some((match) => match.id === original.id)
  ).toBe(true)
  expect(f.store.trialSkill(f.input)).toMatchObject({ id: trial.id, runId: trial.runId })
})
it("records failure evidence without validating a failed or uncertain run", () => {
  const f = fixture(),
    trial = f.store.trialSkill(f.input),
    claim = f.store.claim("host")!
  f.store.finish(claim.lease, "failed", "记录不存在")
  expect(() =>
    f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "looks fine" })
  ).toThrow("不能标记通过")
  const result = f.store.reviewSkillTrial({
    id: trial.id,
    verdict: "failed",
    note: "缺少不存在记录的分支处理"
  })
  expect(f.store.reviewSkillTrial({ id: trial.id, verdict: "failed", note: result.note! })).toEqual(
    result
  )
  expect(f.store.skills(f.bot.id)[0].verified).toBe(false)
  expect(() =>
    f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "overwritten" })
  ).toThrow("已验收")
})
