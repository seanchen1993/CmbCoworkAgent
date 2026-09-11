import { isGoalClearAlias } from "./goal-slash"
import { projectMarkdownVisibleText } from "./markdown-visible-text"
import { buildStreamingMarkdownPreview } from "./streaming-markdown-preview"
import { projectGoalNoticeVisibleText } from "./goal-notice-presentation"
import { SKILL_USE_TAG_NAME } from "./skill-use-block"
import { createChatSearchPlan } from "./chat-search-plan"
import {
  BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX,
  BUILTIN_BROWSER_PROMPT_PREFIX
} from "./user-input-transport"

const SKILL_OPEN = `<${SKILL_USE_TAG_NAME}>`
const SKILL_CLOSE = `</${SKILL_USE_TAG_NAME}>`
const BROWSER_PREFIX = BUILTIN_BROWSER_PROMPT_PREFIX
const BROWSER_NO_SCREENSHOT_PREFIX = BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX
const LEGACY_BROWSER_PREFIX =
  "使用内置浏览器 browser_*工具。仅当当前模型支持图片识别/视觉输入时，才允许调用截图工具；否则不要调用截图工具，改用 DOM 快照、文本、locator、evaluate 等非视觉方式："

export const MAX_EXPANDED_CHAT_SEARCH_TEXT_CHARS = 256 * 1024
interface ChatSearchProjectionOptions {
  /** Includes bounded folded fragments, exposed using a search context rather than full rendering. */
  includeFoldedContent?: boolean
}

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
  } else if (visibleText.startsWith(LEGACY_BROWSER_PREFIX)) {
    browserSelected = true
    visibleText = visibleText.slice(LEGACY_BROWSER_PREFIX.length)
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

/** Text mounted in a message's search region, or exposed there by expanding completed content. */
export function projectVisibleChatSearchContent(
  role: string,
  content: unknown,
  options: ChatSearchProjectionOptions = {}
): string {
  return projectVisibleChatSearchContentWithMetadata(role, content, options).text
}

export function projectVisibleChatSearchContentWithMetadata(
  role: string,
  content: unknown,
  options: ChatSearchProjectionOptions = {}
): { text: string; truncated: boolean } {
  if (options.includeFoldedContent) {
    const plan = createChatSearchPlan(role, content)
    return {
      text: plan.segments.map((segment) => projectChatSearchFragment(role, segment.raw)).join("\n"),
      truncated: plan.truncated
    }
  }
  if (!Array.isArray(content)) {
    const text = typeof content === "string" ? content : ""
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
      projectVisibleChatSearchContentWithMetadata(role, block, options)
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

/** A source fragment has already passed the message-wide admission budget. */
export function projectChatSearchFragment(role: string, text: string): string {
  if (role === "system") return projectSystemNoticeSearchText(text)
  if (role === "user") {
    const visible = parseUserTransportText(text).visibleText
    return projectGoalUserText(visible) ?? visible
  }
  return projectMarkdownVisibleText(text)
}

export function projectChatSearchUserBlocks(blocks: readonly string[]): string {
  const visible = blocks.map((block) => parseUserTransportText(block).visibleText).join("\n")
  return projectGoalUserText(visible) ?? visible
}
