import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import {
  buildPlaywrightScriptRecorderInjectionScript,
  isDynamicOverlaySelector,
  preferExactRecordedTextSelector
} from "../../../../src/main/browser/record/script-record/script-recorder-playwright-adapter"
import { formatPlaywrightSelector } from "../../../../src/main/browser/record/common/playwright-codegen/projectLocatorAdapter"

describe("recorded text selector precision", () => {
  const target = {}
  const other = {}
  const selector = 'internal:text="编辑"i'
  const exact = 'internal:text="编辑"s'

  it("records exact text only when it uniquely identifies the same element", () => {
    const result = preferExactRecordedTextSelector(selector, () => [target])
    expect(result).toBe(exact)
    expect(formatPlaywrightSelector(result)).toBe('getByText("编辑", { exact: true })')
  })

  it.each([
    ["partial text", [target], []],
    ["duplicate exact text", [target], [target, other]],
    ["different element", [target], [other]],
    ["different first fuzzy match", [other, target], [target]],
    ["detached target", [], []]
  ])("preserves the original selector for %s", (_name, original, exactMatches) => {
    expect(
      preferExactRecordedTextSelector(selector, (value) =>
        value === selector ? (original as object[]) : (exactMatches as object[])
      )
    ).toBe(selector)
  })

  it.each([
    exact,
    "internal:text=/编辑/i",
    'internal:role=button[name="编辑"i]',
    'internal:label="姓名"i',
    'internal:attr=[placeholder="姓名"i]',
    'internal:testid=[data-testid="edit"s]',
    'internal:text="编辑"i >> nth=1',
    'css=.toolbar >> internal:text="编辑"i'
  ])("leaves other selectors untouched: %s", (value) => {
    expect(
      preferExactRecordedTextSelector(value, () => {
        throw new Error("must not query other selectors")
      })
    ).toBe(value)
  })

  it("preserves the selector when DOM querying fails", () => {
    expect(
      preferExactRecordedTextSelector(selector, () => {
        throw new Error("detached")
      })
    ).toBe(selector)
  })

  it("records exact text when a tooltip adds a second fuzzy match", () => {
    expect(
      preferExactRecordedTextSelector(selector, (value) =>
        value === selector ? [target, other] : [target]
      )
    ).toBe(exact)
  })
})

describe("dynamic Element UI overlay selectors", () => {
  it.each([
    '#el-popover-3396 >> internal:text="Merge（推荐）"s',
    'css=[id="el-tooltip-4366"] >> internal:text="帮助"s',
    "#el-dropdown-1024",
    "#el-popper-88",
    '#at-popover-2048 >> internal:text="Merge（推荐）"s',
    "#custom-menu-popover-9001",
    "#popover-42"
  ])("recognizes transient generated ids: %s", (selector) => {
    expect(isDynamicOverlaySelector(selector)).toBe(true)
  })

  it.each([
    "#merge-popover",
    "#el-popover-stable",
    "#custom-menu-popover-final",
    'internal:text="Merge（推荐）"s'
  ])("leaves stable selectors alone: %s", (selector) => {
    expect(isDynamicOverlaySelector(selector)).toBe(false)
  })
})

describe("tooltip fallback and exact text together", () => {
  it.each(["click", "check", "uncheck"])(
    "preserves the hover target for %s after tooltip changes the DOM",
    (name) => {
      const { context, target, query, run } = createTooltipHarness()
      context.rememberHoveredActionSelector({ target })
      context.tooltipVisible = true
      const selector = run(name, ".ant-tooltip-open")
      expect(selector).toBe('internal:text="编辑"s')
      context.tooltipVisible = false
      expect(query(selector)).toEqual([target])
    }
  )

  it("keeps the old CSS fallback when text cannot safely be tightened", () => {
    const { context, target, run } = createTooltipHarness()
    context.generatedSelector = ".stable-edit"
    context.rememberHoveredActionSelector({ target })
    context.tooltipVisible = true
    expect(run("click", ".ant-tooltip-open")).toBe(".stable-edit")
  })

  it("does not replace a normal action with an unrelated hover target", () => {
    const { context, target, run } = createTooltipHarness()
    context.rememberHoveredActionSelector({ target })
    expect(run("click", 'internal:role=button[name="保存"i]')).toBe(
      'internal:role=button[name="保存"i]'
    )
  })

  it("preserves the original when no hover target exists or the target detached", () => {
    const { context, target, run } = createTooltipHarness()
    expect(run("click", ".ant-tooltip-open")).toBe(".ant-tooltip-open")
    context.rememberHoveredActionSelector({ target })
    target.isConnected = false
    expect(run("click", ".ant-tooltip-open")).toBe(".ant-tooltip-open")
  })
})

function createTooltipHarness() {
  class FakeElement {
    isConnected = true
  }
  const target = new FakeElement()
  const tooltip = new FakeElement()
  const context = {
    Element: FakeElement,
    tooltipVisible: false,
    generatedSelector: 'internal:text="编辑"i',
    text: (value: string) => value,
    RECORDER_OPTIONS: { testIdAttributeName: "data-testid" },
    recorder: { _recorder: { deepEventTarget: (event: { target: FakeElement }) => event.target } },
    injectedScript: {
      document: {},
      parseSelector: (selector: string) => selector,
      querySelectorAll: (selector: string) => query(selector),
      generateSelector: () => ({ selector: context.generatedSelector })
    },
    resolveElement: (selector: string) => query(selector)[0] ?? null,
    rememberHoveredActionSelector: (event: { target: FakeElement }) => void event,
    selectorForRecorderAction: (action: { name: string; selector: string }) => action.selector,
    normalizeRecordedSelector: (selector: string) => selector
  }
  function query(selector: string): FakeElement[] {
    if (!target.isConnected) return []
    if (selector === 'internal:text="编辑"i')
      return context.tooltipVisible ? [target, tooltip] : [target]
    if (selector === 'internal:text="编辑"s' || selector === ".stable-edit") return [target]
    return []
  }
  const script = buildPlaywrightScriptRecorderInjectionScript()
  const normalizer = script.slice(
    script.indexOf("const preferExactRecordedTextSelector ="),
    script.indexOf("window[FRAME_SELECTOR_HELPER] =")
  )
  const transientCheck = script.slice(
    script.indexOf("function isTransientActionSelector"),
    script.indexOf("function fallbackFileUploadLocator")
  )
  const hoverFallback = script.slice(
    script.indexOf('let lastHoveredActionSelector = ""'),
    script.indexOf("window.__pw_recorderRecordAction =")
  )
  runInNewContext(normalizer + transientCheck + hoverFallback, context)
  return {
    context,
    target,
    query,
    run: (name: string, selector: string) =>
      context.normalizeRecordedSelector(context.selectorForRecorderAction({ name, selector }))
  }
}
