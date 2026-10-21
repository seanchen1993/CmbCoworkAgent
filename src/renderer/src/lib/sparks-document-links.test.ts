import { describe, expect, it } from "vitest"
import { SPARKS_DOCUMENTS, sparksDocumentLink } from "../components/customize/sparks-document-links"

describe("bundled Sparks documentation links", () => {
  it("routes known chapters without navigating the application", () => {
    expect(sparksDocumentLink("./create.md")).toEqual({ kind: "chapter", file: "create.md" })
    expect(sparksDocumentLink("README.md")).toEqual({ kind: "chapter", file: "README.md" })
    for (const file of [
      "creator-plugin-workflow.md",
      "business-mod-assembly.md",
      "platform-authoring-lifecycle.md",
      "stage-debug-mod-extension.md",
      "autobiz-composition-example.md"
    ]) {
      expect(sparksDocumentLink(`./${file}`)).toEqual({ kind: "chapter", file })
    }
    expect(SPARKS_DOCUMENTS).toHaveLength(16)
  })

  it("allows only explicit secure external references", () => {
    expect(sparksDocumentLink("https://example.invalid/documentation-reference").kind).toBe(
      "external"
    )
    for (const href of [
      "javascript:alert(1)",
      "file:///C:/secret",
      "../private.md",
      "../../src/main.ts",
      "data:text/html,test",
      "http://example.test",
      "https://user:password@example.test",
      "//example.test"
    ])
      expect(sparksDocumentLink(href)).toEqual({ kind: "reference" })
  })
})
