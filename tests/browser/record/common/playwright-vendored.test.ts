import { describe, expect, it } from "vitest"
import { resolvePlaywrightLocator } from "../../../../src/main/browser/record/common/playwright-codegen/projectLocatorAdapter"
import { getPlaywrightRecorderSourceBundle } from "../../../../src/main/browser/record/common/playwright-codegen"

describe("playwright vendored recorder sources", () => {
  it("exposes copied generated recorder sources through the project adapter", () => {
    const bundle = getPlaywrightRecorderSourceBundle()

    expect(bundle.injectedScriptSource).toContain("InjectedScript")
    expect(bundle.pollingRecorderSource).toContain("PollingRecorder")
    expect(bundle.pollingRecorderSource).toContain("__pw_recorderRecordAction")
  })

  it("formats locators through the Playwright locator adapter", () => {
    const result = resolvePlaywrightLocator({
      selector: "svg",
      tagName: "svg",
      matchCount: 6,
      nth: 3
    })

    expect(result.best.locator).toBe('page.locator("svg").nth(3)')
  })
})
