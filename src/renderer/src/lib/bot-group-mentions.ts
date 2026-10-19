import type { BotGroupMention } from "../../../shared/bots/contracts"
export type { BotGroupMention } from "../../../shared/bots/contracts"

/** Attachment projection prepends file labels; keep only ranges whose visible token still matches. */
export function displayedGroupMentions(
  raw: string,
  display: string,
  mentions: readonly BotGroupMention[]
) {
  if (raw === display) return validGroupMentions(display, mentions)
  const body = raw.split("<attachment ", 1)[0].trimEnd()
  if (!body || !display.endsWith(body)) return []
  const offset = display.length - body.length
  return validGroupMentions(
    display,
    mentions
      .filter((mention) => mention.end <= body.length)
      .map((mention) => ({ ...mention, start: mention.start + offset, end: mention.end + offset }))
  )
}

export function rebaseGroupMentions(
  previous: string,
  next: string,
  mentions: readonly BotGroupMention[]
): BotGroupMention[] {
  if (previous === next) return [...mentions]
  let start = 0
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++
  let oldEnd = previous.length,
    newEnd = next.length
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  const delta = newEnd - oldEnd
  return mentions.flatMap((mention) => {
    // Editing any part of a mention removes its authority; untouched ranges keep their IDs.
    if (mention.end <= start) return [mention]
    if (mention.start >= oldEnd)
      return [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
    return []
  })
}

export function groupMentionQuery(
  text: string,
  caret: number,
  mentions: readonly BotGroupMention[]
) {
  if (mentions.some((mention) => caret > mention.start && caret <= mention.end)) return null
  const match = text.slice(0, caret).match(/(?:^|\s)@([^@\n]{0,80})$/u)
  if (!match) return null
  const start = caret - match[1].length - 1
  if (mentions.some((mention) => start >= mention.start && start < mention.end)) return null
  return { start, end: caret, query: match[1] }
}

export function insertGroupMention(
  text: string,
  range: { start: number; end: number },
  mentions: readonly BotGroupMention[],
  botId: string | null,
  label: string
) {
  const token = `@${label}`
  const next = text.slice(0, range.start) + token + " " + text.slice(range.end)
  const mention = { start: range.start, end: range.start + token.length, botId, label }
  return {
    text: next,
    mentions: [...rebaseGroupMentions(text, next, mentions), mention].sort(
      (a, b) => a.start - b.start
    ),
    caret: mention.end + 1
  }
}

export function validGroupMentions(text: string, mentions: readonly BotGroupMention[]) {
  let end = 0
  return mentions.filter((mention) => {
    if (
      mention.start < end ||
      mention.end > text.length ||
      mention.end <= mention.start ||
      text.slice(mention.start, mention.end) !== `@${mention.label}`
    )
      return false
    end = mention.end
    return true
  })
}

export function groupMentionRecipients(
  mentions: readonly BotGroupMention[],
  memberIds: readonly string[]
) {
  // Do not silently redirect a draft when an explicitly mentioned member was removed.
  if (mentions.some((mention) => mention.botId !== null && !memberIds.includes(mention.botId)))
    return { ids: [] as string[], error: "提及的 Bot 已不在本群，请移除该提及后重新选择。" }
  if (mentions.some((mention) => mention.botId === null))
    return { ids: [...memberIds], error: null }
  return {
    ids: [...new Set(mentions.flatMap((mention) => (mention.botId ? [mention.botId] : [])))],
    error: null
  }
}

/** Grok sends replies to the quoted author as well as explicitly selected members. */
export function groupMessageRecipients(
  mentions: readonly BotGroupMention[],
  memberIds: readonly string[],
  {
    targets = null,
    replyAuthorId = null
  }: { targets?: string[] | null; replyAuthorId?: string | null } = {}
) {
  const mentioned = groupMentionRecipients(mentions, memberIds)
  if (mentioned.error) return mentioned
  if (replyAuthorId && !memberIds.includes(replyAuthorId))
    return { ids: [], error: "被回复的 Bot 已不在本群，请取消回复后重新发送。" }
  const selected = mentions.length
    ? mentioned.ids
    : targets !== null
      ? targets.filter((id) => memberIds.includes(id))
      : replyAuthorId
        ? []
        : memberIds
  return {
    ids: [...new Set([...selected, ...(replyAuthorId ? [replyAuthorId] : [])])],
    error: null
  }
}
