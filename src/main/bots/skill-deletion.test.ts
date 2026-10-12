import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { BotHost } from "./host"
import type { BotSkill } from "../../shared/bot-types"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "Owner" })
  const skill = store.saveSkill({
    botId: bot.id,
    name: "Private workflow",
    instructions: "Read the evidence",
    enabled: true
  })
  const input = { nonce: "delete", botId: bot.id, skillId: skill.id, version: skill.version }
  return { store, bot, conversationId, skill, input }
}
it("deletes the exact private skill once and preserves history without keeping it executable", () => {
  const f = fixture()
  const trial = f.store.trialSkill({
    nonce: "trial",
    botId: f.bot.id,
    skillId: f.skill.id,
    version: 1,
    inputs: "42",
    criteria: "Return evidence"
  })
  const receipt = f.store.deleteSkill(f.input)
  expect(f.store.deleteSkill(f.input)).toEqual(receipt)
  expect(receipt.cancelledRunIds).toEqual([trial.runId])
  expect(f.store.skills(f.bot.id)).toEqual([])
  expect(f.store.skillLibrary.available(f.bot.id)).toEqual([])
  expect(f.store.skillVersion(f.bot.id, f.skill.id, 1)).toMatchObject({
    instructions: f.skill.instructions,
    enabled: false,
    deletedAt: receipt.deletedAt
  })
  expect(f.store.skillTrials(f.bot.id)[0]).toMatchObject({ id: trial.id, runStatus: "cancelled" })
  expect(() =>
    f.store.trialSkill({
      nonce: "new-trial",
      botId: f.bot.id,
      skillId: f.skill.id,
      version: 1,
      inputs: "42",
      criteria: "Evidence"
    })
  ).toThrow("删除")
  expect(() => f.store.saveSkill({ ...f.skill, instructions: "Resurrection" })).toThrow("删除")
  expect(() =>
    f.store.send({
      nonce: "new",
      conversationId: f.conversationId,
      text: "Run it",
      skills: [{ botId: f.bot.id, id: f.skill.id, version: 1 }]
    })
  ).toThrow("删除")
  expect(() => f.store.deleteSkill({ ...f.input, version: 2 })).toThrow("同一请求")
  expect(
    f.store.cloneBot({ nonce: "clone", id: f.bot.id, revision: f.bot.revision }).bot.id
  ).not.toBe(f.bot.id)
})
it("rejects stale versions, foreign ownership and extra fields without changing the skill", () => {
  const f = fixture()
  const other = f.store.createBot({ nonce: "other", name: "Other" }).bot
  expect(() => f.store.deleteSkill({ ...f.input, botId: other.id })).toThrow("属于")
  expect(() => f.store.deleteSkill({ ...f.input, extra: true } as typeof f.input)).toThrow("参数")
  f.store.saveSkill({ ...f.skill, instructions: "New instructions" })
  expect(() => f.store.deleteSkill(f.input)).toThrow("版本")
  expect(f.store.skills(f.bot.id)).toHaveLength(1)
})

function verify(store: BotStore, skill: BotSkill) {
  const trial = store.trialSkill({
    nonce: `verify-${skill.id}`,
    botId: skill.botId,
    skillId: skill.id,
    version: skill.version,
    inputs: "42",
    criteria: "Evidence"
  })
  const claim = store.claim("review")!
  store.finish(claim.lease, "succeeded", "42 verified")
  store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "Checked evidence" })
}

it("pauses only related routines, keeps their exact references and excludes deleted dependencies from clones", () => {
  const f = fixture()
  verify(f.store, f.skill)
  const selection = { botId: f.bot.id, id: f.skill.id, version: 1 }
  const base = {
    botId: f.bot.id,
    prompt: "Read evidence",
    timezone: "UTC",
    enabled: true,
    schedule: { kind: "event" as const, topic: "evidence.ready" }
  }
  const bound = f.store.saveRoutine(
    { ...base, name: "Bound", skills: [selection] },
    { kind: "human" }
  )
  const unrelated = f.store.saveRoutine({ ...base, name: "Unrelated" }, { kind: "human" })
  const queued = f.store.runRoutine({ id: bound.id, nonce: "queued" })
  const plain = f.store.runRoutine({ id: unrelated.id, nonce: "plain" })
  const receipt = f.store.deleteSkill(f.input)
  expect(receipt.affectedRoutineIds).toEqual([bound.id])
  expect(receipt.cancelledRunIds).toEqual([queued.id])
  expect(f.store.getRun(plain.id).status).toBe("queued")
  expect(f.store.routine(f.bot.id, bound.id)).toMatchObject({
    enabled: false,
    revision: bound.revision + 1,
    skillReferences: [{ ...selection, name: f.skill.name }],
    skillIssueCode: "skill_unavailable"
  })
  expect(f.store.routine(f.bot.id, unrelated.id).enabled).toBe(true)
  expect(() => f.store.runRoutine({ id: bound.id, nonce: "after" })).toThrow()
  expect(() =>
    f.store.saveRoutine(
      { ...f.store.routine(f.bot.id, bound.id), enabled: true },
      { kind: "human" }
    )
  ).toThrow("删除")
  const clone = f.store.cloneBot({ nonce: "clone", id: f.bot.id, revision: f.bot.revision }).bot
  expect(f.store.skills(clone.id)).toEqual([])
  expect(f.store.routines(clone.id).map((routine) => routine.name)).toEqual(["Unrelated"])
})

it("leaves published user-library snapshots and another Bot's accepted execution intact", () => {
  const f = fixture()
  const shared = f.store.skillLibrary.publish({
    nonce: "publish",
    botId: f.bot.id,
    skillId: f.skill.id,
    version: 1,
    libraryRevision: 0
  })
  const other = f.store.createBot({ nonce: "other", name: "Other" })
  const sent = f.store.send({
    nonce: "shared-use",
    conversationId: other.conversationId,
    text: "Use snapshot",
    skills: [{ botId: other.bot.id, id: shared.id, version: shared.revision }]
  })
  expect(f.store.deleteSkill(f.input).retainedLibraryIds).toEqual([shared.id])
  expect(f.store.skillLibrary.current(other.bot.id, shared.id, 1).instructions).toBe(
    f.skill.instructions
  )
  expect(f.store.getRun(sent.runIds[0]).status).toBe("queued")
  expect(() =>
    f.store.deleteSkill({ ...f.input, nonce: "shared-delete", skillId: shared.id })
  ).toThrow("私有技能")
  expect(() =>
    f.store.skillLibrary.publish({
      nonce: "republish",
      botId: f.bot.id,
      skillId: f.skill.id,
      version: 1,
      libraryRevision: shared.revision
    })
  ).toThrow("技能已修改")
})

it("revokes a waiting approval and fences the actual previously approved mutation dispatch", () => {
  const f = fixture()
  const sent = f.store.send({
    nonce: "selected",
    conversationId: f.conversationId,
    text: "Read",
    skills: [{ botId: f.bot.id, id: f.skill.id, version: 1 }]
  })
  const claim = f.store.claim("host")!
  const action = { tool: "test_change", target: "42" }
  const approval = f.store.requestInteraction(claim.lease, {
    kind: "approval",
    prompt: "Change 42?",
    action
  })
  const receipt = f.store.deleteSkill(f.input)
  expect(receipt.cancellingRunIds).toEqual(sent.runIds)
  expect(f.store.getInteraction(approval.id).status).toBe("cancelled")
  expect(() =>
    f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  ).toThrow()
  let mutated = false
  expect(() =>
    f.store.approvedToolOnce(claim.lease, { id: "effect", action, approvalId: approval.id }, () => {
      mutated = true
      return "changed"
    })
  ).toThrow()
  expect(mutated).toBe(false)
  f.store.finish(claim.lease, "cancelled", "Skill removed")
  expect(f.store.getRun(claim.run.id).status).toBe("cancelled")
})

it("also stops skills learned by read_skill and pending steering without relying on explicit initiating selections", () => {
  const f = fixture()
  const sent = f.store.send({
    nonce: "plain",
    conversationId: f.conversationId,
    text: "Investigate"
  })
  const claim = f.store.claim("host")!
  f.store.skillLibrary.readForRun(claim.run.id, f.skill.id)
  f.store.send({
    nonce: "steer",
    conversationId: f.conversationId,
    text: "Use this skill",
    skills: [{ botId: f.bot.id, id: f.skill.id, version: 1 }]
  })
  expect(f.store.deleteSkill(f.input).cancellingRunIds).toContain(sent.runIds[0])
  expect(() => f.store.skillLibrary.readForRun(claim.run.id, f.skill.id)).toThrow("删除")
  expect(() => f.store.skillDeletion.assertRunPresent(claim.run.id)).toThrow("删除")
})

it("preserves unknown effects for review and refuses resume without changing their evidence", () => {
  const f = fixture()
  f.store.send({
    nonce: "selected",
    conversationId: f.conversationId,
    text: "Run",
    skills: [{ botId: f.bot.id, id: f.skill.id, version: 1 }]
  })
  const claim = f.store.claim("host")!
  const action = { tool: "external_change" }
  const approval = f.store.requestInteraction(claim.lease, {
    kind: "approval",
    prompt: "Change?",
    action
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(claim.lease, { id: "external-effect", action, approvalId: approval.id })
  f.store.settleEffect(claim.lease, "external-effect", "unknown", "Connection lost")
  f.store.finish(claim.lease, "failed", "Connection lost")
  const before = f.store.getRun(claim.run.id)
  expect(before.status).toBe("needs_review")
  expect(f.store.deleteSkill(f.input)).toMatchObject({
    reviewRunIds: [before.id],
    cancellingRunIds: []
  })
  const resolution = {
    id: before.id,
    revision: before.revision,
    note: "Reviewed",
    decision: "resume" as const,
    effects: [{ id: "external-effect", outcome: "failed" as const, note: "Confirmed no write" }]
  }
  expect(() => f.store.recover(resolution)).toThrow("删除")
  expect(f.store.effects(before.id)[0]).toMatchObject({
    status: "unknown",
    result: "Connection lost"
  })
  expect(f.store.recover({ ...resolution, decision: "cancel" }).status).toBe("cancelled")
})

it("lets in-flight effect receipts settle without claiming an uncertain operation was cancelled", () => {
  const f = fixture()
  f.store.send({
    nonce: "selected",
    conversationId: f.conversationId,
    text: "Run",
    skills: [{ botId: f.bot.id, id: f.skill.id, version: 1 }]
  })
  const claim = f.store.claim("host")!
  const action = { tool: "external_change" }
  const approval = f.store.requestInteraction(claim.lease, {
    kind: "approval",
    prompt: "Change?",
    action
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(claim.lease, { id: "inflight", action, approvalId: approval.id })
  expect(f.store.deleteSkill(f.input).cancellingRunIds).toEqual([claim.run.id])
  f.store.settleEffect(claim.lease, "inflight", "unknown", "May have changed")
  expect(f.store.finish(claim.lease, "cancelled", "Stopped").status).toBe("needs_review")
  expect(f.store.effects(claim.run.id)[0]).toMatchObject({
    status: "unknown",
    result: "May have changed"
  })
})

it("aborts the actual Host runtime after deletion and does not dispatch unrelated queued work before it settles", async () => {
  const f = fixture()
  const trial = f.store.trialSkill({
    nonce: "trial",
    botId: f.bot.id,
    skillId: f.skill.id,
    version: 1,
    inputs: "42",
    criteria: "Evidence"
  })
  let began!: () => void
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  let aborted = false
  const host = new BotHost(f.store, {
    execute: async ({ signal }) => {
      began()
      await new Promise<void>((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true
            reject(signal.reason)
          },
          { once: true }
        )
      )
      return "unreachable"
    }
  })
  try {
    host.tick()
    await started
    f.store.deleteSkill(f.input)
    host.tick()
    for (let count = 0; count < 100 && f.store.getRun(trial.runId).status === "cancelling"; count++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    expect(aborted).toBe(true)
    expect(f.store.getRun(trial.runId).status).toBe("cancelled")
  } finally {
    await host.stop()
  }
})

it("requests stopping a keepAlive service even after its origin turn succeeded, preserving uncertain external effects", () => {
  const f = fixture()
  f.store.bindLeaseGuard("host", () => {})
  f.store.send({
    nonce: "service-task",
    conversationId: f.conversationId,
    text: "Start service",
    skills: [{ botId: f.bot.id, id: f.skill.id, version: 1 }]
  })
  const claim = f.store.claim("host")!
  const action = { shell: { command: "server", keepAlive: true } }
  const approval = f.store.requestInteraction(claim.lease, {
    kind: "approval",
    prompt: "Start server?",
    action
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  const reserved = f.store.toolOnce(claim.lease, "create-service", action, () => {
    f.store.beginEffect(claim.lease, { id: "service-effect", action, approvalId: approval.id })
    const jobId = f.store.shellJobs.reserve(claim.lease, "server", "service-effect", "server")
    return { jobId, service: f.store.shellServices.attach(claim.lease, jobId, 60_000) }
  })
  f.store.shellJobs.start(claim.lease, reserved.jobId)
  expect(f.store.finish(claim.lease, "succeeded", "Service started").status).toBe("succeeded")
  const receipt = f.store.deleteSkill(f.input)
  expect(receipt.stoppingServiceJobIds).toEqual([reserved.jobId])
  expect(f.store.shellJobs.get(claim.run.id, reserved.jobId, 0).status).toBe("cancelling")
  expect(f.store.getRun(claim.run.id).status).toBe("succeeded")
  expect(f.store.deleteSkill(f.input)).toEqual(receipt)
  f.store.shellServices.finish(reserved.service, {
    output: "Service interrupted",
    exitCode: 130,
    truncated: false
  })
  expect(f.store.effects(claim.run.id)[0].status).toBe("unknown")
  expect(f.store.getRun(claim.run.id).status).toBe("needs_review")
  expect(f.store.claim("host")).toBeNull()
})
