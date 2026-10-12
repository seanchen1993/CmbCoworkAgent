import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { botProfileTools, type ApproveLocalBotAction } from "./profile-tools"
import type { BotRuntimeRequest } from "./host"

const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
)
function fixture(path = ":memory:", maxBots = 50) {
  const store = new BotStore(path, undefined, maxBots)
  cleanup.push(() => store.close())
  const created = store.createBot({
    nonce: "parent",
    name: "负责人",
    instructions: "原职责",
    modelRef: "model",
    workspacePath: "C:/project",
    connectorIds: ["notes"]
  })
  store.send({ nonce: "work", conversationId: created.conversationId, text: "创建助手并修改职责" })
  const claimed = store.claim("host")!
  const request: BotRuntimeRequest = {
    ...claimed,
    bot: created.bot,
    store,
    signal: new AbortController().signal,
    messages: store.messagesForRun(claimed.run.id)
  }
  const approve: ApproveLocalBotAction = async (id, action, operation) => {
    const previous = store.effectResult(request.lease, id, action)
    if (previous) return previous.result!
    const approval = store.requestInteraction(request.lease, {
      kind: "approval",
      action,
      prompt: JSON.stringify(action)
    })
    store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
    return store.approvedToolOnce(request.lease, { id, action, approvalId: approval.id }, operation)
  }
  return { store, request, approve, ...created }
}
function invoke(
  tools: ReturnType<typeof botProfileTools>,
  name: string,
  args: Record<string, unknown>,
  id = name
) {
  return tools.find((item) => item.name === name)!.invoke({ type: "tool_call", name, args, id })
}

it("commits Bot creation, approval consumption and receipt together; replay survives reopen without creating another Bot", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-profile-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite")
  const f = fixture(path)
  f.store.saveMemory({ botId: f.bot.id, text: "PRIVATE" })
  const tools = botProfileTools(f.request, () => f.store.assertLease(f.request.lease), f.approve)
  const args = { name: "审查助手", description: "负责审查" }
  const result = await invoke(tools, "create_bot", args)
  const parsed = JSON.parse(String(result.content))
  expect(parsed.bot).toMatchObject({
    name: "审查助手",
    instructions: "负责审查",
    modelRef: "model",
    workspacePath: "C:/project",
    connectorIds: ["notes"]
  })
  expect(f.store.memories(parsed.bot.id)).toEqual([])
  expect(f.store.routines(parsed.bot.id)).toEqual([])
  expect(f.store.messages(parsed.conversationId)).toEqual([])
  expect(f.store.effects(f.request.run.id)).toEqual([
    expect.objectContaining({ status: "succeeded" })
  ])
  expect((await invoke(tools, "create_bot", args)).content).toEqual(result.content)
  expect(f.store.listBots()).toHaveLength(2)
  expect(
    f.store.events(0, 100).filter((event) => event.kind === "bot.created-from-task")
  ).toHaveLength(1)
  f.store.close()
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  const id = `bot-create:${f.request.run.id}:create_bot`
  const action = {
    botProfile: {
      operation: "create",
      ...args,
      modelRef: "model",
      workspacePath: "C:/project",
      connectorIds: ["notes"]
    }
  }
  expect(reopened.effectResult(f.request.lease, id, action)?.result).toEqual(result.content)
  expect(() =>
    reopened.effectResult(f.request.lease, id, {
      botProfile: { ...action.botProfile, name: "changed" }
    })
  ).toThrow("不同参数")
  reopened.finish(f.request.lease, "succeeded", "已创建审查助手。")
  const final = reopened.messages(f.conversationId).at(-1)!
  expect(final.entityReferences).toEqual([
    { kind: "bot", id: parsed.bot.id, name: "审查助手", conversationId: parsed.conversationId }
  ])
  expect(final.text).toBe("已创建审查助手。")
  expect(reopened.messages(parsed.conversationId)).toEqual([])
  const opening = reopened.nextClaim()!
  expect(opening.botId).toBe(parsed.bot.id)
  expect(reopened.introductionForRun(opening.id)).toEqual({ language: "auto" })
  expect(reopened.memories(parsed.bot.id)).toEqual([])
  expect(reopened.routines(parsed.bot.id)).toEqual([])
})

it.each(["assigned", "failed"])(
  "does not introduce a tool-created Bot after work was %s",
  async (mode) => {
    const f = fixture()
    const tools = botProfileTools(f.request, () => f.store.assertLease(f.request.lease), f.approve)
    const created = JSON.parse(
      String((await invoke(tools, "create_bot", { name: "核对助手" })).content)
    )
    if (mode === "assigned")
      f.store.send({
        nonce: "actual-first-task",
        conversationId: created.conversationId,
        text: "核对这些数字"
      })
    f.store.finish(f.request.lease, mode === "failed" ? "failed" : "succeeded", "创建后结束。")
    expect(f.store.db.exec("SELECT COUNT(*) FROM bot_introductions")[0].values[0][0]).toBe(0)
    if (mode === "assigned") {
      expect(f.store.nextClaim()!.source).toBe("user")
      expect(f.store.messages(created.conversationId).map((item) => item.text)).toEqual([
        "核对这些数字"
      ])
    } else expect(f.store.messages(created.conversationId)).toEqual([])
  }
)

it("rolls back both local mutation and effect on failure, allowing a confirmed retry without an unknown external effect", () => {
  const f = fixture()
  const action = { name: "助手" }
  const approval = f.store.requestInteraction(f.request.lease, {
    kind: "approval",
    prompt: "创建",
    action
  })
  f.store.answerInteraction({ id: approval.id, revision: 1, answer: "approve" })
  const input = { id: "atomic-create", action, approvalId: approval.id }
  expect(() =>
    f.store.approvedToolOnce(f.request.lease, input, () => {
      f.store.createBot({ nonce: "child", name: "助手" }, f.request.lease)
      throw new Error("database operation failed")
    })
  ).toThrow("database operation failed")
  expect(f.store.listBots()).toHaveLength(1)
  expect(f.store.effects(f.request.run.id)).toEqual([])
  expect(f.store.entityReferences.createdInRun(f.request.run.id)).toEqual([])
  const operation = () => JSON.stringify(f.store.createBot({ nonce: "child", name: "助手" }))
  const result = f.store.approvedToolOnce(f.request.lease, input, operation)
  expect(f.store.approvedToolOnce(f.request.lease, input, operation)).toBe(result)
  expect(f.store.listBots()).toHaveLength(2)
})

it("omits a deleted created target and refuses creation from a stopped origin lease", async () => {
  const f = fixture()
  const tools = botProfileTools(f.request, () => f.store.assertLease(f.request.lease), f.approve)
  const result = await invoke(tools, "create_bot", { name: "临时核对助手" })
  const created = JSON.parse(String(result.content))
  f.store.deleteBot(created.bot.id, created.bot.revision)
  expect(f.store.entityReferences.createdInRun(f.request.run.id)).toEqual([])
  f.store.cancel(f.request.run.id)
  expect(() =>
    f.store.createBot({ nonce: "late-create", name: "不应创建" }, f.request.lease)
  ).toThrow()
  expect(f.store.listBots()).toHaveLength(1)
})

it("allows only leased self profile edits during execution, preserves capabilities and fences stale revisions and stopped runs", async () => {
  const f = fixture()
  const tools = botProfileTools(f.request, () => f.store.assertLease(f.request.lease), f.approve)
  expect(() =>
    f.store.updateBot({ id: f.bot.id, revision: 1, instructions: "UI override" })
  ).toThrow("先停止")
  const result = await invoke(tools, "update_bot", {
    agent_id: f.bot.id,
    revision: 1,
    description: "新职责",
    name: ""
  })
  expect(JSON.parse(String(result.content))).toMatchObject({
    ok: true,
    appliesFrom: "next_turn",
    bot: {
      name: "负责人",
      instructions: "新职责",
      modelRef: "model",
      workspacePath: "C:/project",
      connectorIds: ["notes"]
    }
  })
  const conflict = await invoke(
    tools,
    "update_bot",
    { agent_id: f.bot.id, revision: 1, description: "覆盖" },
    "stale"
  )
  expect(String(conflict.content)).toContain("revision_conflict")
  expect(f.store.effects(f.request.run.id)).toHaveLength(1)
  expect(f.store.getBot(f.bot.id).instructions).toBe("新职责")
  f.store.cancel(f.request.run.id)
  expect(() =>
    f.store.updateBotProfile(f.request.lease, {
      id: f.bot.id,
      revision: 2,
      instructions: "stopped"
    })
  ).toThrow()
})

it("does not permit the caller's lease to overwrite another running Bot", async () => {
  const f = fixture()
  const other = f.store.createBot({ nonce: "other", name: "其他" })
  f.store.send({ nonce: "other-work", conversationId: other.conversationId, text: "工作" })
  f.store.claim("host-two")
  const tools = botProfileTools(f.request, () => f.store.assertLease(f.request.lease), f.approve)
  const result = await invoke(tools, "update_bot", {
    agent_id: other.bot.id,
    revision: 1,
    description: "覆盖"
  })
  expect(String(result.content)).toContain("bot_busy")
  expect(f.store.getBot(other.bot.id).revision).toBe(1)
  expect(f.store.effects(f.request.run.id)).toEqual([])
})

it("enforces the same limit for creation and cloning, counts hidden Bots, frees deleted slots, and preserves committed retries", async () => {
  const f = fixture(":memory:", 2)
  const create = { nonce: "slot", name: "占用名额" }
  const child = f.store.createBot(create).bot
  const hidden = f.store.updateBot({ id: child.id, revision: child.revision, hidden: true })
  expect(() => f.store.createBot({ nonce: "over", name: "超限" })).toThrow("最多")
  expect(() => f.store.cloneBot({ nonce: "clone", id: f.bot.id, revision: 1 })).toThrow("最多")
  expect(f.store.createBot(create).bot.id).toBe(child.id)
  const tools = botProfileTools(f.request, () => f.store.assertLease(f.request.lease), f.approve)
  expect(String((await invoke(tools, "create_bot", { name: "超限" })).content)).toContain(
    "bot_limit"
  )
  expect(f.store.effects(f.request.run.id)).toEqual([])
  f.store.deleteBot(hidden.id, hidden.revision)
  expect(f.store.cloneBot({ nonce: "clone", id: f.bot.id, revision: 1 }).bot.id).not.toBe(child.id)
  expect(f.store.listBots()).toHaveLength(2)
})
