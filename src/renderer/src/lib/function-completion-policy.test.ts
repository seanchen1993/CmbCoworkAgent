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
    "指定文件或目录",
    "本次代码改动",
    "Feature",
    "整个项目",
    "代码评审",
    "单元测试",
    "E2E",
    "Autobiz 业务验收",
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

it("offers an explicit stage input and explains that only the compiler chooses its destination", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionCompletionPolicyForm, {
      value: {
        ...DEFAULT_COMPLETION_POLICY,
        mode: "check",
        feature: "orders",
        checks: ["autobiz-validator"],
        autobizStartCheckpoint: "requirements_eval_in_progress"
      },
      source: "application",
      disabled: false,
      onChange: () => {},
      onSave: () => {}
    })
  )
  expect(html).toContain("自动推进阶段起点")
  expect(html).toContain('value="requirements_eval_in_progress"')
  expect(html).toContain("应用根据项目工作流确定下一阶段")
  expect(html).toContain("留空只检查，不推进")
})

it("blocks unavailable Autobiz selections while keeping ordinary templates and off available", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionCompletionPolicyForm, {
      value: { ...DEFAULT_COMPLETION_POLICY, mode: "repair" },
      source: "application",
      disabled: false,
      environment: {
        ready: false,
        source: "D:/source",
        issues: ["请安装 Python 3"],
        stageSupported: false
      },
      onChange: () => {},
      onSave: () => {}
    })
  )
  expect(html).toContain("普通代码检查仍可使用")
  expect(html).toContain("请安装 Python 3")
  expect(html).toContain("修复后再完成")
  expect(html).toContain("只给检查报告")
  expect(html).toContain("取消该检查后保存")
  expect(html).not.toContain("相对文件或目录")
})
