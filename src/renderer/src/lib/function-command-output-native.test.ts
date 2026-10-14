import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, expect, it, vi } from "vitest"
import type { ModObject } from "../../../shared/mods/types"

const host = vi.hoisted(() => ({ safe: {} as ModObject, facts: [] as ModObject[] }))
// This fixture verifies the real output factories. Main publication and actual browser mount
// waiting/failure behavior are covered separately; this is not an end-to-end claim.
vi.mock("../components/chat/FunctionSite", () => ({
  FunctionSite: (props: { facts: ModObject; renderNative(safe: ModObject): ReactNode }) => {
    host.facts.push(props.facts)
    return createElement(
      "section",
      { "data-native-owner": "CommandOutput" },
      props.renderNative(host.safe)
    )
  }
}))
import { FunctionCommandOutput } from "../components/chat/FunctionCommandOutput"

beforeEach(() => {
  host.safe = { text: "Protected output" }
  host.facts.length = 0
})

it.each(["pre", "status"] as const)(
  "uses the original %s output factory with protected text",
  (kind) => {
    const renderText = vi.fn((text: string) =>
      kind === "pre"
        ? createElement("pre", { className: "whitespace-pre-wrap break-words" }, text)
        : createElement("p", { role: "status" }, text)
    )
    const html = renderToStaticMarkup(
      createElement(FunctionCommandOutput, {
        threadId: "thread",
        command: "actual-command",
        text: "SECRET_OUTPUT",
        isErrored: kind === "status",
        fallback: createElement("div", {}, "SECRET_FALLBACK"),
        renderText
      })
    )
    expect(html).toContain("Protected output")
    expect(html).not.toContain("SECRET_")
    expect(renderText).toHaveBeenCalledTimes(1)
    expect(renderText).toHaveBeenCalledWith("Protected output")
    expect(host.facts).toEqual([
      {
        command: "actual-command",
        args: "***",
        text: "SECRET_OUTPUT",
        isErrored: kind === "status"
      }
    ])
    if (kind === "pre") expect(html).toContain('<pre class="whitespace-pre-wrap break-words">')
    else expect(html).toContain('<p role="status">')
  }
)

it("does not restore original output when a protected frame omits the text", () => {
  host.safe = {}
  const renderText = vi.fn((text: string) => createElement("pre", {}, text))
  const html = renderToStaticMarkup(
    createElement(FunctionCommandOutput, {
      threadId: "thread",
      command: "actual-command",
      text: "SECRET_OUTPUT",
      isErrored: false,
      fallback: "SECRET_FALLBACK",
      renderText
    })
  )
  expect(html).not.toContain("SECRET_")
  expect(renderText).not.toHaveBeenCalled()
})
