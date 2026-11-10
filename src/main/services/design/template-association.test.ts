import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { designSystemKey, isTemplateVisible } from "../../../shared/design-template"
import type { DesignSystemInfo } from "../../../shared/design-system"
import { DesignTemplatePackages } from "./template-packages"
import { resolveTemplateAssociation, validateTemplateSelection } from "./template-association"

const temporary: string[] = []
afterEach(() =>
  temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))
)
const a: DesignSystemInfo = {
  id: "a-v1",
  libraryId: "a",
  ownership: "user",
  name: "同名",
  description: "",
  path: ""
}
const a2 = { ...a, id: "a-v2" }
const b: DesignSystemInfo = {
  id: "b",
  ownership: "builtin",
  name: "同名",
  description: "",
  path: ""
}

describe("template association validation", () => {
  it("uses stable identities across revisions, and distinguishes same-name systems", () => {
    expect(designSystemKey(a)).toBe(designSystemKey(a2))
    expect(designSystemKey(a)).not.toBe(designSystemKey(b))
    expect(isTemplateVisible({}, null)).toBe(true)
    expect(isTemplateVisible({ designSystemKey: "user:a" }, null)).toBe(false)
    expect(isTemplateVisible({ designSystemKey: "user:a" }, designSystemKey(a2))).toBe(true)
    expect(resolveTemplateAssociation("user:a", [a2, b])).toBe("user:a")
    expect(() => resolveTemplateAssociation("user:missing", [a, b])).toThrow("不存在")
    expect(() => resolveTemplateAssociation(false, [a, b])).toThrow("无效")
  })

  it("rechecks stored package/catalog metadata rather than a stale or forged renderer selection", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "template-association-"))
    temporary.push(dir)
    const source = path.join(dir, "index.html")
    fs.writeFileSync(source, "<p>Template</p>")
    const packages = new DesignTemplatePackages(path.join(dir, "library"))
    const template = packages.importSource(source, "user:a")
    const selection = { mode: "upload" as const, package: template, designSystemKey: null }
    expect(() => validateTemplateSelection(selection, a2, packages, [])).not.toThrow()
    expect(() => validateTemplateSelection(selection, b, packages, [])).toThrow("不属于")
    packages.updateAssociation(template, "builtin:b")
    expect(() => validateTemplateSelection(selection, a, packages, [])).toThrow("不属于")
    expect(() => validateTemplateSelection(selection, b, packages, [])).not.toThrow()
    const builtins = [
      { path: "/templates/a/SKILL.md", name: "A", previewHtml: "A", designSystemKey: "user:a" }
    ]
    expect(() =>
      validateTemplateSelection(
        { mode: "select", builtinPath: builtins[0].path },
        b,
        packages,
        builtins
      )
    ).toThrow("不属于")
    expect(() =>
      validateTemplateSelection({ mode: "select", builtinPath: "/unknown" }, a, packages, builtins)
    ).toThrow("不存在")
    expect(() =>
      validateTemplateSelection(
        { mode: "select", name: "历史快照", html: "Old" },
        b,
        packages,
        builtins
      )
    ).not.toThrow()
  })
})
