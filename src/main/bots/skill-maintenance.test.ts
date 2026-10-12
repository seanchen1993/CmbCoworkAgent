import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotTeachStore } from "./teach-store"

const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
)
const DAY = 86_400_000
function fixture(path = ":memory:") {
  let now = 1_700_000_000_000
  const store = new BotStore(path, () => now)
  cleanup.push(() => store.close())
  const owner = store.createBot({ nonce: "owner", name: "Owner" })
  const skill = store.saveSkill({
    botId: owner.bot.id,
    name: "检查",
    instructions: "检查真实结果",
    enabled: true
  })
  const address = { botId: owner.bot.id, expectedDataEpoch: "initial" }
  const view = () => store.skillMaintenance.view(address)
  const change = (
    action: "pin" | "unpin" | "manage" | "unmanage" | "archive" | "restore",
    skillId = skill.id
  ) => {
    const item = view().entries.find((entry) => entry.skillId === skillId)!
    return store.skillMaintenance.change({
      ...address,
      nonce: `${action}-${item.revision}`,
      skillId,
      version: item.version,
      revision: item.revision,
      action
    })
  }
  const configure = (enabled = true) =>
    store.skillMaintenance.configure({
      ...address,
      nonce: `configure-${view().policy.revision}`,
      revision: view().policy.revision,
      enabled,
      staleAfterDays: 14,
      archiveAfterDays: 30
    })
  return {
    store,
    owner,
    skill,
    address,
    view,
    change,
    configure,
    advance: (days: number) => {
      now += days * DAY
    }
  }
}

it("does not grant automatic maintenance to existing skills or rewrite content", () => {
  const f = fixture()
  f.advance(100)
  f.store.skillMaintenance.tick()
  expect(f.view().policy.enabled).toBe(false)
  expect(f.view().entries[0]).toMatchObject({ managed: false, archived: false, useCount: 0 })
  f.configure()
  f.advance(100)
  f.store.skillMaintenance.tick()
  expect(f.store.skills(f.owner.bot.id)).toEqual([f.skill])
})

it("archives only explicitly managed, inactive skills and restores without deleting versions", () => {
  const f = fixture()
  f.change("manage")
  f.configure()
  f.advance(15)
  expect(f.view().entries[0]).toMatchObject({ stale: true, archived: false })
  f.store.skillMaintenance.tick()
  expect(f.store.skills(f.owner.bot.id)[0].enabled).toBe(true)
  f.advance(17)
  f.store.skillMaintenance.tick()
  expect(f.view().entries[0].archived).toBe(true)
  expect(() => f.store.skillLibrary.current(f.owner.bot.id, f.skill.id)).toThrow("归档")
  expect(f.store.skillVersion(f.owner.bot.id, f.skill.id, 1).instructions).toBe(
    f.skill.instructions
  )
  f.change("restore")
  expect(f.store.skillLibrary.current(f.owner.bot.id, f.skill.id)).toEqual(f.skill)
  f.store.skillMaintenance.run({ ...f.address, nonce: "check-after-restore" })
  expect(f.view().entries[0].archived).toBe(false)
})

it("protects pinned skills, active tasks and configured routine bindings", () => {
  const f = fixture()
  f.change("manage")
  f.change("pin")
  f.configure()
  f.advance(60)
  expect(() => f.change("archive")).toThrow("固定")
  expect(
    f.store.skillMaintenance.run({ ...f.address, nonce: "pinned-check" }).protectedIds
  ).toEqual([f.skill.id])
  f.change("unpin")
  const sent = f.store.send({
    nonce: "task",
    conversationId: f.owner.conversationId,
    text: "执行检查"
  })
  expect(() => f.change("archive")).toThrow("未完成")
  const claim = f.store.claim("host")!
  f.store.finish(claim.lease, "succeeded", "完成")
  expect(f.store.getRun(sent.runIds[0]).status).toBe("succeeded")
  const trial = f.store.trialSkill({
    nonce: "verify",
    botId: f.owner.bot.id,
    skillId: f.skill.id,
    version: f.skill.version,
    inputs: "检查项目",
    criteria: "检查结果正确"
  })
  const checking = f.store.claim("verify")!
  f.store.finish(checking.lease, "succeeded", "检查结果已核对")
  f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "检查结果正确" })
  f.store.saveRoutine({
    botId: f.owner.bot.id,
    name: "每日检查",
    prompt: "按步骤检查",
    timezone: "Asia/Shanghai",
    enabled: true,
    schedule: { kind: "interval", anchor: f.store.now() + DAY, everyMs: DAY },
    skills: [{ botId: f.owner.bot.id, id: f.skill.id, version: f.skill.version }]
  })
  expect(() => f.change("archive")).toThrow("例程")
  expect(
    f.store.skillMaintenance.run({ ...f.address, nonce: "routine-check" }).protectedIds
  ).toEqual([f.skill.id])
})

it("counts actual skill reads once per task and resets inactivity using the latest read", () => {
  const f = fixture()
  f.change("manage")
  f.configure()
  f.advance(29)
  f.store.send({ nonce: "task", conversationId: f.owner.conversationId, text: "检查" })
  const claim = f.store.claim("host")!
  // Routine/trial admission can bind a skill without having executed/read it.
  f.store.db.run("INSERT INTO bot_run_skills VALUES(?,?,?)", [
    claim.run.id,
    f.skill.id,
    f.skill.version
  ])
  f.store.skillLibrary.readForRun(claim.run.id, f.skill.id)
  f.advance(20_000 / DAY)
  f.store.skillLibrary.readForRun(claim.run.id, f.skill.id)
  f.store.finish(claim.lease, "succeeded", "完成")
  expect(f.view().entries[0]).toMatchObject({ useCount: 1, lastUsedAt: f.store.now() })
  f.advance(5)
  f.store.skillMaintenance.tick()
  expect(f.view().entries[0]).toMatchObject({ stale: false, archived: false })
})

it("keeps paused routine bindings readable and uses existing unavailable-skill handling after archive", () => {
  const f = fixture()
  const trial = f.store.trialSkill({
    nonce: "verify-before-binding",
    botId: f.owner.bot.id,
    skillId: f.skill.id,
    version: f.skill.version,
    inputs: "检查项目",
    criteria: "确认检查结果"
  })
  const claim = f.store.claim("verify")!
  f.store.finish(claim.lease, "succeeded", "检查结果已核对")
  f.store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "检查结果正确" })
  const published = f.store.skillLibrary.publish({
    nonce: "published-before-archive",
    botId: f.owner.bot.id,
    skillId: f.skill.id,
    version: f.skill.version,
    libraryRevision: 0
  })
  const routine = f.store.saveRoutine({
    botId: f.owner.bot.id,
    name: "暂停的检查",
    prompt: "按技能检查",
    enabled: false,
    timezone: "UTC",
    schedule: { kind: "event", topic: "project.changed" },
    skills: [{ botId: f.owner.bot.id, id: f.skill.id, version: f.skill.version }]
  })
  f.change("archive")
  expect(() => f.store.routines(f.owner.bot.id)).not.toThrow()
  expect(f.store.routine(f.owner.bot.id, routine.id)).toMatchObject({
    enabled: false,
    revision: routine.revision,
    skillIssueCode: "skill_unavailable"
  })
  expect(() => f.store.runRoutine({ id: routine.id, nonce: "archived-run" })).toThrow(
    expect.objectContaining({ code: "skill_unavailable" })
  )
  const edited = f.store.saveRoutine({ ...routine, name: "调整暂停例程" })
  expect(edited.skillReferences).toEqual(routine.skillReferences)
  const other = f.store.createBot({ nonce: "other", name: "Other" })
  expect(f.store.skillLibrary.current(other.bot.id, published.id).instructions).toBe(
    f.skill.instructions
  )
  f.change("restore")
  expect(f.store.routine(f.owner.bot.id, routine.id).skillIssue).toBeUndefined()
})

it.each(["recording", "paused", "finalizing"] as const)(
  "protects skills while a demonstration is %s, even without a queued model run",
  (phase) => {
    const f = fixture()
    f.change("manage")
    f.configure()
    f.advance(40)
    const teach = new BotTeachStore(f.store)
    const session = teach.create({
      botId: f.owner.bot.id,
      conversationId: f.owner.conversationId,
      nonce: "demonstration"
    })
    if (phase !== "recording") teach.update(session.id, session.revision, phase)
    expect(() => f.change("archive")).toThrow("未完成")
    f.store.skillMaintenance.tick()
    expect(f.view().entries[0].archived).toBe(false)
  }
)

it("protects a service after its model turn finishes, including the pending stop acknowledgement", () => {
  const f = fixture()
  f.change("manage")
  f.configure()
  f.advance(40)
  f.store.bindLeaseGuard("host", () => {})
  f.store.send({ nonce: "server-task", conversationId: f.owner.conversationId, text: "启动服务" })
  const claim = f.store.claim("host")!
  const action = { shell: { command: "server", keepAlive: true } }
  const approval = f.store.requestInteraction(claim.lease, {
    kind: "approval",
    prompt: "启动服务",
    action
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  const jobId = f.store.toolOnce(claim.lease, "server", action, () => {
    f.store.beginEffect(claim.lease, { id: "service", action, approvalId: approval.id })
    const id = f.store.shellJobs.reserve(claim.lease, "server", "service", "server")
    f.store.shellServices.attach(claim.lease, id, 60_000)
    return id
  })
  f.store.shellJobs.start(claim.lease, jobId)
  f.store.finish(claim.lease, "succeeded", "服务已启动")
  expect(() => f.change("archive")).toThrow("未完成")
  f.store.transaction(() => f.store.shellJobs.requestStopInTransaction(claim.run.id, jobId))
  expect(f.store.getRun(claim.run.id).status).toBe("succeeded")
  expect(() => f.change("archive")).toThrow("未完成")
  f.store.skillMaintenance.tick()
  expect(f.view().entries[0].archived).toBe(false)
})

it("does not let busy profiles consume the bounded sweep's idle profile quota", () => {
  const f = fixture()
  f.change("manage")
  f.configure()
  for (let i = 0; i < 6; i++) {
    const owner = f.store.createBot({ nonce: `busy-${i}`, name: `Busy ${i}` })
    f.store.skillMaintenance.configure({
      botId: owner.bot.id,
      expectedDataEpoch: "initial",
      nonce: `policy-${i}`,
      revision: 0,
      enabled: true,
      staleAfterDays: 14,
      archiveAfterDays: 30
    })
    f.store.send({ nonce: `task-${i}`, conversationId: owner.conversationId, text: "未完成任务" })
  }
  f.advance(40)
  // These six busy profiles sort before the eligible profile. Filtering only
  // after LIMIT 5 would otherwise starve the eligible one forever.
  f.store.db.run("UPDATE bot_skill_maintenance_policy SET last_run_at=? WHERE bot_id=?", [
    f.store.now() - 8 * DAY,
    f.owner.bot.id
  ])
  f.store.skillMaintenance.tick()
  expect(f.view().entries[0].archived).toBe(true)
})

it("preserves exact operation receipts over restart, rejects cross-Bot and restored-workspace writes", () => {
  const root = mkdtempSync(join(tmpdir(), "bot-skill-maintenance-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite"),
    f = fixture(path)
  const input = {
    ...f.address,
    nonce: "manage-once",
    skillId: f.skill.id,
    version: 1,
    revision: 0,
    action: "manage" as const
  }
  const receipt = f.store.skillMaintenance.change(input)
  f.store.close()
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  expect(reopened.skillMaintenance.change(input)).toEqual(receipt)
  expect(() => reopened.skillMaintenance.change({ ...input, action: "pin" })).toThrow(
    "同一请求标识"
  )
  const other = reopened.createBot({ nonce: "other", name: "Other" })
  expect(() =>
    reopened.skillMaintenance.change({ ...input, nonce: "foreign", botId: other.bot.id })
  ).toThrow("私有技能")
  expect(() =>
    reopened.skillMaintenance.change({
      ...input,
      nonce: "wrong-epoch",
      expectedDataEpoch: "replacement"
    })
  ).toThrow("恢复")
})

it("does not archive a new version or a recently re-enabled policy based on old inactivity", () => {
  const f = fixture()
  f.change("manage")
  f.configure()
  f.advance(40)
  f.change("archive")
  const updated = f.store.saveSkill({ ...f.skill, instructions: "新的检查方法" })
  f.store.skillMaintenance.run({ ...f.address, nonce: "new-version" })
  expect(f.store.skillLibrary.current(f.owner.bot.id, updated.id)).toEqual(updated)
  f.configure(false)
  f.advance(100)
  f.configure(true)
  f.advance(8)
  f.store.skillMaintenance.tick()
  expect(f.view().entries[0].archived).toBe(false)
  expect(() =>
    f.store.skillMaintenance.change({
      ...f.address,
      nonce: "stale-version",
      skillId: f.skill.id,
      version: 1,
      revision: f.view().entries[0].revision,
      action: "archive"
    })
  ).toThrow("变化")
})

it("does not spend model calls or repeatedly write during idle heartbeats", () => {
  const f = fixture()
  f.change("manage")
  f.configure()
  f.advance(40)
  f.store.skillMaintenance.tick()
  const changes = () => f.store.db.exec("SELECT total_changes()")[0].values[0][0]
  const before = changes()
  for (let i = 0; i < 500; i++) f.store.skillMaintenance.tick()
  expect(changes()).toBe(before)
  expect(f.store.events().filter((event) => event.kind === "skill.archived")).toHaveLength(1)
})

it("bounds each automatic pass, drains later candidates and paginates metadata without skill bodies", () => {
  const f = fixture()
  for (let i = 0; i < 205; i++) {
    const skill = f.store.saveSkill({
      botId: f.owner.bot.id,
      name: `检查 ${i}`,
      instructions: "PRIVATE_PROCEDURE_CONTENT",
      enabled: true
    })
    f.store.skillMaintenance.change({
      ...f.address,
      nonce: `manage-${i}`,
      skillId: skill.id,
      version: 1,
      revision: 0,
      action: "manage"
    })
  }
  f.configure()
  f.advance(40)
  f.store.skillMaintenance.tick()
  const archiveCount = () =>
    Number(
      f.store.db.exec("SELECT COUNT(*) FROM bot_events WHERE kind='skill.archived'")[0].values[0][0]
    )
  expect(archiveCount()).toBe(200)
  expect(f.view().policy.lastRunAt).toBeNull()
  f.advance(1 / 1440)
  f.store.skillMaintenance.tick()
  expect(archiveCount()).toBe(205)
  expect(f.view().policy.lastRunAt).toBe(f.store.now())
  const page = f.store.skillMaintenance.view({ ...f.address, limit: 100 })
  expect(page.entries).toHaveLength(100)
  expect(JSON.stringify(page)).not.toContain("PRIVATE_PROCEDURE_CONTENT")
  const next = f.store.skillMaintenance.view({ ...f.address, after: page.next!, limit: 100 })
  expect(new Set([...page.entries, ...next.entries].map((entry) => entry.skillId)).size).toBe(200)
  expect(() => f.store.skillMaintenance.view({ ...f.address, after: "foreign-skill" })).toThrow(
    "分页位置"
  )
})

it("records a real manual check without enabling automation or inventing prior checks", () => {
  const f = fixture()
  expect(f.view().policy.lastRunAt).toBeNull()
  f.configure()
  expect(f.view().policy.lastRunAt).toBeNull()
  const result = f.store.skillMaintenance.run({ ...f.address, nonce: "manual-check" })
  expect(f.view().policy.lastRunAt).toBe(result.checkedAt)
  f.configure(false)
  expect(f.view().policy.lastRunAt).toBe(result.checkedAt)
})
