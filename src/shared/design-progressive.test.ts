import { describe, expect, it } from "vitest"
import { inspectDesignDocument, isFinalizableDesignDraft } from "./design-progressive"
import {
  readTweakDeclaration,
  reconcileTweaks,
  editTweaks,
  materializeTweaks,
  effectiveTweaks,
  readyTweakKeys
} from "./design-tweaks"

const declaration = {
  defaults: { primary: "#123456", radius: 12, label: "开始" },
  schema: {
    primary: { type: "color", label: "主色" },
    radius: { type: "number", label: "圆角", min: 0, max: 32 },
    label: { type: "text", label: "文案", maxLength: 20 }
  },
  bindings: {
    primary: [{ type: "css-var", name: "--primary" }],
    radius: [{ type: "css-var", name: "--radius", unit: "px" }],
    label: [{ type: "text", selector: "#label" }]
  }
}
const page = (attrs = "", content = '<span id="label">开始</span>') =>
  `<!doctype html><html><head><style>.card{color:var(--primary);border-radius:var(--radius)}</style><script type="application/design-tweaks+json">${JSON.stringify(declaration)}</script></head><body ${attrs}><section data-design-section="main">${content}</section></body></html>`

describe("progressive artifact contract", () => {
  it("identifies duplicate section markers across A/B variations with actionable feedback", () => {
    const variation = (id: string, section: string) => `<div id="variation-${id}"><section data-design-section="${section}">内容</section></div>`
    const duplicate = `<!doctype html><html><body>${variation("a", "shell")}${variation("b", "shell")}</body></html>`
    expect(inspectDesignDocument(duplicate).issues).toContain("区块 ID 重复：shell；不同方案请使用独立前缀")
    expect(isFinalizableDesignDraft(`<!doctype html><html><body>${variation("a", "a-shell")}${variation("b", "b-shell")}</body></html>`)).toBe(true)
  })
  it("accepts closed scaffolds for preview but never for final delivery", () => {
    const scaffold = page('data-design-build="building"').replace(
      '<section data-design-section="main">',
      '<section data-design-section="main" data-design-pending>'
    )
    expect(inspectDesignDocument(scaffold)).toMatchObject({
      valid: true,
      finalizable: false,
      completedSections: []
    })
    expect(isFinalizableDesignDraft(page(), ["main"])).toBe(true)
    expect(isFinalizableDesignDraft(page(), ["main", "missing"])).toBe(false)
  })
  it("recognizes actual attributes rather than matching example strings inside scripts", () => {
    expect(
      isFinalizableDesignDraft(page("", '<script>const example="data-design-pending";</script>'))
    ).toBe(true)
    expect(inspectDesignDocument(page().replace("</section>", "")).valid).toBe(false)
    expect(inspectDesignDocument(page("", "<|begin_of_sentence|>")).valid).toBe(false)
  })
})

describe("declarative tweaks and source composition", () => {
  const state = () => reconcileTweaks(readTweakDeclaration(page()))!
  it("accumulates independent edits, supports reset/undo/redo and rejects stale revisions", () => {
    let value = state()
    value = editTweaks(value, {
      scope: "artifact",
      baseRevision: value.revision,
      operation: "set",
      key: "primary",
      value: "#00aa00"
    })
    value = editTweaks(value, {
      scope: "artifact",
      baseRevision: value.revision,
      operation: "set",
      key: "radius",
      value: 24
    })
    expect(effectiveTweaks(value)).toMatchObject({ primary: "#00aa00", radius: 24 })
    value = editTweaks(value, {
      scope: "artifact",
      baseRevision: value.revision,
      operation: "undo"
    })
    expect(effectiveTweaks(value).radius).toBe(12)
    value = editTweaks(value, {
      scope: "artifact",
      baseRevision: value.revision,
      operation: "redo"
    })
    expect(effectiveTweaks(value).radius).toBe(24)
    expect(() =>
      editTweaks(value, { scope: "artifact", baseRevision: 0, operation: "reset" })
    ).toThrow("版本")
    expect(() =>
      editTweaks(value, {
        scope: "artifact",
        baseRevision: value.revision,
        operation: "set",
        key: "radius",
        value: 1000
      })
    ).toThrow("无效")
  })
  it("keeps user edits across new model defaults and honors explicit override resets", () => {
    const current = state()
    current.overrides.primary = "#00aa00"
    const next = {
      ...current.declaration,
      defaults: { ...current.declaration.defaults, primary: "#ff0000" },
      resetOverrides: ["primary"]
    }
    expect(reconcileTweaks(next, current)!.overrides.primary).toBe("#00aa00")
    expect(reconcileTweaks(next, current, true)!.overrides.primary).toBeUndefined()
  })
  it("materializes current values and standalone runtime without changing business scripts", () => {
    const current = state()
    current.overrides = { primary: "#00aa00", label: "<开始>" }
    const html = materializeTweaks(
      page("", '<span id="label">开始</span><script>window.business=1</script>'),
      current
    )
    expect(html).toContain("--primary:#00aa00")
    expect(html).toContain("&lt;开始&gt;")
    expect(html).toContain("window.business=1")
    expect(html.match(/<script data-design-tweaks-runtime/g)).toHaveLength(1)
    expect(
      materializeTweaks(html, current).match(/<script data-design-tweaks-runtime/g)
    ).toHaveLength(1)
    expect(materializeTweaks(html, current)).toBe(html)
    expect(materializeTweaks(html, current, false)).not.toContain("data-design-tweaks-runtime")
    expect(readTweakDeclaration(html)!.defaults.primary).toBe("#00aa00")
  })
  it("only opens text parameters once their section is complete", () => {
    const html = page().replace(
      '<section data-design-section="main">',
      '<section data-design-section="main" data-design-pending>'
    )
    expect([...readyTweakKeys(html, state().declaration)]).toEqual(["primary", "radius"])
    expect(readyTweakKeys(page(), state().declaration).has("label")).toBe(true)
  })
})
