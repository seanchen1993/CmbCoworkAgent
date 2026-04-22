import { posix as pathPosix } from "path"

export interface SkillMetadataLite {
  name?: string
  path?: string
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "")
}

export class SkillUsageDetector {
  private readonly loadedSkillsByDocPath = new Map<string, string>()
  private readonly loadedSkillsByRootDir = new Map<string, string>()
  private readonly usedSkillNames = new Set<string>()

  onSkillsMetadata(skills: SkillMetadataLite[]): void {
    for (const skill of skills) {
      const skillName = typeof skill.name === "string" ? skill.name.trim() : ""
      const skillPath = typeof skill.path === "string" ? normalizePath(skill.path.trim()) : ""
      if (!skillName || !skillPath) continue

      this.loadedSkillsByDocPath.set(skillPath, skillName)
      const rootDir = normalizePath(pathPosix.dirname(skillPath))
      if (rootDir && rootDir !== ".") {
        this.loadedSkillsByRootDir.set(rootDir, skillName)
      }
    }
  }

  /**
   * Record a read_file path and check whether it matches any loaded skill.
   * Returns `true` when at least one new skill name was added to the set
   * (callers can use this to immediately refresh downstream state, e.g.
   * tracer.setUsedSkills / adoption context, so that subsequent code_gen
   * events in the same turn carry the skill attribution).
   */
  onReadFilePath(rawPath: string): boolean {
    const normalized = normalizePath(rawPath.trim())
    if (!normalized) return false

    const priorSize = this.usedSkillNames.size

    const exactMatch = this.loadedSkillsByDocPath.get(normalized)
    if (exactMatch) {
      this.usedSkillNames.add(exactMatch)
      return this.usedSkillNames.size > priorSize
    }

    for (const [rootDir, skillName] of this.loadedSkillsByRootDir.entries()) {
      if (normalized === rootDir || normalized.startsWith(`${rootDir}/`)) {
        this.usedSkillNames.add(skillName)
      }
    }
    return this.usedSkillNames.size > priorSize
  }

  getUsedSkillNames(): string[] {
    return Array.from(this.usedSkillNames)
  }

  hasUsedSkills(): boolean {
    return this.usedSkillNames.size > 0
  }
}

/**
 * The popup should display the same count that crossed the threshold.
 */
export function getAutoProposeToolCallCount(turnToolCallCount: number): number {
  return turnToolCallCount
}
