export const GOAL_CLEAR_ALIASES = [
  "clear",
  "stop",
  "off",
  "reset",
  "none",
  "cancel"
] as const

export function isGoalClearAlias(value: string): boolean {
  return GOAL_CLEAR_ALIASES.includes(value as (typeof GOAL_CLEAR_ALIASES)[number])
}

export const GOAL_SKILL_OPEN_TAG = "<CMBDEVCLAW-SKILL-USE-V1>"
export const GOAL_SKILL_CLOSE_TAG = "</CMBDEVCLAW-SKILL-USE-V1>"

function consumeAttachmentBlock(input: string): number {
  const open = input.match(/^<attachment\b[^>]*>/i)
  if (!open) return 0
  const closeTag = "</attachment>"
  const closeIndex = input.toLowerCase().indexOf(closeTag, open[0].length)
  if (closeIndex < 0) return 0
  return closeIndex + closeTag.length
}

function isCompleteAttachmentTransportSuffix(input: string): boolean {
  let rest = input.trim()
  let consumedAny = false
  while (rest) {
    const consumed = consumeAttachmentBlock(rest)
    if (consumed <= 0) return false
    consumedAny = true
    rest = rest.slice(consumed).trim()
  }
  return consumedAny
}

function findAttachmentTransportStart(input: string): number {
  // TODO(goal-transport): This is a legacy text-framing fallback. A user-authored
  // literal attachment XML block at the very end of a /goal message is still
  // indistinguishable from renderer-appended transport. Prefer a structured
  // renderer->main prompt envelope or a private transport tag in a future pass.
  const pattern = /\n\s*\n\s*<attachment\b/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input))) {
    const suffix = input.slice(match.index).trim()
    if (isCompleteAttachmentTransportSuffix(suffix)) return match.index
  }
  return -1
}

export function splitGoalTransportPayload(input: string): {
  commandText: string
  payload: string
} {
  let text = input.trim()
  const payloadParts: string[] = []
  const skillOpen = text.lastIndexOf(GOAL_SKILL_OPEN_TAG)
  const skillClose = text.lastIndexOf(GOAL_SKILL_CLOSE_TAG)
  if (
    skillOpen >= 0 &&
    skillClose > skillOpen &&
    text.slice(skillClose + GOAL_SKILL_CLOSE_TAG.length).trim() === ""
  ) {
    payloadParts.unshift(text.slice(skillOpen).trim())
    text = text.slice(0, skillOpen).trimEnd()
  }

  const attachmentStart = findAttachmentTransportStart(text)
  if (attachmentStart >= 0) {
    payloadParts.unshift(text.slice(attachmentStart).trim())
    text = text.slice(0, attachmentStart).trimEnd()
  }

  return { commandText: text, payload: payloadParts.filter(Boolean).join("\n\n") }
}
