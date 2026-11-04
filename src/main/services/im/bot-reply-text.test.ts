import { describe, expect, it } from "vitest"
import { botImReplyText } from "./bot-reply-text"

describe("Bot IM file presentation", () => {
  it.each([
    String.raw`C:\Users\alice\.cmbcoworkagent\bots\workspaces\bot-id\hello.txt`,
    "C:/Users/alice/.cmbcoworkagent/bots/workspaces/bot-id/hello.txt",
    String.raw`C:\\Users\\alice\\.cmbcoworkagent\\bots\\workspaces\\bot-id\\hello.txt`,
    "/Users/alice/.cmbcoworkagent/bots/workspaces/bot-id/hello.txt",
    "/home/alice/.cmbcoworkagent/bots/workspaces/bot-id/hello.txt",
    "file:///C:/Users/alice/.cmbcoworkagent/bots/workspaces/bot-id/hello.txt",
    "file:///Users/alice/.cmbcoworkagent/bots/workspaces/bot-id/hello.txt",
    "file://desktop/share/workspace/hello.txt",
    String.raw`\\desktop\share\workspace\hello.txt`
  ])("keeps only the filename in a reply with no attachment in this round: %s", (path) => {
    expect(botImReplyText(`已创建：\`${path}\`，请查看附件。`)).toBe(
      "已创建：`hello.txt`，请查看附件。"
    )
    expect(botImReplyText(`已创建：${path}，请查看附件。`)).toBe("已创建：hello.txt，请查看附件。")
    expect(botImReplyText(`Created ${path}. Done.`)).toBe("Created hello.txt. Done.")
    expect(botImReplyText(`Location:${path}`)).toBe("Location:hello.txt")
  })

  it("retains names with spaces while removing source paths, cache paths and Markdown destinations", () => {
    const file = {
      name: "核验 报告.docx",
      size: 10,
      filePath: String.raw`D:\runtime\bots\id\核验 报告.docx`,
      attachmentPath: String.raw`D:\runtime\bots\id\.bot-deliveries\hash\核验 报告.docx`
    }
    const text = `位置：${file.filePath}\n副本：\`${file.attachmentPath}\`\n[打开报告](file:///D:/runtime/bots/id/%E6%A0%B8%E9%AA%8C%20%E6%8A%A5%E5%91%8A.docx)`
    expect(botImReplyText(text, [file])).toBe(
      "位置：核验 报告.docx\n副本：`核验 报告.docx`\n打开报告"
    )
    expect(file.attachmentPath).toContain(".bot-deliveries")
  })

  it("removes custom runtime roots and plain directories without treating API routes as host paths", () => {
    expect(
      botImReplyText(
        "工作目录：/mnt/custom-runtime/bots/id\n文件：/mnt/custom-runtime/bots/id/a.md",
        [],
        ["/mnt/custom-runtime"]
      )
    ).toBe("工作目录：本机目录\n文件：a.md")
    const text =
      "接口 /api/v1/tasks，相对路径 docs/hello.txt。参考 https://docs.example/home/alice/help 和 [文档](https://docs.example/Users/alice/hello.txt)。"
    expect(botImReplyText(text)).toBe(text)
  })

  it("does not rewrite web links containing a delivered path or claim a successful send", () => {
    const file = { name: "a.txt", size: 3, filePath: "/Users/alice/a.txt" }
    const text = "上传失败，尚未发送。参考 https://example.test/Users/alice/a.txt"
    expect(botImReplyText(text, [file])).toBe(text)
    expect(botImReplyText("文件仍在处理。")).toBe("文件仍在处理。")
  })
})
