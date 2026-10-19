import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { ChatTaskOverview } from "../components/chat/ChatTaskOverview"

const facts = {
  working: false,
  waitingApproval: false,
  waitingInput: false,
  interrupted: false,
  hasReply: false,
  hasMessages: false,
  disabled: false,
  onReturn: vi.fn(),
  onStop: vi.fn()
}

it("starts with the user's goal instead of a required plan picker", () => {
  const html = renderToStaticMarkup(createElement(ChatTaskOverview, facts))
  expect(html).toContain("直接说你想完成什么")
  expect(html).not.toContain("选择执行步骤")
  expect(html).not.toContain("停止本次任务")
})

it("surfaces a real approval ahead of ongoing model work", () => {
  const html = renderToStaticMarkup(
    createElement(ChatTaskOverview, {
      ...facts,
      working: true,
      waitingApproval: true,
      hasReply: true
    })
  )
  expect(html).toContain("需要你确认")
  expect(html).toContain("去确认操作")
  expect(html).toContain("停止本次任务")
  expect(html).not.toContain(">已回复<")
})

it("does not treat a visible earlier reply as completion while work continues", () => {
  const html = renderToStaticMarkup(
    createElement(ChatTaskOverview, { ...facts, working: true, hasReply: true })
  )
  expect(html).toContain("正在处理你的任务")
  expect(html).not.toContain(">已回复<")
})

it("keeps private errors in the existing chat error display", () => {
  const html = renderToStaticMarkup(
    createElement(ChatTaskOverview, { ...facts, error: "PRIVATE_PATH_OR_RESPONSE", hasReply: true })
  )
  expect(html).toContain("这次处理没有完成")
  expect(html).not.toContain("PRIVATE_PATH_OR_RESPONSE")
})

it("only offers continuation for a genuinely paused goal", () => {
  const html = renderToStaticMarkup(
    createElement(ChatTaskOverview, { ...facts, paused: true, onContinue: vi.fn() })
  )
  expect(html).toContain("任务已暂停")
  expect(html).toContain("继续原任务")
  expect(
    renderToStaticMarkup(
      createElement(ChatTaskOverview, { ...facts, interrupted: true, onContinue: vi.fn() })
    )
  ).not.toContain("继续原任务")
})
