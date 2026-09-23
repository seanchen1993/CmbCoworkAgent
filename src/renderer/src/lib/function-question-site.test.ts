import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { FunctionQuestionSite } from "../components/chat/FunctionQuestionSite"
import { UserInputRequestDialog } from "../components/chat/UserInputRequestDialog"

const request = {
  requestId: "r",
  threadId: "t",
  createdAt: "2026-09-23",
  questions: [
    {
      id: "choice",
      header: "Plan",
      question: "Original question?",
      options: [
        { label: "Careful", description: "Original description" },
        { label: "Fast", description: "Other description" }
      ]
    }
  ]
}
it("preserves original question controls and mounts a bounded presentation slot", () => {
  const html = renderToStaticMarkup(
    createElement(UserInputRequestDialog, { request, onSubmit: () => {} })
  )
  expect(html).toContain("Original question?")
  expect(html).toContain("Careful")
  expect(html).toContain("跳过全部问题")
  expect(html).toContain('data-function-site="AskUserQuestion"')
})
it("does not mount a site for malformed native question facts", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionQuestionSite, {
      request: { ...request, questions: [] },
      onQuestions: () => {}
    })
  )
  expect(html).toBe("")
})
