import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { FunctionCompletionPolicyForm } from "../components/customize/FunctionCompletionPolicy"
import { DEFAULT_COMPLETION_POLICY } from "../../../shared/mods/v2/completion-policy-values"

it("offers all application completion modes, scopes, checks and bounded budgets without an example plugin", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionCompletionPolicyForm, {
      value: {
        ...DEFAULT_COMPLETION_POLICY,
        mode: "repair",
        scope: "file",
        target: "src/orders.ts"
      },
      source: "application",
      disabled: false,
      onChange: () => {},
      onSave: () => {}
    })
  )
  for (const text of [
    "关闭",
    "仅报告",
    "阻止完成",
    "自动修复并复检",
    "当前文件",
    "当前 diff",
    "Feature",
    "整个项目",
    "代码评审",
    "单元测试",
    "E2E",
    "Autobiz validator",
    "最大修复次数",
    "最长时间（秒）",
    "模型总预算（tokens）",
    "src/orders.ts"
  ])
    expect(html).toContain(text)
  expect(html).toContain("由应用保存")
  expect(html).toContain('max="10"')
  expect(html).toContain('max="3600"')
})

it("keeps inherited plugin behavior visibly distinct until an application rule is saved", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionCompletionPolicyForm, {
      value: DEFAULT_COMPLETION_POLICY,
      source: "default",
      disabled: true,
      onChange: () => {},
      onSave: () => {}
    })
  )
  expect(html).toContain("保存前沿用插件行为")
  expect(html).toContain('disabled=""')
})
