import { expect, it } from "vitest"
import { requestUserInputSchema, userInputPresentationSchema } from "./user-input-schema"
import { functionQuestionPresentation, functionSiteProps } from "./mods/v2/sites"

const question = {
  id: "decision",
  header: "选择",
  question: "请确认下一步",
  options: [
    { label: "继续", description: "继续处理" },
    { label: "暂停", description: "暂时停止" }
  ]
}

it.each([0, 1, 2])("renders %i fixed options after free-text option cleanup", (count) => {
  const questions = [{ ...question, options: question.options.slice(0, count) }]
  expect(userInputPresentationSchema.safeParse({ questions }).success).toBe(true)
  expect(requestUserInputSchema.safeParse({ questions }).success).toBe(count === 2)
  const props = functionSiteProps("AskUserQuestion", { tool: "request_user_input", questions })
  expect(functionQuestionPresentation(questions, props.questions)).toEqual(questions)
})

it("still pins option identity, count, order and question IDs", () => {
  expect(() => functionQuestionPresentation([question], [{ ...question, options: [] }])).toThrow()
  expect(() => functionQuestionPresentation([question], [{ ...question, id: "changed" }])).toThrow()
  expect(() =>
    functionQuestionPresentation(
      [question],
      [{ ...question, options: [...question.options].reverse() }]
    )
  ).toThrow()
})

it("accepts the supported ten-question display instead of silently blanking it at 16KB", () => {
  const questions = Array.from({ length: 10 }, (_, index) => ({
    ...question,
    id: `choice_${index}`,
    question: "问".repeat(500),
    options: Array.from({ length: 5 }, (_, option) => ({
      label: `选项${option}`,
      description: "说".repeat(240)
    }))
  }))
  expect(requestUserInputSchema.safeParse({ questions }).success).toBe(true)
  expect(
    functionSiteProps("AskUserQuestion", { tool: "request_user_input", questions }).questions
  ).toEqual(questions)
})
