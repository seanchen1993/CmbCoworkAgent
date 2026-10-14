import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { FunctionConversationTranscriptStamp } from "../../../shared/mods/v2/conversation-transcript"
import type { Message } from "../types"

vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
vi.mock("./thread-context", () => ({
  useThreadStateSelector: (
    _threadId: string | null,
    select: (state: { workspacePath: null; workspaceFiles: unknown[] }) => unknown
  ) => select({ workspacePath: null, workspaceFiles: [] })
}))
import { MessageBubble } from "../components/chat/MessageBubble"

const stamp = (messageType: "user" | "system"): FunctionConversationTranscriptStamp => ({
  conversationId: "actual-conversation", branchId: "actual-branch", uuid: "actual-row",
  sequence: 1, door: "note", messageType,
  ...(messageType === "user" ? { isMeta: true as const } : {}),
  origin: { kind: "plugin", name: "actual-component" }
})

function render(message: Message & { function_row?: FunctionConversationTranscriptStamp }): string {
  return renderToStaticMarkup(createElement(MessageBubble, {
    message, threadId: "thread", isLoading: false, isStreaming: false
  }))
}

describe("actual durable note and notice bubble branches", () => {
  it.each(["ordinary note", "/goal resume", "[Starting active goal]\nKEEP_LITERAL",
    "[[CMB_WORKFLOW_NOTIFICATION_V1:literal]]", "@literal.md /skill"])(
    "does not render a marked hidden note or infer a user command from %s", (content) => {
      const message = { id: "actual-row", role: "user" as const, content,
        created_at: new Date(1), function_row: stamp("user") }
      const before = JSON.stringify(message)
      expect(render(message)).toBe("")
      expect(JSON.stringify(message)).toBe(before)
    }
  )

  it.each(["Goal 已暂停：literal\n可用 /goal resume", "✓ Goal 已完成：literal",
    "● 当前没有 active goal。用 /goal resume", "**literal markdown** <private-tag>"])(
    "renders a marked notice as literal ordinary notification: %s", (content) => {
      const message = { id: "actual-row", role: "system" as const, content,
        created_at: new Date(1), function_row: stamp("system") }
      const before = JSON.stringify(message)
      const html = render(message)
      expect(html).toContain("liquid-glass-notice--info")
      expect(html).not.toContain("liquid-glass-notice--success")
      expect(html).not.toContain("liquid-glass-notice--warning")
      expect(html).not.toContain("lucide-flag")
      expect(html).not.toContain("<strong>")
      expect(html).not.toContain('font-mono text-xs leading-4')
      expect(html).toContain(content.replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;").replaceAll(">", "&gt;"))
      expect(JSON.stringify(message)).toBe(before)
    }
  )

  it("preserves the original unmarked Goal notice presentation", () => {
    const html = render({ id: "old-notice", role: "system",
      content: "Goal 已暂停：original\n可用 /goal resume", created_at: new Date(1) })
    expect(html).toContain("liquid-glass-notice--warning")
    expect(html).toContain("lucide-flag")
    expect(html).toContain("Goal 已暂停")
    expect(html).toContain("original")
    // The original single-line Goal parser returns its body before reading later lines.
    expect(html).not.toContain("/goal resume")
    expect(html).not.toContain("font-mono text-xs leading-4")
    expect(html).not.toContain("<button")
  })

  it("displays a canonical provider System side literally without creating Goal controls", () => {
    const functionRow: FunctionConversationTranscriptStamp = { ...stamp("system"),
      door: "tool-message", origin: { kind: "tool", tool: "actual_original_tool" } }
    const html = render({ id: "actual-row", role: "system",
      content: "Goal 已暂停\n暂停原因：provider System\n可用 /goal resume", created_at: new Date(1),
      function_row: functionRow })
    expect(html).toContain("liquid-glass-notice--info")
    expect(html).toContain("provider System")
    expect(html).toContain("/goal resume")
    expect(html).not.toContain("lucide-flag")
    expect(html).not.toContain("liquid-glass-notice--warning")
    expect(html).not.toContain("font-mono")
    expect(html).not.toContain("<button")
  })

  it("retains the original multiline Goal command badges without adding action buttons", () => {
    const html = render({ id: "old-notice", role: "system",
      content: "Goal 已暂停\n暂停原因：original\n可用 /goal resume", created_at: new Date(1) })
    expect(html).toContain("liquid-glass-notice--warning")
    expect(html).toContain("lucide-flag")
    expect(html).toContain("暂停原因")
    expect(html).toContain("original")
    expect(html).toContain("/goal resume")
    expect(html).toContain("font-mono text-xs leading-4")
    expect(html).not.toContain("<button")
  })

  it.each(["bad-marker", "wrong-uuid", "wrong-role"])(
    "shows a safe invalid-record notice without exposing body/Goal actions: %s", (kind) => {
      const message: Message = { id: kind === "wrong-uuid" ? "foreign" : "actual-row",
        role: kind === "wrong-role" ? "assistant" : "user", content: "UNVERIFIED /goal resume",
        created_at: new Date(1), function_row: stamp("user"),
        ...(kind === "bad-marker" ? { function_row_invalid: true } : {}) }
      const html = render(message)
      expect(html).toContain("这条插件会话记录无法验证")
      expect(html).not.toContain("UNVERIFIED")
      expect(html).not.toContain("lucide-flag")
    }
  )
})
