import type { BotGroupMention } from "../../shared/bots/contracts"

/** Bind new Bot replies to current room identities once; routing uses IDs, never these labels. */
export function bindBotGroupMentions(
  text: string,
  members: readonly { id: string; name: string }[]
): BotGroupMention[] {
  // Grok/Hermes resolve room @handles. Presentation uses exact full names here:
  // ambiguous names remain text, and later renames cannot retarget a stored ID.
  const identities = new Map<string, string | null>()
  for (const { id, name } of members) {
    if (!name) continue
    identities.set(name, identities.has(name) && identities.get(name) !== id ? null : id)
  }
  const names = [...identities.keys()].sort((a, b) => b.length - a.length)
  const isHandleChar = (char: string | undefined) => !!char && /[a-zA-Z0-9_.@-]/.test(char)
  const mentions: BotGroupMention[] = []
  for (let start = text.indexOf("@"); start >= 0 && mentions.length < 128; ) {
    const everyone = !isHandleChar(text[start - 1])
      ? /^@(everyone|all|所有人)(?![a-zA-Z0-9_.@-])/i.exec(text.slice(start))
      : null
    if (everyone) {
      const end = start + everyone[0].length
      mentions.push({ start, end, botId: null, label: everyone[1] })
      start = text.indexOf("@", end)
      continue
    }
    const label = !isHandleChar(text[start - 1])
      ? names.find(
          (name) => text.startsWith(name, start + 1) && !isHandleChar(text[start + name.length + 1])
        )
      : undefined
    const end = start + 1 + (label?.length ?? 0)
    const botId = label ? identities.get(label) : null
    if (label && botId) mentions.push({ start, end, botId, label })
    start = text.indexOf("@", end)
  }
  return mentions
}
