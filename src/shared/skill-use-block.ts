export interface SkillUseBlockMetadata {
  name: string
  path: string
  description?: string | null
  metadata?: Record<string, string> | null
  allowedTools?: string[] | null
}

export const SKILL_USE_TAG_NAME = "CMBDEVCLAW-SKILL-USE-V1"

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function optionalXmlLine(tag: string, value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed ? `<${tag}>${escapeXml(trimmed)}</${tag}>\n` : ""
}

function skillWhenToUse(skill: SkillUseBlockMetadata): string | undefined {
  const metadata = skill.metadata ?? undefined
  return metadata?.whenToUse ?? metadata?.["when-to-use"] ?? metadata?.when_to_use
}

const SKILL_USE_OPEN_TAG = `<${SKILL_USE_TAG_NAME}>`
const SKILL_USE_CLOSE_TAG = `</${SKILL_USE_TAG_NAME}>`

/** Reverse of escapeXml, tolerant of the quote entities a stricter producer may emit. */
function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
}

/**
 * The skill directory is named after the skill, so the last path segment before
 * SKILL.md names the skill even when the `<name>` pair itself did not survive.
 */
function skillNameFromPathTail(block: string): string {
  return block.match(/([^\\/<>\s]+)[\\/]SKILL\.md\s*<\/path>/i)?.[1] ?? ""
}

/**
 * A half-eaten `<name>` is worse than none — `使用 /autobiz-require 技能` names a
 * skill that does not exist — so the pair has to be intact to be believed, and
 * the path tail is the fallback rather than whatever text follows the open tag.
 */
function salvageSkillName(block: string): string {
  const paired = block.match(/<name>\s*([^<]*)\s*<\/name>/)
  const name = paired ? unescapeXml(paired[1]).trim() : ""
  return name || skillNameFromPathTail(block)
}

/**
 * Display-only companion to parseSkillUseBlock, for a payload read back out of
 * storage rather than one on its way to the model.
 *
 * parseSkillUseBlock demands an intact `<name>` *and* `<path>` pair and refuses
 * everything else. That strictness is load-bearing where it is used: it also
 * activates the selected skill in the main process and refills the composer
 * when a message is edited, and mistaking prose for a protocol block there
 * would swallow what the user wrote. A trace replayed on the operations
 * dashboard has no such stake, and it routinely carries a block the upload
 * sanitizer cut down the middle — the compressed 512-char userMessage budget
 * elides the middle of the message, taking `</name>` and the opening `<path>`
 * with it. Refusing there shows the reader 400 characters of transport
 * plumbing instead of the question that was asked.
 *
 * Returns null when no block is present. `skillName` is "" when truncation left
 * nothing trustworthy to name it with.
 */
export function stripSkillUseBlockForDisplay(
  content: string
): { rest: string; skillName: string } | null {
  const openAt = content.lastIndexOf(SKILL_USE_OPEN_TAG)
  if (openAt < 0) return null
  const block = content.slice(openAt)
  // Our own block always carries at least one of these. Prose that merely
  // mentions the tag name carries neither, and is left alone.
  if (!block.includes("<instruction>") && !block.includes(SKILL_USE_CLOSE_TAG)) return null
  return {
    rest: content.slice(0, openAt).replace(/\s+$/, ""),
    skillName: salvageSkillName(block)
  }
}

/**
 * How an explicitly-chosen skill is named wherever the block itself is not
 * shown. One definition on purpose: the marker written at upload time and the
 * label the dashboard falls back to are the same thing to a reader, and a trace
 * list mixing "使用 /x 技能" with "[技能] x" reads as two different events.
 */
export function skillUseDisplayLabel(skillName: string): string {
  return skillName ? `[技能] ${skillName}` : "[技能] （名称未完整记录）"
}

/**
 * Reduce the block to a one-line marker naming the skill, for storage that
 * keeps a payload only so a person can read it back.
 *
 * The block is transport: ~500 characters of fixed instruction text plus the
 * SKILL.md path, identical on every explicitly-chosen skill. Left in, it spends
 * the trace's userMessage budget on itself — a 49-character question plus one
 * block lands over the 512-char compressed limit, and the middle-elision that
 * follows takes the skill's identity with it. Compacted first, the question
 * fits whole and the skill name survives.
 */
export function compactSkillUseBlockForTrace(content: string): string {
  const stripped = stripSkillUseBlockForDisplay(content)
  if (!stripped) return content
  const marker = skillUseDisplayLabel(stripped.skillName)
  return stripped.rest ? `${stripped.rest}\n${marker}` : marker
}

export function formatSkillUseBlock(skill: SkillUseBlockMetadata): string {
  const name = skill.name.trim()
  const path = skill.path.trim()
  const allowedTools =
    skill.allowedTools && skill.allowedTools.length > 0 ? skill.allowedTools.join(", ") : undefined
  return (
    `<${SKILL_USE_TAG_NAME}>\n` +
    `<instruction>\n` +
    `用户显式选择了下面 <name> 指定的技能。请先使用 read_file 工具读取 <path> 指定的 SKILL.md 文件。读取后必须严格按照该技能说明执行本轮任务：\n` +
    `- 不要跳过任何步骤，也不要把步骤改写成泛化或概括的回答；\n` +
    `- 不要重复询问技能文档中已经明确给出的内容；\n` +
    `- 不要凭猜测代替技能中明确的指令；\n` +
    `- 技能文档中提到的相对脚本、资源、模板路径，都必须按 <path> 指定的 SKILL.md 所在目录解析；执行脚本时请使用绝对路径，或把 cwd 设置为该技能目录；\n` +
    `- 始终使用中文回答。\n` +
    `</instruction>\n` +
    `<name>${escapeXml(name)}</name>\n` +
    optionalXmlLine("description", skill.description ?? undefined) +
    optionalXmlLine("when_to_use", skillWhenToUse(skill)) +
    optionalXmlLine("allowed_tools", allowedTools) +
    `<path>${escapeXml(path)}</path>\n` +
    `</${SKILL_USE_TAG_NAME}>`
  )
}
