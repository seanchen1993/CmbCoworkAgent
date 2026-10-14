import { expect, it } from "vitest"
import { functionEventUsage } from "./compatibility-usage"
import { getFunctionEventSupport } from "./compatibility-catalog"

it("explains real automatic triggers with their user-visible boundaries", () => {
  expect(functionEventUsage("prompt.submit").range).toContain("含附件")
  expect(functionEventUsage("prompt.submit").range).toContain("忙时排队")
  expect(getFunctionEventSupport("prompt.submit")?.note).toContain("组件命令中不能直接提交")
  expect(functionEventUsage("turn.step").range).toContain("不会改变主对话")
  expect(functionEventUsage("turn.step").range).toContain("回答可逐段显示")
  expect(functionEventUsage("process.spawn").range).toContain("每段分别")
  expect(getFunctionEventSupport("process.spawn")?.note).toContain("不重复模型或进程")
  expect(functionEventUsage("completion.check").range).toContain("取决于组件内容")
  expect(functionEventUsage("author.unknown").range).toContain("未知入口")
  expect(functionEventUsage("prompt.edit").range).toContain("输入法")
  expect(functionEventUsage("prompt.suggest").range).toContain("不会自动替你发消息")
  expect(functionEventUsage("session.start").range).toContain("普通保存不会偷偷请求模型")
  expect(functionEventUsage("model.complete").range).toContain("不消耗规则自身处理时间")
  expect(getFunctionEventSupport("config.list")?.note).toContain("敏感值不进入配置查询")
})
