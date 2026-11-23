import { describe, expect, it } from "vitest"
import {
  userInputAnswers,
  pendingUserInputPatch,
  userInputDraftPatch,
  type UserInputDraft
} from "./user-input-answer"
import type { UserInputRequest } from "@/types"

const questions = [
  {
    id: "format",
    header: "格式",
    question: "选择格式？",
    options: [
      { label: "简版", description: "核心内容" },
      { label: "完整版", description: "全部内容" }
    ]
  },
  { id: "name", header: "名称", question: "如何命名？", options: [] }
]

describe("original user input response projection", () => {
  it("keeps explicit multiple selections in option order without mutating the draft", () => {
    const question = { ...questions[0], allowMultiple: true }
    const draft = { format: { type: "options" as const, optionIndices: [1, 0] } }
    expect(userInputAnswers([question], draft)?.format).toEqual({
      type: "options",
      questionId: "format",
      options: question.options.map((option, optionIndex) => ({ optionIndex, ...option }))
    })
    expect(draft.format.optionIndices).toEqual([1, 0])
    expect(userInputAnswers([questions[0]], draft)).toBeNull()
  })

  it("rejects empty, duplicate or invalid multi selections and single answers to multi questions", () => {
    const question = { ...questions[0], allowMultiple: true }
    for (const optionIndices of [[], [0, 0], [-1], [0.5], [9], [NaN]]) {
      expect(
        userInputAnswers([question], { format: { type: "options", optionIndices } })
      ).toBeNull()
    }
    expect(userInputAnswers([question], { format: { type: "option", optionIndex: 0 } })).toBeNull()
    expect(
      userInputAnswers([question], { format: { type: "other", text: "自填" } })?.format
    ).toEqual({
      type: "other",
      questionId: "format",
      text: "自填"
    })
  })
  it("rejects whitespace-only Bot answers while preserving the workbench default", () => {
    const draft = {
      format: { type: "option" as const, optionIndex: 0 },
      name: { type: "other" as const, text: " \t\n　 " }
    }
    expect(userInputAnswers(questions, draft, true)).toBeNull()
    expect(userInputAnswers(questions, draft)?.name).toEqual({
      type: "other",
      questionId: "name",
      text: draft.name.text
    })
  })

  it("normalizes Bot custom text only at submission without changing the draft", () => {
    const draft = Object.freeze({
      name: Object.freeze({ type: "other" as const, text: "  青桐\n第二行　 " })
    })
    expect(userInputAnswers(questions.slice(1), draft, true)?.name).toEqual({
      type: "other",
      questionId: "name",
      text: "青桐\n第二行"
    })
    expect(draft.name.text).toBe("  青桐\n第二行　 ")
  })

  it("does not finish a Bot batch when an earlier custom answer is blank", () => {
    expect(
      userInputAnswers(
        questions,
        {
          format: { type: "other", text: "   " },
          name: { type: "other", text: "有效名称" }
        },
        true
      )
    ).toBeNull()
  })

  it("does not submit missing questions, empty custom answers, or invalid options", () => {
    expect(userInputAnswers(questions, {})).toBeNull()
    expect(userInputAnswers(questions, { format: { type: "option", optionIndex: 0 } })).toBeNull()
    expect(
      userInputAnswers(questions, {
        format: { type: "option", optionIndex: 8 },
        name: { type: "other", text: "合成" }
      })
    ).toBeNull()
    expect(
      userInputAnswers(questions, {
        format: { type: "option", optionIndex: 0 },
        name: { type: "other", text: "" }
      })
    ).toBeNull()
  })

  it("preserves exact option identity, custom text and trimmed supplementary text", () => {
    expect(
      userInputAnswers(questions, {
        format: {
          type: "option",
          optionIndex: 1,
          additionalText: "  保留测试\n和说明  ",
          additionalTextOpen: true
        },
        name: { type: "other", text: "合成名称\n第二行" },
        stale: { type: "other", text: "上一轮草稿" }
      })
    ).toEqual({
      format: {
        type: "option",
        questionId: "format",
        optionIndex: 1,
        label: "完整版",
        description: "全部内容",
        additionalText: "保留测试\n和说明"
      },
      name: { type: "other", questionId: "name", text: "合成名称\n第二行" }
    })
  })

  it("can serialize a directly chosen single option without changing the caller's draft", () => {
    const draft = Object.freeze({
      format: Object.freeze({ type: "option" as const, optionIndex: 0, additionalText: " " })
    })
    expect(userInputAnswers(questions.slice(0, 1), draft)).toEqual({
      format: {
        type: "option",
        questionId: "format",
        optionIndex: 0,
        label: "简版",
        description: "核心内容"
      }
    })
    expect(draft.format.additionalText).toBe(" ")
  })
})

describe("pending inbox answer draft lifetime", () => {
  const request: UserInputRequest = {
    requestId: "pending-one",
    threadId: "group-live",
    createdAt: "2026-10-25T00:00:00Z",
    questions
  }
  const draft: UserInputDraft = {
    requestId: request.requestId,
    answers: {
      format: { type: "options", optionIndices: [0] },
      name: { type: "other", text: "Keep this constraint" }
    },
    activeIndex: 1
  }

  it("retains the same pending request draft when hydrated again", () => {
    expect(pendingUserInputPatch({ userInputDraft: draft }, { ...request }).userInputDraft).toBe(
      draft
    )
  })

  it("drops the draft on submit, cancellation or replacement, never restoring a completed answer", () => {
    expect(pendingUserInputPatch({ userInputDraft: draft }, null).userInputDraft).toBeNull()
    expect(
      pendingUserInputPatch({ userInputDraft: draft }, { ...request, requestId: "next" })
        .userInputDraft
    ).toBeNull()
    const ended = pendingUserInputPatch({ userInputDraft: draft }, null)
    expect(pendingUserInputPatch(ended, { ...request }).userInputDraft).toBeNull()
  })

  it("rejects late draft updates for an ended or replaced request", () => {
    let invoked = false
    const update = () => {
      invoked = true
      return draft
    }
    expect(userInputDraftPatch({ pendingUserInput: null }, request.requestId, update)).toEqual({})
    expect(
      userInputDraftPatch(
        { pendingUserInput: { ...request, requestId: "next" } },
        request.requestId,
        update
      )
    ).toEqual({})
    expect(invoked).toBe(false)
  })

  it("applies successive answer and navigation updates to the same live draft without mixing requests", () => {
    const state = { pendingUserInput: request, userInputDraft: { ...draft, requestId: "old" } }
    const first = userInputDraftPatch(state, request.requestId, (previous) => ({
      ...previous,
      answers: { format: { type: "options", optionIndices: [0] } }
    }))
    expect(first.userInputDraft?.answers.name).toBeUndefined()
    const second = userInputDraftPatch({ ...state, ...first }, request.requestId, (previous) => ({
      ...previous,
      activeIndex: 1
    }))
    expect(second.userInputDraft?.answers.format).toEqual({ type: "options", optionIndices: [0] })
    expect(second.userInputDraft?.activeIndex).toBe(1)
    expect(second.userInputDraft?.requestId).toBe(request.requestId)
  })
})
