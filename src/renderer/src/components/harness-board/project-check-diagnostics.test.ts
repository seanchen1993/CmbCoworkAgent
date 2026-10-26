import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import type { HostExecutionTerminal } from "../../../../shared/project-runtime/host-types"
import { ProjectCheckDiagnostics } from "./ProjectCheckDiagnostics"

it("renders retained failed-check errors, warnings and project-only retry guidance as text", () => {
  const terminal: HostExecutionTerminal = {
    outcome: "error",
    code: "project_checks_failed",
    checkDiagnostics: [
      {
        checkId: "prd.business",
        actionId: "prd.business",
        runId: "run",
        executionId: "execution",
        provider: {
          pluginId: "rules-id",
          plugin: "rules",
          digest: "a".repeat(64),
          actionId: "prd"
        },
        inputFingerprint: "b".repeat(64),
        resultDigest: "c".repeat(64),
        summary: "需求检查未通过",
        errors: [{ code: "REQUIREMENT_MISSING", message: "缺少反馈验收条件" }],
        warnings: [{ code: "REFERENCE", message: "<script>untrusted</script>" }],
        truncated: true
      }
    ]
  }
  const html = renderToStaticMarkup(createElement(ProjectCheckDiagnostics, { terminal }))
  expect(html).toContain("prd.business")
  expect(html).toContain("缺少反馈验收条件")
  expect(html).toContain("REFERENCE")
  expect(html).toContain("&lt;script&gt;untrusted&lt;/script&gt;")
  expect(html).not.toContain("<script>")
  expect(html).toContain("诊断显示已截断")
  expect(html).toContain("从本项目重新开始当前阶段")
  expect(html).toContain("阶段会话仅供查看")
  expect(html).not.toContain("<button")
  expect(terminal.outcome).toBe("error")
})

it("does not invent diagnostics for old operations without retained evidence", () => {
  expect(
    renderToStaticMarkup(
      createElement(ProjectCheckDiagnostics, {
        terminal: { outcome: "error", code: "project_checks_failed" }
      })
    )
  ).toBe("")
})
