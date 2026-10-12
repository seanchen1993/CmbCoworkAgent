import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { botRoutineTools } from "./routine-tools"
import { sendReviewedBotPeer } from "./peer-approval"
import type { ApproveLocalBotAction } from "./profile-tools"

const stores: BotStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
function fixture() {
  let now = Date.now()
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "计划助手" })
  const recipient = store.createBot({ nonce: "peer", name: "验证助手" }).bot
  store.send({ nonce: "task", conversationId, text: "创建日检，并请验证助手检查项目" })
  const { run, lease } = store.claim("host")!
  const request = {
    store,
    bot,
    run,
    lease,
    messages: store.messagesForRun(run.id),
    signal: new AbortController().signal
  }
  const configure = (isEnabled: boolean) =>
    store.autoReview.change({
      ...store.autoReview.read(bot.id),
      isEnabled,
      nonce: `policy-${store.autoReview.read(bot.id).revision}`
    })
  configure(true)
  const seen: unknown[] = []
  const check = () => {
    store.assertLease(lease)
  }
  const approve =
    (before?: () => void, reject = false): ApproveLocalBotAction =>
    async (id, action, operation) => {
      seen.push(action)
      const interaction = store.requestInteraction(lease, {
        kind: "approval",
        prompt: JSON.stringify(action),
        action
      })
      store.answerInteraction({
        id: interaction.id,
        revision: interaction.revision,
        answer: reject ? "reject" : "approve"
      })
      before?.()
      if (reject) return "用户拒绝"
      return store.approvedToolOnce(lease, { id, action, approvalId: interaction.id }, operation)
    }
  const tools = (approval: ApproveLocalBotAction) =>
    botRoutineTools(
      request,
      check,
      async () => {
        throw new Error("unexpected external approval")
      },
      approval
    )
  return {
    store,
    bot,
    recipient,
    request,
    run,
    lease,
    configure,
    check,
    approve,
    tools,
    seen,
    advance: (milliseconds = 1000) => {
      now += milliseconds
    },
    now: () => now
  }
}

it("reviews the frozen routine plan and preserves its original interval and receipt after mode changes", async () => {
  const f = fixture(),
    start = f.now()
  const create = f.tools(f.approve(f.advance)).find((tool) => tool.name === "create_routine")!
  const input = {
    id: "create-one",
    type: "tool_call" as const,
    name: create.name,
    args: { name: "每小时检查", prompt: "检查项目", timezone: "UTC", every_minutes: 60 }
  }
  await create.invoke(input)
  const saved = f.store.routines(f.bot.id)[0]
  expect(saved.schedule).toEqual({
    kind: "interval",
    everyMs: 3_600_000,
    anchor: start + 3_600_000
  })
  expect(f.seen).toMatchObject([
    { routine: { operation: "create", before: null, after: { name: "每小时检查", enabled: true } } }
  ])
  f.configure(false)
  await create.invoke(input)
  f.configure(true)
  await create.invoke(input)
  expect(f.store.routines(f.bot.id)).toEqual([saved])
  expect(f.seen).toHaveLength(1)
  expect(f.store.effects(f.run.id)).toHaveLength(1)
  f.advance(3_600_000)
  const [occurrence] = f.store.dispatchDueRoutines()
  expect(f.store.autoReview.task(occurrence)).toMatchObject({
    messages: [{ text: saved.prompt }],
    routine: { origin: "human" }
  })
})

it("calculates a relative one-shot on the Host once and keeps its reviewed timestamp across retries", async () => {
  const f = fixture(),
    start = f.now()
  f.store.renew(f.lease, 300_000)
  const create = f
    .tools(f.approve(() => f.advance(60_000)))
    .find((tool) => tool.name === "create_routine")!
  const input = {
    id: "relative-once",
    type: "tool_call" as const,
    name: create.name,
    args: {
      name: "三分钟后",
      prompt: "ONLY_THE_MARKER",
      timezone: "Asia/Shanghai",
      after_seconds: 180
    }
  }
  await create.invoke(input)
  const saved = f.store.routines(f.bot.id)[0]
  expect(saved).toMatchObject({
    enabled: true,
    nextAt: start + 180_000,
    schedule: { kind: "once", at: start + 180_000 }
  })
  f.advance(180_000)
  await create.invoke(input)
  expect(f.store.routines(f.bot.id)).toEqual([saved])
  expect(f.seen).toHaveLength(1)
})

it("rejects an explicitly past one-shot and conflicting relative triggers without writing a definition", async () => {
  const f = fixture()
  f.configure(false)
  const create = f.tools(f.approve()).find((tool) => tool.name === "create_routine")!
  for (const [id, trigger] of [
    ["past", { at: f.now() - 1 }],
    ["conflict", { after_seconds: 180, every_minutes: 3 }]
  ] as const) {
    const response = await create.invoke({
      id,
      type: "tool_call",
      name: create.name,
      args: { name: "拒绝的计划", prompt: "MARKER", timezone: "UTC", ...trigger }
    })
    expect(JSON.parse(String(response.content))).toMatchObject({
      error: "invalid_schedule",
      now: f.now()
    })
  }
  expect(f.store.routines(f.bot.id)).toEqual([])
})

it("reports the Host clock when the existing store rejects a one-shot that expired during review", async () => {
  const f = fixture()
  const create = f
    .tools(f.approve(() => f.advance(5000)))
    .find((tool) => tool.name === "create_routine")!
  const response = await create.invoke({
    id: "expired-during-review",
    type: "tool_call",
    name: create.name,
    args: { name: "已过期", prompt: "MARKER", timezone: "UTC", at: f.now() + 1000 }
  })
  expect(JSON.parse(String(response.content))).toMatchObject({
    error: "invalid_schedule",
    now: f.now()
  })
  expect(f.store.routines(f.bot.id)).toEqual([])
})

it("does not create a rejected routine and rejects stale edits atomically", async () => {
  const f = fixture()
  const create = f.tools(f.approve(undefined, true)).find((tool) => tool.name === "create_routine")!
  await create.invoke({
    id: "rejected",
    type: "tool_call",
    name: create.name,
    args: { name: "日检", prompt: "检查", timezone: "UTC", topic: "daily" }
  })
  expect(f.store.routines(f.bot.id)).toEqual([])
  expect(f.store.effects(f.run.id)).toEqual([])
  const initial = f.store.saveRoutine({
    botId: f.bot.id,
    name: "原计划",
    prompt: "原要求",
    timezone: "UTC",
    schedule: { kind: "event", topic: "daily" },
    enabled: true
  })
  const update = f
    .tools(
      f.approve(() => {
        f.store.saveRoutine({ ...initial, prompt: "人工已修改" })
      })
    )
    .find((tool) => tool.name === "update_routine")!
  const result = await update.invoke({
    id: "stale",
    type: "tool_call",
    name: update.name,
    args: { id: initial.id, revision: initial.revision, prompt: "旧任务要求" }
  })
  expect(String(result.content)).toContain("revision_conflict")
  expect(f.store.routines(f.bot.id)[0].prompt).toBe("人工已修改")
  expect(f.store.effects(f.run.id)).toEqual([])
})

it("replays a routine written before review was enabled without creating another plan or approval", async () => {
  const f = fixture()
  f.configure(false)
  const create = f.tools(f.approve()).find((tool) => tool.name === "create_routine")!
  const input = {
    id: "legacy",
    type: "tool_call" as const,
    name: create.name,
    args: { name: "日检", prompt: "检查", timezone: "UTC", every_minutes: 60 }
  }
  await create.invoke(input)
  const original = f.store.routines(f.bot.id)
  f.configure(true)
  f.advance()
  await create.invoke(input)
  expect(f.store.routines(f.bot.id)).toEqual(original)
  expect(f.seen).toEqual([])
})

it("preserves complete long instructions in review details and bounds snapshots and tool results", async () => {
  const f = fixture()
  const prompt = "开始" + "\u0001".repeat(63_990) + "末尾要求"
  const before = f.store.saveRoutine({
    botId: f.bot.id,
    name: "完整指令",
    prompt,
    timezone: "UTC",
    enabled: true,
    schedule: { kind: "event", topic: "daily" }
  })
  const update = f
    .tools(async (id, action, operation) => {
      const approval = f.store.requestInteraction(f.lease, {
        kind: "approval",
        action,
        prompt: JSON.stringify(action)
      })
      const snapshot = f.store.snapshot()
      expect(snapshot.interactions[0]).toMatchObject({ prompt: "", promptTruncated: true })
      expect(JSON.stringify(snapshot).length).toBeLessThan(10_000)
      const detail = f.store.interactionDetail({
        conversationId: f.run.conversationId,
        runId: f.run.id,
        interactionId: approval.id
      })
      const shown = JSON.parse(detail.interaction.prompt).routine
      expect(shown.before.prompt).toBe(prompt)
      expect(shown.after.prompt).toBe(prompt + "。")
      f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
      return f.store.approvedToolOnce(f.lease, { id, action, approvalId: approval.id }, operation)
    })
    .find((tool) => tool.name === "update_routine")!
  const response = await update.invoke({
    id: "long-edit",
    type: "tool_call",
    name: update.name,
    args: { id: before.id, revision: before.revision, prompt: prompt + "。" }
  })
  expect(JSON.parse(String(response.content)).promptTruncated).toBe(true)
  expect(f.store.routine(f.bot.id, before.id).prompt).toBe(prompt + "。")
  expect(f.store.effects(f.run.id)).toHaveLength(1)
})

it.each(["allow", "reject", "changed", "legacy"] as const)(
  "keeps reviewed peer delivery atomic and recoverable (%s)",
  async (mode) => {
    const f = fixture()
    if (mode === "legacy") f.configure(false)
    const input = { callId: "peer-call", recipient: f.recipient.id, text: "验证项目测试" }
    const approve = f.approve(
      mode === "changed"
        ? () => {
            f.store.updateBot({
              id: f.recipient.id,
              revision: f.recipient.revision,
              instructions: "新职责"
            })
          }
        : undefined,
      mode === "reject"
    )
    const send = () => sendReviewedBotPeer(f.request, input, f.check, approve)
    if (mode === "changed") await expect(send()).rejects.toThrow("职责或权限已变化")
    else await send()
    if (mode === "allow" || mode === "legacy") {
      const first = f.store.snapshot().runs.filter((run) => run.parentRunId === f.run.id)
      expect(first).toHaveLength(1)
      f.configure(true)
      const receipt = JSON.parse(await send())
      expect(receipt.runIds).toEqual([first[0].id])
      expect(f.seen).toHaveLength(mode === "allow" ? 1 : 0)
      await expect(
        sendReviewedBotPeer(f.request, { ...input, text: "换个任务" }, f.check, approve)
      ).rejects.toThrow("同一请求标识")
    } else {
      expect(f.store.snapshot().runs.filter((run) => run.parentRunId === f.run.id)).toEqual([])
      expect(f.store.effects(f.run.id)).toEqual([])
    }
  }
)
