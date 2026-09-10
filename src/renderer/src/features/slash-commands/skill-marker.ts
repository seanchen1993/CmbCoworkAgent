/**
 * Protocol for slash-command skill invocations — v2 (simplified).
 *
 * We emit ONE tag pair at the END of the user message:
 *
 *   <CMBDEVCLAW-SKILL-USE-V1>
 *     <instruction>
 *     请先使用 read 工具读取 <path> 指定的 SKILL.md ...
 *     </instruction>
 *     <name>skill-name</name>
 *     <path>/abs/path/to/SKILL.md</path>
 *   </CMBDEVCLAW-SKILL-USE-V1>
 *
 * No SKILL.md body inlined — the model is told to read the file via the `read`
 * tool. That deliberately collapses v1's two-tag protocol (<skill-invocation-
 * instruction> + <skill>body</skill>) into one block, and skips all the
 * body-defuse / anti-spoof machinery v1 needed.
 *
 * Tag name is deliberately "loud" (ALL-CAPS, project-branded, versioned):
 *   - Doesn't collide with HTML/Markdown the user might actually type.
 *   - Versioned so a future v2 can coexist without silent misparse.
 *   - Main process recognizes this marker to activate run-scoped skill hooks,
 *     while still forwarding the full wrapped payload so the model reads the
 *     selected SKILL.md via read_file.
 */

export { formatSkillUseBlock } from "../../../../shared/skill-use-block"

const TAG_NAME = "CMBDEVCLAW-SKILL-USE-V1"

/**
 * Reverse of escapeXml, but also tolerant of `&quot;` / `&apos;` so any future
 * producer that escapes more aggressively still round-trips cleanly.
 */
function unescapeXml(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
}

/**
 * Locate the trailing `<CMBDEVCLAW-SKILL-USE-V1>…</CMBDEVCLAW-SKILL-USE-V1>`
 * block inside a message string.
 *
 * Tail-anchored on purpose: the block is always at the end of the model-facing
 * payload, and `lastIndexOf` survives even if the user's own prose happens to
 * contain the literal tag before the real transport block.
 *
 * This is protocol data, not just cosmetic UI metadata: main-side code also
 * reads a valid tail block to activate the explicitly selected skill. User
 * prose that ends with a complete, valid block is therefore still ambiguous
 * until the composer sends skills out-of-band instead of as text.
 *
 * Returns null if no matching block exists, or if the block has no valid <name>.
 */
export function parseSkillUseBlock(
  content: string
): { skillName: string; skillPath: string; rest: string } | null {
  const openTag = `<${TAG_NAME}>`
  const closeTag = `</${TAG_NAME}>`
  const closeAt = content.lastIndexOf(closeTag)
  if (closeAt < 0) return null
  const openAt = content.lastIndexOf(openTag, closeAt)
  if (openAt < 0) return null

  // Strict tail check: real protocol blocks are always at the very end (we only
  // ever append, no trailing payload follows). If anything non-whitespace sits
  // after the close tag, this is user-authored prose that happens to mention
  // the tag — leaving it alone is safer than swallowing the user's text.
  const tailAfterClose = content.slice(closeAt + closeTag.length)
  if (tailAfterClose.trim() !== "") return null

  const block = content.slice(openAt, closeAt + closeTag.length)
  const nameMatch = block.match(/<name>\s*([^<]*)\s*<\/name>/)
  const pathMatch = block.match(/<path>\s*([^<]*)\s*<\/path>/)
  // Both <name> and <path> are required. Our generator always emits both, so a
  // block that's missing either is almost certainly user-authored prose that
  // happens to contain `<name>` or the outer tag — refuse to recognise it as
  // a real protocol block to avoid swallowing the user's text.
  if (!nameMatch || !pathMatch) return null

  const skillName = unescapeXml(nameMatch[1]).trim()
  const skillPath = unescapeXml(pathMatch[1]).trim()
  if (!skillName || !skillPath) return null

  // Preserve everything before the tag (user text + attachments). The tail
  // check above guarantees nothing meaningful follows the close tag.
  const rest = content.slice(0, openAt).replace(/\s+$/, "")
  return { skillName, skillPath, rest }
}
