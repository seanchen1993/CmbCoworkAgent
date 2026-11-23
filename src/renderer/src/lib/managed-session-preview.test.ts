import { describe, expect, it } from "vitest"
import type { Message } from "../types"
import { formatSkillUseBlock } from "../../../shared/skill-use-block"
import { buildManagedSessionPreview } from "./managed-session-preview"

const message = (id: string, role: Message["role"], content: Message["content"]): Message => ({
  id,
  role,
  content,
  created_at: new Date(0)
})

describe("managed session history preview", () => {
  it("keeps user messages and assistant replies in conversation order, without tool or system messages", () => {
    const preview = buildManagedSessionPreview([
      message("system", "system", "内部系统消息"),
      message("user", "user", "检查现有实现"),
      message("tool", "tool", "很长的工具结果"),
      message("empty", "assistant", "  "),
      message("reply", "assistant", "检查完成，需要补充校验")
    ])
    expect(preview).toEqual([
      { id: "user", role: "user", content: "检查现有实现" },
      { id: "reply", role: "assistant", content: "检查完成，需要补充校验" }
    ])
  })

  it("reuses the existing display cleanup for skills, browser instructions and attachment bodies", () => {
    const skill = formatSkillUseBlock({
      name: "dev-code",
      path: "/skills/dev-code",
      description: "实现代码"
    })
    const preview = buildManagedSessionPreview([
      message(
        "user",
        "user",
        `使用内置浏览器 browser_*工具：检查登录\n<attachment filename="需求.md">很长的附件正文</attachment>\n${skill}`
      )
    ])
    expect(preview[0].content).toContain("检查登录")
    expect(preview[0].content).toContain("需求.md")
    expect(preview[0].content).not.toContain("附件正文")
    expect(preview[0].content).not.toContain("browser_*")
    expect(preview[0].content).not.toContain("SKILL-USE")
    expect(preview[0].content).not.toContain("/skills/dev-code")
  })

  it("only displays assistant answer text, while preserving literal skill examples in assistant replies", () => {
    const preview = buildManagedSessionPreview([
      message("reasoning", "assistant", "<think>内部推理</think>"),
      message("reply", "assistant", "<think>内部推理</think>已经完成校验"),
      message(
        "example",
        "assistant",
        "协议示例：<CMBDEVCLAW-SKILL-USE-V1>标签示例</CMBDEVCLAW-SKILL-USE-V1>"
      )
    ])
    expect(preview.map((item) => item.id)).toEqual(["reply", "example"])
    expect(preview[0].content).toBe("已经完成校验")
    expect(preview[1].content).toContain("<CMBDEVCLAW-SKILL-USE-V1>")
  })

  it("extracts text blocks without displaying image or other non-text payloads", () => {
    expect(
      buildManagedSessionPreview([
        message("reply", "assistant", [
          { type: "text", text: "第一段" },
          { type: "image", content: "non-text payload" },
          { type: "text", text: "第二段" }
        ])
      ])[0].content
    ).toBe("第一段\n第二段")
  })

  it("bounds the displayed history and long message text without changing the stored messages", () => {
    const input = Array.from({ length: 12 }, (_, index) =>
      message(String(index), "assistant", "答".repeat(8000))
    )
    const preview = buildManagedSessionPreview(input)
    expect(preview).toHaveLength(6)
    expect(preview.map((item) => item.id)).toEqual(["6", "7", "8", "9", "10", "11"])
    expect(preview.every((item) => item.content.length <= 4003 && item.content.endsWith("…"))).toBe(
      true
    )
    expect(input[0].content).toHaveLength(8000)
  })

  it("returns an empty preview when recent messages contain only internal activity", () => {
    expect(
      buildManagedSessionPreview([
        message("tool", "tool", "工具结果"),
        message("system", "system", "内部指令"),
        message("assistant", "assistant", [])
      ])
    ).toEqual([])
  })
})
