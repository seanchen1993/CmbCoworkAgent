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

export function isGoalResumeDisplayText(text: string): boolean {
  return /^\/goal\s+resume$/i.test(text.trim())
}

export const GOAL_SKILL_OPEN_TAG = "<CMBDEVCLAW-SKILL-USE-V1>"
export const GOAL_SKILL_CLOSE_TAG = "</CMBDEVCLAW-SKILL-USE-V1>"

function findAttachmentTransportStart(input: string): number {
  // TODO(goal-transport): This is a legacy text-framing fallback. A user-authored
  // literal attachment XML block at the very end of a /goal message is still
  // indistinguishable from renderer-appended transport. Prefer a structured
  // renderer->main prompt envelope or a private transport tag in a future pass.
  const openTags = Array.from(input.matchAll(/<attachment\b/gi), (tag) => tag.index)
  if (!openTags.length) return -1
  const tagEnds = Array.from(input.matchAll(/>/g), (tag) => tag.index)
  const closeTags = Array.from(input.matchAll(/<\/attachment>/gi), (tag) => tag.index)
  const validStarts = new Set<number>()
  const nextTextByClose = new Map<number, number>()
  const nextText = /\S/g
  const whitespace = /\s/
  const closeTagLength = "</attachment>".length
  let nextTagEnd = tagEnds.length
  let nextCloseTag = closeTags.length
  let transportStart = -1

  // A block can close at the first matching end tag. It forms a transport
  // suffix only when everything after it is whitespace or another valid block.
  for (let index = openTags.length - 1; index >= 0; index -= 1) {
    const open = openTags[index]
    while (nextTagEnd > 0 && tagEnds[nextTagEnd - 1] > open) nextTagEnd -= 1
    const end = tagEnds[nextTagEnd]
    if (end === undefined) continue
    while (nextCloseTag > 0 && closeTags[nextCloseTag - 1] > end) nextCloseTag -= 1
    const close = closeTags[nextCloseTag]
    if (close === undefined) continue
    let following = nextTextByClose.get(close)
    if (following === undefined) {
      nextText.lastIndex = close + closeTagLength
      following = nextText.exec(input)?.index ?? input.length
      nextTextByClose.set(close, following)
    }
    if (following !== input.length && !validStarts.has(following)) continue
    validStarts.add(open)

    let newlines = 0
    let firstNewline = open
    for (let offset = open - 1; offset >= 0 && whitespace.test(input[offset]); offset -= 1) {
      if (input[offset] === "\n") {
        newlines += 1
        firstNewline = offset
      }
    }
    if (newlines >= 2) transportStart = firstNewline
  }
  return transportStart
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
