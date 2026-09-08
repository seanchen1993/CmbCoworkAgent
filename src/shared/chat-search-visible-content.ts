import { coordinatorTranscriptContentToText } from "./internal-notification-turn"
import { isGoalClearAlias } from "./goal-slash"
import { projectMarkdownVisibleText } from "./markdown-visible-text"
import { buildStreamingMarkdownPreview } from "./streaming-markdown-preview"
import { projectGoalNoticeVisibleText } from "./goal-notice-presentation"

const SKILL_OPEN = "<CMBDEVCLAW-SKILL-USE-V1>"
const SKILL_CLOSE = "</CMBDEVCLAW-SKILL-USE-V1>"
const BROWSER_PREFIX = "使用内置浏览器 browser_*工具："
const BROWSER_NO_SCREENSHOT_PREFIX = "使用内置浏览器 browser_*工具（不允许使用截图功能）："

function projectSystemNoticeSearchText(text: string): string {
  const clean = text.replace(/^●\s*/, "").replace(/^(?:✓|Ⅱ)\s*/, "")
  const goalNotice = projectGoalNoticeVisibleText(text)
  if (goalNotice) return goalNotice
  return projectMarkdownVisibleText(clean)
}

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
}

function parseUserTransportText(content: string): {
  visibleText: string
  skillName: string
  browserSelected: boolean
} {
  let visibleText = content
  let skillName = ""
  const closeAt = visibleText.lastIndexOf(SKILL_CLOSE)
  const openAt = closeAt < 0 ? -1 : visibleText.lastIndexOf(SKILL_OPEN, closeAt)
  if (
    openAt >= 0 &&
    closeAt > openAt &&
    visibleText.slice(closeAt + SKILL_CLOSE.length).trim() === ""
  ) {
    const block = visibleText.slice(openAt, closeAt + SKILL_CLOSE.length)
    const name = block.match(/<name>\s*([^<]*)\s*<\/name>/)?.[1]
    const path = block.match(/<path>\s*([^<]*)\s*<\/path>/)?.[1]
    if (name && path) {
      skillName = unescapeXml(name).trim()
      visibleText = visibleText.slice(0, openAt).trimEnd()
    }
  }

  let browserSelected = false
  if (visibleText.startsWith(BROWSER_NO_SCREENSHOT_PREFIX)) {
    browserSelected = true
    visibleText = visibleText.slice(BROWSER_NO_SCREENSHOT_PREFIX.length)
  } else if (visibleText.startsWith(BROWSER_PREFIX)) {
    browserSelected = true
    visibleText = visibleText.slice(BROWSER_PREFIX.length)
  }

  return { visibleText, skillName, browserSelected }
}

function projectGoalUserText(content: string): string | null {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const firstLine = lines[0] ?? ""
  const match = firstLine.match(/^\/goal\b\s*(.*)$/i)
  if (!match) return null
  const rest = (match[1] ?? "").trim()
  const normalized = rest.toLowerCase()
  if (normalized === "resume") return "继续 Goal\n从上次暂停处继续推进目标"
  if (!rest || ["status", "pause"].includes(normalized) || isGoalClearAlias(normalized)) {
    return null
  }

  const objective: string[] = [rest]
  let attachments = ""
  let skill = ""
  for (const line of lines.slice(1)) {
    const attachmentMatch = line.match(/^启动附件[：:]\s*(.+)$/)
    if (attachmentMatch) {
      attachments = attachmentMatch[1]?.trim() ?? ""
      continue
    }
    const skillMatch = line.match(/^显式技能[：:]\s*(.+)$/)
    if (skillMatch) {
      skill = skillMatch[1]?.trim() ?? ""
      continue
    }
    objective.push(line)
  }
  return [
    "设为 Goal",
    objective.join("\n").trim(),
    attachments ? `附件：${attachments}` : "",
    skill ? `技能：${skill}` : ""
  ]
    .filter(Boolean)
    .join("\n")
}

/** Text actually mounted inside a message's `data-chat-search-text` content region. */
export function projectVisibleChatSearchContent(role: string, content: unknown): string {
  return projectVisibleChatSearchContentWithMetadata(role, content).text
}

export function projectVisibleChatSearchContentWithMetadata(
  role: string,
  content: unknown
): { text: string; truncated: boolean } {
  if (!Array.isArray(content)) {
    const text = coordinatorTranscriptContentToText(content)
    if (role === "system") return { text: projectSystemNoticeSearchText(text), truncated: false }
    if (role !== "user") {
      const bounded = buildStreamingMarkdownPreview(text)
      return {
        text: [bounded.head, bounded.tail].filter(Boolean).map(projectMarkdownVisibleText).join("\n"),
        truncated: bounded.omittedCharacters > 0
      }
    }
    const projected = parseUserTransportText(text).visibleText
    return { text: projectGoalUserText(projected) ?? projected, truncated: false }
  }

  const blocks = content.flatMap((block) => {
        if (!block || typeof block !== "object") return []
        const record = block as Record<string, unknown>
        if (record.type === "text" && typeof record.text === "string") return [record.text]
        // MessageBubble only renders `content` fallbacks for system notices.
        if (role === "system" && typeof record.content === "string") return [record.content]
        return []
      })
  if (role !== "user") {
    const projectedBlocks = blocks.map((block) =>
      projectVisibleChatSearchContentWithMetadata(role, block)
    )
    return {
      text: projectedBlocks.map((block) => block.text).join("\n"),
      truncated: projectedBlocks.some((block) => block.truncated)
    }
  }
  const projected = blocks.map(parseUserTransportText)
  const visibleText = projected.map((block) => block.visibleText).join("\n")
  const goalText = projectGoalUserText(visibleText)
  if (goalText) return { text: goalText, truncated: false }
  return { text: visibleText, truncated: false }
}
