import { describe, expect, it } from "vitest"
import { readTweakDeclaration, tweakSourceDiagnostics, tweakSourceIssues } from "./design-tweaks"

const page = (raw: unknown) =>
  `<!doctype html>\n<html><body>\n<script type="application/design-tweaks+json">${JSON.stringify(raw)}</script>\n</body></html>`
const declaration = () => ({
  defaults: { maxQuick: 10, failText: "系统繁忙" },
  schema: { maxQuick: { type: "number", min: 1, max: 12 }, failText: { type: "text" } },
  bindings: {
    maxQuick: [{ type: "css-var", name: "--max-quick" }],
    failText: [{ type: "text", selector: "#leaf-fail-text" }]
  }
})

describe("raw Tweaks declaration diagnostics", () => {
  it("reports every failing field and parameter before normalization drops them", () => {
    const raw = declaration()
    raw.schema.maxQuick.max = 5
    raw.bindings.failText[0].selector = "#modal-body span"
    const html = page(raw)
    expect(readTweakDeclaration(html)).toBeNull()
    const issues = tweakSourceDiagnostics(html)
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatchObject({
      tweakKey: "maxQuick",
      fieldPath: 'defaults["maxQuick"]',
      actual: "10",
      line: 3
    })
    expect(issues[0].expected).toContain('"max":5')
    expect(issues[1]).toMatchObject({
      tweakKey: "failText",
      fieldPath: 'bindings["failText"][0].selector',
      actual: '"#modal-body span"'
    })
    expect(issues[1].expected).toContain("不支持组合、后代、类选择器")
    expect(tweakSourceIssues(html)).toEqual(issues.map((issue) => issue.message))
    expect(
      tweakSourceIssues(
        html.replace("</body>", '<span id="leaf-fail-text" hidden>系统繁忙</span></body>')
      )
    ).toEqual(tweakSourceIssues(html))
  })

  it.each([
    ["integer type", { type: "integer" }, ".type"],
    ["string min", { type: "number", min: "1" }, ".min"],
    ["inverted range", { type: "number", min: 12, max: 2 }, ".min"],
    ["zero step", { type: "number", step: 0 }, ".step"],
    ["invalid options", { type: "select", options: 3 }, ".options"],
    ["fractional length", { type: "text", maxLength: 2.5 }, ".maxLength"]
  ])("diagnoses %s without throwing", (_name, schema, field) => {
    const raw = {
      defaults: { value: 10 },
      schema: { value: schema },
      bindings: { value: [{ type: "css-var", name: "--value" }] }
    }
    expect(
      tweakSourceDiagnostics(page(raw)).some(
        (issue) => issue.fieldPath === `schema["value"]${field}`
      )
    ).toBe(true)
  })

  it("checks default types, options, CSS-safe strings and supported bindings", () => {
    const cases = [
      {
        defaults: { value: "10" },
        schema: { value: { type: "number" } },
        bindings: { value: [{ type: "css-var", name: "--v" }] }
      },
      {
        defaults: { value: "a" },
        schema: { value: { type: "select", options: ["b"] } },
        bindings: { value: [{ type: "text", selector: "#v" }] }
      },
      {
        defaults: { value: "a;b" },
        schema: { value: { type: "text" } },
        bindings: { value: [{ type: "css-var", name: "--v" }] }
      }
    ]
    for (const raw of cases)
      expect(tweakSourceDiagnostics(page(raw))[0].fieldPath).toBe('defaults["value"]')
    const raw = declaration()
    raw.bindings.maxQuick.push({ type: "css-var", name: "max-quick" })
    expect(tweakSourceDiagnostics(page(raw))[0].fieldPath).toBe('bindings["maxQuick"][1].name')
  })

  it("preserves valid declarations and legacy pages, and locates malformed JSON", () => {
    expect(tweakSourceIssues(page(declaration()))).toEqual([])
    expect(tweakSourceIssues("<html><body>legacy</body></html>")).toEqual([])
    expect(
      tweakSourceDiagnostics(page(declaration()).replace('"maxQuick":10', '"maxQuick":'))[0]
    ).toMatchObject({ line: 3, message: expect.stringContaining("JSON") })
    expect(tweakSourceIssues(page(declaration()) + page(declaration()))).toEqual([
      "Tweaks 声明必须只有一个"
    ])
  })
})
