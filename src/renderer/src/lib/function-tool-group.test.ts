import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { FunctionToolGroup } from "../components/chat/FunctionToolGroup"

const call = {
  tool_use_id: "call",
  tool: "read_file",
  input: {},
  output: "actual",
  isRunning: false,
  isErrored: true,
  isInterrupted: false
}
const children = (expanded: boolean) => createElement("div", {}, `native:${expanded}:failed`)
const props = { threadId: "thread", calls: [call], blocked: false, isActive: false, children }
it("retains original native rows before plugin activation", () => {
  const html = renderToStaticMarkup(createElement(FunctionToolGroup, props))
  expect(html).toContain('data-function-site="ToolGroup"')
  expect(html).toContain("native:false:failed")
})
it("does not allocate a plugin site over approval, oversized or duplicate calls", () => {
  for (const extra of [
    { blocked: true },
    { calls: [call, call] },
    { calls: [{ ...call, output: "x".repeat(10001) }] },
    { calls: [] }
  ]) {
    expect(renderToStaticMarkup(createElement(FunctionToolGroup, { ...props, ...extra }))).toBe(
      "<div>native:false:failed</div>"
    )
  }
})
