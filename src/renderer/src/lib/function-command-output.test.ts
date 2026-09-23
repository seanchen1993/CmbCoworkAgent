import { createElement, isValidElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
import { FunctionCommandOutput } from "../components/chat/FunctionCommandOutput"

it("retains native command output formatting and status while Mods is off", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionCommandOutput, {
      threadId: "thread",
      command: "echo",
      text: "original",
      isErrored: true,
      fallback: createElement("p", { role: "status" }, "original")
    })
  )
  expect(html).toContain('class="contents"')
  expect(html).toContain('<p role="status">original</p>')
})

it("does not invent or disclose arguments absent from the durable command job", () => {
  const node = FunctionCommandOutput({
    threadId: "thread",
    command: "echo",
    text: "original",
    isErrored: false,
    fallback: null
  })
  if (!isValidElement<{ facts: unknown }>(node)) throw Error("Missing site")
  expect(node.props.facts).toEqual({
    command: "echo",
    args: "***",
    text: "original",
    isErrored: false
  })
  expect(
    FunctionCommandOutput({
      threadId: "thread",
      command: "echo",
      text: "x".repeat(10001),
      isErrored: false,
      fallback: "large native output"
    })
  ).toBe("large native output")
})
