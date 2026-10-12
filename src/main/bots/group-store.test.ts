import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { parseGroupMentions, orderRoundSpeakers } from "./upstream/grok-group-chat"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture(path = ":memory:", count = 2) {
  const store = new BotStore(path)
  cleanup.push(() => store.close())
  const bots = Array.from({ length: count }, (_, index) =>
    store.createBot({ nonce: `bot-${index}`, name: `Bot${index}` })
  )
  const group = store.createGroup({
    nonce: "group",
    name: "项目讨论",
    members: bots.map(({ bot }) => bot.id)
  })
  return { store, bots, group }
}
function speak(
  store: BotStore,
  lease: Parameters<BotStore["assertLease"]>[0],
  text: string,
  call = "public"
) {
  return store.toolOnce(lease, call, { text }, () => store.groups.post(lease, text))
}

it("reuses one Bot in independent rooms with durable receipts and separate public histories", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-single-room-"))
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }))
  const path = join(directory, "bots.sqlite")
  const { store, bots, group } = fixture(path, 1)
  const member = bots[0].bot.id
  const input = { nonce: "second-room", name: "独立核验", members: [member] }
  const second = store.createGroup(input)
  expect(second.id).not.toBe(group.id)
  expect(store.createGroup(input)).toEqual(second)
  expect(() => store.createGroup({ ...input, name: "不同意图" })).toThrow()
  store.send({ nonce: "first-work", conversationId: group.id, text: "FIRST_ROOM_ONLY" })
  const first = store.claim("host")!
  expect(first.run.botId).toBe(member)
  speak(store, first.lease, "FIRST_RESULT_ONLY")
  store.finish(first.lease, "succeeded", "PRIVATE_SCRATCH")
  store.advanceGroups()
  expect(store.claim("host")).toBeNull()
  store.close()
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  expect(reopened.createGroup(input)).toEqual(second)
  expect(reopened.snapshot().bots.map((bot) => bot.id)).toEqual([member])
  expect(reopened.messages(group.id).map((message) => message.text)).toEqual([
    "FIRST_ROOM_ONLY",
    "FIRST_RESULT_ONLY"
  ])
  expect(reopened.messages(second.id)).toEqual([])
  reopened.send({ nonce: "second-work", conversationId: second.id, text: "SECOND_ROOM_ONLY" })
  const next = reopened.claim("host")!
  expect(next.run.botId).toBe(member)
  const prompt = reopened.groups.scope(next.run.id)!.prompt
  expect(prompt).toContain("SECOND_ROOM_ONLY")
  expect(prompt).not.toContain("FIRST_ROOM_ONLY")
  expect(prompt).not.toContain("FIRST_RESULT_ONLY")
  expect(prompt).not.toContain("PRIVATE_SCRATCH")
  expect(reopened.messages(bots[0].conversationId)).toEqual([])
})

it.each(["succeeded", "failed"] as const)(
  "finishes a single-member room after its %s turn without starting a self-reply",
  (status) => {
    const { store, group } = fixture(":memory:", 1)
    store.send({ nonce: "single-turn", conversationId: group.id, text: "核验" })
    const first = store.claim("host")!
    speak(store, first.lease, "核验结果", "first-publication")
    speak(store, first.lease, "补充依据", "second-publication")
    store.advanceGroups()
    expect(store.groups.isCurrent(first.run.id)).toBe(true)
    expect(store.claim("host")).toBeNull()
    store.finish(first.lease, status, status === "failed" ? "核验失败" : "PRIVATE_SCRATCH")
    store.advanceGroups()
    store.advanceGroups()
    expect(store.claim("host")).toBeNull()
    expect(store.groups.isCurrent(first.run.id)).toBe(false)
    expect(store.events().filter((event) => event.kind === "group.completed")).toHaveLength(1)
    expect(store.messages(group.id).map((message) => message.text)).toEqual([
      "核验",
      "核验结果",
      "补充依据",
      ...(status === "failed" ? ["核验失败"] : [])
    ])
  }
)

it("retains Grok mention boundaries and rotates round speakers", () => {
  const members = [
    { id: "a", name: "Alice Smith" },
    { id: "b", name: "验证员" }
  ]
  expect(parseGroupMentions("@Alice @验证员", members).memberIds).toEqual(["a", "b"])
  expect(parseGroupMentions("email@alice.example @alicesmithx", members).memberIds).toEqual([])
  expect(parseGroupMentions("@everyone", members).isEveryone).toBe(true)
  expect(orderRoundSpeakers(["a", "b", "c"], 1)).toEqual(["b", "c", "a"])
})

it("routes mentions, posts only explicit messages and stops after an all-pass round", () => {
  const { store, bots, group } = fixture()
  const sent = store.send({ nonce: "send", conversationId: group.id, text: "@Bot1 请检查" })
  expect(sent.runIds).toHaveLength(1)
  const first = store.claim("host")!
  expect(store.groups.hasResponded(first.lease)).toBe(false)
  expect(first.run.botId).toBe(bots[1].bot.id)
  expect(store.claim("other-host")).toBeNull()
  const response = speak(store, first.lease, "检查通过")
  expect(store.groups.hasResponded(first.lease)).toBe(true)
  expect(speak(store, first.lease, "检查通过")).toEqual(response)
  store.finish(first.lease, "succeeded", "PRIVATE_SCRATCH")
  store.advanceGroups()
  const next = store.claim("host")!
  expect(store.groups.hasResponded(next.lease)).toBe(false)
  expect(next.run.botId).toBe(bots[1].bot.id)
  expect(store.groups.scope(next.run.id)?.prompt).not.toContain("PRIVATE_SCRATCH")
  speak(store, next.lease, "(pass)")
  expect(store.groups.hasResponded(next.lease)).toBe(true)
  store.finish(next.lease, "succeeded", "another private summary")
  store.advanceGroups()
  expect(store.claim("host")).toBeNull()
  expect(store.messages(group.id).map((message) => message.text)).toEqual([
    "@Bot1 请检查",
    "检查通过"
  ])
  expect(store.events().filter((event) => event.kind === "group.completed")).toHaveLength(1)
})

it("retains explicit group pass resolution across reopen without publishing or counting scratch text", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-group-pass-"))
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }))
  const path = join(directory, "bots.sqlite")
  const { store, group } = fixture(path)
  store.send({ nonce: "send", conversationId: group.id, text: "@Bot0 检查" })
  const { lease } = store.claim("host")!
  const passed = speak(store, lease, "(pass)")
  expect(passed).toEqual({ posted: false, remaining: 2 })
  store.close()
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  expect(reopened.groups.hasResponded(lease)).toBe(true)
  expect(speak(reopened, lease, "(pass)")).toEqual(passed)
  speak(reopened, lease, "(pass)", "second-explicit-pass")
  expect(reopened.events().filter((event) => event.kind === "group.passed")).toHaveLength(1)
  expect(reopened.messages(group.id)).toHaveLength(1)
  reopened.send({ nonce: "new", conversationId: group.id, text: "@Bot0 新要求" })
  expect(() => reopened.groups.hasResponded(lease)).toThrow()
  expect(() => speak(reopened, lease, "DO_NOT_PUBLISH", "old-run")).toThrow()
  expect(reopened.messages(group.id).map((message) => message.text)).toEqual([
    "@Bot0 检查",
    "@Bot0 新要求"
  ])
})

it("records only a nonempty final pass, survives reopen and rejects an obsolete turn", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-group-final-pass-"))
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }))
  const path = join(directory, "bots.sqlite")
  const { store, group } = fixture(path)
  store.send({ nonce: "send", conversationId: group.id, text: "@Bot0 检查" })
  const { lease } = store.claim("host")!
  for (const text of ["", "  ", "已完成", "(pass) 已完成", "<think>(pass)</think>"])
    expect(store.groups.acceptFinalPass(lease, text)).toBe(false)
  expect(store.groups.hasResponded(lease)).toBe(false)
  expect(store.groups.acceptFinalPass(lease, "(pass)")).toBe(true)
  store.close()
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  expect(reopened.groups.acceptFinalPass(lease, "(pass)")).toBe(true)
  expect(reopened.groups.hasResponded(lease)).toBe(true)
  expect(reopened.events().filter((event) => event.kind === "group.passed")).toHaveLength(1)
  expect(reopened.messages(group.id)).toHaveLength(1)
  const count = reopened.db.exec("SELECT sent_count FROM bot_group_runs WHERE run_id=?", [
    lease.runId
  ])[0].values[0][0]
  expect(count).toBe(0)
  reopened.send({ nonce: "replace", conversationId: group.id, text: "@Bot0 新要求" })
  expect(() => reopened.groups.acceptFinalPass(lease, "(pass)")).toThrow()
  expect(reopened.events().filter((event) => event.kind === "group.passed")).toHaveLength(1)
})

it("keeps a prior decline in this cycle without hiding a new peer question or exposing scratch", () => {
  const { store, group } = fixture()
  store.send({ nonce: "send", conversationId: group.id, text: "@everyone 分析" })
  const first = store.claim("host")!
  store.groups.acceptFinalPass(first.lease, "(pass)")
  store.finish(first.lease, "succeeded", "PRIVATE_DECLINE")
  store.advanceGroups()
  const second = store.claim("host")!
  speak(store, second.lease, "@Bot0 请核对新结果")
  store.finish(second.lease, "succeeded", "PRIVATE_PEER")
  store.advanceGroups()
  const rotated = store.claim("host")!
  speak(store, rotated.lease, "(pass)")
  store.finish(rotated.lease, "succeeded", "")
  store.advanceGroups()
  const followup = store.claim("host")!
  expect(followup.run.botId).toBe(first.run.botId)
  const scope = store.groups.scope(followup.run.id)!
  expect(scope.prompt).toContain("你此前已明确跳过本次请求的一轮发言")
  expect(scope.prompt).toContain("@Bot0 请核对新结果")
  expect(scope.prompt).not.toContain("你已经公开答复本次用户请求")
  expect(scope.prompt).not.toContain("PRIVATE_")
  store.groups.acceptFinalPass(followup.lease, "(pass)")
  store.finish(followup.lease, "succeeded", "")
  store.send({ nonce: "new", conversationId: group.id, text: "@Bot0 新问题" })
  const newRequest = store.claim("host")!
  expect(store.groups.scope(newRequest.run.id)!.prompt).not.toContain(
    "你此前已明确跳过本次请求的一轮发言"
  )
})

it("round robins with a hard ten-message cap and two deliveries per member turn", () => {
  const { store, group } = fixture(":memory:", 3)
  store.send({ nonce: "send", conversationId: group.id, text: "@everyone 讨论" })
  let turns = 0
  for (;;) {
    const claim = store.claim("host")
    if (!claim) break
    turns++
    speak(store, claim.lease, `reply ${turns}-1`, "one")
    speak(store, claim.lease, `reply ${turns}-2`, "two")
    expect(() => speak(store, claim.lease, "extra", "three")).toThrow("上限")
    store.finish(claim.lease, "succeeded", "private")
    store.advanceGroups()
    store.advanceGroups()
    expect(turns).toBeLessThanOrEqual(5)
  }
  expect(turns).toBe(5)
  expect(store.messages(group.id).filter((message) => message.sender === "bot")).toHaveLength(10)
})

it("resumes a dependent verifier after waiting and reopening, with the actual current-cycle result", () => {
  const directory = mkdtempSync(join(tmpdir(), "bot-group-dependency-"))
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }))
  const path = join(directory, "bots.sqlite")
  const { store, bots, group } = fixture(path)
  const task = "@Bot1 先交付计算结果；@Bot0 独立核对该结果。各只发一条结果。"
  store.send({ nonce: "dependency", conversationId: group.id, text: task })
  const earlyVerifier = store.claim("host")!
  expect(earlyVerifier.run.botId).toBe(bots[0].bot.id)
  const waitingScope = store.groups.scope(earlyVerifier.run.id)!
  expect(waitingScope.systemPrompt).toContain("对方尚未交付时，发送 (pass) 等待后续轮次")
  expect(waitingScope.systemPrompt).toContain("不能证明对方的结果正确")
  expect(waitingScope.prompt).not.toContain("CURRENT_CALCULATION_RESULT")
  speak(store, earlyVerifier.lease, "(pass)")
  store.finish(earlyVerifier.lease, "succeeded", "PRIVATE_WAIT_SCRATCH")
  store.advanceGroups()
  store.close()
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  const producer = reopened.claim("new-host")!
  expect(producer.run.botId).toBe(bots[1].bot.id)
  speak(reopened, producer.lease, "CURRENT_CALCULATION_RESULT")
  reopened.finish(producer.lease, "succeeded", "PRIVATE_PRODUCER_SCRATCH")
  reopened.advanceGroups()
  const rotatedProducer = reopened.claim("new-host")!
  expect(rotatedProducer.run.botId).toBe(producer.run.botId)
  speak(reopened, rotatedProducer.lease, "(pass)")
  reopened.finish(rotatedProducer.lease, "succeeded", "")
  reopened.advanceGroups()
  const verifier = reopened.claim("new-host")!
  expect(verifier.run.botId).toBe(earlyVerifier.run.botId)
  const scope = reopened.groups.scope(verifier.run.id)!
  expect(scope.prompt).toContain("你此前已明确跳过本次请求的一轮发言")
  expect(scope.prompt).toContain("CURRENT_CALCULATION_RESULT")
  expect(scope.prompt).toContain(task)
  expect(scope.prompt).not.toContain("PRIVATE_")
  speak(reopened, verifier.lease, "CURRENT_VERIFICATION_JUDGMENT")
  reopened.finish(verifier.lease, "succeeded", "")
  reopened.advanceGroups()
  for (let index = 0; index < 2; index++) {
    const last = reopened.claim("new-host")!
    speak(reopened, last.lease, "(pass)")
    reopened.finish(last.lease, "succeeded", "")
    reopened.advanceGroups()
  }
  expect(reopened.claim("new-host")).toBeNull()
  expect(reopened.messages(group.id).map((message) => message.text)).toEqual([
    task,
    "CURRENT_CALCULATION_RESULT",
    "CURRENT_VERIFICATION_JUDGMENT"
  ])
})

it("keeps the member's last public delivery as context while admitting a peer's new question", () => {
  const { store, group } = fixture()
  store.send({ nonce: "send", conversationId: group.id, text: "@everyone 核对交付" })
  const first = store.claim("host")!
  speak(store, first.lease, "定位依据已经交付")
  store.finish(first.lease, "succeeded", "PRIVATE_INTERNAL_RESULT")
  store.advanceGroups()
  const second = store.claim("host")!
  speak(store, second.lease, "@Bot0 请补充验证结果")
  store.finish(second.lease, "succeeded", "PRIVATE_PEER_SCRATCH")
  store.advanceGroups()
  // Grok rotates the next round's speakers; Bot1 goes first this time.
  const rotated = store.claim("host")!
  expect(rotated.run.botId).toBe(second.run.botId)
  speak(store, rotated.lease, "(pass)")
  store.finish(rotated.lease, "succeeded", "")
  store.advanceGroups()
  const followup = store.claim("host")!
  expect(followup.run.botId).toBe(first.run.botId)
  const prompt = store.groups.scope(followup.run.id)!.prompt
  expect(prompt).toContain("Your latest already-delivered public reply")
  expect(prompt).toContain(JSON.stringify("定位依据已经交付"))
  expect(prompt).toContain("@Bot0 请补充验证结果")
  expect(prompt).toContain("不要重复介绍或重复交付")
  expect(prompt).toContain("你已经公开答复本次用户请求")
  expect(prompt).toContain("只有针对你的新问题")
  expect(prompt).toContain("send_group_message")
  expect(prompt).not.toContain("PRIVATE_INTERNAL_RESULT")
  expect(prompt).not.toContain("PRIVATE_PEER_SCRATCH")
  expect(store.groups.hasResponded(followup.lease)).toBe(false)
  speak(store, followup.lease, "(pass)")
  store.finish(followup.lease, "succeeded", "")
  store.advanceGroups()
  const name = store.getBot(first.run.botId).name
  store.send({ nonce: "new-request", conversationId: group.id, text: `@${name} ？` })
  const nextRequest = store.claim("host")!
  expect(nextRequest.run.botId).toBe(first.run.botId)
  const nextPrompt = store.groups.scope(nextRequest.run.id)!.prompt
  expect(nextPrompt).toContain("本次用户请求尚未得到群内公开答复")
  expect(nextPrompt).toContain("之前请求的答复不能代替本次答复")
  expect(nextPrompt.indexOf("本次用户请求尚未得到群内公开答复")).toBeGreaterThan(
    nextPrompt.indexOf("Your latest already-delivered public reply")
  )
  expect(nextPrompt).toContain("不能因内容简短或旧请求已完成而跳过")
  expect(nextPrompt).toContain("调用 read_message 读取后再回答")
  expect(nextPrompt).toContain("上下文仍无法确定意图时才澄清")
  expect(nextPrompt).toContain("旧结果只能说明过去的交付，不能替代本轮新工作或授权")
  expect(store.groups.scope(nextRequest.run.id)?.systemPrompt).toContain(
    "询问上一轮的进展、结果或含义时，读取相关历史公开回复"
  )
  expect(store.groups.scope(nextRequest.run.id)?.systemPrompt).toContain(
    "旧技能选择和旧分工不会自动成为本次任务"
  )
  expect(store.groups.scope(nextRequest.run.id)?.systemPrompt).toContain("一位成员已作出充分答复后")
  expect(nextPrompt).not.toContain("你已经公开答复本次用户请求")
  expect(nextPrompt).not.toContain("定位依据已经交付")
  expect(store.groups.scope(nextRequest.run.id)?.background.map(({ text }) => text)).toContain(
    "定位依据已经交付"
  )
  expect(nextPrompt).not.toContain("Your latest already-delivered public reply")
})

it("keeps repeated-task old verification out of the current-turn delivery context", () => {
  const { store, group } = fixture()
  const task = "一位成员完成计算，另一位独立核对；各发一次。"
  store.send({ nonce: "old-task", conversationId: group.id, text: task })
  const oldFirst = store.claim("host")!
  speak(store, oldFirst.lease, "OLD_CALCULATION")
  store.finish(oldFirst.lease, "succeeded", "PRIVATE_OLD_REASONING")
  store.advanceGroups()
  const oldVerifier = store.claim("host")!
  speak(store, oldVerifier.lease, "OLD_VERIFICATION")
  store.finish(oldVerifier.lease, "succeeded", "")
  store.advanceGroups()

  store.send({ nonce: "repeat-task", conversationId: group.id, text: task })
  const first = store.claim("host")!
  speak(store, first.lease, "CURRENT_CALCULATION")
  store.finish(first.lease, "succeeded", "")
  store.advanceGroups()
  const verifier = store.claim("host")!
  const scope = store.groups.scope(verifier.run.id)!
  const current = scope.prompt
  const historical = JSON.stringify(scope.background)
  expect(verifier.run.botId).toBe(oldVerifier.run.botId)
  expect(current).toContain(task)
  expect(current).toContain("CURRENT_CALCULATION")
  expect(current).not.toContain("OLD_CALCULATION")
  expect(current).not.toContain("OLD_VERIFICATION")
  expect(historical).toContain("OLD_CALCULATION")
  expect(historical).toContain("OLD_VERIFICATION")
  expect(historical).not.toContain("CURRENT_CALCULATION")
  expect(current).toContain("It's your turn")
  expect(scope.prompt).not.toContain("Your latest already-delivered public reply")
  expect(scope.prompt).not.toContain("PRIVATE_OLD_REASONING")
  expect(scope.prompt).toContain("本轮已有 1 条 Bot 公开消息")
  expect(scope.prompt).toContain("未点名的协作角色仍需按本轮进展接力")
  expect(scope.systemPrompt).toContain("前一位成员的结果不能代替另一位成员的独立核对")

  speak(store, verifier.lease, "CURRENT_VERIFICATION")
  store.finish(verifier.lease, "succeeded", "")
  store.advanceGroups()
  const next = store.claim("host")!
  const answered = store.groups.scope(next.run.id)!.prompt
  expect(answered).toContain("Your latest already-delivered public reply")
  expect(answered).toContain(JSON.stringify("CURRENT_VERIFICATION"))
  expect(answered).not.toContain(JSON.stringify("OLD_VERIFICATION"))
  expect(answered).toContain("你已经公开答复本次用户请求")
})

it("scopes repeat-task and continuation progress to the actual originating message identity", () => {
  const { store, bots, group } = fixture()
  const peer = store.createBot({ nonce: "private-peer", name: "Private verifier" })
  const task = "@everyone 重新读取原件并计算；已完成的本次交接只发一次。"
  const state = (runId: string) => {
    const prompt = store.groups.scope(runId)!.prompt
    return JSON.parse(/<group_task_state>(.*?)<\/group_task_state>/s.exec(prompt)![1])
  }
  const old = store.send({ nonce: "original", conversationId: group.id, text: task })
  const first = store.claim("host")!
  expect(state(first.run.id)).toMatchObject({
    taskId: old.messageId,
    assignmentMessageId: old.messageId,
    source: "user_request",
    discussionRound: 1,
    memberHasReplied: false,
    memberHasPassed: false,
    publicReplyCount: 0,
    peerDispatches: { deliveries: [], truncated: false }
  })
  const dispatched = store.sendPeer(first.lease, {
    nonce: "handoff",
    recipient: peer.bot.id,
    text: "Read the original once"
  })
  const privateRun = store.claim("peer-host")!
  expect(privateRun.run.id).toBe(dispatched.runIds[0])
  store.finish(privateRun.lease, "succeeded", "PRIVATE_HANDOFF_RESULT")
  speak(store, first.lease, "ORIGINAL_TASK_DELIVERY")
  store.finish(first.lease, "succeeded", "")
  store.advanceGroups()
  for (let index = 0; index < 2; index++) {
    const other = store.claim("host")!
    expect(other.run.botId).toBe(bots[1].bot.id)
    speak(store, other.lease, "(pass)")
    store.finish(other.lease, "succeeded", "")
    store.advanceGroups()
  }
  const continuation = store.claim("host")!
  expect(continuation.run.botId).toBe(first.run.botId)
  expect(state(continuation.run.id)).toMatchObject({
    taskId: old.messageId,
    discussionRound: 2,
    memberHasReplied: true,
    publicReplyCount: 1,
    peerDispatches: {
      deliveries: [{ runId: privateRun.run.id, recipient: peer.bot.name, status: "succeeded" }]
    }
  })
  expect(store.groups.scope(continuation.run.id)!.prompt).not.toContain("PRIVATE_HANDOFF_RESULT")
  speak(store, continuation.lease, "(pass)")
  store.finish(continuation.lease, "succeeded", "")
  store.advanceGroups()
  expect(store.claim("host")).toBeNull()

  const next = store.send({ nonce: "repeat", conversationId: group.id, text: task })
  expect(next.messageId).not.toBe(old.messageId)
  const newRun = store.claim("host")!
  const scope = store.groups.scope(newRun.run.id)!
  expect(state(newRun.run.id)).toMatchObject({
    taskId: next.messageId,
    assignmentMessageId: next.messageId,
    discussionRound: 1,
    memberHasReplied: false,
    memberHasPassed: false,
    publicReplyCount: 0,
    peerDispatches: { deliveries: [], truncated: false }
  })
  expect(scope.background.some((message) => message.text === "ORIGINAL_TASK_DELIVERY")).toBe(true)
  expect(scope.prompt).not.toContain(privateRun.run.id)
  expect(scope.prompt).not.toContain("这是同一条原始请求的连续讨论，不是新任务")
  expect(scope.prompt).toContain("必须取得本任务的新证据")
  expect(scope.systemPrompt).toContain("对方尚未交付时，发送 (pass) 等待后续轮次")
})

it("distinguishes an unanswered new request from another member's already public answer", () => {
  const { store, group } = fixture()
  store.send({ nonce: "question", conversationId: group.id, text: "？" })
  const first = store.claim("host")!
  const scope = store.groups.scope(first.run.id)!
  expect(scope.prompt).toContain("当前用户交办的任务（本轮有效指令）：\n？")
  expect(scope.prompt).not.toContain("本轮用户原始请求（引用数据）")
  expect(scope.prompt).toContain("本轮已有 0 条 Bot 公开消息")
  expect(scope.prompt).toContain("应通过 send_group_message 交付")
  expect(scope.systemPrompt).toContain("群内分工直接用公开消息 @ 对应成员")
  expect(scope.systemPrompt).toContain("不要在委派中夹带预设答案")
  speak(store, first.lease, "请说明需要协作完成的目标。")
  store.finish(first.lease, "succeeded", "")
  store.advanceGroups()
  const second = store.claim("host")!
  const later = store.groups.scope(second.run.id)!
  expect(later.prompt).toContain("本轮已有 1 条 Bot 公开消息")
  expect(later.prompt).toContain("完成本次用户明确分配给你的部分")
  expect(later.prompt).toContain("若本次只是追问，且其他成员已充分回答")
  expect(later.prompt).toContain("不自动重做上一轮的分工")
  expect(later.prompt).toContain("不要重复待命、澄清或礼貌确认")
  expect(later.prompt).not.toContain("本次用户请求尚未得到群内公开答复")
})

it("rejects a nonhuman origin instead of treating a peer record as the current human assignment", () => {
  const { store, bots, group } = fixture()
  const sent = store.send({ nonce: "origin", conversationId: group.id, text: "Current task" })
  const claim = store.claim("host")!
  store.db.run("UPDATE bot_messages SET sender='bot',bot_id=? WHERE id=?", [
    bots[1].bot.id,
    sent.messageId
  ])
  expect(() => store.groups.scope(claim.run.id)).toThrow("群聊缺少本轮用户交办的任务")
})

it("keeps group membership and history when rewriting only the current user's model input", () => {
  const { store, bots, group } = fixture()
  const earlier = store.send({
    nonce: "earlier",
    conversationId: group.id,
    text: "@Bot0 EARLIER_CONTEXT"
  })
  const first = store.claim("host")!
  speak(store, first.lease, "PEER_EVIDENCE")
  store.finish(first.lease, "succeeded", "PRIVATE_SCRATCH")
  const current = store.send({
    nonce: "next",
    conversationId: group.id,
    text: "@Bot1 ORIGINAL_TASK"
  })
  const next = store.claim("host")!
  expect(next.run.botId).toBe(bots[1].bot.id)
  const scope = store.groups.scope(next.run.id, {
    messageId: current.messageId,
    text: "REWRITTEN_TASK"
  })!
  expect(scope.prompt).toContain("REWRITTEN_TASK")
  expect(scope.prompt).not.toContain("ORIGINAL_TASK")
  expect(scope.prompt).not.toContain("EARLIER_CONTEXT")
  expect(scope.prompt).not.toContain("PEER_EVIDENCE")
  expect(scope.background.map(({ text }) => text)).toEqual([
    "@Bot0 EARLIER_CONTEXT",
    "PEER_EVIDENCE"
  ])
  expect(scope.prompt).toContain("Bot0")
  expect(scope.prompt).toContain("Bot1")
  expect(scope.prompt).toContain("send_group_message")
  expect(scope.prompt).not.toContain("PRIVATE_SCRATCH")
  expect(store.message({ conversationId: group.id, id: current.messageId }).text).toBe(
    "@Bot1 ORIGINAL_TASK"
  )
  expect(() =>
    store.groups.scope(next.run.id, { messageId: earlier.messageId, text: "REPLACE_HISTORY" })
  ).toThrow("当前任务")
  expect(store.groups.scope(next.run.id)?.prompt).toContain("ORIGINAL_TASK")
})

it.each(["@Bot0", "@everyone"])(
  "does not route a user's reply to mentions inside its quoted %s history",
  (mention) => {
    const { store, bots, group } = fixture()
    const earlier = store.send({
      nonce: "earlier",
      conversationId: group.id,
      text: `${mention} OLD`
    })
    const current = store.send({
      nonce: "reply",
      conversationId: group.id,
      text: "@Bot1 CURRENT",
      replyTo: earlier.messageId
    })
    const first = store.claim("host")!
    expect(first.run.messageId).toBe(current.messageId)
    expect(first.run.botId).toBe(bots[1].bot.id)
    // Quoted text is still available to the addressed Bot as task context.
    expect(store.groups.scope(first.run.id)?.prompt).toContain(`${mention} OLD`)
    speak(store, first.lease, "Checked the requested subject")
    store.finish(first.lease, "succeeded", "private")
    store.advanceGroups()
    const next = store.claim("host")!
    expect(next.run.botId).toBe(bots[1].bot.id)
    speak(store, next.lease, "(pass)")
    store.finish(next.lease, "succeeded", "private")
    store.advanceGroups()
    expect(store.claim("host")).toBeNull()
  }
)

it("stops after three rounds even when members continue adding replies", () => {
  const { store, group } = fixture()
  store.send({ nonce: "send", conversationId: group.id, text: "讨论" })
  const order: string[] = []
  for (;;) {
    const claim = store.claim("host")
    if (!claim) break
    order.push(claim.run.botId)
    speak(store, claim.lease, `reply ${order.length}`)
    store.finish(claim.lease, "succeeded", "private")
    store.advanceGroups()
    expect(order.length).toBeLessThanOrEqual(6)
  }
  expect(order).toEqual([...group.members, ...group.members.toReversed(), ...group.members])
})

it("invalidates the old epoch and rejects late deliveries after a new user instruction", () => {
  const { store, group } = fixture()
  store.send({ nonce: "old", conversationId: group.id, text: "旧指令" })
  const old = store.claim("host")!
  const replacement = store.send({ nonce: "new", conversationId: group.id, text: "改为新目标" })
  expect(store.getRun(old.run.id).status).toBe("cancelling")
  expect(() => speak(store, old.lease, "late")).toThrow("执行权")
  store.finish(old.lease, "cancelled", "stopped")
  store.advanceGroups()
  expect(store.claim("host")?.run.id).toBe(replacement.runIds[0])
  expect(store.messages(group.id).some((message) => message.text === "late")).toBe(false)
})

it("persists the current speaker and advances once after reopening the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-group-restart-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "bots.sqlite")
  const { store, group } = fixture(path)
  store.send({ nonce: "send", conversationId: group.id, text: "讨论" })
  const first = store.claim("host")!
  speak(store, first.lease, "已查到依据")
  store.finish(first.lease, "succeeded", "private")
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  reopened.advanceGroups()
  store.advanceGroups()
  const next = reopened.claim("host")!
  expect(next.run.botId).toBe(group.members[1])
  expect(store.claim("other")).toBeNull()
  expect(reopened.groups.scope(next.run.id)?.prompt).toContain("已查到依据")
  expect(
    reopened.messages(group.id).filter((message) => message.text === "已查到依据")
  ).toHaveLength(1)
})

it("keeps uncertain work waiting for review and prevents resuming a superseded epoch", () => {
  const { store, group } = fixture()
  store.send({ nonce: "send", conversationId: group.id, text: "讨论" })
  const first = store.claim("host")!
  store.db.run("UPDATE bot_runs SET lease_until=0 WHERE id=?", [first.run.id])
  store.recoverExpired()
  store.advanceGroups()
  expect(store.claim("host")).toBeNull()
  store.send({ nonce: "new", conversationId: group.id, text: "新目标" })
  const review = store.getRun(first.run.id)
  expect(() =>
    store.recover({
      id: review.id,
      revision: review.revision,
      decision: "resume",
      effects: [],
      note: "checked"
    })
  ).toThrow("旧群聊")
  expect(
    store.recover({
      id: review.id,
      revision: review.revision,
      decision: "cancel",
      effects: [],
      note: "checked"
    }).status
  ).toBe("cancelled")
})

it("keeps delegated results private until the member publishes and cancels old descendants", () => {
  const { store, bots, group } = fixture()
  store.send({ nonce: "send", conversationId: group.id, text: "@Bot0 处理" })
  const first = store.claim("host")!
  const peer = store.sendPeer(first.lease, {
    nonce: "peer",
    recipient: bots[1].bot.id,
    text: "请给私下证据"
  })
  const child = store.claim("peer-host")!
  expect(child.run.id).toBe(peer.runIds[0])
  store.finish(child.lease, "succeeded", "PRIVATE_PEER_RESULT")
  expect(store.messages(group.id).some((message) => message.text === "PRIVATE_PEER_RESULT")).toBe(
    false
  )
  const pending = store.sendPeer(first.lease, {
    nonce: "peer2",
    recipient: bots[1].bot.id,
    text: "更多证据"
  })
  store.send({ nonce: "new", conversationId: group.id, text: "改口" })
  expect(store.getRun(pending.runIds[0]).status).toBe("cancelled")
})

it("updates group membership with revision checks and invalidates in-flight turns", () => {
  const { store, bots, group } = fixture()
  const extra = store.createBot({ nonce: "extra", name: "新成员" })
  store.send({ nonce: "work", conversationId: group.id, text: "开始" })
  const current = store.claim("host")!
  const updated = store.updateGroup({
    id: group.id,
    revision: group.revision,
    name: "发布评审",
    description: "检查发布准备",
    members: [bots[0].bot.id, extra.bot.id]
  })
  expect(updated).toMatchObject({ name: "发布评审", description: "检查发布准备", revision: 2 })
  expect(updated.members).toContain(extra.bot.id)
  expect(store.getRun(current.run.id).status).toBe("cancelling")
  expect(() => store.updateGroup({ ...updated, revision: 1, description: "stale" })).toThrow(
    "群聊已变化"
  )
  expect(() =>
    store.updateGroup({ ...updated, description: "invalid", members: [bots[0].bot.id, "missing"] })
  ).toThrow()
  expect(store.getConversation(group.id)).toEqual(updated)
  expect(() =>
    store.updateGroup({
      id: bots[0].conversationId,
      revision: 1,
      name: "bad",
      description: "",
      members: [bots[0].bot.id, extra.bot.id]
    })
  ).toThrow("只能编辑群聊")
})

it("recovers a lost group update response without cancelling later work after reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-group-update-retry-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, "bots.sqlite")
  const { store, group } = fixture(path)
  const input = {
    id: group.id,
    revision: group.revision,
    nonce: "group-update-once",
    name: "发布评审",
    description: "检查发布准备",
    members: group.members
  }
  const saved = store.updateGroup(input)
  const next = store.send({ nonce: "later-work", conversationId: group.id, text: "开始下一轮" })
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  expect(reopened.updateGroup(input)).toEqual(saved)
  expect(reopened.getConversation(group.id).revision).toBe(saved.revision)
  expect(reopened.getRun(next.runIds[0]).status).toBe("queued")
  expect(
    reopened
      .events(0, 100)
      .filter((event) => event.kind === "conversation.updated" && event.entityId === group.id)
  ).toHaveLength(1)
  expect(() => reopened.updateGroup({ ...input, name: "另一个修改" })).toThrow("同一请求标识")
})

it("does not redeliver an accepted group message after lease recovery", () => {
  const { store, group } = fixture()
  store.send({ nonce: "send", conversationId: group.id, text: "讨论", recipients: [] })
  const first = store.claim("old-host")!
  const posted = speak(store, first.lease, "已提交的回复")
  store.db.run("UPDATE bot_runs SET lease_until=0 WHERE id=?", [first.run.id])
  store.recoverExpired()
  const review = store.getRun(first.run.id)
  store.recover({
    id: review.id,
    revision: review.revision,
    decision: "resume",
    effects: [],
    note: "已核对"
  })
  const resumed = store.claim("new-host")!
  expect(speak(store, resumed.lease, "已提交的回复")).toEqual(posted)
  expect(
    store.messages(group.id).filter((message) => message.text === "已提交的回复")
  ).toHaveLength(1)
})

it.each(["succeeded", "unknown"] as const)(
  "a new group instruction lets started effects settle as %s and forbids new dispatch",
  (effectStatus) => {
    const { store, group } = fixture()
    store.send({ nonce: "old", conversationId: group.id, text: "旧要求" })
    const old = store.claim("host")!
    const action = { tool: "submit" }
    const card = store.requestInteraction(old.lease, { kind: "approval", action, prompt: "提交" })
    store.answerInteraction({ id: card.id, revision: card.revision, answer: "approve" })
    store.beginEffect(old.lease, { id: "submit", action, approvalId: card.id })
    const next = store.send({
      nonce: "new",
      conversationId: group.id,
      text: "新要求",
      recipients: [old.run.botId]
    })
    expect(store.getRun(old.run.id).status).toBe("running")
    expect(() => store.assertLease(old.lease)).not.toThrow()
    expect(() => store.assertDispatch(old.lease)).toThrow("新消息")
    expect(() => store.toolOnce(old.lease, "new-work", {}, () => true)).toThrow("新消息")
    expect(() =>
      store.requestInteraction(old.lease, { kind: "question", prompt: "旧问题" })
    ).toThrow("新消息")
    expect(store.claim("next")).toBeNull()
    store.settleEffect(old.lease, "submit", effectStatus, "真实回执")
    store.finish(old.lease, "succeeded", "PRIVATE_OLD_SUMMARY")
    expect(store.getRun(old.run.id).status).toBe(
      effectStatus === "unknown" ? "needs_review" : "cancelled"
    )
    expect(store.effects(old.run.id)).toMatchObject([{ status: effectStatus, result: "真实回执" }])
    expect(
      store.messages(group.id).some((message) => message.text.includes("PRIVATE_OLD_SUMMARY"))
    ).toBe(false)
    expect(store.claim("next")?.run.id ?? null).toBe(
      effectStatus === "unknown" ? null : next.runIds[0]
    )
  }
)

it("explicit Stop still stops a group action that was draining after a new instruction", () => {
  const { store, group } = fixture()
  store.send({ nonce: "old", conversationId: group.id, text: "旧要求" })
  const old = store.claim("host")!
  const action = { tool: "submit" }
  const card = store.requestInteraction(old.lease, { kind: "approval", action, prompt: "提交" })
  store.answerInteraction({ id: card.id, revision: card.revision, answer: "approve" })
  store.beginEffect(old.lease, { id: "submit", action, approvalId: card.id })
  store.send({ nonce: "new", conversationId: group.id, text: "新要求" })
  store.cancel(old.run.id)
  expect(store.getRun(old.run.id).status).toBe("cancelling")
  expect(() => store.assertLease(old.lease)).toThrow()
  store.settleEffect(old.lease, "submit", "unknown", "停止后尚未收到回执")
  store.finish(old.lease, "cancelled", "停止")
  expect(store.getRun(old.run.id).status).toBe("needs_review")
})

it("keeps a one-Bot group and its history after removing a member without permitting an empty group", () => {
  const { store, bots, group } = fixture()
  store.send({ nonce: "old", conversationId: group.id, text: "保留的讨论" })
  const running = store.claim("host")!
  store.finish(running.lease, "succeeded", "private")
  const input = {
    ...group,
    description: group.description ?? "",
    members: [bots[0].bot.id],
    nonce: "remove-one"
  }
  const saved = store.updateGroup(input)
  expect(saved.members).toEqual([bots[0].bot.id])
  expect(store.updateGroup(input)).toEqual(saved)
  expect(store.messages(group.id).map((message) => message.text)).toContain("保留的讨论")
  expect(() => store.updateGroup({ ...saved, description: "", members: [] })).toThrow("1～6")
  expect(() => store.createGroup({ nonce: "empty-group", name: "缺少成员", members: [] })).toThrow(
    "1～6"
  )
  store.send({ nonce: "next", conversationId: group.id, text: "继续讨论" })
  const next = store.claim("host")!
  expect(next.run.botId).toBe(bots[0].bot.id)
  expect(store.groups.scope(next.run.id)?.systemPrompt).toContain(bots[0].bot.name)
  speak(store, next.lease, "(pass)")
  store.finish(next.lease, "succeeded", "private")
  store.advanceGroups()
  expect(store.claim("host")).toBeNull()
})

it("does not interrupt a pending approval when an unchanged group form is saved", () => {
  const { store, group } = fixture()
  store.send({ nonce: "work", conversationId: group.id, text: "继续工作" })
  const running = store.claim("host")!
  const approval = store.requestInteraction(running.lease, {
    kind: "approval",
    action: { tool: "check" },
    prompt: "检查"
  })
  const before = store.getRun(running.run.id)
  const input = {
    ...group,
    description: group.description ?? "",
    members: [...group.members].reverse(),
    nonce: "unchanged"
  }
  expect(store.updateGroup(input).revision).toBe(group.revision)
  expect(store.getRun(running.run.id)).toEqual(before)
  expect(store.updateGroup(input).revision).toBe(group.revision)
  expect(store.getInteraction(approval.id).status).toBe("pending")
  const changed = store.updateGroup({ ...input, nonce: "changed", description: "新任务目标" })
  expect(changed.revision).toBe(group.revision + 1)
  expect(() =>
    store.updateGroup({
      ...changed,
      description: "新任务目标",
      nonce: "stale",
      revision: group.revision
    })
  ).toThrow("群聊已变化")
})
