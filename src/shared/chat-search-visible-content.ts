import { isGoalClearAlias, isGoalResumeDisplayText } from "./goal-slash"
import { projectMarkdownVisibleText, type MarkdownSearchProjection } from "./markdown-visible-text"
import { buildStreamingMarkdownPreview } from "./streaming-markdown-preview"
import { getSystemNoticePresentation, projectGoalNoticeVisibleText, systemNoticeBlockText } from "./goal-notice-presentation"
import { parseSkillUseBlock } from "./skill-use-block"
import { createChatSearchPlan } from "./chat-search-plan"
import {
  BOT_BROWSER_PROMPT_PREFIX,
  stripBuiltinBrowserInstructions,
  stripLegacyBuiltinBrowserInstructions
} from "./user-input-transport"

export const MAX_EXPANDED_CHAT_SEARCH_TEXT_CHARS = 256 * 1024
interface ChatSearchProjectionOptions {
  /** Includes bounded folded fragments, exposed using a search context rather than full rendering. */
  includeFoldedContent?: boolean
}

function projectSystemNoticeSearchText(text: string, trackSource = false): MarkdownSearchProjection {
  const notice = getSystemNoticePresentation(text)
  const goalNotice = projectGoalNoticeVisibleText(notice.text)
  if (goalNotice) return { text: goalNotice, truncated: false }
  return projectMarkdownVisibleText(notice.text, trackSource)
}

function parseUserTransportText(content: string): {
  visibleText: string
  skillName: string
  browserSelected: boolean
} {
  const skill = parseSkillUseBlock(content)
  let visibleText = skill?.rest ?? content
  const skillName = skill?.skillName ?? ""

  let browserSelected = false
  const wrappedText = stripBuiltinBrowserInstructions(visibleText)
  if (wrappedText !== null) {
    browserSelected = true
    visibleText = wrappedText
  } else if (visibleText.startsWith(BOT_BROWSER_PROMPT_PREFIX)) {
    browserSelected = true
    visibleText = visibleText.slice(BOT_BROWSER_PROMPT_PREFIX.length)
  } else {
    const legacyText = stripLegacyBuiltinBrowserInstructions(visibleText)
    if (legacyText !== null) {
      browserSelected = true
      visibleText = legacyText
    }
  }

  return { visibleText, skillName, browserSelected }
}

function projectGoalUserText(content: string): string | null {
  if (isGoalResumeDisplayText(content)) return "继续 Goal\n从上次暂停处继续推进目标"
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const firstLine = lines[0] ?? ""
  const match = firstLine.match(/^\/goal\b\s*(.*)$/i)
  if (!match) return null
  const rest = (match[1] ?? "").trim()
  const normalized = rest.toLowerCase()
  if (!rest || ["status", "pause", "resume"].includes(normalized) || isGoalClearAlias(normalized)) {
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
  if (role === "system" && !options.includeFoldedContent) {
    const text = Array.isArray(content) ? content.map(systemNoticeBlockText).filter(Boolean).join("\n") : content
    return projectSystemNoticeSearchText(typeof text === "string" ? text : "")
  }
  if (options.includeFoldedContent) {
    const plan = createChatSearchPlan(role, content)
    const segments = plan.segments.map((segment) => projectChatSearchFragment(role, segment.raw))
    return {
      text: segments.map((segment) => segment.text).join("\n"),
      truncated: plan.truncated || segments.some((segment) => segment.truncated)
    }
  }
  if (!Array.isArray(content)) {
    const text = typeof content === "string" ? content : ""
    if (role !== "user") {
      const bounded = buildStreamingMarkdownPreview(text)
      const parts = [bounded.head, bounded.tail].filter(Boolean).map((text) => projectMarkdownVisibleText(text))
      return {
        text: parts.map((part) => part.text).join("\n"),
        truncated: bounded.omittedCharacters > 0 || parts.some((part) => part.truncated)
      }
    }
    const projected = parseUserTransportText(text).visibleText
    return { text: projectGoalUserText(projected) ?? projected, truncated: false }
  }

  const blocks = content.flatMap((block) => {
    if (!block || typeof block !== "object") return []
    const record = block as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string") return [record.text]
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
export function projectChatSearchFragment(role: string, text: string, trackSource = false): MarkdownSearchProjection {
  if (role === "system") return projectSystemNoticeSearchText(text, trackSource)
  if (role === "user") {
    const visible = parseUserTransportText(text).visibleText
    return { text: projectGoalUserText(visible) ?? visible, truncated: false }
  }
  return projectMarkdownVisibleText(text, trackSource)
}

export function projectChatSearchUserBlocks(blocks: readonly string[]): string {
  const visible = blocks.map((block) => parseUserTransportText(block).visibleText).join("\n")
  return projectGoalUserText(visible) ?? visible
}
