import { parse as parseYaml } from "yaml"

export interface ParsedSkillFrontmatter {
  frontmatter: Record<string, unknown>
  body: string
}

export interface CheckedSkillFrontmatter extends ParsedSkillFrontmatter {
  status: "absent" | "valid" | "invalid"
}

/** Preserve the original body/name semantics while allowing dependency readers
 * to distinguish malformed declarations from a skill with no frontmatter. */
export function parseSkillFrontmatterChecked(content: string): CheckedSkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/)
  if (!match) {
    return {
      frontmatter: {},
      body: content,
      status: /^---\r?\n/.test(content) ? "invalid" : "absent"
    }
  }

  const rawYaml = match[1]
  let frontmatter: Record<string, unknown> = {}
  let status: CheckedSkillFrontmatter["status"] = "invalid"
  try {
    const parsed = parseYaml(rawYaml)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>
      status = "valid"
    }
  } catch {
    frontmatter = {}
  }

  return {
    frontmatter,
    body: content.slice(match[0].length),
    status
  }
}

export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const { frontmatter, body } = parseSkillFrontmatterChecked(content)
  return { frontmatter, body }
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
