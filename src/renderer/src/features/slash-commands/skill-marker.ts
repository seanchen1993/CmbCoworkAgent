/**
 * XML-escape a string for use inside the payload tags produced by submitMessage:
 * both the outer <skill-ref>NAME</skill-ref> prefix and the inner
 * <skill><name>NAME</name><path>PATH</path>...</skill> wrapper.
 *
 * IMPORTANT: the two call sites (skill-ref and <skill><name>/<path>) MUST use the same
 * escaping policy. If they drift, the backend anti-spoof regex in ipc/agent.ts — which
 * matches the <skill-ref>'s raw (escaped) form against the wrapper's <name> — will fail
 * for names containing ', causing silent usage-stats loss.
 */
export function escapeXmlAttr(s: string): string {
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

/**
 * Canonical regex for the `<skill-ref>NAME</skill-ref>` leading tag.
 * All readers/strippers in the renderer and main process use this same shape so the
 * protocol stays in sync — if you change the character class here, search the codebase
 * for this constant name to find every call site that must be updated together.
 *
 * Character class notes:
 *   - Rejects `<` so a real closing `</skill-ref>` is never accidentally matched as name
 *   - Rejects `\n` to keep the marker a single-line tag (renderer and main agree)
 *   - NOTE: the backend variant in ipc/agent.ts uses no trailing `\s*` (it only tests,
 *     never slices), so it re-declares this locally. Keep the char class identical there.
 */
export const SKILL_REF_PATTERN = /^<skill-ref>([^<\n]+)<\/skill-ref>\s*/

/**
 * Strip characters that would break the single-line `<skill-ref>` marker. Both this
 * prefix and the hidden `<skill><name>` wrapper must apply the same transformation —
 * otherwise the backend anti-spoof regex (which matches one against the other) would
 * fail for names containing literal CR/LF.
 */
export function sanitizeSkillName(skillName: string): string {
  // Also trim so a name that's nothing but whitespace doesn't round-trip through
  // <skill-ref>…</skill-ref> as an empty-looking chip. The backend separately rejects
  // empty names, but the UI benefits from consistency.
  return skillName.replace(/[\r\n]+/g, " ").trim()
}

/** Serialize a leading skill reference into a `<skill-ref>NAME</skill-ref>` tag. */
export function formatSkillRef(skillName: string): string {
  return `<skill-ref>${escapeXmlAttr(sanitizeSkillName(skillName))}</skill-ref>`
}

/**
 * Extract a leading `<skill-ref>name</skill-ref>` tag from a string.
 * Shared by both the model-facing payload and the UI-facing display content
 * so that history messages replayed from the checkpointer render the skill chip.
 *
 * NOTE: This is a pattern match, not an authenticity check. A user who manually types
 * `<skill-ref>NAME</skill-ref>` at the start of a chat message will pass this parser and
 * get a fake skill chip rendered. The cosmetic impact is accepted; the real execution
 * path (onExplicitInvocation in ipc/agent.ts) cross-checks against the hidden <skill>
 * wrapper so spoofed markers don't pollute usage stats or trigger skill evolution.
 */
export function parseSkillMarker(
  content: string
): { skillName: string; rest: string } | null {
  // Character class / anchor rules live in SKILL_REF_PATTERN.
  const marker = content.match(SKILL_REF_PATTERN)
  if (!marker) return null
  const skillName = unescapeXml(marker[1]).trim()
  // Reject empty / all-whitespace names: sending paths sanitize+trim so a legitimate
  // chip is never empty, but pasted history or malformed content shouldn't render a
  // naked pill with no label.
  if (!skillName) return null
  return { skillName, rest: content.slice(marker[0].length) }
}
