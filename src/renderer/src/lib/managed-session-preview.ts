import type { Message } from "../types"
import { stripSkillUseBlockForDisplay } from "../../../shared/skill-use-block"
import { stripThinkBlocksForDisplay } from "../../../shared/think-block-display"
import { cleanUserAttachmentContentForDisplay } from "../../../shared/user-attachment-display"
import { stripBuiltinBrowserPrompt } from "../features/builtin-browser/chat-integration"

export const MANAGED_SESSION_PREVIEW_PAGE_OPTIONS = { limit: 32, byteBudget: 128 * 1024 }
const PREVIEW_MESSAGE_LIMIT = 6
const PREVIEW_TEXT_LIMIT = 4000

export interface ManagedSessionPreviewMessage {
  id: string
  role: "user" | "assistant"
  content: string
}

export function buildManagedSessionPreview(messages: Message[]): ManagedSessionPreviewMessage[] {
  const preview: ManagedSessionPreviewMessage[] = []
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue
    let content =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text || "")
            .join("\n")
    if (message.role === "user") {
      content = stripSkillUseBlockForDisplay(content)?.rest ?? content
      content = cleanUserAttachmentContentForDisplay(stripBuiltinBrowserPrompt(content))
    } else {
      content = stripThinkBlocksForDisplay(content)
    }
    content = content.trim()
    if (!content) continue
    preview.push({
      id: message.id,
      role: message.role,
      content:
        content.length > PREVIEW_TEXT_LIMIT
          ? `${content.slice(0, PREVIEW_TEXT_LIMIT)}\n\n…`
          : content
    })
  }
  return preview.slice(-PREVIEW_MESSAGE_LIMIT)
}
