import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { FlowAttempt, FlowRun, FlowStep } from "../../../shared/mods/flows/types"
import { FlowRunView } from "../components/customize/FlowRunView"

const step = (id: string, enabled = true): FlowStep => ({
  id,
  name: id,
  enabled,
  kind: "agent",
  prompt: "Review the fixture"
})
const attempt = (
  stepId: string,
  status: FlowAttempt["status"],
  patch: Partial<FlowAttempt> = {}
): FlowAttempt => ({
  executionId: `${stepId}-${status}`,
  stepId,
  status,
  attempt: 1,
  epoch: 0,
  startedAt: 1,
  ...patch
})
const run = (steps: FlowStep[], attempts: FlowAttempt[]): FlowRun => ({
  id: "fixture-run",
  threadId: "fixture-thread",
  workspace: "C:/isolated/fixture",
  status: "complete",
  startedAt: 1,
  epoch: 1,
  failureCounts: {},
  attempts,
  flow: {
    revision: 1,
    digest: "a".repeat(64),
    updatedAt: 1,
    definition: {
      id: "fixture",
      name: "Fixture flow",
      schemaVersion: 2,
      execution: { kind: "host", profile: "prompt-only-v1" },
      goal: "Review fixture",
      timeoutMs: 60000,
      maxExecutions: 20,
      steps
    }
  }
})
const render = (value: FlowRun): string =>
  renderToStaticMarkup(
    createElement(FlowRunView, {
      run: value,
      busy: false,
      onDecide: () => {},
      onCancel: () => {}
    })
  )

/** Inspect native disclosure ancestors without relying on CSS or a browser fixture. */
function disclosureAncestors(html: string, text: string): string[] {
  const index = html.indexOf(text)
  expect(index).toBeGreaterThanOrEqual(0)
  const stack: string[] = []
  for (const match of html.slice(0, index).matchAll(/<details\b[^>]*>|<\/details>/g)) {
    if (match[0].startsWith("</")) stack.pop()
    else stack.push(match[0])
  }
  return stack
}

describe("flow run overview", () => {
  it("retains valid upstream passes across a repair epoch without counting invalidated results", () => {
    const html = render(
      run(
        [step("read"), step("review")],
        [
          attempt("read", "passed"),
          attempt("review", "failed", { invalidated: true }),
          attempt("review", "passed", { epoch: 1, attempt: 2 })
        ]
      )
    )
    expect(html).toContain("已完成 2 / 2 步")
    expect(html).toContain("历史步骤与技术详情")
    expect(html).not.toContain("已失效，不能作为当前通过依据")
    expect(html).toContain("尚无可确认的项目测试结果，不能据此认为测试通过")
  })

  it("does not count disabled, skipped, unknown or superseded passes as current success", () => {
    const value = run(
      [step("disabled", false), step("skipped"), step("unknown"), step("changed"), step("passed")],
      [
        attempt("disabled", "passed"),
        attempt("skipped", "skipped"),
        attempt("unknown", "unknown"),
        attempt("changed", "passed"),
        attempt("changed", "failed", { epoch: 1, attempt: 2 }),
        attempt("passed", "passed")
      ]
    )
    value.status = "interrupted"
    const html = render(value)
    expect(html).toContain("已完成 1 / 4 步")
    expect(html).toContain("不要直接重复提交")
    expect(html).toContain("需要核对")
  })

  it("does not let invalidated unknown attempts override the completed run next step", () => {
    const html = render(
      run(
        [step("read")],
        [
          attempt("read", "unknown", { invalidated: true }),
          attempt("read", "passed", { epoch: 1, attempt: 2 })
        ]
      )
    )
    expect(html).toContain("已完成 1 / 1 步")
    expect(html).toContain("下一步：查看成果和检查结果")
  })

  it("keeps raw output, trace and historical evidence behind closed technical disclosures", () => {
    const html = render(
      run(
        [step("review")],
        [
          attempt("review", "failed", {
            result: {
              passed: false,
              source: "agent",
              summary: "Fixture failure",
              output: { raw: "RAW_FIXTURE" }
            },
            telemetry: { childThreadId: "child", traceId: "trace", rootTraceId: "root" }
          })
        ]
      )
    )
    for (const text of [
      "技术详情 · 运行编号与版本",
      "技术详情 · 历史检查证据"
    ]) {
      expect(disclosureAncestors(html, text).some((tag) => !/\bopen(?:=|\s|>)/.test(tag))).toBe(
        true
      )
    }
    expect(html).toContain("Fixture failure")
    expect(html).not.toContain("RAW_FIXTURE")
    expect(html).not.toContain("查看子执行轨迹")
  })

  it("keeps approval outcome and both decisions outside technical disclosures", () => {
    const value = run([step("review")], [attempt("review", "waiting")])
    value.status = "waiting"
    value.pendingApproval = {
      nonce: "one-use",
      stepId: "review",
      executionId: "review-waiting",
      inputDigest: "input",
      fingerprint: "fingerprint",
      definitionDigest: "definition",
      summary: "APPROVAL_FIXTURE"
    }
    const html = render(value)
    for (const text of ["APPROVAL_FIXTURE", "同意并继续", "拒绝并停止"])
      expect(disclosureAncestors(html, text)).toEqual([])
    expect(html.match(/>同意并继续<\/button>/g)).toHaveLength(1)
    expect(html).toContain("文件或结果改变后会再次请你确认")
  })
})

