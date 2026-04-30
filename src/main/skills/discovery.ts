import { existsSync, readFileSync, readdirSync } from "fs"
import { readdir, readFile } from "fs/promises"
import { basename, dirname, join, relative } from "path"

export const MAX_SKILL_DISCOVERY_DEPTH = 3

export interface DiscoveredSkill {
  name: string
  sourceDir: string
  rootDir: string
  skillMdPath: string
  relativePath: string
  depth: number
}

export function normalizeSkillRelativePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
}

export function parseSkillNameFromFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0 && line.slice(0, colonIdx).trim().toLowerCase() === "name") {
      return line.slice(colonIdx + 1).trim()
    }
  }
  return null
}

export function getSkillNameFromContent(content: string, fallbackName: string): string {
  return parseSkillNameFromFrontmatter(content) || fallbackName
}

function makeDiscoveredSkill(
  sourceDir: string,
  skillDir: string,
  content: string,
  depth: number
): DiscoveredSkill {
  const relativePath = normalizeSkillRelativePath(relative(sourceDir, skillDir))
  return {
    name: getSkillNameFromContent(content, basename(skillDir)),
    sourceDir,
    rootDir: skillDir,
    skillMdPath: join(skillDir, "SKILL.md"),
    relativePath,
    depth
  }
}

export async function discoverSkills(
  sourceDir: string,
  maxDepth = MAX_SKILL_DISCOVERY_DEPTH
): Promise<DiscoveredSkill[]> {
  const result: DiscoveredSkill[] = []
  if (!existsSync(sourceDir)) return result

  async function walk(dirPath: string, depth: number): Promise<void> {
    const skillMdPath = join(dirPath, "SKILL.md")
    try {
      const content = await readFile(skillMdPath, "utf-8")
      result.push(makeDiscoveredSkill(sourceDir, dirPath, content, depth))
    } catch {
      /* not a skill directory */
    }

    if (depth >= maxDepth) return

    let entries
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch {
      return
    }

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => walk(join(dirPath, entry.name), depth + 1))
    )
  }

  await walk(sourceDir, 0)
  return result
}

export function discoverSkillsSync(
  sourceDir: string,
  maxDepth = MAX_SKILL_DISCOVERY_DEPTH
): DiscoveredSkill[] {
  const result: DiscoveredSkill[] = []
  if (!existsSync(sourceDir)) return result

  function walk(dirPath: string, depth: number): void {
    const skillMdPath = join(dirPath, "SKILL.md")
    try {
      const content = readFileSync(skillMdPath, "utf-8")
      result.push(makeDiscoveredSkill(sourceDir, dirPath, content, depth))
    } catch {
      /* not a skill directory */
    }

    if (depth >= maxDepth) return

    let entries
    try {
      entries = readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      walk(join(dirPath, entry.name), depth + 1)
    }
  }

  walk(sourceDir, 0)
  return result
}

export async function expandSkillMiddlewareSourceDirs(sourceDirs: string[]): Promise<string[]> {
  const expanded: string[] = []
  const seen = new Set<string>()

  const push = (dir: string): void => {
    const key = dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    expanded.push(dir)
  }

  for (const sourceDir of sourceDirs) {
    push(sourceDir)
    const skills = await discoverSkills(sourceDir)
    const parentDirs = Array.from(
      new Set(
        skills
          .filter((skill) => skill.depth > 1)
          .sort((a, b) => a.depth - b.depth || a.rootDir.localeCompare(b.rootDir))
          .map((skill) => dirname(skill.rootDir))
      )
    )
    for (const parentDir of parentDirs) {
      push(parentDir)
    }
  }

  return expanded
}

export function makeFlattenedSkillDirName(relativePath: string): string {
  const normalized = normalizeSkillRelativePath(relativePath)
  const base = normalized || "skill"
  return (
    base
      .split("/")
      .map((segment) =>
        segment
          .replace(/[\\/:*?"<>|]/g, "-")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
      )
      .filter(Boolean)
      .join("__") || "skill"
  ).slice(0, 80)
}
