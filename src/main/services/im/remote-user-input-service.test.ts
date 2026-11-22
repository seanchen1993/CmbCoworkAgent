import { afterEach, expect, it, vi } from "vitest"
import { tmpdir } from "node:os"
import type { UserInputResponse } from "../../types"

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] }, app: { getPath: () => tmpdir() }
}))
vi.mock("../../app-attention-events", () => ({ emitAppAttention: vi.fn() }))
import { requestUserInput, getPendingUserInputForThread, submitUserInputResponse, cancelUserInputsForThread } from "../user-input"
import { botInteractionRoutes } from "./bot-interaction-route"
import { ImRemoteUserInputService, imRemoteUserInputService } from "./remote-user-input-service"
import { buildQuestionCard } from "./card-builder"

imRemoteUserInputService.dispose()
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach((cleanup) => cleanup()))

async function pending(multiple: boolean, group = false, resultConfirmation = false) {
  const threadId = `im-choice-${Math.random()}`
  const submitted: UserInputResponse[] = []
  const notices: string[] = []
  const publish = vi.fn(async () => null)
  const service = new ImRemoteUserInputService({
    getSettings: () => ({ enabled: true }) as never,
    getThread: () => null,
    createCode: () => "AABB01",
    cards: { publish, interactions: { findByRequestRef: () => null }, resolveDetached() {} } as never,
    events: { enqueueProactiveReplies: async (replies) => { notices.push(JSON.stringify(replies)); return [] }, markOutboxFailed: async () => {} } as never,
    submitResponse: (response, options) => {
      const accepted = submitUserInputResponse(response, options)
      if (accepted) submitted.push(response)
      return accepted
    }
  })
  const releaseTransport = botInteractionRoutes.setTransport(() => true)
  const releaseRoute = botInteractionRoutes.register({
    principalId: "p", conversationKey: "c", realm: "r", kind: group ? "group" : "dm", prefix: "Bot", threadId, isCurrent: () => true,
    ...(group ? {botBindingRef:"binding:room:1", ...(resultConfirmation ? { senderId: "original-member" } : {})} : {})
  })
  cleanups.push(() => { service.dispose(); releaseRoute(); releaseTransport(); cancelUserInputsForThread(threadId, "cleanup") })
  const question = { id: "format", header: "格式", question: "选择格式", allowMultiple: multiple || undefined,
    options: [{ label: "CSV", description: "数据" }, { label: "JSON", description: "结构" }] }
  const result = requestUserInput({ threadId, questions: [question], allowDeferredRenderer: true,
    ...(resultConfirmation ? { kind: "bot_result_confirmation" as const, originalGroupSenderOnly: true } : {}) })
  void result.catch(() => {})
  await vi.waitFor(() => expect(notices).toHaveLength(1))
  const request = getPendingUserInputForThread(threadId)!
  const answer = (text: string) => service.resolveAnswer({ principalId: "p", conversationKey: "c", argument: `AABB01 ${text}` })
  const card = (value: string, other?: string) => service.resolveCardAnswers({
    principalId: "p", conversationKey: "c", requestId: request.requestId,
    feedback: [{ key: "q0", value }, ...(other ? [{ key: "q0__other", value: other }] : [])]
  })
  return { service, answer, card, result, request, submitted, question, publish, notices }
}

it("requires the original authenticated group member to confirm this delivery", async () => {
  const ctx = await pending(false, true, true)
  const reply = (botSenderId: string) => ctx.service.resolveAnswer({ principalId: "p", conversationKey: "c",
    botSenderId, argument: "AABB01 1" })
  expect(await reply("different-member")).toContain("群成员")
  expect(ctx.submitted).toHaveLength(0)
  expect(submitUserInputResponse({ requestId: ctx.request.requestId, answers: {} }, { desktopMainFrame: true })).toBe(false)
  expect(await reply("original-member")).toContain("任务将继续")
  expect((await ctx.result).answers.format).toMatchObject({ type: "option", optionIndex: 0 })
  expect(ctx.submitted).toHaveLength(1)
})

it.each([false, true])("accepts one or several real Bot multi choices through card=%s", async (card) => {
  for (const value of ["1", "1,2"]) {
    const ctx = await pending(true)
    expect(await (card ? ctx.card(value) : ctx.answer(value))).toContain("任务将继续")
    expect((await ctx.result).answers.format).toEqual({ type: "options", questionId: "format",
      options: ctx.question.options.slice(0, value === "1" ? 1 : 2).map((option, optionIndex) => ({ ...option, optionIndex })) })
    expect(getPendingUserInputForThread(ctx.request.threadId)).toBeNull()
    expect(await ctx.answer(value)).toContain("不存在")
    expect(ctx.submitted).toHaveLength(1)
    ctx.service.dispose()
  }
})

it("rejects malformed multi answers without consuming the pending request or short code", async () => {
  const ctx = await pending(true)
  expect(ctx.notices[0]).toContain("回复 /回答 AABB01 <编号，可用逗号分隔，如 1,2>")
  expect(await ctx.answer("1,1")).toContain("请输入不重复的选项编号")
  for (const value of ["0", "3", "1,x", "1,", "[]"]) {
    await ctx.answer(value)
    expect(getPendingUserInputForThread(ctx.request.threadId)?.requestId).toBe(ctx.request.requestId)
    expect(ctx.submitted).toHaveLength(0)
  }
  expect(await ctx.answer("1，2")).toContain("任务将继续")
  await ctx.result
})

it.each([false, true])("preserves single choice, free text and desktop completion (card=%s)", async (card) => {
  const single = await pending(false)
  expect(await (card ? single.card("0") : single.answer("1"))).toContain("任务将继续")
  expect((await single.result).answers.format).toMatchObject({ type: "option", optionIndex: 0 })
  single.service.dispose()
  const custom = await pending(true)
  expect(await (card ? custom.card("1,2", "其他格式") : custom.answer("其他 其他格式"))).toContain("任务将继续")
  expect((await custom.result).answers.format).toMatchObject({ type: "other", text: "其他格式" })
  custom.service.dispose()
  const desktop = await pending(true)
  expect(submitUserInputResponse({ requestId: desktop.request.requestId, ignored: true, answers: {} })).toBe(true)
  await desktop.result
  expect(await desktop.answer("1")).toContain("不存在")
})

it("shows every full option under its question before the group form, with matching selector numbers", () => {
  const questions = Array.from({ length: 6 }, (_, index) => ({
    key: `q${index}`, header: `口径 ${index + 1}`, question: `第 ${index + 1} 题采用哪种口径？`,
    allowMultiple: index === 5,
    options: [{ label: "周期可含未来日期", description: "按日历周期统计，结束日期可以在当前日期之后".repeat(3) }, { label: "仅统计已发生数据" }]
  }))
  const card = buildQuestionCard({ group: true, targetLabel: "群任务", questions, tag: "test" })
  expect(card[3].list).toEqual([{ content: "显示不全？在本群 @机器人 发送 /文字模式 开" }])
  const form = card.at(-1)!
  expect(form.type).toBe("interactive")
  for (const [index, question] of questions.entries()) {
    expect(card[4 + 2 * index].list).toEqual([{ type: [1], content: `${index + 1}. ${question.header}` }])
    expect(card[5 + 2 * index].list).toEqual([
      { content: question.question },
      { type: [1], content: "\n1. " },
      { content: `周期可含未来日期（${question.options[0].description}）` },
      { type: [1], content: "\n2. " },
      { content: "仅统计已发生数据" }
    ])
    const control = (form.inputControlArray as Record<string, unknown>[])[index * 2]
    expect(control.feedbackKey).toBe(question.key)
    if (question.allowMultiple) expect(control).toMatchObject({ subType: "inputBox", promptText: expect.stringContaining("多个编号") })
    else expect(control).toMatchObject({ subType: "listSelector", isMultiple: false, optionArray: [
      { text: "1. 周期可含未来日期", value: "0" }, { text: "2. 仅统计已发生数据", value: "1" }
    ] })
  }
})


it.each([false,true])("answers a desktop-origin group question through card=%s with its binding grant", async card => {
  const ctx = await pending(false,true)
  expect(ctx.publish).toHaveBeenCalledWith(expect.objectContaining({botBindingRef:"binding:room:1",conversationKey:"c"}))
  expect(await (card ? ctx.card("0") : ctx.answer("1"))).toContain("任务将继续")
  expect((await ctx.result).answers.format).toMatchObject({type:"option",optionIndex:0})
  expect(ctx.submitted).toHaveLength(1)
})
