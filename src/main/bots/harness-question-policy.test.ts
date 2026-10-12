import { describe, expect, it } from "vitest"
import type { BotInteraction } from "../../shared/bot-types"
import type { BotQuestions } from "../../shared/bot-questions"
import { validateBotQuestionAnswer } from "../../shared/bot-questions"
import type { HarnessRequestUserInputConfig } from "../../shared/harness-board-types"
import { botHarnessAutomaticAnswer, botHarnessQuestionsSchema } from "./harness-question-policy"

const createdAt = 1_000_000
const policy: HarnessRequestUserInputConfig = {
  allowAutoResolution: true,
  autoResolutionType: "select_first",
  defaultTimeoutMs: 60_000
}
const questions: BotQuestions = {
  questions: [
    {
      id: "strategy",
      header: "Strategy",
      question: "Which strategy should be used?",
      options: [
        { label: "Incremental", description: "Keep the current design." },
        { label: "Rewrite", description: "Replace the design." }
      ]
    },
    {
      id: "checks",
      header: "Checks",
      question: "Which checks should run?",
      multiple: true,
      options: [
        { label: "Unit", description: "Run unit tests." },
        { label: "Integration", description: "Run integration tests." }
      ]
    }
  ]
}
function interaction(
  overrides: Partial<BotInteraction> = {},
  input: BotQuestions = questions,
  deadline: unknown = createdAt + 60_000
): BotInteraction {
  return {
    id: "interaction-1",
    runId: "run-1",
    kind: "question",
    prompt: JSON.stringify({
      botQuestions: { version: 1, input },
      harnessAutoResolution: { deadline }
    }),
    actionHash: null,
    status: "pending",
    answer: null,
    revision: 1,
    expiresAt: createdAt + 600_000,
    createdAt,
    ...overrides
  }
}

describe("Harness Bot question tool schema", () => {
  it("permits bounded integer automatic timeouts only under an enabled project policy", () => {
    expect(
      botHarnessQuestionsSchema().safeParse({ ...questions, autoResolutionMs: 60_000 }).success
    ).toBe(false)
    expect(
      botHarnessQuestionsSchema({ ...policy, allowAutoResolution: false }).safeParse({
        ...questions,
        autoResolutionMs: 60_000
      }).success
    ).toBe(false)
    expect(botHarnessQuestionsSchema(policy).safeParse(questions).success).toBe(true)
    for (const autoResolutionMs of [30_000, 240_000])
      expect(
        botHarnessQuestionsSchema(policy).safeParse({ ...questions, autoResolutionMs }).success
      ).toBe(true)
    for (const autoResolutionMs of [29_999, 240_001, 60_000.1, "60000", Infinity])
      expect(
        botHarnessQuestionsSchema(policy).safeParse({ ...questions, autoResolutionMs }).success
      ).toBe(false)
  })

  it("preserves unique question IDs and choice cardinality when enabling timeout support", () => {
    const first = questions.questions[0]
    const schema = botHarnessQuestionsSchema(policy)
    expect(schema.safeParse({ questions: [first, first] }).success).toBe(false)
    expect(schema.safeParse({ questions: [{ ...first, id: "constructor" }] }).success).toBe(false)
    expect(
      schema.safeParse({ questions: [{ ...first, options: first.options.slice(0, 1) }] }).success
    ).toBe(false)
    expect(
      schema.safeParse({ questions: [{ ...first, options: [], multiple: true }] }).success
    ).toBe(false)
    expect(schema.safeParse({ questions: [{ ...first, options: [] }] }).success).toBe(true)
    expect(schema.safeParse({ ...questions, autoApprove: true }).success).toBe(false)
  })
})

describe("Harness Bot automatic question answers", () => {
  it("waits until the configured deadline and marks single and multiple selections as project decisions", () => {
    const pending = interaction()
    expect(botHarnessAutomaticAnswer(pending, policy, createdAt + 59_999)).toBeNull()
    const answer = botHarnessAutomaticAnswer(pending, policy, createdAt + 60_000)
    expect(JSON.parse(answer!)).toEqual({
      status: "auto_resolved",
      answers: {
        strategy: {
          type: "option",
          questionId: "strategy",
          optionIndex: 0,
          label: "Incremental",
          description: "Keep the current design."
        },
        checks: { type: "multiple", questionId: "checks", optionIndices: [0], labels: ["Unit"] }
      },
      message: "按项目配置自动采用首个选项。这不是用户授权。",
      source: "project_policy"
    })
    expect(pending.status).toBe("pending")
    expect(pending.answer).toBeNull()
  })

  it.each([30_000, 240_000])("resolves at the permitted deadline boundary of %i ms", (offset) => {
    expect(
      botHarnessAutomaticAnswer(
        interaction({}, questions, createdAt + offset),
        policy,
        createdAt + offset
      )
    ).not.toBeNull()
  })

  it("does not invent a deadline when only the default policy timeout is present", () => {
    const pending = interaction({
      prompt: JSON.stringify({ botQuestions: { version: 1, input: questions } })
    })
    expect(botHarnessAutomaticAnswer(pending, policy, createdAt + 300_000)).toBeNull()
  })

  it("fails closed for a missing, invalid or out-of-range stored deadline", () => {
    for (const deadline of [
      null,
      "1060000",
      createdAt + 29_999,
      createdAt + 240_001,
      createdAt + 60_000.5
    ])
      expect(
        botHarnessAutomaticAnswer(interaction({}, questions, deadline), policy, createdAt + 300_000)
      ).toBeNull()
    for (const prompt of [
      "not JSON",
      "{}",
      JSON.stringify({ botQuestions: { version: 1, input: questions }, harnessAutoResolution: {} }),
      JSON.stringify({
        botQuestions: { version: 2, input: questions },
        harnessAutoResolution: { deadline: createdAt + 60_000 }
      })
    ])
      expect(
        botHarnessAutomaticAnswer(interaction({ prompt }), policy, createdAt + 60_000)
      ).toBeNull()
  })

  it("requires explicit policy permission for every automatic resolution", () => {
    const pending = interaction()
    expect(botHarnessAutomaticAnswer(pending, undefined, createdAt + 60_000)).toBeNull()
    expect(
      botHarnessAutomaticAnswer(
        pending,
        { ...policy, allowAutoResolution: false },
        createdAt + 60_000
      )
    ).toBeNull()
  })

  it("never changes answered, cancelled or expired interactions", () => {
    for (const status of ["answered", "cancelled", "expired"] as const)
      expect(
        botHarnessAutomaticAnswer(
          interaction({ status, answer: "Existing user response" }),
          policy,
          createdAt + 60_000
        )
      ).toBeNull()
  })

  it("preserves an explicit manual answer and distinguishes it from project timeout output", () => {
    const manualAnswer = validateBotQuestionAnswer(
      questions,
      JSON.stringify({
        status: "submitted",
        answers: {
          strategy: { type: "option", questionId: "strategy", optionIndex: 1 },
          checks: { type: "multiple", questionId: "checks", optionIndices: [0, 1] }
        }
      })
    )
    const answered = interaction({ status: "answered", answer: manualAnswer })
    expect(botHarnessAutomaticAnswer(answered, policy, createdAt + 60_000)).toBeNull()
    expect(JSON.parse(answered.answer!).answers.strategy.label).toBe("Rewrite")
    expect(JSON.parse(answered.answer!).status).toBe("submitted")
    expect(() =>
      validateBotQuestionAnswer(
        questions,
        botHarnessAutomaticAnswer(interaction(), policy, createdAt + 60_000)!
      )
    ).toThrow("回答格式无效")
  })

  it("never grants approval or resolves secure credential prompts", () => {
    expect(
      botHarnessAutomaticAnswer(
        interaction({ kind: "approval", actionHash: "external-action" }),
        policy,
        createdAt + 60_000
      )
    ).toBeNull()
    expect(
      botHarnessAutomaticAnswer(
        interaction({
          prompt: JSON.stringify({
            requestSecret: { name: "API key" },
            harnessAutoResolution: { deadline: createdAt + 60_000 }
          })
        }),
        policy,
        createdAt + 60_000
      )
    ).toBeNull()
  })

  it("returns the configured message with no fabricated selections", () => {
    const customPolicy: HarnessRequestUserInputConfig = {
      ...policy,
      autoResolutionType: "user_message",
      userMessage: "Continue with the supplied requirements."
    }
    expect(
      JSON.parse(botHarnessAutomaticAnswer(interaction(), customPolicy, createdAt + 60_000)!)
    ).toEqual({
      status: "auto_resolved",
      answers: {},
      message: "Continue with the supplied requirements.",
      source: "project_policy"
    })
  })

  it("leaves answers empty when any requested question requires free text", () => {
    const input: BotQuestions = {
      questions: [
        questions.questions[0],
        { id: "details", header: "Details", question: "What details should be used?", options: [] }
      ]
    }
    expect(
      JSON.parse(botHarnessAutomaticAnswer(interaction({}, input), policy, createdAt + 60_000)!)
    ).toEqual({
      status: "auto_resolved",
      answers: {},
      message: "未收到用户回答，没有选择答案。",
      source: "project_policy"
    })
  })
})
