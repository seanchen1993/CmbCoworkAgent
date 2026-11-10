import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { isTemplateVisible } from "../../../shared/design-template"
import { listBuiltinTemplateBundle } from "./builtin-template-bundles"
import { DesignTemplatePackages, buildTemplatePackageContext } from "./template-packages"
import { validateTemplateSelection } from "./template-association"

const source = path.resolve("design-templates/market-wplus")
const temporary: string[] = []
afterEach(() => temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-wplus-"))
  temporary.push(directory)
  const packages = new DesignTemplatePackages(path.join(directory, "library"))
  return { directory, packages, catalog: listBuiltinTemplateBundle(source, packages) }
}

describe("Market W+ builtin template bundle", () => {
  it("exposes five exclusive pages with one shared offline package, without user imports", () => {
    const { packages, catalog } = fixture()
    expect(catalog).toHaveLength(5)
    expect(new Set(catalog.map((item) => item.path)).size).toBe(5)
    expect(new Set(catalog.map((item) => item.package!.id)).size).toBe(1)
    expect(catalog.map((item) => item.package!.entryPath)).toEqual([
      "basic-form.html", "batch-import.html", "complex-form.html", "filter-table.html", "select-list.html"
    ])
    for (const item of catalog) {
      expect(isTemplateVisible(item, "builtin:wplus")).toBe(true)
      expect(isTemplateVisible(item, "builtin:wealth")).toBe(false)
      expect(isTemplateVisible(item, null)).toBe(false)
      const template = packages.read(item.package!)
      expect(template.framework).toBe("React + Ant Design")
      expect(template.warnings).toEqual([])
      expect(template.files).toContain("assets/企业导入模板.xlsx")
      expect(template.html).toBe(fs.readFileSync(item.previewPath, "utf8"))
    }
    expect(packages.list()).toEqual([])
  })

  it("restores stable references and materializes dependencies without overwriting a design's edits", () => {
    const { directory, catalog } = fixture()
    const restored = new DesignTemplatePackages(path.join(directory, "library"))
    listBuiltinTemplateBundle(source, restored)
    const reference = catalog.find((item) => item.package!.entryPath === "filter-table.html")!.package!
    const prepared = restored.materialize(reference, path.join(directory, "design"))
    const context = buildTemplatePackageContext(prepared)
    expect(context).toContain("React + Ant Design")
    expect(context).toContain(prepared.referencePath)
    expect(context).toContain("禁止引用原始上传位置")
    const css = path.join(path.dirname(prepared.referencePath), "theme.css")
    expect(fs.readFileSync(css, "utf8")).toContain("#1774ff")
    expect(fs.existsSync(path.join(path.dirname(css), "cdn/antd5.min.js"))).toBe(true)
    fs.writeFileSync(css, "/* edited by this design */")
    restored.materialize(reference, path.join(directory, "design"))
    expect(fs.readFileSync(css, "utf8")).toBe("/* edited by this design */")
    expect(() => restored.updateAssociation(reference, null)).toThrow("内置模板")
  })

  it("resolves a selected card to its canonical package and checks the design-system association", () => {
    const { packages, catalog } = fixture()
    const item = catalog[0]
    const selection = {
      mode: "select" as const, builtinPath: item.path, html: "<base href='expired-preview'>",
      package: { id: "forged", entryPath: "other.html" }
    }
    validateTemplateSelection(selection, { id: "wplus", name: "市场w+", path: "", description: "" }, packages, catalog)
    expect(selection.package).toEqual(item.package)
    expect(selection.html).toBe(item.previewHtml)
    expect(() => validateTemplateSelection(selection,
      { id: "wealth", name: "财富管理", path: "", description: "" }, packages, catalog)).toThrow("不属于")
  })
})
