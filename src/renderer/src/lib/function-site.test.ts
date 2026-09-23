import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
import { FunctionSiteContent } from "../components/chat/FunctionSite"
import { AgentModeSwitcher } from "../components/chat/AgentModeSwitcher"
import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"

it("renders the actual site tree as safe interactive controls and restores host fallback when absent", () => {
  const snapshot: FunctionPaneSnapshot = {
    key: "engine:owner",
    id: "owner",
    generation: "generation",
    plugin: "engine",
    title: "PromptHint",
    rows: 12,
    closeOnEscape: false,
    tree: {
      type: "Box",
      props: {},
      children: [
        { type: "Text", props: {}, children: ["<script>site</script>"] },
        {
          type: "Button",
          props: { key: "go", label: "Site action" },
          press: { plugin: "site", handle: 4 }
        },
        {
          type: "Input",
          props: { key: "field", label: "Site input", value: "saved" },
          press: { plugin: "site", handle: 5 }
        }
      ]
    }
  }
  const html = renderToStaticMarkup(
    createElement(FunctionSiteContent, {
      snapshot,
      fallback: "Host hint",
      busy: false,
      act: async () => {}
    })
  )
  expect(html).toContain("&lt;script&gt;site&lt;/script&gt;")
  expect(html).toContain('data-function-control="go"')
  expect(html).toContain('data-function-plugin="site"')
  expect(html).toContain('aria-label="Site input"')
  expect(html).toContain('value="saved"')
  expect(html).not.toContain("Host hint")
  expect(
    renderToStaticMarkup(
      createElement(FunctionSiteContent, {
        snapshot: null,
        fallback: "Host hint",
        busy: false,
        act: async () => {}
      })
    )
  ).toBe("Host hint")
})

it("retains rich host fallback when the host confirms a pass-through drawing", () => {
  const snapshot: FunctionPaneSnapshot = {
    key: "engine:owner",
    id: "owner",
    plugin: "engine",
    title: "Spinner",
    generation: "generation",
    rows: 12,
    closeOnEscape: false,
    nativeFallback: true,
    tree: { type: "Text", props: {}, children: ["plain fallback"] }
  }
  const html = renderToStaticMarkup(
    createElement(FunctionSiteContent, {
      snapshot,
      fallback: createElement(
        "span",
        { className: "thinking-shimmer-text", "data-host": "original" },
        "Working…"
      ),
      busy: false,
      act: async () => {}
    })
  )
  expect(html).toContain('class="thinking-shimmer-text"')
  expect(html).toContain('data-host="original"')
  expect(html).not.toContain("plain fallback")
})

it("retains the original mode button label, accessibility and locked control when no custom drawing exists", () => {
  for (const locked of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(AgentModeSwitcher, {
        threadId: "thread",
        mode: "normal",
        locked,
        lockedReason: locked ? "Original policy lock" : undefined,
        onChange: () => {
          throw Error("Rendering cannot change execution mode")
        }
      })
    )
    expect(html).toContain('aria-label="执行模式：Solo。')
    expect(html).toContain('<span class="font-medium">Solo</span>')
    expect(html).toContain('data-function-site="SessionMode"')
    expect(html).not.toContain("STATUS_MODE")
    if (locked) expect(html).toContain("Original policy lock")
  }
})
