function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function unescapeXml(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
}

/** Serialize a leading skill reference into a `<skill-ref>NAME</skill-ref>` tag. */
export function formatSkillRef(skillName: string): string {
  return `<skill-ref>${escapeXml(skillName)}</skill-ref>`
}

/**
 * Extract a leading `<skill-ref>name</skill-ref>` tag from a string.
 * Shared by both the model-facing payload and the UI-facing display content
 * so that history messages replayed from the checkpointer render the skill chip.
 */
export function parseSkillMarker(
  content: string
): { skillName: string; rest: string } | null {
  // Skill names never contain newlines or raw '<' (those get XML-escaped in formatSkillRef).
  // Keeping the character class tight prevents arbitrary user-typed text that happens to start
  // with a <skill-ref>…</skill-ref>-shaped string from spoofing a skill chip.
  const marker = content.match(/^<skill-ref>([^<\n]+)<\/skill-ref>\s*/)
  if (!marker) return null
  return { skillName: unescapeXml(marker[1]).trim(), rest: content.slice(marker[0].length) }
}
