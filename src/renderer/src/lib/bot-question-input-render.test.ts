import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BotQuestionInput } from "../components/bots/BotQuestionInput"
import type { UserInputRequest } from "@/types"

const request: UserInputRequest = {
  requestId: "question",
  threadId: "private",
  createdAt: "2026-10-18T00:00:00.000Z",
  questions: [
    {
      id: "format",
      header: "格式",
      question: "选择交付格式？",
      options: [{ label: "甲版", description: "简洁说明" }]
    }
  ]
}
const noop = (): void => {}
const defaults = {
  request,
  activeIndex: 0,
  complete: false,
  remainingLabel: null,
  onChoose: noop,
  onAdditional: noop,
  onEditAdditional: noop,
  onEditCustom: noop,
  onNavigate: noop,
  onContinue: noop,
  onIgnore: noop
}
const render = (props: Partial<Parameters<typeof BotQuestionInput>[0]> = {}): string =>
  renderToStaticMarkup(createElement(BotQuestionInput, { ...defaults, ...props }))

describe("Bot custom answer entry", () => {
  it("keeps a direct answer field unless the main inbox is proven available", () => {
    expect(render()).toContain('aria-label="自定义回答"')
    const inbox = render({ useComposerForSingleAnswer: true })
    expect(inbox).not.toContain('aria-label="自定义回答"')
    expect(inbox).toContain("甲版")
    expect(inbox).toContain('aria-label="跳过问题"')
  })

  it("retains existing custom drafts and the per-question field for a batch", () => {
    expect(
      render({ useComposerForSingleAnswer: true, draft: { type: "other", text: "原草稿" } })
    ).toContain("原草稿")
    const batch = render({
      useComposerForSingleAnswer: true,
      request: {
        ...request,
        questions: [...request.questions, { ...request.questions[0], id: "b" }]
      }
    })
    expect(batch).toContain('aria-label="自定义回答"')
    expect(batch).toContain('aria-label="下一题"')
  })

  it("does not enable submission for whitespace-only custom answers", () => {
    const blank = render({ draft: { type: "other", text: " \t\n　 " } })
    expect(blank).not.toContain('aria-label="提交回答"')
    expect(blank).not.toContain('aria-label="继续回答下一题"')
    const batch = render({
      draft: { type: "other", text: " \t\n　 " },
      request: {
        ...request,
        questions: [...request.questions, { ...request.questions[0], id: "b" }]
      }
    })
    expect(batch).toMatch(/aria-label="继续回答下一题"[^>]*disabled=""/)
    const answer = render({ draft: { type: "other", text: " 合成名称 " }, complete: true })
    expect(answer).toContain('aria-label="提交回答"')
    expect(answer).not.toContain('disabled=""')
  })
})
