import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { botRoutineTools } from "./routine-tools"
import type { BotRuntimeRequest } from "./host"
import type { ApproveLocalBotAction } from "./profile-tools"
import type { BotSkill } from "../../shared/bot-types"

const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function fixture() {
  let now = 1_800_000_000_000
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const owner = store.createBot({ nonce: "owner", name: "日报" })
  return {
    store,
    ...owner,
    advance: (ms: number) => {
      now += ms
    },
    task: (
      nonce: string,
      text: string,
      skills?: { botId: string; id: string; version: number }[]
    ) => {
      const sent = store.send({
        nonce,
        conversationId: owner.conversationId,
        text,
        ...(skills ? { skills } : {})
      })
      const claim = store.claim("tool-host")!
      expect(claim.run.id).toBe(sent.runIds[0])
      const request: BotRuntimeRequest = {
        store,
        bot: owner.bot,
        ...claim,
        signal: new AbortController().signal,
        messages: store.messagesForRun(claim.run.id)
      }
      const tools = (approveLocal?: ApproveLocalBotAction) =>
        botRoutineTools(
          request,
          () => store.assertLease(claim.lease),
          async () => {
            throw new Error("unexpected generic approval")
          },
          approveLocal
        )
      return { ...claim, tools }
    }
  }
}

const specification = {
  name: "日报",
  prompt: "核对项目并交付证据",
  timezone: "UTC"
}
const invoke = (
  tools: ReturnType<typeof botRoutineTools>,
  name: string,
  id: string,
  args: unknown
) => tools.find((item) => item.name === name)!.invoke({ type: "tool_call", id, name, args })

function verify(store: BotStore, skill: BotSkill) {
  const trial = store.trialSkill({
    nonce: `trial-${skill.id}-${skill.version}`,
    botId: skill.botId,
    skillId: skill.id,
    version: skill.version,
    inputs: "验收项目",
    criteria: "交付实际检查结果和证据"
  })
  const claim = store.claim("trial-host")!
  expect(claim.run.id).toBe(trial.runId)
  store.finish(claim.lease, "succeeded", "项目检查通过，原始证据已交付")
  store.reviewSkillTrial({
    id: trial.id,
    verdict: "passed",
    note: "已核对受控结果"
  })
}

it("atomically saves a paused routine through the real tool and only dispatches after an explicit resume", async () => {
  const f = fixture()
  const task = f.task("create-request", "先保存每分钟的日报，不要启用")
  const args = { ...specification, every_minutes: 1, enabled: false }
  await invoke(task.tools(), "create_routine", "create-paused", args)
  const saved = f.store.routines(f.bot.id)[0]
  expect(saved).toMatchObject({
    enabled: false,
    desiredEnabled: false,
    effectiveState: "paused",
    revision: 1
  })
  expect(
    f.store.messages(f.conversationId).filter((message) => message.routineOutcome)
  ).toHaveLength(1)
  await invoke(task.tools(), "create_routine", "create-paused", args)
  expect(f.store.routines(f.bot.id)).toEqual([saved])
  f.store.finish(task.lease, "succeeded", "已保存并暂停")
  f.advance(180_000)
  expect(f.store.dispatchDueRoutines()).toEqual([])
  expect(f.store.routineHistory({ botId: f.bot.id, routineId: saved.id }).items).toEqual([])
  const resume = f.task("resume-request", "现在启用这条例程")
  await invoke(resume.tools(), "update_routine", "resume", {
    id: saved.id,
    revision: saved.revision,
    enabled: true
  })
  const active = f.store.routine(f.bot.id, saved.id)
  expect(active).toMatchObject({
    enabled: true,
    desiredEnabled: true,
    revision: 2
  })
  expect(active.nextAt).toBe(f.store.now() + 60_000)
  f.store.finish(resume.lease, "succeeded", "已启用")
  expect(f.store.dispatchDueRoutines()).toEqual([])
  f.advance(60_000)
  const [runId] = f.store.dispatchDueRoutines()
  expect(f.store.getRun(runId)).toMatchObject({
    botId: f.bot.id,
    source: `routine:${saved.id}`,
    status: "queued"
  })
  expect(f.store.routineHistory({ botId: f.bot.id, routineId: saved.id }).items).toHaveLength(1)
  expect(f.store.dispatchDueRoutines()).toEqual([])
})

it("preserves omitted legacy arguments and replays an existing receipt without adding defaults or skills", async () => {
  const f = fixture()
  const task = f.task("legacy-request", "创建日报")
  const args = { ...specification, topic: "report.ready" }
  const old = f.store.toolOnce(
    task.lease,
    "legacy-create",
    { tool: "create_routine", ...args },
    () =>
      f.store.saveRoutine(
        {
          ...specification,
          botId: f.bot.id,
          enabled: true,
          schedule: { kind: "event", topic: args.topic }
        },
        { kind: "task", lease: task.lease }
      )
  )
  await invoke(task.tools(), "create_routine", "legacy-create", args)
  expect(f.store.routines(f.bot.id)).toEqual([old])
  expect(f.store.messages(f.conversationId).filter((message) => message.routineOutcome)).toEqual([])
  await invoke(task.tools(), "create_routine", "new-omitted", {
    ...args,
    name: "新日报"
  })
  expect(f.store.routines(f.bot.id).find((item) => item.name === "新日报")).toMatchObject({
    enabled: true,
    desiredEnabled: true
  })
})

it("reviews the exact paused skill binding and carries that accepted version into the event occurrence", async () => {
  const f = fixture()
  const skill = f.store.saveSkill({
    botId: f.bot.id,
    name: "项目核对",
    instructions: "读取项目原件并核对",
    enabled: true
  })
  verify(f.store, skill)
  const selection = { botId: f.bot.id, id: skill.id, version: skill.version }
  f.store.autoReview.change({
    ...f.store.autoReview.read(f.bot.id),
    isEnabled: true,
    nonce: "review-on"
  })
  const task = f.task("skill-request", "用已确认的项目核对技能保存日报例程，先暂停", [selection])
  let reviews = 0
  const approve: ApproveLocalBotAction = async (id, action, operation) => {
    reviews++
    expect(action).toMatchObject({
      routine: {
        operation: "create",
        after: { enabled: false, skills: [selection] },
        skillReferences: [{ ...selection, name: skill.name }]
      }
    })
    expect(f.store.routines(f.bot.id)).toEqual([])
    const review = f.store.requestInteraction(task.lease, {
      kind: "approval",
      action,
      prompt: JSON.stringify(action)
    })
    f.store.answerInteraction({
      id: review.id,
      revision: review.revision,
      answer: "approve"
    })
    return f.store.approvedToolOnce(task.lease, { id, action, approvalId: review.id }, operation)
  }
  const args = {
    ...specification,
    topic: "report.ready",
    enabled: false,
    skills: [selection]
  }
  await invoke(task.tools(approve), "create_routine", "skill-create", args)
  await invoke(task.tools(approve), "create_routine", "skill-create", args)
  expect(reviews).toBe(1)
  const routine = f.store.routines(f.bot.id)[0]
  expect(routine.skillReferences).toEqual([{ ...selection, name: skill.name }])
  expect(
    f.store.emitEvent({
      nonce: "paused-event",
      topic: "report.ready",
      payload: "project1"
    }).runIds
  ).toEqual([])
  f.store.finish(task.lease, "succeeded", "已保存暂停例程和技能版本")
  // The existing human editor's explicit resume is a distinct authorized action.
  f.store.saveRoutine({ ...routine, enabled: true, desiredEnabled: true }, { kind: "human" })
  const [runId] = f.store.emitEvent({
    nonce: "active-event",
    topic: "report.ready",
    payload: "project2"
  }).runIds
  expect(f.store.skillReferences.forRun(runId)).toEqual(routine.skillReferences)
  expect(f.store.autoReview.task(runId)?.routine).toMatchObject({
    id: routine.id,
    origin: "human",
    trigger: "event"
  })
})

it.each(["foreign", "unverified", "stale", "disabled"] as const)(
  "rejects a %s skill before review, saving or consuming the creation receipt",
  async (kind) => {
    const f = fixture()
    const ownerId =
      kind === "foreign" ? f.store.createBot({ nonce: "other", name: "其他 Bot" }).bot.id : f.bot.id
    let skill = f.store.saveSkill({
      botId: ownerId,
      name: "项目核对",
      instructions: "核对原件",
      enabled: true
    })
    if (kind !== "unverified") verify(f.store, skill)
    const selection = { botId: ownerId, id: skill.id, version: skill.version }
    if (kind === "stale") skill = f.store.saveSkill({ ...skill, instructions: "更改后的核对规则" })
    if (kind === "disabled") f.store.saveSkill({ ...skill, enabled: false })
    f.store.autoReview.change({
      ...f.store.autoReview.read(f.bot.id),
      isEnabled: true,
      nonce: "review-on"
    })
    const task = f.task("request", "将技能安排为暂停例程")
    const response = await invoke(
      task.tools(async () => {
        throw new Error("invalid selection reached approval")
      }),
      "create_routine",
      "invalid-skill",
      {
        ...specification,
        topic: "report.ready",
        enabled: false,
        skills: [selection]
      }
    )
    expect(String(response.content)).toContain(
      kind === "foreign"
        ? "skill_scope"
        : kind === "unverified"
          ? "skill_unverified"
          : kind === "stale"
            ? "skill_changed"
            : "skill_unavailable"
    )
    expect(f.store.routines(f.bot.id)).toEqual([])
    expect(f.store.hasToolResult(task.lease, "invalid-skill")).toBe(false)
    expect(f.store.snapshot().interactions).toEqual([])
    expect(f.store.messages(f.conversationId).filter((message) => message.routineOutcome)).toEqual(
      []
    )
  }
)

it("does not accept a filesystem path or an unknown skill field in the typed tool selection", async () => {
  const f = fixture()
  const task = f.task("request", "创建暂停例程")
  const args = {
    ...specification,
    topic: "report.ready",
    enabled: false,
    skills: [
      {
        botId: f.bot.id,
        id: "skill",
        version: 1,
        path: "/private/other/SKILL.md"
      }
    ]
  }
  await expect(invoke(task.tools(), "create_routine", "path-injection", args)).rejects.toThrow()
  expect(f.store.routines(f.bot.id)).toEqual([])
  expect(f.store.hasToolResult(task.lease, "path-injection")).toBe(false)
})

it("revalidates a selected skill after approval rather than saving a changed version under the old review", async () => {
  const f = fixture()
  const skill = f.store.saveSkill({
    botId: f.bot.id,
    name: "项目核对",
    instructions: "核对原件",
    enabled: true
  })
  verify(f.store, skill)
  f.store.autoReview.change({
    ...f.store.autoReview.read(f.bot.id),
    isEnabled: true,
    nonce: "review-on"
  })
  const task = f.task("request", "按这个技能创建暂停例程")
  const approve: ApproveLocalBotAction = async (id, action, operation) => {
    const review = f.store.requestInteraction(task.lease, {
      kind: "approval",
      action,
      prompt: JSON.stringify(action)
    })
    f.store.saveSkill({ ...skill, instructions: "审批期间更改的版本" })
    f.store.answerInteraction({
      id: review.id,
      revision: review.revision,
      answer: "approve"
    })
    return f.store.approvedToolOnce(task.lease, { id, action, approvalId: review.id }, operation)
  }
  const response = await invoke(task.tools(approve), "create_routine", "stale-after-review", {
    ...specification,
    topic: "report.ready",
    enabled: false,
    skills: [{ botId: f.bot.id, id: skill.id, version: skill.version }]
  })
  expect(String(response.content)).toContain("skill_changed")
  expect(f.store.routines(f.bot.id)).toEqual([])
  expect(f.store.hasToolResult(task.lease, "stale-after-review")).toBe(false)
  expect(f.store.messages(f.conversationId).filter((message) => message.routineOutcome)).toEqual([])
})
