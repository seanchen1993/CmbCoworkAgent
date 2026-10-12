import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { BotSkillTrialMessage } from "../components/bots/BotSkillTrialMessage"

it("shows the accepted trial inputs and keeps the complete execution text collapsed and escaped", () => {
  const instructions = "Run taught skill: 整理订单\nApproval boundaries: <script>alert(1)</script>"
  const html = renderToStaticMarkup(
    createElement(BotSkillTrialMessage, {
      trial: {
        id: "trial",
        skillId: "skill",
        name: "整理订单",
        version: 3,
        inputs: "订单 <ORD-002>\n金额 100",
        criteria: "订单编号与金额一致"
      },
      text: instructions
    })
  )
  expect(html).toContain('aria-label="技能试跑"')
  expect(html).toContain("整理订单")
  expect(html).toContain("v3")
  expect(html).toContain("订单 &lt;ORD-002&gt;\n金额 100")
  expect(html).toContain("订单编号与金额一致")
  const details = html.slice(html.indexOf("<details"), html.indexOf("</details>"))
  expect(details).not.toMatch(/^<details[^>]*\bopen[=> ]/)
  expect(details).toContain("查看完整执行说明")
  expect(details).toContain("Run taught skill:")
  expect(details).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  expect(html.slice(0, html.indexOf("<details"))).not.toContain("Approval boundaries:")
  expect(html).not.toContain("<script>")
})
