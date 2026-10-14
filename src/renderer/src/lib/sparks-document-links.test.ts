import { describe, expect, it } from "vitest"
import { sparksDocumentLink } from "../components/customize/sparks-document-links"

describe("bundled Sparks documentation links", () => {
  it("routes known chapters without navigating the application", () => {
    expect(sparksDocumentLink("./create.md")).toEqual({ kind: "chapter", file: "create.md" })
    expect(sparksDocumentLink("README.md")).toEqual({ kind: "chapter", file: "README.md" })
  })

  it("allows only explicit secure external references", () => {
    expect(sparksDocumentLink("https://code.claude.com/docs/zh-CN/plugins/mods/create").kind).toBe("external")
    for (const href of ["javascript:alert(1)", "file:///C:/secret", "../private.md", "../../src/main.ts", "data:text/html,test", "http://example.test", "https://user:password@example.test", "//example.test"])
      expect(sparksDocumentLink(href)).toEqual({ kind: "reference" })
  })
})
