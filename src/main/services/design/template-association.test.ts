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
  it("keeps a selected secondary entry from the registered market package", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "template-market-association-"))
    temporary.push(dir)
    const system: DesignSystemInfo = {
      ...b, ownership: "market", marketSystemId: "market-system", marketVersion: "1.0.0"
    }
    const packageId = "mkt_template"
    const pages = ["index.html", "detail.html"]
    for (const page of pages) fs.writeFileSync(path.join(dir, page), `<p>${page}</p>`)
    const packages = new DesignTemplatePackages(path.join(dir, "library"))
    packages.registerMarket(packageId, dir, {
      id: packageId, name: "市场模板", entryPath: "index.html", pages, files: pages,
      designSystemKey: "market:market-system", totalBytes: 0, framework: "HTML",
      importedAt: new Date().toISOString(), source: "market", marketTemplateId: "template",
      marketSystemId: "market-system", marketVersion: "1.0.0", marketVersionId: "version",
      marketMinSystemVersion: "1.0.0", marketOwnerName: "作者"
    })
    const catalog = [{
      path: path.join(dir, "index.html"), name: "市场模板", previewHtml: "",
      designSystemKey: "market:market-system", marketMinSystemVersion: "1.0.0",
      package: { id: packageId, entryPath: "index.html" }
    }]
    const selection = {
      mode: "select" as const, builtinPath: catalog[0].path,
      package: { id: packageId, entryPath: "detail.html" }
    }
    validateTemplateSelection(selection, system, packages, catalog)
    expect(selection.package).toEqual({ id: packageId, entryPath: "detail.html" })
    selection.package.entryPath = "missing.html"
    expect(() => validateTemplateSelection(selection, system, packages, catalog)).toThrow("HTML 页面")
  })

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
