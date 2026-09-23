import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { FunctionCompletionEvidenceContent } from "../components/chat/FunctionCompletionEvidence"
import type { BoundCompletionEvidenceRecord as CompletionEvidenceRecord } from "../../../main/mods/v2/completion-evidence"

const record = (
  phase: CompletionEvidenceRecord["phase"],
  status: CompletionEvidenceRecord["status"],
  detail: CompletionEvidenceRecord["detail"]
): CompletionEvidenceRecord => ({
  id: `${phase}:${status}`,
  idempotencyKey: "key",
  workspace: "workspace",
  threadId: "thread",
  turnId: "turn",
  runId: "run",
  phase,
  status,
  detail,
  at: 1,
  binding: {
    workspace: "workspace",
    threadId: "thread",
    turnId: "turn",
    runId: "run",
    runtimeGeneration: 4,
    pluginDigests: { review: "digest" },
    diffFingerprint: "diff",
    stateFingerprint: "state",
    configFingerprint: "config",
    requirementVersion: "requirements-v2",
    files: [{ path: "src/main.ts", size: 21, sha256: "fingerprint" }]
  }
})

it("separates host test evidence from guest opinion and gives a concrete next action", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionCompletionEvidenceContent, {
      records: [
        record("check.started", "running", {
          rules: [
            {
              plugin: "policy",
              mode: "repair",
              scope: "diff",
              checks: ["code-review", "unit-test"],
              maxRepairs: 2,
              timeoutMs: 5000,
              modelTokenBudget: 4096
            }
          ]
        }),
        record("validator.result", "pass", {
          source: "guest-opinion",
          check: "code-review",
          businessAccepted: false
        }),
        record("validator.result", "block", {
          kind: "unit-test",
          reason: "assertion failed <script>",
          outputFingerprint: "test-output"
        }),
        record("check.result", "block", {
          reason: "MODS_COMPLETION_MODEL_BUDGET",
          inputTokens: 123,
          outputTokens: 45
        })
      ]
    })
  )
  expect(html).toContain("插件评审意见")
  expect(html).toContain("宿主单元测试")
  expect(html).toContain("不代表业务验收")
  expect(html).toContain("assertion failed &lt;script&gt;")
  expect(html).toContain("调整模型总预算")
  expect(html).toContain("src/main.ts")
  expect(html).toContain("fingerprint")
  expect(html).toContain("requirements-v2")
  expect(html).toContain("4096")
  expect(html).toContain("code-review + unit-test")
  expect(html).not.toContain("<script>")
})

it("adds no visible UI when there is no trusted host evidence", () => {
  expect(
    renderToStaticMarkup(createElement(FunctionCompletionEvidenceContent, { records: [] }))
  ).toBe("")
})

it("shows capture errors as unavailable file evidence without claiming a zero-file PASS", () => {
  const base = record("check.result", "error", { error: "File is too large" })
  const html = renderToStaticMarkup(
    createElement(FunctionCompletionEvidenceContent, {
      records: [
        {
          ...base,
          phase: "capture.failed",
          status: "error",
          binding: null,
          capture: {
            workspace: "workspace",
            threadId: "thread",
            turnId: "turn",
            runId: "run",
            runtimeGeneration: 4,
            pluginDigests: { review: "digest" },
            configFingerprint: "config"
          }
        }
      ]
    })
  )
  expect(html).toContain("文件证据采集失败")
  expect(html).toContain("未取得文件证据")
  expect(html).toContain("File is too large")
  expect(html).not.toContain("文件指纹 0")
  expect(html).not.toContain("需求版本：")
})

it("does not let late invalidation of an old runtime replace a newer check summary", () => {
  const old = { ...record("check.result", "pass", {}), id: "old", at: 1 }
  const current = {
    ...record("check.result", "pass", {}),
    id: "new",
    at: 2,
    binding: { ...old.binding, runtimeGeneration: 5 }
  }
  const stale = { ...record("invalidated", "stale", { reason: "runtime-replaced" }), at: 3 }
  const html = renderToStaticMarkup(
    createElement(FunctionCompletionEvidenceContent, {
      records: [stale, current, old]
    })
  )
  expect(html).toMatch(/完成检查证据 · 通过/)
  expect(html).toContain("证据已失效")
})

it("identifies an uncertain checkpoint commit and requires reconciliation before retry", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionCompletionEvidenceContent, {
      records: [
        record("state.transition", "interrupted", {
          operationId: "trusted-operation-123",
          reason: "AUTOBIZ_COMMIT_UNKNOWN"
        })
      ]
    })
  )
  expect(html).toContain("trusted-operation-123")
  expect(html).toContain("提交结果未知")
  expect(html).toContain("不要直接重试推进")
})

it("limits history while preserving stale and cancelled outcomes instead of calling them PASS", () => {
  const records = Array.from({ length: 40 }, (_, index) => ({
    ...record("invalidated", "stale", { reason: `changed-${index}` }),
    id: `${index}`,
    at: index
  }))
  const html = renderToStaticMarkup(createElement(FunctionCompletionEvidenceContent, { records }))
  expect(html).toContain("证据已失效")
  expect(html.match(/data-completion-record=/g)).toHaveLength(24)
  expect(html).not.toContain("changed-0<")
})
