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

  onReadFilePath(rawPath: string): void {
    const skillName = this.getSkillNameForReadFilePath(rawPath)
    if (skillName) {
      this.usedSkillNames.add(skillName)
    }
  }

  getSkillNameForReadFilePath(rawPath: string): string {
    const normalized = normalizePath(rawPath.trim())
    if (!normalized) return ""

    const exactMatch = this.loadedSkillsByDocPath.get(normalized)
    if (exactMatch) return exactMatch

    for (const [rootDir, skillName] of this.loadedSkillsByRootDir.entries()) {
      if (normalized === rootDir || normalized.startsWith(`${rootDir}/`)) return skillName
    }

    return ""
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
