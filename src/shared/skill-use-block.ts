export interface SkillUseBlockMetadata {
  name: string
  path: string
  description?: string | null
  metadata?: Record<string, string> | null
  allowedTools?: string[] | null
}

const SKILL_USE_TAG_NAME = "CMBDEVCLAW-SKILL-USE-V1"

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
