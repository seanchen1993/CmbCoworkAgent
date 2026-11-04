import { describe, expect, it } from "vitest"
import type { DevelopmentTrialStatus } from "../../../../shared/mods/development"
import {
  developmentCapabilitySummary,
  developmentFailureMessage,
  developmentRepairPrompt,
  developmentNextStep
} from "./development-trial-view"

describe("development trial explanations", () => {
  it("does not prescribe refresh or stop for historical trial observations", () => {
    const row: DevelopmentTrialStatus = { componentId: "ui", draftId: "d", revision: 1,
      bundleDigest: "source", compiledDigest: "compiled", phase: "unknown", capabilities: [],
      historical: true }
    expect(developmentNextStep(row)).toContain("会话灵件管理")
    expect(developmentNextStep(row)).not.toContain("刷新")
    expect(developmentNextStep(row)).toContain("历史外部操作的结果仍需单独核对")
    delete row.historical
    expect(developmentNextStep(row)).toContain("刷新")
  })
  it("summarizes the permission set without dropping a new unknown capability", () => {
    expect(
      developmentCapabilitySummary([
        "ui.open",
        "ui.resolve",
        "ui.invalidate",
        "event:ui.render",
        "store.get",
        "store.set",
        "command.register",
        "event:command.run",
        "event:tool.call",
        "event:turn.complete"
      ])
    ).toEqual([
      "在聊天中显示面板和提示",
      "读取或保存此灵件的本地设置",
      "提供聊天快捷指令",
      "查看和调整工具调用",
      "随聊天开始、每轮结束更新"
    ])
    expect(developmentCapabilitySummary(["future.permission"])).toEqual(["其他权限（见完整列表）"])
    expect(developmentCapabilitySummary([])).toEqual([])
  })

  it.each([
    ["MODS_RETURN_UNDEFINED", "缺少必要的返回结果"],
    ["MODS_COMMAND_CONFLICT", "更换指令名称"],
    ["MODS_DEVELOPMENT_CAPABILITY_DENIED", "未批准的权限"],
    ["MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED", "调整启动代码"],
    ["MODS_RUNTIME_LOST", "运行已断开"],
    ["MODS_DEVELOPMENT_SOURCE_CHANGED", "草稿在启动前发生了变化"]
  ])("gives an actionable explanation for %s", (code, text) => {
    expect(developmentFailureMessage(code)).toContain(text)
    expect(developmentFailureMessage(code)).not.toContain(code)
  })

  it("does not present unknown failure details as an uncertain approval result", () => {
    const explanation = developmentFailureMessage("SECRET_PRIVATE_PATH")
    expect(explanation).toContain("未能启动")
    expect(explanation).not.toContain("SECRET_PRIVATE_PATH")
    expect(explanation).not.toContain("批准")
  })

  it("never describes future chat-writing or clipboard permissions as read-only facts", () => {
    expect(
      developmentCapabilitySummary(["session.send", "session.messages", "clock.every", "ui.copy"])
    ).toEqual(["创建运行期间的定时任务", "其他权限（见完整列表）"])
  })
  it("explains new display, connection and child permissions without granting them", () => {
    expect(developmentCapabilitySummary([
      "ui.place", "mcp.list", "mcp.status", "mcp.connect", "mcp.call", "mcp.disconnect",
      "agent.list", "agent.register", "agent.spawn", "agent.status", "agent.messages",
      "agent.stop", "ui.view"
    ])).toEqual([
      "在聊天中显示面板和提示",
      "查看已选 MCP 服务和所属连接状态",
      "连接、调用或断开当前明确选择的 MCP 服务",
      "查看可用的助手",
      "定义或创建子任务，可能调用模型和工具",
      "查看本灵件子任务的进度和原文",
      "请求停止本灵件创建的子任务",
      "按用户操作只读查看子任务"
    ])
    expect(developmentCapabilitySummary(["mcp.status", "agent.status"]).join(" "))
      .not.toMatch(/创建|停止|断开/)
  })
  it("distinguishes real activation from result verification and never retries unknown effects", () => {
    expect(developmentNextStep({ phase: "active", validation: "authorized-real" } as DevelopmentTrialStatus))
      .toContain("读取实际状态")
    expect(developmentNextStep({ phase: "active", diagnostics: { unknownRequests: 1 } } as DevelopmentTrialStatus))
      .toContain("不要再次执行")
    expect(developmentNextStep({ phase: "failed", activeRevision: 2 } as DevelopmentTrialStatus))
      .toContain("旧版 v2 仍可用")
    expect(developmentNextStep({ phase: "stopped" } as DevelopmentTrialStatus))
      .toContain("重启应用不会自动恢复")
    expect(developmentCapabilitySummary(["fs.write", "http.fetch", "model.complete"]).join(" "))
      .toMatch(/文件.*网络.*费用/)
  })

  it("asks for current authority without approving, executing, or exposing internal errors", () => {
    const row = { revision: 1, error: "SECRET_PRIVATE_PATH" } as DevelopmentTrialStatus
    const prompt = developmentRepairPrompt("天气悬框", row)
    expect(prompt).toContain("天气悬框")
    expect(prompt).toContain("先读取当前试用状态")
    expect(prompt).toContain("重新申请试用")
    expect(prompt).not.toContain("SECRET_PRIVATE_PATH")
  })
  it("targets the actual missing return instead of guessing a command collision", () => {
    const prompt = developmentRepairPrompt("天气与工具计数", {
      revision: 4, error: "MODS_RETURN_UNDEFINED"
    } as DevelopmentTrialStatus)
    expect(prompt).toContain("return next(event)")
    expect(prompt).toContain("最多尝试两次")
    expect(prompt).not.toContain("检查与已启用灵件的快捷指令是否重名")
  })
})
