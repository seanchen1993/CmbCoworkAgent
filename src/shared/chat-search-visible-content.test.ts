import { describe, expect, it } from "vitest"
import { projectVisibleChatSearchContent } from "./chat-search-visible-content"

describe("visible chat search content projection", () => {
  it("projects only visible block text without structural object keys", () => {
    const projected = projectVisibleChatSearchContent("assistant", [
      { type: "text", text: "first needle" },
      { type: "image", source: "hidden metadata" },
      { type: "tool_result", content: "hidden result needle" },
      { type: "text", text: "second needle" }
    ])

    expect(projected).toBe("first needle\nsecond needle")
    expect(projected).not.toContain("type")
    expect(projected).not.toContain("hidden result")
    expect(projected.match(/needle/g)).toHaveLength(2)
  })

  it("removes valid skill and browser transport while preserving user text", () => {
    const skillPayload = [
      "visible user needle",
      "",
      "<CMBDEVCLAW-SKILL-USE-V1>",
      "<instruction>hidden protocol needle</instruction>",
      "<name>demo-skill</name>",
      "<path>C:/skills/demo/SKILL.md</path>",
      "</CMBDEVCLAW-SKILL-USE-V1>"
    ].join("\n")
    expect(projectVisibleChatSearchContent("user", skillPayload)).toBe(
      "visible user needle"
    )
    expect(
      projectVisibleChatSearchContent(
        "user",
        "使用内置浏览器 browser_*工具（不允许使用截图功能）：visible browser needle"
      )
    ).toBe("visible browser needle")
  })

  it("matches the special Goal text mounted by MessageBubble", () => {
    expect(
      projectVisibleChatSearchContent(
        "user",
        "/goal ship release\n启动附件：report.md\n显式技能：release-check"
      )
    ).toBe("设为 Goal\nship release\n附件：report.md\n技能：release-check")
    expect(projectVisibleChatSearchContent("user", "/goal resume")).toBe(
      "继续 Goal\n从上次暂停处继续推进目标"
    )
  })

  it("matches restructured Goal system notices and cleans ordinary notices", () => {
    expect(projectVisibleChatSearchContent("system", "● Goal 已暂停：reason")).toBe(
      "Goal 已暂停\nreason"
    )
    expect(projectVisibleChatSearchContent("system", "● ordinary **notice**")).toBe(
      "ordinary notice"
    )
  })

  it("indexes only revealable head and tail for oversized completed Markdown", () => {
    const content = `head-token\n${"padding ".repeat(20_000)}middle-token${" padding".repeat(20_000)}\ntail-token`
    const projected = projectVisibleChatSearchContent("assistant", content)
    expect(projected).toContain("head-token")
    expect(projected).toContain("tail-token")
    expect(projected).not.toContain("middle-token")
  })
})
