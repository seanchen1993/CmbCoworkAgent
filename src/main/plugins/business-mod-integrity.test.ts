import { describe, expect, it } from "vitest"
import { businessModIntegrityDiagnostics } from "./business-mod-integrity"

describe("business knowledge path diagnostics", () => {
  it.each(["${pluginPath}/sys", "${pluginPath}\\sys", "${pluginPath}\\sys\\"])(
    "reports an absent knowledge directory with portable and Windows separators: %s",
    (knowledgePath) => {
      const result = businessModIntegrityDiagnostics({
        inspectCommands: { win32: { knowledge_path: knowledgePath } }
      }, [])
      expect(result.diagnostics).toEqual([expect.stringContaining("外部知识待绑定：sys")])
    }
  )

  it("recognizes materialized knowledge and does not resolve traversal as a package resource", () => {
    const board = (path: string) => ({ inspectCommands: { win32: { knowledge_path: path } } })
    expect(businessModIntegrityDiagnostics(board("${pluginPath}\\sys"), [
      { path: "sys/AGENTS.md", bytes: Buffer.from("knowledge"), digest: "a".repeat(64), mode: 0o644 }
    ]).diagnostics).toEqual([])
    expect(businessModIntegrityDiagnostics(board("${pluginPath}\\..\\private"), [])
      .diagnostics).toEqual([])
  })
})
