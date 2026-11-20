import { describe, expect, it } from "vitest"
import { resolveHtmlPreviewDependency } from "./html-srcdoc"

describe("HTML preview dependency paths", () => {
  it.each([
    ["app.js", "pages/app.js"],
    ["./app.js", "pages/app.js"],
    ["assets/app.js?v=2#module", "pages/assets/app.js"],
    ["assets\\style.css", "pages/assets/style.css"],
    ["./脚本%20代码.js", "pages/脚本 代码.js"]
  ])("resolves local dependency %s", (reference, expected) => {
    expect(resolveHtmlPreviewDependency("pages/index.html", reference)).toBe(expected)
  })

  it("preserves Windows and workspace-root HTML paths", () => {
    expect(resolveHtmlPreviewDependency("C:\\work\\index.html", "app.js")).toBe("C:/work/app.js")
    expect(resolveHtmlPreviewDependency("/index.html", "app.js")).toBe("/app.js")
  })

  it.each([
    "",
    "#x",
    "../secret.js",
    "assets/../../secret.js",
    "%2e%2e/secret.js",
    "..%5csecret.js",
    "/secret.js",
    "//host/secret.js",
    "https://host/app.js",
    "file:///C:/app.js",
    "C:\\app.js",
    "app.js:secret",
    "app%00.js",
    "%ZZ.js",
    "assets//app.js",
    "."
  ])("rejects unsafe dependency %s", (reference) => {
    expect(resolveHtmlPreviewDependency("pages/index.html", reference)).toBeNull()
  })
})
