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

  const attachmentStart = text.search(/\n\s*<attachment\b/i)
  if (attachmentStart >= 0) {
    payloadParts.unshift(text.slice(attachmentStart).trim())
    text = text.slice(0, attachmentStart).trimEnd()
  }

  return { commandText: text, payload: payloadParts.filter(Boolean).join("\n\n") }
}
