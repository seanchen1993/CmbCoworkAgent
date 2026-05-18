import { parse as parseYaml } from "yaml"

export interface ParsedSkillFrontmatter {
  frontmatter: Record<string, unknown>
  body: string
}

export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/)
  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const rawYaml = match[1]
  let frontmatter: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(rawYaml)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>
    }
  } catch {
    frontmatter = {}
  }

  return {
    frontmatter,
    body: content.slice(match[0].length)
  }
}

export function getFrontmatterString(
  frontmatter: Record<string, unknown>,
  key: string
): string | null {
  const value =
    frontmatter[key] ??
    Object.entries(frontmatter).find(
      ([candidate]) => candidate.toLowerCase() === key.toLowerCase()
    )?.[1]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function parseSkillNameFromFrontmatterYaml(content: string): string | null {
  return getFrontmatterString(parseSkillFrontmatter(content).frontmatter, "name")
}
