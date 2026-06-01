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

const TAG_NAME = "CMBDEVCLAW-SKILL-USE-V1"

/**
 * Escape the minimum set of characters that would break our text-node XML.
 * We only put values inside element text (never attributes), so quotes need no
 * escaping. `&` / `<` / `>` are the only three that matter.
 */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

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
 * Serialize a skill invocation into the tail XML block that goes at the END of
 * the user message. The standing instruction inside tells the model to load the
 * SKILL.md via its own read tool — main-side never inlines the body.
 *
 * Callers concatenate this result onto the user's message (usually separated by
 * one blank line). They are free to put attachments in between too; the chip
 * parser anchors on `lastIndexOf` so anything preceding the tag is preserved.
 */
function optionalXmlLine(tag: string, value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed ? `<${tag}>${escapeXml(trimmed)}</${tag}>\n` : ""
}

function skillWhenToUse(skill: {
  metadata?: Record<string, string> | null
}): string | undefined {
  const metadata = skill.metadata ?? undefined
  return metadata?.whenToUse ?? metadata?.["when-to-use"] ?? metadata?.when_to_use
}

export function formatSkillUseBlock(skill: {
  name: string
  path: string
  description?: string | null
  metadata?: Record<string, string> | null
  allowedTools?: string[] | null
}): string {
  const name = skill.name.trim()
  const path = skill.path.trim()
  const allowedTools =
    skill.allowedTools && skill.allowedTools.length > 0 ? skill.allowedTools.join(", ") : undefined
  return (
    `<${TAG_NAME}>\n` +
    `<instruction>\n` +
    `用户显式选择了下面 <name> 指定的技能。请先使用 read_file 工具读取 <path> 指定的 SKILL.md 文件。读取后必须严格按照该技能说明执行本轮任务：\n` +
    `- 不要跳过任何步骤，也不要把步骤改写成泛化或概括的回答；\n` +
    `- 不要重复询问技能文档中已经明确给出的内容；\n` +
    `- 不要凭猜测代替技能中明确的指令；\n` +
    `- 始终使用中文回答。\n` +
    `</instruction>\n` +
    `<name>${escapeXml(name)}</name>\n` +
    optionalXmlLine("description", skill.description ?? undefined) +
    optionalXmlLine("when_to_use", skillWhenToUse(skill)) +
    optionalXmlLine("allowed_tools", allowedTools) +
    `<path>${escapeXml(path)}</path>\n` +
    `</${TAG_NAME}>`
  )
}

/**
 * Locate the trailing `<CMBDEVCLAW-SKILL-USE-V1>…</CMBDEVCLAW-SKILL-USE-V1>`
 * block inside a message string.
 *
 * Tail-anchored on purpose: the block is always at the end of the model-facing
 * payload, and `lastIndexOf` survives even if the user's own prose happens to
 * contain the literal tag (they'd see their own text render, plus a chip for
 * the tail block — cosmetic-only, no execution impact because main-side does
 * nothing special with this string).
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
