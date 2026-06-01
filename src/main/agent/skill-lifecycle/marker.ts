const TAG_NAME = "CMBDEVCLAW-SKILL-USE-V1"

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function unescapeXml(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
}

export function formatSkillUseBlock(skill: { name: string; path: string }): string {
  const name = skill.name.trim()
  const path = skill.path.trim()
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
    `<path>${escapeXml(path)}</path>\n` +
    `</${TAG_NAME}>`
  )
}

export interface ParsedSkillUseBlock {
  skillName: string
  skillPath: string
  rest: string
  block: string
}

export function parseSkillUseBlock(content: string): ParsedSkillUseBlock | null {
  const openTag = `<${TAG_NAME}>`
  const closeTag = `</${TAG_NAME}>`
  const closeAt = content.lastIndexOf(closeTag)
  if (closeAt < 0) return null
  const openAt = content.lastIndexOf(openTag, closeAt)
  if (openAt < 0) return null

  const tailAfterClose = content.slice(closeAt + closeTag.length)
  if (tailAfterClose.trim() !== "") return null

  const block = content.slice(openAt, closeAt + closeTag.length)
  const nameMatch = block.match(/<name>\s*([^<]*)\s*<\/name>/)
  const pathMatch = block.match(/<path>\s*([^<]*)\s*<\/path>/)
  if (!nameMatch || !pathMatch) return null

  const skillName = unescapeXml(nameMatch[1]).trim()
  const skillPath = unescapeXml(pathMatch[1]).trim()
  if (!skillName || !skillPath) return null

  return {
    skillName,
    skillPath,
    rest: content.slice(0, openAt).replace(/\s+$/, ""),
    block
  }
}
