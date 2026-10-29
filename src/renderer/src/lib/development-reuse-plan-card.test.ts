import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { DevelopmentReusePlanCard } from "../components/customize/DevelopmentReusePlanCard"
import type { DevelopmentStatus } from "../../../shared/mods/development"

function render(
  save: NonNullable<DevelopmentStatus["save"]>,
  phase: "needs-approval" | "active" | "unknown",
  error?: string
) {
  const approve = vi.fn()
  const html = renderToStaticMarkup(
    React.createElement(DevelopmentReusePlanCard, {
      plan: {
        phase,
        error,
        planId: "plan",
        name: "Weather",
        draftId: "weather",
        revision: 1,
        sourceDigest: "a".repeat(64),
        compiledDigest: "b".repeat(64),
        targetProfileDigest: "c".repeat(64),
        capabilities: []
      },
      save,
      current: true,
      busy: false,
      onApprove: approve,
      onRead: () => {}
    })
  )
  return { html, approve }
}
describe("named combination save feedback", () => {
  it("distinguishes a reviewed function version from the still unsaved complete combination", () => {
    const { html, approve } = render(
      { saved: false, phase: "needs-approval", name: "日常开发", revision: 0, dependencies: [] },
      "needs-approval"
    )
    expect(html).toContain("正式功能版本")
    expect(html).toContain("正在准备搭配「日常开发」")
    expect(html).toContain("全部生效后才会保存完整搭配")
    expect(html).not.toContain("已保存搭配")
    expect(approve).not.toHaveBeenCalled()
  })
  it("does not infer complete combination success from an active installed function", () => {
    const { html } = render(
      { saved: false, phase: "unknown", name: "日常开发", revision: 0, dependencies: [] },
      "active"
    )
    expect(html).toContain("尚未保存")
    expect(html).toContain("请勿重复安装")
    expect(html).not.toContain("已保存搭配")
  })
  it("reports the requested combination name and exact saved revision after completion", () => {
    const { html } = render(
      { saved: true, phase: "saved", name: "日常开发", revision: 2, dependencies: [] },
      "active"
    )
    expect(html).toContain("已保存搭配「日常开发」，版本 2")
  })
  it("does not mistake a saved dependency awaiting runtime readiness for complete named-save success", () => {
    const { html, approve } = render(
      { saved: false, phase: "unknown", name: "日常开发", revision: 0, dependencies: [] },
      "unknown",
      "CREATOR_REUSE_RUNTIME_UNCONFIRMED"
    )
    expect(html).toContain("这个正式功能版本已保存，当前聊天尚未确认运行就绪")
    expect(html).toContain("完整搭配的保存结果以上方状态为准")
    expect(html).not.toContain("正式版本和可复用组合已保存")
    expect(html).not.toContain("已保存搭配")
    expect(html).toContain("核对运行状态")
    expect(html).not.toContain("确认保存并复用")
    expect(approve).not.toHaveBeenCalled()
  })
  it("keeps true unconfirmed installation outcomes protected rather than claiming a saved version", () => {
    const { html, approve } = render(
      { saved: false, phase: "unknown", name: "日常开发", revision: 0, dependencies: [] },
      "unknown",
      "CREATOR_REUSE_RESTART_UNCONFIRMED"
    )
    expect(html).toContain("保存或切换结果待核对")
    expect(html).toContain("不要重复安装或授权")
    expect(html).toContain("核对复用状态")
    expect(html).not.toContain("核对运行状态")
    expect(html).not.toContain("这个正式功能版本已保存")
    expect(approve).not.toHaveBeenCalled()
  })
})
