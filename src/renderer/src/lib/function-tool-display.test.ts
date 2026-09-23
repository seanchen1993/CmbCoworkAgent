import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
import { FunctionToolDisplay } from "../components/chat/FunctionToolDisplay"
import { ToolCallRenderer } from "../components/chat/ToolCallRenderer"

const props = {
  threadId: "thread",
  component: "ToolUse" as const,
  toolCall: { id: "call", name: "read_file", args: { file_path: "original" } },
  status: "completed" as const,
  result: "original result",
  fallback: createElement("pre", {}, "native details")
}
it("keeps native details with no layout changes until a guest changes presentation", () => {
  expect(renderToStaticMarkup(createElement(FunctionToolDisplay, props))).toContain(
    '<section data-function-site="ToolUse" class="contents"><pre>native details</pre></section>'
  )
})
it("never mounts a plugin display over a pending approval or oversized/invalid payload", () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  for (const input of [
    { ...props, needsApproval: true },
    { ...props, toolCall: { ...props.toolCall, args: cycle } },
    { ...props, result: "x".repeat(10001) },
    { ...props, toolCall: { ...props.toolCall, id: "" } }
  ])
    expect(renderToStaticMarkup(createElement(FunctionToolDisplay, input))).toBe(
      "<pre>native details</pre>"
    )
})

it("keeps actual ToolCallRenderer approval details and decisions outside the render hooks", () => {
  const html = renderToStaticMarkup(
    createElement(ToolCallRenderer, {
      threadId: "thread",
      toolCall: { id: "approve", name: "execute", args: { command: "original command" } },
      needsApproval: true,
      status: "awaiting_approval",
      onApprovalDecision: () => {}
    })
  )
  expect(html).not.toContain("data-function-site")
  expect(html).toContain("original command")
  expect(html).toContain("待审批")
})
