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

async function pending(multiple: boolean, group = false) {
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
    ...(group ? {botBindingRef:"binding:room:1"} : {})
  })
  cleanups.push(() => { service.dispose(); releaseRoute(); releaseTransport(); cancelUserInputsForThread(threadId, "cleanup") })
  const question = { id: "format", header: "格式", question: "选择格式", allowMultiple: multiple || undefined,
    options: [{ label: "CSV", description: "数据" }, { label: "JSON", description: "结构" }] }
  const result = requestUserInput({ threadId, questions: [question], allowDeferredRenderer: true })
  void result.catch(() => {})
  await vi.waitFor(() => expect(notices).toHaveLength(1))
  const request = getPendingUserInputForThread(threadId)!
  const answer = (text: string) => service.resolveAnswer({ principalId: "p", conversationKey: "c", argument: `AABB01 ${text}` })
  const card = (value: string, other?: string) => service.resolveCardAnswers({
    principalId: "p", conversationKey: "c", requestId: request.requestId,
    feedback: [{ key: "q0", value }, ...(other ? [{ key: "q0__other", value: other }] : [])]
  })
  return { service, answer, card, result, request, submitted, question, publish }
}

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
  for (const value of ["0", "3", "1,1", "1,x", "1,", "[]"]) {
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

it("uses the documented numbered input only for multi choice and retains the single selector", () => {
  const questions = [false, true].map((allowMultiple, index) => ({ key: `q${index}`, header: "格式", question: "选择格式", allowMultiple,
    options: [{ label: "CSV" }, { label: "JSON" }] }))
  const json = JSON.stringify(buildQuestionCard({ targetLabel: "Bot", questions, tag: "test" }))
  expect(json).toContain('"subType":"listSelector"')
  expect(json).toContain('"isMultiple":false')
  expect(json).not.toContain('"isMultiple":true')
  expect(json).toContain("1. CSV")
  expect(json).toContain("2. JSON")
  expect(json).toContain("多个编号用逗号分隔")
})


it.each([false,true])("answers a desktop-origin group question through card=%s with its binding grant", async card => {
  const ctx = await pending(false,true)
  expect(ctx.publish).toHaveBeenCalledWith(expect.objectContaining({botBindingRef:"binding:room:1",conversationKey:"c"}))
  expect(await (card ? ctx.card("0") : ctx.answer("1"))).toContain("任务将继续")
  expect((await ctx.result).answers.format).toMatchObject({type:"option",optionIndex:0})
  expect(ctx.submitted).toHaveLength(1)
})
