import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { DevelopmentReusePlanCard } from "../../../renderer/src/components/customize/DevelopmentReusePlanCard"
import type { DevelopmentReuseStatus } from "../../../shared/mods/development"

const plan: DevelopmentReuseStatus = { phase: "needs-approval", name: "公共检查", draftId: "check",
  revision: 2, sourceDigest: "a".repeat(64), capabilities: [],
  dependencyImpact: { inspectedSources: 16, knownDependants: [{ id: "consumer", name: "报告项目",
    kind: "installed", actionIds: ["validate"] }], uninspectedSources: 1, moreSources: true, complete: false } }

it("shows known callers and unresolved coverage together without asserting compatibility or changing approval", () => {
  const html = renderToStaticMarkup(createElement(DevelopmentReusePlanCard, { plan, current: true, busy: false,
    onApprove: () => {}, onRead: () => {} }))
  expect(html).toContain("已识别 1 个声明依赖")
  expect(html).toContain("报告项目")
  expect(html).toContain("validate")
  expect(html).toContain("还有来源未核对")
  expect(html).toContain("读取或声明校验失败")
  expect(html).toContain("未发现依赖不代表没有影响")
  expect(html).toContain("不会自动改用新版")
  expect(html).toContain("确认保存并复用")
})
