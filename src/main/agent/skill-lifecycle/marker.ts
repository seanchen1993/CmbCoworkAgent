const TAG_NAME = "CMBDEVCLAW-SKILL-USE-V1"

function unescapeXml(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
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
