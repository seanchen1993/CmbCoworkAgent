import { describe, expect, it } from "vitest"
import { resolvePlaywrightLocator } from "../../../src/main/browser/recording/locator-generator"

describe("locator generator", () => {
  it("prefers test id over other candidates", () => {
    const result = resolvePlaywrightLocator({
      target: "Login button",
      role: "button",
      label: "登录",
      testId: "login-submit"
    })

    expect(result.best.locator).toBe('page.getByTestId("login-submit")')
    expect(result.candidates[1]?.locator).toBe(
      'page.getByRole("button", { name: "登录" })'
    )
  })

  it("prefers an explicit role and accessible name before a label", () => {
    const result = resolvePlaywrightLocator({
      target: "Email input",
      role: "textbox",
      label: "邮箱地址"
    })

    expect(result.best.locator).toBe('page.getByRole("textbox", { name: "邮箱地址" })')
  })

  it("builds frameLocator roots when frame metadata is present", () => {
    const result = resolvePlaywrightLocator({
      placeholder: "Card number",
      framePath: ['iframe[name="payment"]']
    })

    expect(result.best.locator).toBe(
      'page.frameLocator("iframe[name=\\"payment\\"]").getByPlaceholder("Card number")'
    )
  })

  it("falls back to explicit selector when semantic metadata is missing", () => {
    const result = resolvePlaywrightLocator({
      selector: ".toolbar .save-button"
    })

    expect(result.best.locator).toBe('page.locator(".toolbar .save-button")')
  })

  it("prefers visible text over a generic tag selector", () => {
    const result = resolvePlaywrightLocator({
      target: "编辑",
      accessibleName: "编辑",
      textContent: "编辑",
      selector: "div",
      tagName: "div"
    })

    expect(result.best.locator).toBe('page.getByText("编辑", { exact: true })')
  })

  it("can infer a role from descriptive target text", () => {
    const result = resolvePlaywrightLocator({
      target: "Actions tab in repository navigation"
    })

    expect(result.best.locator).toBe('page.getByRole("tab", { name: "Actions" })')
  })
})
