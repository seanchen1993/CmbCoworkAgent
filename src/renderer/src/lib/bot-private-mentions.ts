import type { BotMessageMention, BotTaskOrigin } from "../../../shared/bots/contracts"
import { parseBotMessageMentions } from "../../../shared/bots/message-mentions"
import { parseBotMessageReply } from "../../../shared/bots/message-reply"
import { BOT_BROWSER_PROMPT_PREFIX } from "../../../shared/user-input-transport"
import { cleanUserAttachmentContentForDisplay } from "../../../shared/user-attachment-display"
import { parseSkillUseBlock } from "../features/slash-commands/skill-marker"
import { parseUserVisibleBuiltinBrowserContent } from "../features/builtin-browser/chat-integration"

type Projection = { text: string; mentions: BotMessageMention[] }
const attachmentLabels = (text: string) => /^(?:📎[^\n]*\n)+(?:\n)?/u.exec(text)?.[0] ?? ""

/** Only remove known transport spans. An identity intersecting removed data cannot be displayed. */
function remove(projection: Projection, start: number, end: number): Projection | null {
  if (projection.mentions.some((mention) => mention.start < end && mention.end > start)) return null
  return {
    text: projection.text.slice(0, start) + projection.text.slice(end),
    mentions: projection.mentions.map((mention) =>
      mention.start >= end
        ? { ...mention, start: mention.start - (end - start), end: mention.end - (end - start) }
        : mention
    )
  }
}

function cleanAttachments(projection: Projection): Projection | null {
  const cleaned = cleanUserAttachmentContentForDisplay(projection.text)
  if (cleaned === projection.text) return projection
  const matches = [
    ...projection.text.matchAll(/<attachment\s+filename="([^"]*)"[^>]*>[\s\S]*?<\/attachment>/g)
  ]
  let current: Projection | null = projection
  for (const match of matches.reverse()) {
    current = remove(current!, match.index!, match.index! + match[0].length)
    if (!current) return null
  }
  const leading = current.text.length - current.text.trimStart().length
  current = remove(current, 0, leading)
  if (!current) return null
  current = remove(current, current.text.trimEnd().length, current.text.length)
  if (!current || !cleaned.endsWith(current.text)) return null
  const prefix = cleaned.length - current.text.length
  return {
    text: cleaned,
    mentions: current.mentions.map((mention) => ({
      ...mention,
      start: mention.start + prefix,
      end: mention.end + prefix
    }))
  }
}

function project(projection: Projection, origin: Extract<BotTaskOrigin, { kind: "user" }>) {
  let current = cleanAttachments(projection)
  if (!current) return null
  if (origin.replyTo) {
    const parsed = parseBotMessageReply(current.text)
    if (
      !parsed ||
      parsed.reply.id !== origin.replyTo.id ||
      parsed.reply.ordinal !== origin.replyTo.ordinal ||
      parsed.reply.role !== origin.replyTo.role
    )
      return null
    const labels = attachmentLabels(current.text)
    const body = current.text.slice(labels.length)
    const prefix =
      labels.length +
      (body.startsWith(BOT_BROWSER_PROMPT_PREFIX) ? BOT_BROWSER_PROMPT_PREFIX.length : 0)
    const removed = current.text.length - parsed.message.length
    current = remove(current, prefix, prefix + removed)
    if (!current || current.text !== parsed.message) return null
  }
  const skill = parseSkillUseBlock(current.text)
  if (skill) {
    if (!current.text.startsWith(skill.rest)) return null
    current = remove(current, skill.rest.length, current.text.length)
    if (!current) return null
  }
  const browser = parseUserVisibleBuiltinBrowserContent(current.text)
  if (browser.visibleText !== current.text) {
    const removed = current.text.length - browser.visibleText.length
    current = remove(current, 0, removed)
    if (!current || current.text !== browser.visibleText) return null
  }
  return current
}

function projectMentions(
  origin: BotTaskOrigin | undefined,
  nativeContent: string,
  visibleText: string
): { mentions: BotMessageMention[]; reason?: "projection-mismatch" | "ambiguous-projection" } {
  if (origin?.kind !== "user" || !origin.mentions?.length) return { mentions: [] }
  // Native hydration can prepend attachment labels. Test only these two known coordinate spaces.
  const prefix = attachmentLabels(nativeContent).length
  const offsets = prefix ? [0, prefix] : [0]
  const results = new Map<string, BotMessageMention[]>()
  for (const offset of offsets) {
    try {
      const mentions = parseBotMessageMentions(
        nativeContent,
        origin.mentions.map((mention) => ({
          ...mention,
          start: mention.start + offset,
          end: mention.end + offset
        }))
      )
      const projected = project({ text: nativeContent, mentions }, origin)
      if (!projected || projected.text !== visibleText) continue
      const verified = parseBotMessageMentions(visibleText, projected.mentions)
      results.set(JSON.stringify(verified), verified)
    } catch {
      // Keep the host identity intact; an unknown display projection must remain plain text.
    }
  }
  if (results.size !== 1)
    return { mentions: [], reason: results.size ? "ambiguous-projection" : "projection-mismatch" }
  return { mentions: [...results.values()][0] }
}

/** Map only host-verified identities through known hydration/display transforms, never search names. */
export function projectPrivateBotMentions(
  origin: BotTaskOrigin | undefined,
  nativeContent: string,
  visibleText: string
) {
  return projectMentions(origin, nativeContent, visibleText)
}
