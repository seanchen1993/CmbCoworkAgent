import { existsSync, readFileSync, readdirSync } from "fs"
import { basename, join, normalize, resolve } from "path"

export interface SkillLifecycleMatch {
  name: string
  path: string
  rootDir: string
}

interface SkillLifecycleEntry extends SkillLifecycleMatch {
  normalizedDocPath: string
  normalizedRootDir: string
}

function normalizePath(input: string): string {
  return normalize(input).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function parseSkillNameFromFrontmatter(content: string): string | null {
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

function readSkillName(skillDoc: string, fallbackName: string): string {
  try {
    return parseSkillNameFromFrontmatter(readFileSync(skillDoc, "utf-8")) || fallbackName
  } catch {
    return fallbackName
  }
}

function collectSkillEntriesFromSource(source: string): SkillLifecycleEntry[] {
  const sourcePath = resolve(source)
  const rootSkill = join(sourcePath, "SKILL.md")
  if (existsSync(rootSkill)) {
    return [
      {
        name: readSkillName(rootSkill, basename(sourcePath)),
        path: rootSkill,
        rootDir: sourcePath,
        normalizedDocPath: normalizePath(rootSkill),
        normalizedRootDir: normalizePath(sourcePath)
      }
    ]
  }

  if (!existsSync(sourcePath)) return []
  const entries: SkillLifecycleEntry[] = []
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillRoot = join(sourcePath, entry.name)
    const skillDoc = join(skillRoot, "SKILL.md")
    if (!existsSync(skillDoc)) continue
    entries.push({
      name: readSkillName(skillDoc, entry.name),
      path: skillDoc,
      rootDir: skillRoot,
      normalizedDocPath: normalizePath(skillDoc),
      normalizedRootDir: normalizePath(skillRoot)
    })
  }
  return entries
}

export class SkillLifecycleRegistry {
  private readonly entries: SkillLifecycleEntry[]

  constructor(sources: string[]) {
    const seen = new Set<string>()
    const entries: SkillLifecycleEntry[] = []
    for (const source of sources) {
      for (const entry of collectSkillEntriesFromSource(source)) {
        const key = entry.normalizedRootDir
        if (seen.has(key)) continue
        seen.add(key)
        entries.push(entry)
      }
    }
    this.entries = entries
  }

  resolveRead(rawPath: string, resolvedPath?: string): SkillLifecycleMatch | null {
    const candidates = [
      resolvedPath ? normalizePath(resolvedPath) : "",
      rawPath ? normalizePath(resolve(rawPath)) : "",
      rawPath ? normalizePath(rawPath) : ""
    ].filter(Boolean)

    for (const candidate of candidates) {
      for (const entry of this.entries) {
        if (
          candidate === entry.normalizedDocPath ||
          candidate === entry.normalizedRootDir ||
          candidate.startsWith(`${entry.normalizedRootDir}/`)
        ) {
          return {
            name: entry.name,
            path: entry.path,
            rootDir: entry.rootDir
          }
        }
      }
    }
    return null
  }
}
