import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ThreadSkillUsageMetric } from "./ThreadSkillUsageMetric"
import { TraceExplorer } from "./TraceHistoryDialog"
import type { DashboardTraceDetail } from "./use-dashboard"

const trace: DashboardTraceDetail = {
  traceId: "trace-with-skill",
  threadId: "user-thread",
  startedAt: "2026-10-22T09:00:00+08:00",
  durationMs: 1000,
  userMessage: "测试会话",
  outcome: "success",
  totalToolCalls: 1,
  modelCallCount: 1,
  userInputRequestCount: 0,
  totalInputTokens: 100,
  totalOutputTokens: 10,
  totalTokens: 110,
  usedSkills: ["autodev-code-v1.0.0"],
  evolvedSkills: [],
  rawAvailable: false
}

describe("Skill metrics without an ancestor TooltipProvider", () => {
  it("renders recorded Skills in an independently mounted detail view", () => {
    const html = renderToStaticMarkup(
      createElement(ThreadSkillUsageMetric, {
        skills: trace.usedSkills,
        loading: false,
        onRetry: () => undefined
      })
    )
    expect(html).toContain("使用过的技能")
    expect(html).toContain("autodev-code-v1.0.0")
    expect(html).toContain('data-slot="tooltip-trigger"')
  })

  it.each(["thread", "trace"] as const)(
    "renders the actual %s explorer used by user details",
    (viewMode) => {
      const html = renderToStaticMarkup(
        createElement(TraceExplorer, {
          traces: [trace],
          viewMode,
          showCodeStats: false,
          allowFullscreen: false
        })
      )
      expect(html).toContain("使用过的技能")
      expect(html).toContain("autodev-code-v1.0.0")
    }
  )

  it.each([
    { skills: [], loading: false, expected: "未记录" },
    { skills: trace.usedSkills, loading: true, expected: "加载中…" },
    { skills: trace.usedSkills, loading: false, error: "失败", expected: "加载失败，重试" }
  ])("preserves the $expected state", ({ expected, ...props }) => {
    const html = renderToStaticMarkup(
      createElement(ThreadSkillUsageMetric, {
        ...props,
        onRetry: () => undefined
      })
    )
    expect(html).toContain(expected)
    expect(html).not.toContain('data-slot="tooltip-trigger"')
  })
})
