import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import AdmZip from "adm-zip"
import { afterEach, describe, expect, it } from "vitest"
import {
  DesignTemplatePackages,
  buildTemplatePackageContext,
  templateRelativePath
} from "./template-packages"
import { DesignTemplatePreview } from "./template-preview"
import { createDesignArtifactZip } from "./artifact-package"

const temporary: string[] = []
const previews: DesignTemplatePreview[] = []
afterEach(() => {
  previews.splice(0).forEach((preview) => preview.close())
  temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))
})
function fixture(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-template-test-"))
  temporary.push(dir)
  const zip = new AdmZip()
  for (const [file, content] of Object.entries(files)) zip.addFile(file, Buffer.from(content))
  const archive = path.join(dir, "template.zip")
  zip.writeZip(archive)
  return { dir, archive, packages: new DesignTemplatePackages(path.join(dir, "library")) }
}

describe("template packages", () => {
  it("recognizes a non-index React entry, persists it, and materializes independent session resources", () => {
    const { dir, archive, packages } = fixture({
      "list.html":
        '<div id="root"></div><script src="./cdn/react.production.min.js"></script><script src="./cdn/antd5.min.js"></script><script type="text/babel">const view = <p>用户</p></script>',
      "cdn/react.production.min.js": "window.React={}",
      "cdn/antd5.min.js": "window.antd={}",
      "detail.html": "<p>详情</p>"
    })
    const imported = packages.importSource(archive)
    expect(imported.entryPath).toBe("detail.html") // deterministic choice for multiple nonstandard pages
    const template = packages.read({ id: imported.id, entryPath: "list.html" })
    expect(template.framework).toBe("React + Ant Design")
    expect(template.warnings).toEqual([])
    expect(new DesignTemplatePackages(packages.storageDir).list()).toHaveLength(1)
    const output = path.join(dir, "artifact")
    const prepared = packages.materialize(template, output)
    const vendor = path.join(output, "template", template.id, "cdn/react.production.min.js")
    expect(fs.readFileSync(vendor, "utf8")).toBe("window.React={}")
    fs.writeFileSync(vendor, "session edit")
    packages.materialize(template, output)
    expect(fs.readFileSync(vendor, "utf8")).toBe("session edit")
    const context = buildTemplatePackageContext(prepared)
    expect(context).toContain(prepared.referencePath)
    expect(context).toContain(`${prepared.resourcePrefix}cdn/react.production.min.js`)
    expect(context).not.toContain("window.React={}")
    fs.rmSync(archive)
    expect(packages.read(template).html).toContain("text/babel")
    expect(() => packages.read({ id: template.id, entryPath: "../outside.html" })).toThrow()
  })

  it("imports an HTML dependency graph without copying unrelated sibling files", () => {
    const { dir, packages } = fixture({})
    const source = path.join(dir, "source")
    fs.mkdirSync(path.join(source, "assets"), { recursive: true })
    fs.writeFileSync(
      path.join(source, "list.html"),
      '<link rel="stylesheet" href="assets/style.css"><script src="assets/app.js"></script><img src="missing.png">'
    )
    fs.writeFileSync(
      path.join(source, "assets/style.css"),
      '@import "other.css"; .icon{background:url(icon.svg)}'
    )
    fs.writeFileSync(path.join(source, "assets/other.css"), "body{color:red}")
    fs.writeFileSync(path.join(source, "assets/icon.svg"), "<svg/>")
    fs.writeFileSync(path.join(source, "assets/app.js"), 'fetch("data.json")')
    fs.writeFileSync(path.join(source, "data.json"), "{}")
    fs.writeFileSync(path.join(source, "private.txt"), "not a template dependency")
    const template = packages.importSource(path.join(source, "list.html"))
    expect(template.files).toEqual([
      "assets/app.js",
      "assets/icon.svg",
      "assets/other.css",
      "assets/style.css",
      "data.json",
      "list.html"
    ])
    expect(template.warnings).toContain("入口资源不存在：missing.png")
  })

  it("supports nested entries and keeps sibling resource paths within the package root", () => {
    const { dir, archive, packages } = fixture({
      "site/pages/list.html": '<script src="../vendor/app.js"></script>',
      "site/vendor/app.js": "window.ready=true"
    })
    const template = packages.importSource(archive)
    expect(template.warnings).toEqual([])
    const prepared = packages.materialize(template, path.join(dir, "artifact"))
    expect(prepared.resourcePrefix).toBe(`./template/${template.id}/site/pages/`)
    expect(
      fs.existsSync(path.resolve(path.dirname(prepared.referencePath), "../vendor/app.js"))
    ).toBe(true)
  })

  it("rejects invalid archives and cleans up incomplete imports", () => {
    for (const entry of [
      "../escape.html",
      "/absolute.html",
      "C:\\absolute.html",
      "nested/../../escape.html",
      "a\0b.html"
    ])
      expect(() => templateRelativePath(entry)).toThrow()
    const { packages, archive } = fixture({ "assets/app.js": "// assets only" })
    expect(() => packages.importSource(archive)).toThrow("未找到 HTML 入口")
    expect(packages.list()).toEqual([])
    const duplicate = fixture({ "index.html": "a", "INDEX.html": "b" })
    expect(() => duplicate.packages.importSource(duplicate.archive)).toThrow("重复路径")
    const oversized = fixture({ "index.html": "x".repeat(5 * 1024 * 1024 + 1) })
    expect(() => oversized.packages.importSource(oversized.archive)).toThrow("HTML 超过")
  })

  it("exports transitive dependencies and the current entry without temporary source snapshots", () => {
    const { dir, archive, packages } = fixture({
      "list.html": '<script src="cdn/app.js"></script>',
      "cdn/app.js": 'fetch("data/config.json")',
      "data/config.json": '{"label":"Exported"}'
    })
    const template = packages.importSource(archive)
    const output = path.join(dir, "artifact")
    packages.materialize(template, output)
    const entry = path.join(output, "index.html")
    fs.writeFileSync(entry, "old HTML")
    fs.writeFileSync(path.join(output, ".draft-a.html"), "unfinished")
    fs.writeFileSync(path.join(output, ".source-a.html"), "snapshot")
    const exported = new AdmZip(createDesignArtifactZip(output, entry, "current HTML"))
    expect(exported.readAsText("index.html")).toBe("current HTML")
    expect(exported.readAsText(`template/${template.id}/data/config.json`)).toContain("Exported")
    expect(exported.getEntries().some((item) => /\.(?:draft|source)-/.test(item.entryName))).toBe(
      false
    )
  })

  it("rejects directory symlinks and prevents session symlinks from redirecting resource writes", () => {
    const { dir, packages } = fixture({})
    const source = path.join(dir, "source")
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, "index.html"), "<p>Template</p>")
    fs.symlinkSync(path.join(dir, "template.zip"), path.join(source, "link.zip"))
    expect(() => packages.importSource(source)).toThrow("符号链接")
    fs.unlinkSync(path.join(source, "link.zip"))
    const external = path.join(dir, "external")
    fs.mkdirSync(external)
    fs.writeFileSync(path.join(external, "secret.js"), "not part of the selected template")
    fs.symlinkSync(external, path.join(source, "linked"))
    fs.writeFileSync(path.join(source, "index.html"), '<script src="linked/secret.js"></script>')
    expect(() => packages.importSource(path.join(source, "index.html"))).toThrow("目录越界")
    fs.unlinkSync(path.join(source, "linked"))
    fs.writeFileSync(path.join(source, "index.html"), "<p>Template</p>")
    const template = packages.importSource(source)
    const output = path.join(dir, "artifact")
    const outside = path.join(dir, "outside")
    fs.mkdirSync(output)
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(output, "template"))
    expect(() => packages.materialize(template, output)).toThrow("符号链接")
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it("serves only registered package bytes over a token-scoped, read-only preview", async () => {
    const { archive, packages } = fixture({
      "list.html": '<script src="cdn/app.js"></script>',
      "cdn/app.js": "window.ready=true"
    })
    const template = packages.importSource(archive)
    const preview = new DesignTemplatePreview()
    previews.push(preview)
    const url = await preview.url(template)
    const page = await fetch(url)
    expect(await page.text()).toBe(template.html)
    expect(page.headers.get("content-security-policy")).toContain("sandbox allow-scripts")
    const script = await fetch(new URL("cdn/app.js", url))
    expect(script.headers.get("content-type")).toContain("text/javascript")
    expect(await script.text()).toBe("window.ready=true")
    expect((await fetch(new URL("../manifest.json", url))).status).toBe(404)
    expect((await fetch(new URL("cdn/app.js", url), { method: "POST" })).status).toBe(405)
    expect((await fetch(url.replace(/\/[^/]+\/list.html$/, "/unknown/list.html"))).status).toBe(404)
  })
})
