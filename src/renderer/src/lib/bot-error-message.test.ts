import { describe, expect, it } from "vitest"
import { botErrorMessage } from "./bot-error-message"

describe("Bot error presentation", () => {
  it("keeps the recovery instruction from a rejected IPC operation", () => {
    expect(
      botErrorMessage(
        new Error(
          "Error invoking remote method 'bots:update': BotError: 请先停止当前任务，再修改 Bot"
        )
      )
    ).toBe("请先停止当前任务，再修改 Bot")
  })
  it("handles native errors and string errors while retaining meaningful diagnostic context", () => {
    expect(botErrorMessage("Error: 文件已被移动，请重新选择")).toBe("文件已被移动，请重新选择")
    expect(botErrorMessage(new Error("ENOENT: /workspace/report.csv"))).toBe(
      "ENOENT: /workspace/report.csv"
    )
    expect(botErrorMessage(new Error("工具返回 BotError: 结果未知"))).toBe(
      "工具返回 BotError: 结果未知"
    )
  })
  it("uses the caller's fallback for absent or empty messages", () => {
    expect(botErrorMessage(null, "无法读取群消息")).toBe("无法读取群消息")
    expect(botErrorMessage(new Error("  "), "保存失败")).toBe("保存失败")
  })
})
